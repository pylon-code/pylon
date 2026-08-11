// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  EventId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeSessionStateChangedEvent,
  type ProviderRuntimeTurnStartedEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterUnsupportedOperationError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { JcodeInstanceManager } from "../jcode/JcodeInstanceManager.ts";
import type { JcodeSdkBridge } from "../jcode/JcodeSdkBridge.ts";
import {
  makeJcodeSessionRuntime,
  type JcodeSessionRuntime,
  type JcodeSessionRuntimeError,
} from "../jcode/JcodeSessionRuntime.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("jcode");

/** The only execution mode Jcode SDK v1 can honor. */
const SUPPORTED_RUNTIME_MODE = "full-access";

export type JcodeAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

export interface JcodeAdapterOptions {
  readonly providerInstanceId: ProviderInstanceId;
  /** Opaque per-instance key used for this instance's private state paths. */
  readonly instanceKey: string;
  /**
   * The provider instance's own bridge. Never the module singleton: it retains
   * launch credential literals for its whole life.
   */
  readonly bridge: JcodeSdkBridge;
  /**
   * Absent when the private Jcode instance could not be started, so the
   * provider still appears with an honest error status instead of vanishing.
   */
  readonly manager: JcodeInstanceManager | undefined;
}

interface JcodeSessionContext {
  session: ProviderSession;
  readonly runtime: JcodeSessionRuntime;
  /** Child of the adapter scope; closing it runs the runtime's finalizer. */
  readonly scope: Scope.Closeable;
  /**
   * Serializes turn admission against event forwarding, so no runtime event for
   * a turn can be published before the adapter's own `turn.started`.
   */
  readonly gate: Semaphore.Semaphore;
  stopped: boolean;
}

/** Terminal turn events after which the session is idle again. */
function releasesTurn(event: ProviderRuntimeEvent): boolean {
  return event.type === "turn.completed" || event.type === "turn.aborted";
}

/**
 * Collapses a session-runtime failure into the provider-neutral adapter error
 * union. The runtime already stripped native identifiers from its detail, so
 * repeating it is safe.
 */
function toAdapterError(threadId: ThreadId, error: JcodeSessionRuntimeError): ProviderAdapterError {
  switch (error.operation) {
    case "attachments":
      return new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: error.detail,
      });
    case "create":
    case "resume":
    case "stream":
    case "close":
      return new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: error.detail,
      });
    case "model":
    case "reasoning":
    case "send":
    case "cancel":
      return new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: error.operation,
        detail: error.detail,
      });
  }
}

