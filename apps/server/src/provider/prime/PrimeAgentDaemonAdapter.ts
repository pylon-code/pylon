import {
  EventId,
  type PrimeAgentSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  SessionInteractionRequest,
  SessionInteractionRequestId,
  SessionInteractionResponse,
  SessionPresentation,
  type ProviderTurnStartResult,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { resolveProviderHomePath } from "../../pathExpansion.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { PrimeAgentAdapterShape } from "../Services/PrimeAgentAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import { primeAgentSessionDirectory } from "../Layers/PrimeAgentAdapter.ts";
import type { PrimeDaemonEvent } from "./PrimeAgentDaemonEvents.ts";
import type { PrimeAgentDaemonManager } from "./PrimeAgentDaemonManager.ts";
import { mapPrimeAgentDaemonRuntimeEventDrafts } from "./PrimeAgentDaemonRuntimeEvents.ts";
import {
  makePrimeAgentDaemonSessionRuntime,
  type PrimeAgentDaemonSessionRuntime,
  type PrimeAgentDaemonSessionRuntimeError,
  type PrimeAgentDaemonSessionRuntimeInput,
} from "./PrimeAgentDaemonSessionRuntime.ts";

const PROVIDER = ProviderDriverKind.make("primeAgent");

export interface PrimeAgentDaemonAdapterLiveOptions {
  /** Kept at the provider boundary because the manager is normally built from this environment. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly runtimeFactory?: (
    input: PrimeAgentDaemonSessionRuntimeInput,
  ) => Effect.Effect<
    PrimeAgentDaemonSessionRuntime,
    PrimeAgentDaemonSessionRuntimeError,
    Scope.Scope
  >;
}

interface PrimeAgentDaemonActiveTurn {
  readonly id: TurnId;
  readonly controller: AbortController;
  readonly completed: Deferred.Deferred<void>;
  cancellationRequested: boolean;
  assistantTextStreamed: boolean;
}

type PrimeAgentDaemonBlockingInteractionMethod = "select" | "confirm" | "input" | "editor";

interface PrimeAgentDaemonPendingInteraction {
  readonly nativeId: string;
  readonly method: PrimeAgentDaemonBlockingInteractionMethod;
  readonly selectOptions: ReadonlySet<string> | undefined;
}

type PrimeAgentDaemonExtensionProjection =
  | {
      readonly _tag: "Blocking";
      readonly method: PrimeAgentDaemonBlockingInteractionMethod;
      readonly request: SessionInteractionRequest;
    }
  | { readonly _tag: "Presentation"; readonly presentation: SessionPresentation };

const decodeSessionInteractionRequest = Schema.decodeUnknownOption(SessionInteractionRequest);
const decodeSessionInteractionResponse = Schema.decodeUnknownOption(SessionInteractionResponse);
const decodeSessionPresentation = Schema.decodeUnknownOption(SessionPresentation);

function projectExtensionRequest(
  request: Extract<PrimeDaemonEvent, { readonly _tag: "ExtensionRequest" }>["request"],
): Option.Option<PrimeAgentDaemonExtensionProjection> {
  switch (request.method) {
    case "select": {
      const decoded = decodeSessionInteractionRequest({
        kind: "select",
        title: request.title,
        options: request.options,
        ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
      });
      return Option.map(decoded, (value) => ({
        _tag: "Blocking",
        method: "select",
        request: value,
      }));
    }
    case "confirm": {
      const decoded = decodeSessionInteractionRequest({
        kind: "confirm",
        title: request.title,
        ...(request.message === undefined ? {} : { message: request.message }),
        ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
      });
      return Option.map(decoded, (value) => ({
        _tag: "Blocking",
        method: "confirm",
        request: value,
      }));
    }
    case "input": {
      const decoded = decodeSessionInteractionRequest({
        kind: "input",
        title: request.title,
        ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
        ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
      });
      return Option.map(decoded, (value) => ({
        _tag: "Blocking",
        method: "input",
        request: value,
      }));
    }
    case "editor": {
      const decoded = decodeSessionInteractionRequest({
        kind: "editor",
        title: request.title,
        ...(request.prefill === undefined ? {} : { prefill: request.prefill }),
        ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
      });
      return Option.map(decoded, (value) => ({
        _tag: "Blocking",
        method: "editor",
        request: value,
      }));
    }
    case "notify":
      return Option.map(
        decodeSessionPresentation({
          kind: "notification",
          message: request.message,
          level: request.notifyType ?? "info",
        }),
        (presentation) => ({ _tag: "Presentation", presentation }),
      );
    case "setStatus":
      return Option.map(
        decodeSessionPresentation({
          kind: "status",
          key: request.statusKey,
          ...(request.statusText === undefined ? {} : { text: request.statusText }),
        }),
        (presentation) => ({ _tag: "Presentation", presentation }),
      );
    case "setWidget":
      return Option.map(
        decodeSessionPresentation({
          kind: "widget",
          key: request.widgetKey,
          ...(request.widgetLines === undefined ? {} : { lines: request.widgetLines }),
          ...(request.widgetPlacement === undefined ? {} : { placement: request.widgetPlacement }),
        }),
        (presentation) => ({ _tag: "Presentation", presentation }),
      );
    default:
      return Option.none();
  }
}

interface PrimeAgentDaemonSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly runtime: PrimeAgentDaemonSessionRuntime;
  eventFiber: Fiber.Fiber<void, never> | undefined;
  readonly turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }>;
  readonly pendingInteractions: Map<
    SessionInteractionRequestId,
    PrimeAgentDaemonPendingInteraction
  >;
  activeTurn: PrimeAgentDaemonActiveTurn | undefined;
  stopRequested: boolean;
  stopped: boolean;
  exitEmitted: boolean;
}

type TurnOutcome =
  | {
      readonly state: "completed";
      readonly event: Extract<PrimeDaemonEvent, { readonly _tag: "RunCompleted" }>;
    }
  | { readonly state: "failed"; readonly errorMessage: string }
  | { readonly state: "cancelled" };

function runtimeOperationError(
  threadId: ThreadId,
  method: string,
  error: PrimeAgentDaemonSessionRuntimeError,
): ProviderAdapterError {
  return error.reason === "invalid-input"
    ? new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: method,
        issue: error.detail,
        cause: error,
      })
    : new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: error.detail,
        cause: error,
      });
}

function runtimeStartError(
  threadId: ThreadId,
  error: PrimeAgentDaemonSessionRuntimeError,
): ProviderAdapterError {
  return error.reason === "invalid-input"
    ? new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: error.detail,
        cause: error,
      })
    : new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: error.detail,
        cause: error,
      });
}

export function makePrimeAgentDaemonAdapter(
  primeAgentSettings: PrimeAgentSettings,
  manager: PrimeAgentDaemonManager,
  options?: PrimeAgentDaemonAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("primeAgent");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const runtimeFactory = options?.runtimeFactory ?? makePrimeAgentDaemonSessionRuntime;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    // The already-created manager owns its launch environment. Retaining this option keeps the
    // daemon adapter's construction boundary compatible with the other Prime adapter.
    void options?.environment;

    const sessions = new Map<ThreadId, PrimeAgentDaemonSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Prime Agent runtime identifier.",
            cause,
          }),
      ),
    );
    const makeEventStamp = () =>
      Effect.all({ eventId: Effect.map(randomUUIDv4, EventId.make), createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });
    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNativeKind = (threadId: ThreadId, event: PrimeDaemonEvent) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              kind: "notification",
              provider: PROVIDER,
              threadId,
              method: event._tag,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write Prime Agent daemon event log.", {
            cause,
            threadId,
            eventType: event._tag,
          }),
        ),
      );

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PrimeAgentDaemonSessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context === undefined || context.stopped || context.stopRequested
        ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
        : Effect.succeed(context);
    };

    const publishDrafts = (
      context: PrimeAgentDaemonSessionContext,
      event: PrimeDaemonEvent,
      turn: PrimeAgentDaemonActiveTurn | undefined,
    ) =>
      Effect.gen(function* () {
        if (
          turn !== undefined &&
          event._tag === "MessageStarted" &&
          event.message.role === "assistant"
        ) {
          turn.assistantTextStreamed = false;
        }
        const drafts = mapPrimeAgentDaemonRuntimeEventDrafts({
          event,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(turn === undefined ? {} : { turnId: turn.id }),
          ...(turn === undefined ? {} : { assistantTextStreamed: turn.assistantTextStreamed }),
        });
        for (const draft of drafts) {
          yield* offerRuntimeEvent({ ...draft, ...(yield* makeEventStamp()) });
        }
        if (
          turn !== undefined &&
          event._tag === "AssistantStream" &&
          event.kind === "text" &&
          event.phase === "delta" &&
          event.delta !== undefined
        ) {
          turn.assistantTextStreamed = true;
        }
      });

    /** Must be called with the thread lock held. */
    const settleActiveTurnLocked = (
      context: PrimeAgentDaemonSessionContext,
      turn: PrimeAgentDaemonActiveTurn,
      outcome: TurnOutcome,
    ) =>
      Effect.gen(function* () {
        if (
          sessions.get(context.threadId) !== context ||
          context.stopped ||
          context.activeTurn !== turn ||
          context.session.activeTurnId !== turn.id
        ) {
          return false;
        }

        const effectiveOutcome: TurnOutcome =
          context.stopRequested || turn.cancellationRequested ? { state: "cancelled" } : outcome;
        if (effectiveOutcome.state === "completed") {
          yield* publishDrafts(context, effectiveOutcome.event, turn);
          context.turns.push({ id: turn.id, items: [effectiveOutcome.event] });
        } else {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId: turn.id,
            payload:
              effectiveOutcome.state === "cancelled"
                ? { state: "cancelled", stopReason: "aborted" }
                : { state: "failed", errorMessage: effectiveOutcome.errorMessage },
          });
        }

        const { activeTurnId: _activeTurnId, ...readySession } = context.session;
        context.activeTurn = undefined;
        context.session = {
          ...readySession,
          status: "ready",
          updatedAt: yield* nowIso,
        };
        yield* Deferred.succeed(turn.completed, undefined).pipe(Effect.ignore);
        return true;
      });

    const settleActiveTurn = (
      context: PrimeAgentDaemonSessionContext,
      turn: PrimeAgentDaemonActiveTurn,
      outcome: TurnOutcome,
    ) =>
      Effect.uninterruptible(
        withThreadLock(context.threadId, settleActiveTurnLocked(context, turn, outcome)),
      );

    /** Must be called with the thread lock held. */
    const clearPendingInteractionsLocked = (
      context: PrimeAgentDaemonSessionContext,
      cancelNative: boolean,
    ) =>
      Effect.gen(function* () {
        for (const [requestId, pending] of context.pendingInteractions) {
          if (cancelNative) {
            yield* context.runtime
              .respondToExtensionUiRequest(pending.nativeId, { cancelled: true })
              .pipe(Effect.ignore);
          }
          if (!context.pendingInteractions.delete(requestId)) continue;
          yield* offerRuntimeEvent({
            type: "interaction.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurn === undefined ? {} : { turnId: context.activeTurn.id }),
            requestId,
            payload: { response: { kind: "cancelled" } },
          });
        }
      });

    const consumeEvent = (context: PrimeAgentDaemonSessionContext, event: PrimeDaemonEvent) =>
      Effect.gen(function* () {
        yield* logNativeKind(context.threadId, event);
        if (event._tag === "SessionResynced" || event._tag === "SessionReplaced") return;

        if (event._tag === "ExtensionRequest") {
          const projection = projectExtensionRequest(event.request);
          const isBlocking =
            event.request.method === "select" ||
            event.request.method === "confirm" ||
            event.request.method === "input" ||
            event.request.method === "editor";
          const validNativeId = event.request.id.trim().length > 0;

          if (
            Option.isNone(projection) ||
            (projection.value._tag === "Blocking" && !validNativeId)
          ) {
            if (isBlocking) {
              const responseExit = yield* context.runtime
                .respondToExtensionUiRequest(event.request.id, { cancelled: true })
                .pipe(Effect.exit);
              if (Exit.isFailure(responseExit)) {
                yield* withThreadLock(
                  context.threadId,
                  Effect.sync(() => {
                    const turn = context.activeTurn;
                    if (sessions.get(context.threadId) !== context || turn === undefined) return;
                    turn.cancellationRequested = true;
                    turn.controller.abort();
                  }),
                );
                const abortExit = yield* context.runtime.abort.pipe(Effect.exit);
                yield* withThreadLock(
                  context.threadId,
                  Effect.gen(function* () {
                    if (sessions.get(context.threadId) !== context || context.stopped) return;
                    const turn = context.activeTurn;
                    if (turn !== undefined) {
                      yield* settleActiveTurnLocked(context, turn, { state: "cancelled" });
                    }
                    yield* offerRuntimeEvent({
                      type: "runtime.error",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      providerInstanceId: boundInstanceId,
                      threadId: context.threadId,
                      payload: {
                        message:
                          "Prime Agent interaction cancellation failed; the active run was aborted.",
                        class: "provider_error",
                      },
                    });
                  }),
                );
                if (Exit.isFailure(abortExit)) {
                  yield* Effect.logError("Prime Agent fail-closed abort also failed.", {
                    threadId: context.threadId,
                  });
                }
                return;
              }
            }

            yield* withThreadLock(
              context.threadId,
              Effect.gen(function* () {
                if (
                  sessions.get(context.threadId) !== context ||
                  context.stopped ||
                  context.stopRequested
                ) {
                  return;
                }
                yield* offerRuntimeEvent({
                  type: "runtime.warning",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: context.threadId,
                  ...(context.activeTurn === undefined ? {} : { turnId: context.activeTurn.id }),
                  payload: {
                    message: isBlocking
                      ? "Prime Agent sent a malformed interaction request; it was ignored."
                      : "Prime Agent sent an unsupported interaction update; it was ignored.",
                  },
                });
              }),
            );
            return;
          }

          const normalized = projection.value;
          if (normalized._tag === "Presentation") {
            const presentation = normalized.presentation;
            yield* withThreadLock(
              context.threadId,
              Effect.gen(function* () {
                if (
                  sessions.get(context.threadId) !== context ||
                  context.stopped ||
                  context.stopRequested
                ) {
                  return;
                }
                yield* offerRuntimeEvent({
                  type: "session-presentation.updated",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: context.threadId,
                  ...(context.activeTurn === undefined ? {} : { turnId: context.activeTurn.id }),
                  payload: { presentation },
                });
              }),
            );
            return;
          }

          const blocking = normalized;
          yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              if (
                sessions.get(context.threadId) !== context ||
                context.stopped ||
                context.stopRequested
              ) {
                return;
              }
              const requestId = SessionInteractionRequestId.make(yield* randomUUIDv4);
              const stamp = yield* makeEventStamp();
              const pending: PrimeAgentDaemonPendingInteraction = {
                nativeId: event.request.id,
                method: blocking.method,
                selectOptions:
                  blocking.request.kind === "select"
                    ? new Set(blocking.request.options)
                    : undefined,
              };
              context.pendingInteractions.set(requestId, pending);
              const timeoutPublished =
                blocking.request.timeout === undefined ? undefined : yield* Deferred.make<void>();
              if (blocking.request.timeout !== undefined && timeoutPublished !== undefined) {
                yield* Effect.sleep(blocking.request.timeout).pipe(
                  Effect.andThen(Deferred.await(timeoutPublished)),
                  Effect.andThen(
                    withThreadLock(
                      context.threadId,
                      Effect.gen(function* () {
                        if (context.pendingInteractions.get(requestId) !== pending) return;
                        context.pendingInteractions.delete(requestId);
                        yield* offerRuntimeEvent({
                          type: "interaction.resolved",
                          ...(yield* makeEventStamp()),
                          provider: PROVIDER,
                          providerInstanceId: boundInstanceId,
                          threadId: context.threadId,
                          ...(context.activeTurn === undefined
                            ? {}
                            : { turnId: context.activeTurn.id }),
                          requestId,
                          payload: { response: { kind: "cancelled" } },
                        });
                      }),
                    ),
                  ),
                  Effect.forkScoped({ startImmediately: true }),
                  Effect.provideService(Scope.Scope, context.scope),
                );
              }
              yield* offerRuntimeEvent({
                type: "interaction.requested",
                ...stamp,
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: context.threadId,
                ...(context.activeTurn === undefined ? {} : { turnId: context.activeTurn.id }),
                requestId,
                payload: { request: blocking.request },
              });
              if (timeoutPublished !== undefined) {
                yield* Deferred.succeed(timeoutPublished, undefined).pipe(Effect.ignore);
              }
            }),
          );
          return;
        }

        if (event._tag === "RunCompleted") {
          yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              const turn = context.activeTurn;
              if (turn === undefined) return;
              yield* settleActiveTurnLocked(context, turn, { state: "completed", event });
            }),
          );
          return;
        }

        if (event._tag === "SessionClosed") {
          yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              if (sessions.get(context.threadId) !== context || context.stopped) return;
              yield* clearPendingInteractionsLocked(context, false);
              const turn = context.activeTurn;
              if (turn !== undefined) {
                yield* settleActiveTurnLocked(
                  context,
                  turn,
                  turn.cancellationRequested || context.stopRequested
                    ? { state: "cancelled" }
                    : {
                        state: "failed",
                        errorMessage:
                          "Prime Agent daemon session closed before the turn completed.",
                      },
                );
              }
              const disposeExit = yield* context.runtime.dispose.pipe(Effect.exit);
              context.stopped = true;
              context.stopRequested = true;
              sessions.delete(context.threadId);
              yield* Scope.close(context.scope, Exit.void);
              if (!context.exitEmitted) {
                context.exitEmitted = true;
                yield* publishDrafts(context, event, undefined);
              }
              if (Exit.isFailure(disposeExit)) {
                yield* Effect.logError("Failed to dispose a terminal Prime Agent daemon session.", {
                  threadId: context.threadId,
                });
              }
            }),
          );
          return;
        }

        yield* withThreadLock(
          context.threadId,
          Effect.gen(function* () {
            if (sessions.get(context.threadId) !== context || context.stopped) return;
            if (event._tag === "ConnectionStatus") {
              context.session = {
                ...context.session,
                status:
                  event.status === "reconnecting"
                    ? "connecting"
                    : context.activeTurn === undefined
                      ? "ready"
                      : "running",
                updatedAt: yield* nowIso,
              };
            }
            yield* publishDrafts(context, event, context.activeTurn);
          }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed to consume a Prime Agent daemon event.", {
            cause,
            threadId: context.threadId,
            eventType: event._tag,
          }),
        ),
      );

    /** Must be called with the thread lock held. */
    const stopSessionInternal = (context: PrimeAgentDaemonSessionContext) =>
      Effect.gen(function* () {
        if (sessions.get(context.threadId) !== context || context.stopped) return;
        context.stopRequested = true;
        yield* clearPendingInteractionsLocked(context, true);
        const turn = context.activeTurn;
        if (turn !== undefined) {
          turn.cancellationRequested = true;
          turn.controller.abort();
          yield* context.runtime.abort.pipe(Effect.ignore);
          yield* settleActiveTurnLocked(context, turn, { state: "cancelled" });
        }

        const disposeExit = yield* context.runtime.dispose.pipe(Effect.exit);
        context.stopped = true;
        if (context.eventFiber !== undefined) yield* Fiber.interrupt(context.eventFiber);
        yield* Scope.close(context.scope, Exit.void);
        if (sessions.get(context.threadId) !== context) return;
        sessions.delete(context.threadId);
        if (!context.exitEmitted) {
          context.exitEmitted = true;
          yield* offerRuntimeEvent({
            type: "session.exited",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            payload: {
              exitKind: Exit.isSuccess(disposeExit) ? "graceful" : "error",
              ...(Exit.isSuccess(disposeExit)
                ? {}
                : { reason: "Prime Agent daemon session disposal failed." }),
            },
          });
        }
        if (Exit.isFailure(disposeExit)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/dispose",
            detail: "Prime Agent daemon session disposal failed.",
            cause: disposeExit.cause,
          });
        }
      });

    const startSession: PrimeAgentAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          if (input.runtimeMode !== "full-access") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Prime Agent daemon sessions support only full-access runtime mode.",
            });
          }

          const existing = sessions.get(input.threadId);
          if (existing !== undefined && !existing.stopped) yield* stopSessionInternal(existing);

          const cwd = path.resolve(input.cwd.trim());
          const selectedModel =
            input.modelSelection?.instanceId === boundInstanceId
              ? input.modelSelection.model.trim()
              : undefined;
          const model = selectedModel || "default";
          const sessionDir = primeAgentSessionDirectory({
            stateDir: serverConfig.stateDir,
            instanceId: boundInstanceId,
            threadId: input.threadId,
            join: path.join,
          });
          yield* fileSystem.makeDirectory(sessionDir, { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to prepare the Prime Agent daemon session directory.",
                  cause,
                }),
            ),
          );

          const sessionScope = yield* Scope.make("sequential");
          let scopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            scopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          const agentDir = primeAgentSettings.agentHomePath.trim();
          const runtime = yield* runtimeFactory({
            manager,
            cwd,
            sessionDir,
            ...(agentDir.length === 0 ? {} : { agentDir: resolveProviderHomePath(agentDir) }),
            ...(model === "default" ? {} : { model }),
            ...(input.resumeCursor === undefined ? {} : { resumeCursor: input.resumeCursor }),
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((error) => runtimeStartError(input.threadId, error)),
          );

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: "full-access",
            cwd,
            model,
            threadId: input.threadId,
            resumeCursor: runtime.resumeCursor,
            createdAt: now,
            updatedAt: now,
          };
          const context: PrimeAgentDaemonSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            runtime,
            eventFiber: undefined,
            turns: [],
            pendingInteractions: new Map(),
            activeTurn: undefined,
            stopRequested: false,
            stopped: false,
            exitEmitted: false,
          };
          sessions.set(input.threadId, context);
          scopeTransferred = true;
          context.eventFiber = yield* runtime.events.pipe(
            Stream.runForEach((event) => consumeEvent(context, event)),
            Effect.forkChild,
          );

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { resume: input.resumeCursor !== undefined },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Prime Agent daemon session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: {},
          });
          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: PrimeAgentAdapterShape["sendTurn"] = (input) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const prepared = yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const context = yield* requireSession(input.threadId);
              if (context.activeTurn !== undefined) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Prime Agent does not support concurrent turns.",
                });
              }
              if (input.interactionMode !== undefined && input.interactionMode !== "default") {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Prime Agent daemon sessions support only default interaction mode.",
                });
              }

              const text = input.input?.trim() ?? "";
              const images = [];
              for (const attachment of input.attachments ?? []) {
                const attachmentPath = resolveAttachmentPath({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachment,
                });
                if (attachmentPath === null) {
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: `Invalid attachment id '${attachment.id}'.`,
                  });
                }
                const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: "Failed to read a turn attachment.",
                        cause,
                      }),
                  ),
                );
                images.push({
                  type: "image" as const,
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType: attachment.mimeType,
                });
              }
              if (text.length === 0 && images.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              const turnId = TurnId.make(yield* randomUUIDv4);
              const turn: PrimeAgentDaemonActiveTurn = {
                id: turnId,
                controller: new AbortController(),
                completed: yield* Deferred.make<void>(),
                cancellationRequested: false,
                assistantTextStreamed: false,
              };
              const requestedModel =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection.model.trim()
                  : undefined;
              context.activeTurn = turn;
              context.session = {
                ...context.session,
                activeTurnId: turnId,
                status: "running",
                updatedAt: yield* nowIso,
              };
              return { context, turn, text, images, requestedModel };
            }),
          );
          const { context, turn, text, images, requestedModel } = prepared;
          const result: ProviderTurnStartResult = {
            threadId: input.threadId,
            turnId: turn.id,
            resumeCursor: context.session.resumeCursor,
          };

          const runPrompt = Effect.gen(function* () {
            const turnModel = requestedModel || context.session.model || "default";
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              turnId: turn.id,
              payload: { model: turnModel },
            });
            if (
              requestedModel !== undefined &&
              requestedModel.length > 0 &&
              requestedModel !== context.session.model
            ) {
              yield* context.runtime
                .setModel(requestedModel)
                .pipe(
                  Effect.mapError((error) =>
                    runtimeOperationError(input.threadId, "session/set-model", error),
                  ),
                );
              context.session = {
                ...context.session,
                model: requestedModel,
                updatedAt: yield* nowIso,
              };
            }
            yield* context.runtime
              .prompt({
                text,
                ...(images.length === 0 ? {} : { images }),
                signal: turn.controller.signal,
              })
              .pipe(
                Effect.mapError((error) =>
                  runtimeOperationError(input.threadId, "session/prompt", error),
                ),
              );
            yield* Deferred.await(turn.completed);
            return result;
          });

          return yield* restore(runPrompt).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const cancelled = turn.cancellationRequested || turn.controller.signal.aborted;
                const settled = yield* settleActiveTurn(
                  context,
                  turn,
                  cancelled
                    ? { state: "cancelled" }
                    : { state: "failed", errorMessage: error.message },
                );
                if (cancelled || !settled) return result;
                return yield* error;
              }),
            ),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                turn.cancellationRequested = true;
                turn.controller.abort();
                yield* context.runtime.abort.pipe(Effect.ignore);
                yield* settleActiveTurn(context, turn, { state: "cancelled" });
              }),
            ),
          );
        }),
      );

    const interruptTurn: PrimeAgentAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const observed = yield* Effect.sync(() => {
          const context = sessions.get(threadId);
          if (context === undefined || context.stopped || context.stopRequested) {
            return { _tag: "Missing" as const };
          }
          const turn = context.activeTurn;
          if (turnId !== undefined && turn?.id !== turnId) {
            return { _tag: "WrongTurn" as const };
          }
          if (turn !== undefined) {
            turn.cancellationRequested = true;
            turn.controller.abort();
          }
          return { _tag: "Found" as const, context, turn };
        });
        if (observed._tag === "Missing") {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        if (observed._tag === "WrongTurn") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "interruptTurn",
            issue: `Turn '${turnId}' is not active.`,
          });
        }
        const abortExit = yield* observed.context.runtime.abort.pipe(
          Effect.mapError((error) => runtimeOperationError(threadId, "session/abort", error)),
          Effect.exit,
        );
        if (observed.turn !== undefined) {
          yield* settleActiveTurn(observed.context, observed.turn, { state: "cancelled" });
        }
        if (Exit.isFailure(abortExit)) return yield* Effect.failCause(abortExit.cause);
      });

    const respondToRequest: PrimeAgentAdapterShape["respondToRequest"] = (threadId, requestId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request",
          detail: `Prime Agent full-access sessions do not expose approval request '${requestId}' for thread '${threadId}'.`,
        }),
      );
    const respondToUserInput: PrimeAgentAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/user-input",
          detail: `Prime Agent daemon interactions are not wired for request '${requestId}' on thread '${threadId}'.`,
        }),
      );
    const respondToInteraction: NonNullable<PrimeAgentAdapterShape["respondToInteraction"]> = (
      threadId,
      requestId,
      response,
    ) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          const pending = context.pendingInteractions.get(requestId);
          if (pending === undefined) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/interaction-response",
              detail: `Unknown or stale Prime Agent interaction '${requestId}' for thread '${threadId}'.`,
            });
          }
          const decodedResponse = decodeSessionInteractionResponse(response);
          if (Option.isNone(decodedResponse)) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/interaction-response",
              detail: `The response is invalid for interaction '${requestId}'.`,
            });
          }
          const normalizedResponse = decodedResponse.value;
          if (
            normalizedResponse.kind === "selected" &&
            (response.kind !== "selected" || response.value !== normalizedResponse.value)
          ) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/interaction-response",
              detail: `The selected value is not an exact offered option for interaction '${requestId}'.`,
            });
          }

          let safeResponse: SessionInteractionResponse;
          let nativeResponse:
            | { readonly value: string }
            | { readonly confirmed: boolean }
            | {
                readonly cancelled: true;
              };
          if (normalizedResponse.kind === "cancelled") {
            safeResponse = { kind: "cancelled" };
            nativeResponse = { cancelled: true };
          } else if (pending.method === "select" && normalizedResponse.kind === "selected") {
            if (pending.selectOptions?.has(normalizedResponse.value) !== true) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/interaction-response",
                detail: `The selected value is not offered by interaction '${requestId}'.`,
              });
            }
            safeResponse = { kind: "selected", value: normalizedResponse.value };
            nativeResponse = { value: normalizedResponse.value };
          } else if (pending.method === "confirm" && normalizedResponse.kind === "confirmed") {
            safeResponse = { kind: "confirmed", confirmed: normalizedResponse.confirmed };
            nativeResponse = { confirmed: normalizedResponse.confirmed };
          } else if (
            (pending.method === "input" || pending.method === "editor") &&
            normalizedResponse.kind === "submitted"
          ) {
            safeResponse = { kind: "submitted", value: normalizedResponse.value };
            nativeResponse = { value: normalizedResponse.value };
          } else {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/interaction-response",
              detail: `The response kind does not match interaction '${requestId}'.`,
            });
          }

          yield* context.runtime
            .respondToExtensionUiRequest(pending.nativeId, nativeResponse)
            .pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/interaction-response", error),
              ),
            );
          context.pendingInteractions.delete(requestId);
          yield* offerRuntimeEvent({
            type: "interaction.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId,
            ...(context.activeTurn === undefined ? {} : { turnId: context.activeTurn.id }),
            requestId,
            payload: { response: safeResponse },
          });
        }),
      );
    const readThread: PrimeAgentAdapterShape["readThread"] = (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({
        threadId,
        turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      }));
    const rollbackThread: PrimeAgentAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Prime Agent daemon conversation rollback is unsupported.",
        });
      });
    const stopSession: PrimeAgentAdapterShape["stopSession"] = (threadId) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const context = sessions.get(threadId);
          if (context === undefined || context.stopped) {
            return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
          }
          context.stopRequested = true;
          if (context.activeTurn !== undefined) {
            context.activeTurn.cancellationRequested = true;
            context.activeTurn.controller.abort();
          }
          yield* withThreadLock(threadId, stopSessionInternal(context));
        }),
      );
    const listSessions: PrimeAgentAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (context) => ({ ...context.session })));
    const hasSession: PrimeAgentAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped && !context.stopRequested;
      });
    const stopAll: PrimeAgentAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = Array.from(sessions.values());
        for (const context of contexts) {
          context.stopRequested = true;
          if (context.activeTurn !== undefined) {
            context.activeTurn.cancellationRequested = true;
            context.activeTurn.controller.abort();
          }
        }
        yield* Effect.forEach(
          contexts,
          (context) => withThreadLock(context.threadId, stopSessionInternal(context)),
          { discard: true },
        );
      }).pipe(Effect.uninterruptible);

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to shut down Prime Agent daemon sessions.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
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
      respondToInteraction,
      readThread,
      rollbackThread,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies PrimeAgentAdapterShape;
  });
}
