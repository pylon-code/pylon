import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  type PrimeAgentDaemonAgentConnection,
  type PrimeAgentDaemonExtensionUiResponse,
  type PrimeAgentDaemonImage,
  type PrimeAgentDaemonServiceTier,
  type PrimeAgentDaemonThinkingLevel,
} from "./PrimeAgentDaemonBridge.ts";
import { decodePrimeAgentDaemonEvent, type PrimeDaemonEvent } from "./PrimeAgentDaemonEvents.ts";
import type { PrimeAgentDaemonManager } from "./PrimeAgentDaemonManager.ts";
import {
  isPrimeAgentCompatibleResumeCursor,
  PRIME_AGENT_DAEMON_RESUME_CURSOR,
  type PrimeAgentDaemonResumeCursor,
} from "./PrimeAgentResumeCursor.ts";

export { PRIME_AGENT_DAEMON_RESUME_CURSOR } from "./PrimeAgentResumeCursor.ts";

const COMMAND_TIMEOUT_MS = 30_000;

const thinkingLevelSchema = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const serviceTierSchema = Schema.NullOr(
  Schema.Literals(["auto", "default", "flex", "scale", "priority"]),
);
const imageSchema = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});
const extensionUiResponseSchema = Schema.Union([
  Schema.Struct({ value: Schema.String }),
  Schema.Struct({ confirmed: Schema.Boolean }),
  Schema.Struct({ cancelled: Schema.Literal(true) }),
]);
const createSuccessSchema = Schema.Struct({
  type: Schema.Literal("response"),
  command: Schema.Literal("create"),
  success: Schema.Literal(true),
  data: Schema.Struct({
    activeSessionId: Schema.String,
  }),
});
const createFailureSchema = Schema.Struct({
  type: Schema.Literal("response"),
  command: Schema.Literal("create"),
  success: Schema.Literal(false),
  error: Schema.String,
});
const modelSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.String,
});
const queueStateSchema = Schema.Struct({
  steering: Schema.Array(Schema.String),
  followUp: Schema.Array(Schema.String),
});

const decodeThinkingLevel = Schema.decodeUnknownOption(thinkingLevelSchema);
const decodeServiceTier = Schema.decodeUnknownOption(serviceTierSchema);
const decodeImage = Schema.decodeUnknownOption(imageSchema);
const decodeExtensionUiResponse = Schema.decodeUnknownOption(extensionUiResponseSchema);
const decodeCreateSuccess = Schema.decodeUnknownOption(createSuccessSchema);
const decodeCreateFailure = Schema.decodeUnknownOption(createFailureSchema);
const decodeModel = Schema.decodeUnknownOption(modelSchema);
const decodeQueueState = Schema.decodeUnknownOption(queueStateSchema);

const runtimeErrorOperation = Schema.Literals([
  "open-client",
  "configure-client",
  "create-session",
  "attach-session",
  "initial-snapshot",
  "prompt",
  "steer",
  "follow-up",
  "abort",
  "abort-and-clear-queue",
  "set-model",
  "set-thinking-level",
  "set-service-tier",
  "extension-ui-response",
  "dispose",
]);
const runtimeErrorReason = Schema.Literals([
  "invalid-input",
  "incompatible-api",
  "request-failed",
  "invalid-response",
  "disposed",
]);