export const makeJcodeAdapter = Effect.fn("makeJcodeAdapter")(function* (
  options: JcodeAdapterOptions,
): Effect.fn.Return<
  JcodeAdapterShape,
  never,
  FileSystem.FileSystem | Path.Path | ServerConfig | Scope.Scope
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const adapterScope = yield* Effect.scope;

  const sessions = new Map<ThreadId, JcodeSessionContext>();
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // A per-adapter UUID prefix, matching the runtime it wraps: a counter alone
  // would re-issue the same ids after a restart.
  const stampPrefix = `jcode-adapter-${NodeCrypto.randomUUID()}`;
  let stampSequence = 0;
  const nextEventId = () => EventId.make(`${stampPrefix}-${++stampSequence}`);

  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

  const requireSession = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const context = sessions.get(threadId);
      return context === undefined || context.stopped
        ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
        : Effect.succeed(context);
    });

  /**
   * Bookkeeping half of teardown. Runs the moment a session is known dead so the
   * thread is immediately free to start again, rather than waiting for the
   * session reaper or a restart.
   */
  const retireSession = (threadId: ThreadId, context: JcodeSessionContext) =>
    Effect.gen(function* () {
      if (context.stopped) return false;
      context.stopped = true;
      sessions.delete(threadId);
      context.session = {
        ...context.session,
        status: "closed",
        activeTurnId: undefined,
        updatedAt: yield* nowIso,
      };
      return true;
    });

  /**
   * Scope close is the single teardown path: the runtime registered its
   * idempotent `close` as a finalizer, so calling it here too would
   * double-manage the child client's lifetime.
   */
  const closeSessionScope = (context: JcodeSessionContext) => Scope.close(context.scope, Exit.void);

  /**
   * Every runtime event passes through here before reaching subscribers.
   *
   * The runtime mints turn ids and maps frames, but it cannot reach the
   * adapter-owned `ProviderSession`, so acting on the terminal events it reports
   * is the adapter's half of that ownership split.
   */
  const forwardEvent = (
    threadId: ThreadId,
    context: JcodeSessionContext,
    event: ProviderRuntimeEvent,
  ) =>
    Effect.gen(function* () {
      if (
        releasesTurn(event) &&
        event.turnId !== undefined &&
        context.session.activeTurnId === event.turnId
      ) {
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
        };
      }
      if (event.type === "session.exited") {
        const retired = yield* retireSession(threadId, context);
        // Closing the scope from this fiber would interrupt this fiber, which is
        // itself scope-owned, so hand the close to the adapter scope. Both
        // `Scope.close` and the runtime's `close` are idempotent.
        if (retired) yield* closeSessionScope(context).pipe(Effect.forkIn(adapterScope));
      }
      yield* publish(event);
    });

  const startSession: JcodeAdapterShape["startSession"] = (input: ProviderSessionStartInput) =>
    Effect.gen(function* () {
      // Defensive: `ProviderService` also rejects unsupported modes, but the
      // adapter must never open a session it cannot execute honestly.
      if (input.runtimeMode !== SUPPORTED_RUNTIME_MODE) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Jcode sessions run only in ${SUPPORTED_RUNTIME_MODE} mode; '${input.runtimeMode}' is not available.`,
        });
      }
      const cwd = input.cwd;
      if (cwd === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Jcode sessions require a working directory.",
        });
      }
      if (sessions.has(input.threadId)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Thread '${input.threadId}' already has an active Jcode session.`,
        });
      }
      const manager = options.manager;
      if (manager === undefined) {
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: "The private Jcode instance is unavailable for this provider instance.",
        });
      }

      const model =
        input.modelSelection?.instanceId === options.providerInstanceId
          ? input.modelSelection.model
          : undefined;

      const sessionScope = yield* Scope.fork(adapterScope);
      return yield* Effect.gen(function* () {
        const client = yield* manager.connectSessionClient.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.detail,
              }),
          ),
        );
        yield* Scope.addFinalizer(sessionScope, manager.releaseSessionClient(client));
        const runtime = yield* makeJcodeSessionRuntime({
          bridge: options.bridge,
          client,
          providerInstanceId: options.providerInstanceId,
          instanceId: options.instanceKey,
          threadId: input.threadId,
          stateDir: serverConfig.stateDir,
          cwd,
          runtimeMode: input.runtimeMode,
          ...(model === undefined ? {} : { model }),
          ...(input.resumeCursor === undefined ? {} : { resumeCursor: input.resumeCursor }),
        }).pipe(
          Effect.mapError((cause) => toAdapterError(input.threadId, cause)),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ServerConfig, serverConfig),
          Effect.provideService(Scope.Scope, sessionScope),
        );

        const context: JcodeSessionContext = {
          session: runtime.session,
          runtime,
          scope: sessionScope,
          gate: Semaphore.makeUnsafe(1),
          stopped: false,
        };
        sessions.set(input.threadId, context);

        // Republish this session's canonical events on the adapter stream. The
        // runtime ends its own stream when the session closes, so this fiber
        // completes on its own rather than needing separate cancellation.
        yield* Stream.runForEach(runtime.streamEvents, (event) =>
          context.gate.withPermit(forwardEvent(input.threadId, context, event)),
        ).pipe(Effect.forkIn(sessionScope, { startImmediately: true }));

        const ready: ProviderRuntimeSessionStateChangedEvent = {
          eventId: nextEventId(),
          type: "session.state.changed",
          provider: PROVIDER,
          providerInstanceId: options.providerInstanceId,
          threadId: input.threadId,
          createdAt: yield* nowIso,
          payload: { state: "ready", reason: "The Jcode session is ready." },
        };
        yield* publish(ready);

        return context.session;
      }).pipe(
        Effect.onError(() => Scope.close(sessionScope, Exit.void)),
        Effect.uninterruptible,
      );
    });

  const sendTurn: JcodeAdapterShape["sendTurn"] = (input: ProviderSendTurnInput) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      // Holding the gate across admission makes the ordering structural: the
      // forwarding fiber cannot publish any event for this turn until
      // `turn.started` has been published.
      return yield* context.gate.withPermit(
        Effect.gen(function* () {
          if (context.session.activeTurnId !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Jcode does not accept a second turn while one is already running.",
            });
          }

          const selected =
            input.modelSelection?.instanceId === options.providerInstanceId
              ? input.modelSelection.model
              : undefined;

          const started: ProviderTurnStartResult = yield* context.runtime
            .sendTurn(input)
            .pipe(Effect.mapError((cause) => toAdapterError(input.threadId, cause)));

          // The runtime deliberately never mutates session status or announces
          // the turn; both belong to the adapter. An in-session switch is
          // authoritative from here on, and an unknown model stays absent rather
          // than being fabricated.
          const model = selected ?? context.session.model;
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: started.turnId,
            ...(model === undefined ? {} : { model }),
            updatedAt: yield* nowIso,
          };
          const turnStarted: ProviderRuntimeTurnStartedEvent = {
            eventId: nextEventId(),
            type: "turn.started",
            provider: PROVIDER,
            providerInstanceId: options.providerInstanceId,
            threadId: input.threadId,
            turnId: started.turnId,
            createdAt: yield* nowIso,
            payload: model === undefined ? {} : { model },
          };
          yield* publish(turnStarted);

          return started;
        }),
      );
    }).pipe(Effect.uninterruptible);

  const interruptTurn: JcodeAdapterShape["interruptTurn"] = (threadId: ThreadId, turnId?: TurnId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      yield* context.runtime
        .interruptTurn(turnId)
        .pipe(Effect.mapError((cause) => toAdapterError(threadId, cause)));
    });

  const closeSession = (threadId: ThreadId, context: JcodeSessionContext) =>
    Effect.gen(function* () {
      yield* retireSession(threadId, context);
      yield* closeSessionScope(context);
    }).pipe(Effect.uninterruptible);

  const stopSession: JcodeAdapterShape["stopSession"] = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      yield* closeSession(threadId, context);
    });

  const stopAll: JcodeAdapterShape["stopAll"] = () =>
    Effect.suspend(() =>
      Effect.forEach(
        Array.from(sessions.entries()),
        ([threadId, context]) => closeSession(threadId, context),
        { discard: true },
      ),
    );

  const listSessions: JcodeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (context) => ({ ...context.session })));

  const hasSession: JcodeAdapterShape["hasSession"] = (threadId: ThreadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  /**
   * Jcode history is not projected into Pylon (see the `history` feature
   * capability), so an active session reports no provider-owned turns. Pylon's
   * own event-sourced history remains authoritative.
   */
  const readThread: JcodeAdapterShape["readThread"] = (threadId: ThreadId) =>
    Effect.map(requireSession(threadId), () => ({ threadId, turns: [] }));

  const rollbackThread: JcodeAdapterShape["rollbackThread"] = (threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      return yield* new ProviderAdapterUnsupportedOperationError({
        provider: PROVIDER,
        operation: "rollbackThread",
      });
    });

  const respondToRequest: JcodeAdapterShape["respondToRequest"] = () =>
    Effect.fail(
      new ProviderAdapterUnsupportedOperationError({
        provider: PROVIDER,
        operation: "respondToRequest",
      }),
    );

  const respondToUserInput: JcodeAdapterShape["respondToUserInput"] = () =>
    Effect.fail(
      new ProviderAdapterUnsupportedOperationError({
        provider: PROVIDER,
        operation: "respondToUserInput",
      }),
    );

  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to stop Jcode sessions during adapter teardown.", { cause }),
      ),
      Effect.andThen(PubSub.shutdown(runtimeEventPubSub)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", conversationRollback: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    readThread,
    rollbackThread,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  } satisfies JcodeAdapterShape;
});
