// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import type { ApiEvent, ImageAttachment, SessionInfo } from "@1jehuang/jcode-sdk";
import {
  EventId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderDriverKind,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderTurnStartResult,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { jcodeThreadIdentityPath } from "./JcodePaths.ts";
import { decodeJcodeResumeCursor, JCODE_RESUME_CURSOR } from "./JcodeResumeCursor.ts";
import {
  initialJcodeEventMappingState,
  mapJcodeRuntimeEvent,
  type JcodeEventMappingState,
} from "./JcodeRuntimeEvents.ts";
import {
  JcodeSessionNotFoundError,
  type JcodeSdkBridge,
  type JcodeSdkClient,
} from "./JcodeSdkBridge.ts";
import { readJcodeSessionIdentity, writeJcodeSessionIdentity } from "./JcodeSessionIdentity.ts";

const PROVIDER = ProviderDriverKind.make("jcode");

/**
 * The reasoning-effort selection that means "leave the harness alone".
 *
 * Jcode's accepted effort set is per-provider, so the only safe way to express
 * "no opinion" is to never issue `set_reasoning_effort` at all rather than
 * guessing at a neutral value the provider may reject.
 */
export const JCODE_DEFAULT_REASONING_EFFORT = "jcode-default";

export class JcodeSessionRuntimeError extends Data.TaggedError("JcodeSessionRuntimeError")<{
  readonly operation:
    | "create"
    | "resume"
    | "attachments"
    | "model"
    | "reasoning"
    | "send"
    | "cancel"
    | "stream"
    | "close";
  readonly detail: string;
  /**
   * Only a non-identifying discriminator, never a throwable and never a bridge
   * error verbatim. A `Data.TaggedError` prop is an own enumerable property of
   * a real `Error`, so anything stored here is printed by `util.inspect`,
   * `JSON.stringify`, Node's crash printer, and any logger that walks error
   * properties. A bridge error redacts the credential literals it was handed at
   * launch, but a session client is connected without any, so its `detail` can
   * still quote a daemon message containing a credential; and its
   * `sessionId` is exactly the native identity the sidecar exists to keep
   * private.
   */
  readonly cause?: unknown;
}> {}

export interface JcodeSessionRuntime {
  readonly session: ProviderSession;
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, JcodeSessionRuntimeError>;
  readonly interruptTurn: (turnId?: TurnId) => Effect.Effect<void, JcodeSessionRuntimeError>;
  readonly close: Effect.Effect<void, JcodeSessionRuntimeError>;
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

export interface JcodeSessionRuntimeInput {
  /** Manager-scoped bridge; never a process singleton. */
  readonly bridge: JcodeSdkBridge;
  /** One child client, owned by this runtime and closed with it. */
  readonly client: JcodeSdkClient;
  readonly providerInstanceId: ProviderInstanceId;
  readonly instanceId: string;
  readonly threadId: ThreadId;
  readonly stateDir: string;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  /** Present only for a durable continuation; must be the exact marker. */
  readonly resumeCursor?: unknown;
}

const TRANSPORT_FAILURE_MESSAGE =
  "The connection to the private Jcode instance was lost, so this session was closed.";
const TRANSPORT_ABORT_REASON =
  "The connection to the private Jcode instance was lost during this turn.";
const FATAL_ABORT_REASON = "Jcode could not continue this turn, so the session was closed.";
const EXIT_REASON_ERROR = "The Jcode session ended after an unrecoverable runtime failure.";
const EXIT_REASON_GRACEFUL = "The Jcode session ended.";

/**
 * What a runtime error may remember about the failure it replaced.
 *
 * The tag identifies which boundary failed and the harness's own `code` is a
 * closed vocabulary, so both are safe. Everything else — message text, stack,
 * native session id — is dropped rather than trusted.
 */
function safeCause(cause: unknown): unknown {
  if (typeof cause !== "object" || cause === null) return undefined;
  const tag = (cause as { readonly _tag?: unknown })._tag;
  const code = (cause as { readonly code?: unknown }).code;
  if (typeof tag !== "string") return undefined;
  return {
    _tag: tag,
    ...(typeof code === "string" ? { code } : {}),
  };
}

function isAbsoluteMatch(left: string, right: string): boolean {
  return left === right;
}

export const makeJcodeSessionRuntime = Effect.fn("makeJcodeSessionRuntime")(function* (
  input: JcodeSessionRuntimeInput,
): Effect.fn.Return<
  JcodeSessionRuntime,
  JcodeSessionRuntimeError,
  FileSystem.FileSystem | Path.Path | ServerConfig | Scope.Scope
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const { bridge, client, threadId, providerInstanceId } = input;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const runtimeError = (
    operation: JcodeSessionRuntimeError["operation"],
    detail: string,
    cause?: unknown,
  ) => {
    const safe = cause === undefined ? undefined : safeCause(cause);
    return new JcodeSessionRuntimeError({
      operation,
      detail,
      ...(safe === undefined ? {} : { cause: safe }),
    });
  };

  const identityPath = jcodeThreadIdentityPath({
    stateDir: input.stateDir,
    instanceId: input.instanceId,
    threadId,
    join: (...segments) => path.join(...segments),
  });

  /**
   * Attach an existing native session, or mint one.
   *
   * A continuation requires the exact marker *and* a valid private sidecar
   * naming this thread's own working directory. Anything else fails closed:
   * silently creating a replacement would strand the previous native session
   * and quietly lose the user's transcript.
   */
  const openSession: Effect.Effect<
    { readonly sessionId: string; readonly restored: boolean },
    JcodeSessionRuntimeError,
    FileSystem.FileSystem | Path.Path
  > = Effect.gen(function* () {
    if (input.resumeCursor !== undefined) {
      if (decodeJcodeResumeCursor(input.resumeCursor) === undefined) {
        return yield* runtimeError(
          "resume",
          "The stored Jcode continuation marker is not the one this provider issues.",
        );
      }
      // Total by construction: absence, corruption, and an unreadable sidecar
      // all decode to `undefined`, and the reader emits its own redacted
      // operator warning. There is no failure channel to map, and the single
      // "nothing to continue" outcome below is the correct fail-closed answer
      // for all three.
      const identity = yield* readJcodeSessionIdentity(identityPath);
      if (identity === undefined) {
        return yield* runtimeError(
          "resume",
          "This thread has no private Jcode session identity to continue.",
        );
      }
      if (!isAbsoluteMatch(identity.workingDir, input.cwd)) {
        return yield* runtimeError(
          "resume",
          "The recorded Jcode session belongs to a different working directory.",
        );
      }
      const attached: SessionInfo = yield* bridge
        .trySdk({
          operation: "attachSession",
          sessionId: identity.sessionId,
          run: () => client.attachSession(identity.sessionId),
        })
        .pipe(
          Effect.mapError((error) =>
            runtimeError(
              "resume",
              error instanceof JcodeSessionNotFoundError
                ? "The recorded Jcode session is no longer known to the instance."
                : "Could not attach the recorded Jcode session.",
              error,
            ),
          ),
        );
      // Fail closed on an omitted directory too. The plan requires attach to
      // verify the *returned* working directory, and the sidecar cannot stand
      // in for that: it is Pylon's own record, so trusting it alone would
      // verify this thread against itself and never against the daemon.
      if (attached.working_dir === undefined || !isAbsoluteMatch(attached.working_dir, input.cwd)) {
        return yield* runtimeError(
          "resume",
          "The attached Jcode session did not confirm this thread's working directory.",
        );
      }
      return { sessionId: identity.sessionId, restored: true };
    }

    const created: SessionInfo = yield* bridge
      .trySdk({ operation: "createSession", run: () => client.createSession(input.cwd) })
      .pipe(
        Effect.mapError((error) =>
          runtimeError("create", "Could not create a Jcode session for this thread.", error),
        ),
      );
    if (created.working_dir !== undefined && !isAbsoluteMatch(created.working_dir, input.cwd)) {
      return yield* runtimeError(
        "create",
        "The new Jcode session reported a different working directory.",
      );
    }
    yield* writeJcodeSessionIdentity({
      filePath: identityPath,
      sessionId: created.session_id,
      workingDir: input.cwd,
    }).pipe(
      Effect.mapError((error) =>
        runtimeError(
          "create",
          `Could not persist the private Jcode session identity (${error.reason ?? "unknown"}).`,
        ),
      ),
    );
    return { sessionId: created.session_id, restored: false };
  });

  const closeClient = bridge
    .trySdk({ operation: "close", run: () => client.close() })
    .pipe(Effect.ignore);

  // Registered before the session is opened, so every fail-closed startup path
  // still releases the child client this runtime was handed. The bridge latches
  // `close` on success, so the later full `close` cannot double-close it.
  yield* Effect.addFinalizer(() => closeClient);

  const opened = yield* openSession;
  const sessionId = opened.sessionId;

  const queue = yield* Queue.unbounded<ProviderRuntimeEvent, Cause.Done>();

  /** One stamp per SDK event; the mapper suffixes each canonical event it emits. */
  const stampPrefix = `jcode-${NodeCrypto.randomUUID()}`;
  let stampSequence = 0;
  const nextStamp = () => EventId.make(`${stampPrefix}-${++stampSequence}`);

  let mappingState: JcodeEventMappingState = initialJcodeEventMappingState;
  let activeTurnId: TurnId | undefined;
  let currentModel = input.model;
  let terminated = false;

  const baseEvent = (createdAt: string, turnId?: TurnId) => ({
    eventId: nextStamp(),
    provider: PROVIDER,
    providerInstanceId,
    threadId,
    createdAt,
    ...(turnId === undefined ? {} : { turnId }),
  });

  /**
   * The single exit path. Runs at most once, whatever raced to it: a transport
   * failure, a mapper invariant the turn cannot survive, or the stream simply
   * ending because the client was closed. There is no reconnect — protocol v1
   * cannot replay what was missed, so a resurrected stream would silently
   * present a hole as continuity.
   */
  const terminate = (kind: "transport" | "fatal" | "end") =>
    Effect.gen(function* () {
      if (terminated) return;
      terminated = true;
      const createdAt = yield* nowIso;
      const turnId = activeTurnId;
      activeTurnId = undefined;
      const events: ProviderRuntimeEvent[] = [];
      if (kind !== "end" && turnId !== undefined) {
        events.push({
          ...baseEvent(createdAt, turnId),
          type: "turn.aborted",
          payload: { reason: kind === "transport" ? TRANSPORT_ABORT_REASON : FATAL_ABORT_REASON },
        } as ProviderRuntimeEvent);
      }
      if (kind === "transport") {
        events.push({
          ...baseEvent(createdAt),
          type: "runtime.error",
          payload: { message: TRANSPORT_FAILURE_MESSAGE, class: "transport_error" },
        } as ProviderRuntimeEvent);
      }
      events.push({
        ...baseEvent(createdAt),
        type: "session.exited",
        payload: {
          reason: kind === "end" ? EXIT_REASON_GRACEFUL : EXIT_REASON_ERROR,
          recoverable: false,
          exitKind: kind === "end" ? "graceful" : "error",
        },
      } as ProviderRuntimeEvent);
      yield* Queue.offerAll(queue, events);
      yield* closeClient;
      yield* Queue.end(queue);
    });

  const handleEvent = (event: ApiEvent) =>
    Effect.gen(function* () {
      if (terminated) return;
      const createdAt = yield* nowIso;
      const result = mapJcodeRuntimeEvent(mappingState, event, {
        eventId: nextStamp(),
        providerInstanceId,
        threadId,
        ...(activeTurnId === undefined ? {} : { turnId: activeTurnId }),
        createdAt,
      });
      mappingState = result.state;
      if (result.events.length > 0) yield* Queue.offerAll(queue, result.events);
      // The mapper resets its own per-turn state at `turn_done`, but the active
      // Pylon turn is separate bookkeeping. Releasing it here is what keeps a
      // later transport failure from aborting a turn that already completed.
      if (result.events.some((event) => event.type === "turn.completed")) {
        activeTurnId = undefined;
      }
      if (result.fatal) yield* terminate("fatal");
    });

  // Opened before the first message so nothing emitted by an eagerly-started
  // turn can land before there is a consumer for it.
  // The bridge already classified and redacted whatever the iterator rejected
  // with, but its error type is still the SDK boundary's union. Collapsing it
  // here to one typed, non-identifying value keeps the pump's error channel
  // honest without carrying a native session id into the fiber's failure.
  const eventStream = Stream.fromAsyncIterable(client.events(sessionId), () =>
    runtimeError("stream", TRANSPORT_FAILURE_MESSAGE),
  );
  const pumpFiber = yield* Effect.forkScoped(
    Stream.runForEach(eventStream, handleEvent).pipe(
      Effect.catch(() => terminate("transport")),
      Effect.andThen(terminate("end")),
    ),
  );

  const close: Effect.Effect<void, JcodeSessionRuntimeError> = Effect.suspend(() =>
    closeClient.pipe(
      Effect.andThen(Fiber.await(pumpFiber)),
      Effect.andThen(Queue.end(queue)),
      Effect.asVoid,
    ),
  );

  yield* Effect.addFinalizer(() => Effect.ignore(close));

  const resolveImages = (
    attachments: NonNullable<ProviderSendTurnInput["attachments"]>,
  ): Effect.Effect<ReadonlyArray<ImageAttachment>, JcodeSessionRuntimeError> =>
    Effect.gen(function* () {
      if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        return yield* runtimeError(
          "attachments",
          `A Jcode turn accepts at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
        );
      }
      return yield* Effect.forEach(
        attachments,
        (attachment) =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (attachmentPath === null) {
              return yield* runtimeError(
                "attachments",
                `Invalid attachment id '${attachment.id}'.`,
              );
            }
            const bytes = yield* fs.readFile(attachmentPath).pipe(
              // The resolved path names the server's private attachment store,
              // so only the client-supplied id survives into the message.
              Effect.mapError(() =>
                runtimeError(
                  "attachments",
                  `Could not read the file for attachment '${attachment.id}'.`,
                ),
              ),
            );
            return [attachment.mimeType, Buffer.from(bytes).toString("base64")] as ImageAttachment;
          }),
        { concurrency: 1 },
      );
    });

  const sendTurn = (turnInput: ProviderSendTurnInput) =>
    Effect.gen(function* () {
      const images = yield* resolveImages(turnInput.attachments ?? []);

      const selection = turnInput.modelSelection;
      const selected =
        selection !== undefined && selection.instanceId === providerInstanceId
          ? selection
          : undefined;

      if (selected !== undefined && selected.model !== currentModel) {
        const model = selected.model;
        yield* bridge
          .trySdk({
            operation: "setModel",
            sessionId,
            run: () => client.setModel(sessionId, model),
          })
          .pipe(
            Effect.mapError((error) =>
              runtimeError("model", "Jcode refused the selected model.", error),
            ),
          );
        currentModel = model;
      }

      const effort =
        selected === undefined
          ? undefined
          : getModelSelectionStringOptionValue(selected, "reasoningEffort");
      if (effort !== undefined && effort !== JCODE_DEFAULT_REASONING_EFFORT) {
        yield* bridge
          .trySdk({
            operation: "setReasoningEffort",
            sessionId,
            run: () => client.setReasoningEffort(sessionId, effort),
          })
          .pipe(
            Effect.mapError((error) =>
              runtimeError("reasoning", "Jcode refused the selected reasoning effort.", error),
            ),
          );
      }

      const turnId = TurnId.make(NodeCrypto.randomUUID());
      activeTurnId = turnId;
      const content = turnInput.input ?? "";
      yield* bridge
        .trySdk({
          operation: "sendMessage",
          sessionId,
          run: () =>
            client.sendMessage(
              sessionId,
              content,
              images.length === 0 ? undefined : { images: [...images] },
            ),
        })
        .pipe(
          // No retry: the harness owns turn admission, and a second write could
          // start a duplicate turn the user never asked for.
          Effect.mapError((error) => {
            // The turn was never admitted, so it must stop being the active one:
            // otherwise a later transport failure would abort a turn no client
            // was ever told about.
            if (activeTurnId === turnId) activeTurnId = undefined;
            return runtimeError("send", "Jcode did not accept the message for this turn.", error);
          }),
        );

      return {
        threadId,
        turnId,
        resumeCursor: JCODE_RESUME_CURSOR,
      } satisfies ProviderTurnStartResult;
    });

  /**
   * Cancels the active turn.
   *
   * The SDK's `cancel` is session-scoped, so the selector is honored to the only
   * precision available: a request naming a turn that is no longer running is
   * dropped rather than applied to whatever is running now. Without that guard,
   * a Stop pressed for a turn that finished on its own would kill the turn the
   * user started next. An idle session cancels nothing.
   */
  const interruptTurn = (turnId?: TurnId) =>
    Effect.suspend(() => {
      const running = activeTurnId;
      if (running === undefined || (turnId !== undefined && turnId !== running)) {
        return Effect.void;
      }
      return bridge
        .trySdk({ operation: "cancel", sessionId, run: () => client.cancel(sessionId) })
        .pipe(
          Effect.mapError((error) =>
            runtimeError("cancel", "Jcode did not accept the cancellation request.", error),
          ),
          Effect.asVoid,
        );
    });

  const createdAt = yield* nowIso;
  const session: ProviderSession = {
    provider: PROVIDER,
    providerInstanceId,
    status: "ready",
    runtimeMode: input.runtimeMode,
    cwd: input.cwd,
    ...(input.model === undefined ? {} : { model: input.model }),
    threadId,
    resumeCursor: JCODE_RESUME_CURSOR,
    restored: opened.restored,
    createdAt,
    updatedAt: createdAt,
  };

  return {
    session,
    sendTurn,
    interruptTurn,
    close,
    streamEvents: Stream.fromQueue(queue),
  };
});