export class PrimeAgentDaemonSessionRuntimeError extends Schema.TaggedErrorClass<PrimeAgentDaemonSessionRuntimeError>()(
  "PrimeAgentDaemonSessionRuntimeError",
  {
    operation: runtimeErrorOperation,
    reason: runtimeErrorReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Prime Agent daemon session failed (${this.operation}/${this.reason}): ${this.detail}`;
  }
}

export interface PrimeAgentDaemonSessionRuntimeInput {
  readonly manager: PrimeAgentDaemonManager;
  readonly cwd: string;
  /** Isolated, deterministic, server-owned directory for this Pylon thread. */
  readonly sessionDir: string;
  readonly agentDir?: string;
  readonly model?: string;
  readonly thinkingLevel?: PrimeAgentDaemonThinkingLevel;
  readonly resumeCursor?: unknown;
}

export interface PrimeAgentDaemonPromptInput {
  readonly text: string;
  readonly images?: ReadonlyArray<PrimeAgentDaemonImage>;
  /** Cancels prompt admission before the daemon accepts ownership of the turn. */
  readonly signal?: AbortSignal;
}

export interface PrimeAgentDaemonSafeModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}

type PrimeAgentDaemonCanonicalSnapshot = Extract<
  PrimeDaemonEvent,
  { readonly _tag: "SessionResynced" }
>;

export interface PrimeAgentDaemonSessionRuntime {
  /** Opaque and safe to persist in ProviderSession.resumeCursor. */
  readonly resumeCursor: PrimeAgentDaemonResumeCursor;
  readonly activeSessionId: string;
  readonly initialSnapshot: PrimeAgentDaemonCanonicalSnapshot;
  readonly events: Stream.Stream<PrimeDaemonEvent, never>;
  readonly prompt: (
    input: PrimeAgentDaemonPromptInput,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly steer: (
    input: PrimeAgentDaemonPromptInput,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly followUp: (
    input: PrimeAgentDaemonPromptInput,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly abort: Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly abortAndClearQueue: Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly setModel: (
    model: string,
  ) => Effect.Effect<PrimeAgentDaemonSafeModel, PrimeAgentDaemonSessionRuntimeError>;
  readonly setThinkingLevel: (
    level: PrimeAgentDaemonThinkingLevel,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly setServiceTier: (
    tier: PrimeAgentDaemonServiceTier,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly respondToExtensionUiRequest: (
    requestId: string,
    response: PrimeAgentDaemonExtensionUiResponse,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly dispose: Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
}

function runtimeError(
  operation: PrimeAgentDaemonSessionRuntimeError["operation"],
  reason: PrimeAgentDaemonSessionRuntimeError["reason"],
  detail: string,
): PrimeAgentDaemonSessionRuntimeError {
  return new PrimeAgentDaemonSessionRuntimeError({ operation, reason, detail });
}

function validateNonEmpty(
  operation: PrimeAgentDaemonSessionRuntimeError["operation"],
  label: string,
  value: string,
): Effect.Effect<string, PrimeAgentDaemonSessionRuntimeError> {
  const normalized = value.trim();
  return normalized.length > 0
    ? Effect.succeed(normalized)
    : Effect.fail(runtimeError(operation, "invalid-input", `${label} must be non-empty.`));
}

function validateImages(
  operation: PrimeAgentDaemonSessionRuntimeError["operation"],
  images: ReadonlyArray<PrimeAgentDaemonImage> | undefined,
): Effect.Effect<ReadonlyArray<PrimeAgentDaemonImage>, PrimeAgentDaemonSessionRuntimeError> {
  const result: PrimeAgentDaemonImage[] = [];
  for (const image of images ?? []) {
    const decoded = decodeImage(image);
    if (
      Option.isNone(decoded) ||
      decoded.value.data.length === 0 ||
      decoded.value.mimeType.trim().length === 0
    ) {
      return Effect.fail(
        runtimeError(operation, "invalid-input", "Each image must contain data and a MIME type."),
      );
    }
    result.push(decoded.value);
  }
  return Effect.succeed(result);
}

function validatePromptContent(
  operation: "prompt" | "steer" | "follow-up",
  text: string,
  images: ReadonlyArray<PrimeAgentDaemonImage>,
): Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError> {
  return text.trim().length > 0 || images.length > 0
    ? Effect.void
    : Effect.fail(
        runtimeError(
          operation,
          "invalid-input",
          "A prompt requires non-empty text or at least one image.",
        ),
      );
}

function safeEvent(event: PrimeDaemonEvent): PrimeDaemonEvent {
  // Extension installation paths are daemon-local diagnostics, never provider events.
  return event._tag === "ExtensionError" ? { ...event, extensionPath: "<redacted>" } : event;
}

function splitModelSelector(
  model: string,
): Effect.Effect<
  { readonly provider: string; readonly modelId: string },
  PrimeAgentDaemonSessionRuntimeError
> {
  const selector = model.trim();
  const separator = selector.indexOf("/");
  if (separator <= 0 || separator === selector.length - 1) {
    return Effect.fail(
      runtimeError("set-model", "invalid-input", "Model must use a provider/model selector."),
    );
  }
  return Effect.succeed({
    provider: selector.slice(0, separator),
    modelId: selector.slice(separator + 1),
  });
}

export const makePrimeAgentDaemonSessionRuntime = Effect.fn("makePrimeAgentDaemonSessionRuntime")(
  function* (
    input: PrimeAgentDaemonSessionRuntimeInput,
  ): Effect.fn.Return<
    PrimeAgentDaemonSessionRuntime,
    PrimeAgentDaemonSessionRuntimeError,
    Scope.Scope
  > {
    const cwd = yield* validateNonEmpty("create-session", "cwd", input.cwd);
    const sessionDir = yield* validateNonEmpty("create-session", "sessionDir", input.sessionDir);
    const shouldContinue = input.resumeCursor !== undefined;
    if (shouldContinue && !isPrimeAgentCompatibleResumeCursor(input.resumeCursor)) {
      return yield* runtimeError(
        "create-session",
        "invalid-input",
        "The Prime Agent resume cursor is invalid or unsupported.",
      );
    }
    if (
      input.thinkingLevel !== undefined &&
      Option.isNone(decodeThinkingLevel(input.thinkingLevel))
    ) {
      return yield* runtimeError(
        "create-session",
        "invalid-input",
        "The Prime Agent thinking level is invalid.",
      );
    }

    const client = yield* input.manager
      .openClient()
      .pipe(
        Effect.mapError(() =>
          runtimeError("open-client", "request-failed", "Could not open the shared daemon client."),
        ),
      );
    let connection: PrimeAgentDaemonAgentConnection | undefined;
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    let disposeStarted = false;

    const closeClient = Effect.sync(() => {
      client.close();
    });

    if (!Predicate.isFunction(client.enableAutoReconnect)) {
      client.close();
      return yield* runtimeError(
        "configure-client",
        "incompatible-api",
        "The installed daemon client does not support automatic reconnect.",
      );
    }
    yield* Effect.try({
      try: () => {
        client.enableRequestRecovery?.();
        client.enableAutoReconnect!({ recoverDaemon: input.manager.recover });
      },
      catch: () =>
        runtimeError(
          "configure-client",
          "request-failed",
          "Could not enable daemon client reconnect.",
        ),
    }).pipe(Effect.onError(() => closeClient));

    const configuredModel = input.model?.trim();
    const configuredAgentDir = input.agentDir?.trim();
    const createResponse = yield* Effect.tryPromise({
      try: () =>
        client.request(
          {
            type: "create",
            lifecycle: "client_owned",
            continueRecent: shouldContinue,
            config: {
              cwd,
              sessionDir,
              noBuiltinTools: false,
              noExtensions: false,
              noSkills: false,
              noContextFiles: false,
              ...(configuredAgentDir ? { agentDir: configuredAgentDir } : {}),
              ...(configuredModel && configuredModel !== "default"
                ? { model: configuredModel }
                : {}),
              ...(input.thinkingLevel === undefined ? {} : { thinking: input.thinkingLevel }),
            },
          },
          COMMAND_TIMEOUT_MS,
        ),
      catch: () =>
        runtimeError(
          "create-session",
          "request-failed",
          "The daemon did not complete the create command.",
        ),
    }).pipe(Effect.onError(() => closeClient));
    const created = decodeCreateSuccess(createResponse);
    if (Option.isNone(created)) {
      client.close();
      return yield* runtimeError(
        "create-session",
        Option.isSome(decodeCreateFailure(createResponse)) ? "request-failed" : "invalid-response",
        Option.isSome(decodeCreateFailure(createResponse))
          ? "The daemon rejected the create command."
          : "The daemon returned an invalid create response.",
      );
    }
    const activeSessionId = created.value.data.activeSessionId.trim();
    if (activeSessionId.length === 0) {
      client.close();
      return yield* runtimeError(
        "create-session",
        "invalid-response",
        "The daemon create response omitted its active session identifier.",
      );
    }

    const completeUnattachedOwnedSession = Effect.tryPromise({
      try: () =>
        client.request({ type: "complete_owned_session", activeSessionId }, COMMAND_TIMEOUT_MS),
      catch: () => undefined,
    }).pipe(Effect.ignore, Effect.ensuring(closeClient));

    connection = yield* Effect.tryPromise({
      try: () =>
        input.manager.bridge.DaemonAgentConnection.attach(client, activeSessionId, {
          closeClientOnDispose: false,
          supportsExtensionUi: true,
          ownedSession: true,
          recoverDaemon: input.manager.recover,
        }),
      catch: () =>
        runtimeError(
          "attach-session",
          "request-failed",
          "Could not attach to the created daemon session.",
        ),
    }).pipe(Effect.onError(() => completeUnattachedOwnedSession));

    const eventQueue = yield* Queue.unbounded<PrimeDaemonEvent>();
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    let initializing = true;
    const bufferedEvents: unknown[] = [];
    let lastSnapshotSequence: number | undefined;

    const offerDecoded = (raw: unknown) => {
      const event = safeEvent(decodePrimeAgentDaemonEvent(raw));
      if (event._tag === "SessionResynced" && event.lastEventSequence !== undefined) {
        if (lastSnapshotSequence !== undefined && event.lastEventSequence <= lastSnapshotSequence) {
          return Effect.void;
        }
        lastSnapshotSequence = event.lastEventSequence;
      }
      return Queue.offer(eventQueue, event).pipe(Effect.asVoid);
    };

    // DaemonAgentConnection serializes its normalized listener callbacks. Returning
    // the Promise preserves their order after initialization.
    unsubscribe = connection.subscribe((event) => {
      if (initializing) {
        bufferedEvents.push(event);
        return;
      }
      return runPromise(offerDecoded(event));
    });

    const rawSnapshot = yield* Effect.tryPromise({
      try: () => connection!.getInitialSnapshot(),
      catch: () =>
        runtimeError(
          "initial-snapshot",
          "request-failed",
          "Could not read the daemon session snapshot.",
        ),
    }).pipe(
      Effect.onError(() =>
        Effect.promise(async () => {
          unsubscribe?.();
          await connection?.dispose().catch(() => undefined);
          client.close();
        }),
      ),
    );
    const initialEvent = safeEvent(
      decodePrimeAgentDaemonEvent({ type: "session_resynced", snapshot: rawSnapshot }),
    );
    if (initialEvent._tag !== "SessionResynced") {
      unsubscribe();
      yield* Effect.promise(() => connection!.dispose().catch(() => undefined));
      client.close();
      return yield* runtimeError(
        "initial-snapshot",
        "invalid-response",
        "The daemon returned an invalid initial snapshot.",
      );
    }
    lastSnapshotSequence = initialEvent.lastEventSequence;
    yield* Queue.offer(eventQueue, initialEvent);
    while (bufferedEvents.length > 0) {
      const batch = bufferedEvents.splice(0);
      for (const bufferedEvent of batch) {
        yield* offerDecoded(bufferedEvent);
      }
    }
    // No callback can interleave between the final empty check and this assignment.
    initializing = false;

    const ensureOpen = (
      operation: PrimeAgentDaemonSessionRuntimeError["operation"],
    ): Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError> =>
      disposed || disposeStarted
        ? Effect.fail(runtimeError(operation, "disposed", "The daemon session is disposed."))
        : Effect.void;

    const callVoid = (
      operation: PrimeAgentDaemonSessionRuntimeError["operation"],
      call: () => Promise<unknown>,
    ) =>
      ensureOpen(operation).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: call,
            catch: () => runtimeError(operation, "request-failed", "The daemon operation failed."),
          }),
        ),
        Effect.flatMap((output) =>
          output === undefined
            ? Effect.void
            : Effect.fail(
                runtimeError(
                  operation,
                  "invalid-response",
                  "The daemon operation returned an invalid response.",
                ),
              ),
        ),
      );

    const requireMethod = <T extends (...args: never[]) => Promise<unknown>>(
      operation: PrimeAgentDaemonSessionRuntimeError["operation"],
      method: T | undefined,
    ): Effect.Effect<T, PrimeAgentDaemonSessionRuntimeError> =>
      Predicate.isFunction(method)
        ? Effect.succeed(method)
        : Effect.fail(
            runtimeError(
              operation,
              "incompatible-api",
              "The installed Prime Agent connection does not support this operation.",
            ),
          );

    const prompt = Effect.fn("PrimeAgentDaemonSessionRuntime.prompt")(function* (
      promptInput: PrimeAgentDaemonPromptInput,
    ) {
      yield* ensureOpen("prompt");
      const images = yield* validateImages("prompt", promptInput.images);
      yield* validatePromptContent("prompt", promptInput.text, images);
      yield* callVoid("prompt", () =>
        connection!.promptAndWait(promptInput.text, {
          queueIfBusy: false,
          ...(images.length === 0 ? {} : { images }),
          ...(promptInput.signal === undefined ? {} : { signal: promptInput.signal }),
        }),
      );
    });

    const steer = Effect.fn("PrimeAgentDaemonSessionRuntime.steer")(function* (
      promptInput: PrimeAgentDaemonPromptInput,
    ) {
      yield* ensureOpen("steer");
      const images = yield* validateImages("steer", promptInput.images);
      yield* validatePromptContent("steer", promptInput.text, images);
      const method = yield* requireMethod("steer", connection!.steer);
      yield* callVoid("steer", () => method.call(connection, promptInput.text, images));
    });

    const followUp = Effect.fn("PrimeAgentDaemonSessionRuntime.followUp")(function* (
      promptInput: PrimeAgentDaemonPromptInput,
    ) {
      yield* ensureOpen("follow-up");
      const images = yield* validateImages("follow-up", promptInput.images);
      yield* validatePromptContent("follow-up", promptInput.text, images);
      const method = yield* requireMethod("follow-up", connection!.followUp);
      yield* callVoid("follow-up", () => method.call(connection, promptInput.text, images));
    });

    const abort = Effect.gen(function* () {
      yield* ensureOpen("abort");
      yield* callVoid("abort", () => connection!.abort());
    });

    const abortAndClearQueue = Effect.gen(function* () {
      yield* ensureOpen("abort-and-clear-queue");
      const method = yield* requireMethod("abort-and-clear-queue", connection!.abortAndClearQueue);
      const output = yield* Effect.tryPromise({
        try: () => method.call(connection),
        catch: () =>
          runtimeError(
            "abort-and-clear-queue",
            "request-failed",
            "The daemon abort-and-clear operation failed.",
          ),
      });
      if (Option.isNone(decodeQueueState(output))) {
        return yield* runtimeError(
          "abort-and-clear-queue",
          "invalid-response",
          "The daemon abort-and-clear operation returned an invalid response.",
        );
      }
    });

    const setModel = Effect.fn("PrimeAgentDaemonSessionRuntime.setModel")(function* (
      selector: string,
    ) {
      yield* ensureOpen("set-model");
      const selected = yield* splitModelSelector(selector);
      const method = yield* requireMethod("set-model", connection!.setModel);
      const output = yield* Effect.tryPromise({
        try: () => method.call(connection, selected.provider, selected.modelId),
        catch: () => runtimeError("set-model", "request-failed", "The daemon model switch failed."),
      });
      const decoded = decodeModel(output);
      if (Option.isNone(decoded)) {
        return yield* runtimeError(
          "set-model",
          "invalid-response",
          "The daemon returned an invalid model response.",
        );
      }
      return {
        id: decoded.value.id,
        name: decoded.value.name,
        provider: decoded.value.provider,
      } satisfies PrimeAgentDaemonSafeModel;
    });

    const setThinkingLevel = Effect.fn("PrimeAgentDaemonSessionRuntime.setThinkingLevel")(
      function* (level: PrimeAgentDaemonThinkingLevel) {
        yield* ensureOpen("set-thinking-level");
        if (Option.isNone(decodeThinkingLevel(level))) {
          return yield* runtimeError(
            "set-thinking-level",
            "invalid-input",
            "The Prime Agent thinking level is invalid.",
          );
        }
        const method = yield* requireMethod("set-thinking-level", connection!.setThinkingLevel);
        yield* callVoid("set-thinking-level", () => method.call(connection, level));
      },
    );

    const setServiceTier = Effect.fn("PrimeAgentDaemonSessionRuntime.setServiceTier")(function* (
      tier: PrimeAgentDaemonServiceTier,
    ) {
      yield* ensureOpen("set-service-tier");
      if (Option.isNone(decodeServiceTier(tier))) {
        return yield* runtimeError(
          "set-service-tier",
          "invalid-input",
          "The Prime Agent service tier is invalid.",
        );
      }
      const method = yield* requireMethod("set-service-tier", connection!.setServiceTier);
      yield* callVoid("set-service-tier", () => method.call(connection, tier));
    });

    const respondToExtensionUiRequest = Effect.fn(
      "PrimeAgentDaemonSessionRuntime.respondToExtensionUiRequest",
    )(function* (requestId: string, response: PrimeAgentDaemonExtensionUiResponse) {
      yield* ensureOpen("extension-ui-response");
      const normalizedRequestId = yield* validateNonEmpty(
        "extension-ui-response",
        "requestId",
        requestId,
      );
      if (Option.isNone(decodeExtensionUiResponse(response))) {
        return yield* runtimeError(
          "extension-ui-response",
          "invalid-input",
          "The extension UI response is invalid.",
        );
      }
      const method = yield* requireMethod(
        "extension-ui-response",
        connection!.respondToExtensionUiRequest,
      );
      yield* callVoid("extension-ui-response", () =>
        method.call(connection, normalizedRequestId, response),
      );
    });

    const dispose = Effect.suspend(() => {
      if (disposed || disposeStarted) return Effect.void;
      disposeStarted = true;
      unsubscribe?.();
      return Effect.tryPromise({
        try: () => connection!.dispose(),
        catch: () =>
          runtimeError("dispose", "request-failed", "Could not dispose the daemon session."),
      }).pipe(
        Effect.flatMap((output) =>
          output === undefined
            ? Effect.void
            : Effect.fail(
                runtimeError(
                  "dispose",
                  "invalid-response",
                  "The daemon dispose operation returned an invalid response.",
                ),
              ),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            disposed = true;
            client.close();
            yield* Queue.shutdown(eventQueue);
          }),
        ),
      );
    });

    yield* Effect.addFinalizer(() => dispose.pipe(Effect.ignore));

    return {
      resumeCursor: PRIME_AGENT_DAEMON_RESUME_CURSOR,
      activeSessionId,
      initialSnapshot: initialEvent,
      events: Stream.fromQueue(eventQueue),
      prompt,
      steer,
      followUp,
      abort,
      abortAndClearQueue,
      setModel,
      setThinkingLevel,
      setServiceTier,
      respondToExtensionUiRequest,
      dispose,
    } satisfies PrimeAgentDaemonSessionRuntime;
  },
);
