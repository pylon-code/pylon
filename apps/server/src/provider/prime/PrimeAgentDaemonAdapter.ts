import {
  ApprovalRequestId,
  EventId,
  type PrimeAgentSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
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
import type {
  PrimeAgentDaemonServiceTier,
  PrimeAgentDaemonThinkingLevel,
} from "./PrimeAgentDaemonBridge.ts";
import type { PrimeDaemonEvent, PrimeDaemonMessage } from "./PrimeAgentDaemonEvents.ts";
import type { PrimeAgentDaemonManager } from "./PrimeAgentDaemonManager.ts";
import {
  PRIME_AGENT_INHERIT_MODEL_OPTION,
  type PrimeAgentTurnControlsResult,
  resolvePrimeAgentTurnControls,
} from "./PrimeAgentModelOptions.ts";
import { mapPrimeAgentDaemonRuntimeEventDrafts } from "./PrimeAgentDaemonRuntimeEvents.ts";
import {
  PRIME_AGENT_PERMISSION_EXTENSION_FILENAME,
  PRIME_AGENT_PERMISSION_EXTENSION_MARKER_COMMAND,
  makePrimeAgentPermissionExtensionSource,
  projectPrimeAgentManagedPermissionRequest,
  type PrimeAgentManagedPermissionRequestType,
} from "./PrimeAgentPermissionExtension.ts";
import {
  makePrimeAgentDaemonSessionRuntime,
  type PrimeAgentDaemonSessionRuntime,
  type PrimeAgentDaemonSessionRuntimeError,
  type PrimeAgentDaemonSessionRuntimeInput,
} from "./PrimeAgentDaemonSessionRuntime.ts";
import {
  PRIME_AGENT_SESSION_IDENTITY_FILENAME,
  PRIME_AGENT_SESSION_IDENTITY_TEMP_FILENAME,
  decodePrimeAgentSessionIdentity,
  encodePrimeAgentSessionIdentity,
  primeAgentLegacySessionFileNames,
  primeAgentSessionFileName,
} from "./PrimeAgentSessionIdentity.ts";

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
  queuedInputCount: number;
  awaitingQueuedRun: boolean;
  queuedActionObserved: boolean;
  readonly completedRunMessages: Array<PrimeDaemonMessage>;
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

interface PrimeAgentDaemonPendingApproval {
  readonly nativeId: string;
  readonly requestType: PrimeAgentManagedPermissionRequestType;
}

interface PrimeAgentDaemonSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly runtime: PrimeAgentDaemonSessionRuntime;
  readonly defaultThinkingLevel: PrimeAgentDaemonThinkingLevel;
  readonly defaultServiceTier: PrimeAgentDaemonServiceTier;
  currentThinkingLevel: PrimeAgentDaemonThinkingLevel;
  currentServiceTier: PrimeAgentDaemonServiceTier;
  eventFiber: Fiber.Fiber<void, never> | undefined;
  readonly turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }>;
  readonly pendingInteractions: Map<
    SessionInteractionRequestId,
    PrimeAgentDaemonPendingInteraction
  >;
  readonly pendingApprovals: Map<ApprovalRequestId, PrimeAgentDaemonPendingApproval>;
  readonly permissionToken: string | undefined;
  approvalsAcceptedForSession: boolean;
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

    /** Must be called with the thread lock held. */
    const clearPendingApprovalsLocked = (
      context: PrimeAgentDaemonSessionContext,
      cancelNative: boolean,
    ) =>
      Effect.gen(function* () {
        for (const [requestId, pending] of context.pendingApprovals) {
          if (cancelNative) {
            yield* context.runtime
              .respondToExtensionUiRequest(pending.nativeId, { cancelled: true })
              .pipe(Effect.ignore);
          }
          if (!context.pendingApprovals.delete(requestId)) continue;
          yield* offerRuntimeEvent({
            type: "request.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(context.activeTurn === undefined ? {} : { turnId: context.activeTurn.id }),
            requestId: RuntimeRequestId.make(requestId),
            payload: { requestType: pending.requestType, decision: "cancel" },
          });
        }
      });

    /** Must be called with the thread lock held. */
    const failManagedPermissionLocked = (
      context: PrimeAgentDaemonSessionContext,
      message: string,
    ) =>
      Effect.gen(function* () {
        context.approvalsAcceptedForSession = false;
        const turn = context.activeTurn;
        if (turn !== undefined) {
          turn.cancellationRequested = true;
          turn.controller.abort();
        }
        yield* context.runtime.abortAndClearQueue.pipe(Effect.ignore);
        if (turn !== undefined) {
          yield* settleActiveTurnLocked(context, turn, { state: "cancelled" });
        }
        yield* offerRuntimeEvent({
          type: "runtime.error",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          payload: { message, class: "provider_error" },
        });
      });

    /** Must be called with the thread lock held. */
    const respondToManagedPermissionLocked = (
      context: PrimeAgentDaemonSessionContext,
      nativeId: string,
      confirmed: boolean,
    ) =>
      Effect.gen(function* () {
        const responseExit = yield* context.runtime
          .respondToExtensionUiRequest(nativeId, { confirmed })
          .pipe(Effect.exit);
        if (Exit.isSuccess(responseExit)) return true;
        yield* failManagedPermissionLocked(
          context,
          "Prime Agent execution approval could not be delivered; the active run was aborted.",
        );
        return false;
      });

    const consumeEvent = (context: PrimeAgentDaemonSessionContext, event: PrimeDaemonEvent) =>
      Effect.gen(function* () {
        yield* logNativeKind(context.threadId, event);
        if (event._tag === "SessionResynced" || event._tag === "SessionReplaced") return;

        if (event._tag === "ExtensionRequest") {
          const permissionProjection = projectPrimeAgentManagedPermissionRequest(
            event.request,
            context.permissionToken ?? "",
          );
          if (context.session.runtimeMode === "approval-required") {
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
                const nativeId = event.request.id.trim();
                if (permissionProjection._tag !== "Request" || nativeId.length === 0) {
                  context.approvalsAcceptedForSession = false;
                  if (nativeId.length > 0) {
                    const delivered = yield* respondToManagedPermissionLocked(
                      context,
                      nativeId,
                      false,
                    );
                    if (delivered) {
                      yield* offerRuntimeEvent({
                        type: "runtime.error",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        providerInstanceId: boundInstanceId,
                        threadId: context.threadId,
                        payload: {
                          message:
                            "Prime Agent sent an invalid execution approval; execution was blocked.",
                          class: "provider_error",
                        },
                      });
                    }
                  } else {
                    yield* failManagedPermissionLocked(
                      context,
                      "Prime Agent sent a malformed execution approval; the active run was aborted.",
                    );
                  }
                  return;
                }
                if (context.approvalsAcceptedForSession) {
                  yield* respondToManagedPermissionLocked(context, nativeId, true);
                  return;
                }

                const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                const pending: PrimeAgentDaemonPendingApproval = {
                  nativeId,
                  requestType: permissionProjection.requestType,
                };
                context.pendingApprovals.set(requestId, pending);
                const stamp = yield* makeEventStamp();
                const timeoutPublished =
                  event.request.timeoutMs === undefined ? undefined : yield* Deferred.make<void>();
                if (event.request.timeoutMs !== undefined && timeoutPublished !== undefined) {
                  yield* Effect.sleep(event.request.timeoutMs).pipe(
                    Effect.andThen(Deferred.await(timeoutPublished)),
                    Effect.andThen(
                      withThreadLock(
                        context.threadId,
                        Effect.gen(function* () {
                          if (context.pendingApprovals.get(requestId) !== pending) return;
                          context.pendingApprovals.delete(requestId);
                          yield* offerRuntimeEvent({
                            type: "request.resolved",
                            ...(yield* makeEventStamp()),
                            provider: PROVIDER,
                            providerInstanceId: boundInstanceId,
                            threadId: context.threadId,
                            ...(context.activeTurn === undefined
                              ? {}
                              : { turnId: context.activeTurn.id }),
                            requestId: RuntimeRequestId.make(requestId),
                            payload: {
                              requestType: pending.requestType,
                              decision: "cancel",
                            },
                          });
                        }),
                      ),
                    ),
                    Effect.forkScoped({ startImmediately: true }),
                    Effect.provideService(Scope.Scope, context.scope),
                  );
                }
                yield* offerRuntimeEvent({
                  type: "request.opened",
                  ...stamp,
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: context.threadId,
                  ...(context.activeTurn === undefined ? {} : { turnId: context.activeTurn.id }),
                  requestId: RuntimeRequestId.make(requestId),
                  payload: {
                    requestType: permissionProjection.requestType,
                    detail: permissionProjection.detail,
                    args: { toolName: permissionProjection.toolName },
                  },
                });
                if (timeoutPublished !== undefined) {
                  yield* Deferred.succeed(timeoutPublished, undefined).pipe(Effect.ignore);
                }
              }),
            );
            return;
          }

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
                const abortFailed = yield* withThreadLock(
                  context.threadId,
                  Effect.gen(function* () {
                    if (sessions.get(context.threadId) !== context || context.stopped) return false;
                    const turn = context.activeTurn;
                    if (turn !== undefined) {
                      turn.cancellationRequested = true;
                      turn.controller.abort();
                    }
                    const abortExit = yield* context.runtime.abortAndClearQueue.pipe(Effect.exit);
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
                    return Exit.isFailure(abortExit);
                  }),
                );
                if (abortFailed) {
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
              if (turn.queuedInputCount > 0) {
                turn.completedRunMessages.push(...event.messages);
                turn.awaitingQueuedRun = true;
                turn.queuedActionObserved = false;
                return;
              }
              const completionEvent =
                turn.completedRunMessages.length === 0
                  ? event
                  : {
                      ...event,
                      messages: [...turn.completedRunMessages, ...event.messages],
                    };
              yield* settleActiveTurnLocked(context, turn, {
                state: "completed",
                event: completionEvent,
              });
            }),
          );
          return;
        }

        if (event._tag === "SessionClosed") {
          yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              if (sessions.get(context.threadId) !== context || context.stopped) return;
              yield* clearPendingApprovalsLocked(context, false);
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
            const turn = context.activeTurn;
            if (event._tag === "ThinkingLevelChanged") {
              context.currentThinkingLevel = event.level;
            } else if (event._tag === "ServiceTierChanged") {
              context.currentServiceTier = event.serviceTier;
            }
            if (event._tag === "RunStarted" && turn?.awaitingQueuedRun === true) {
              turn.awaitingQueuedRun = false;
              turn.queuedActionObserved = false;
            }
            if (event._tag === "QueueChanged" && turn !== undefined) {
              turn.queuedInputCount = event.queuedCount;
              if (turn.awaitingQueuedRun && event.active !== undefined) {
                turn.queuedActionObserved = true;
              } else if (turn.awaitingQueuedRun && turn.queuedActionObserved) {
                const clearExit = yield* context.runtime.abortAndClearQueue.pipe(Effect.exit);
                yield* settleActiveTurnLocked(context, turn, {
                  state: "failed",
                  errorMessage: "Prime Agent could not start a queued input.",
                });
                if (Exit.isFailure(clearExit)) {
                  context.stopRequested = true;
                  yield* Effect.forkDetach(
                    Effect.yieldNow.pipe(
                      Effect.andThen(
                        withThreadLock(context.threadId, stopSessionInternal(context)),
                      ),
                    ),
                  );
                }
              }
            }
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
        yield* clearPendingApprovalsLocked(context, true);
        yield* clearPendingInteractionsLocked(context, true);
        const turn = context.activeTurn;
        if (turn !== undefined) {
          turn.cancellationRequested = true;
          turn.controller.abort();
          yield* context.runtime.abortAndClearQueue.pipe(Effect.ignore);
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
          if (input.runtimeMode !== "approval-required" && input.runtimeMode !== "full-access") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Runtime mode '${input.runtimeMode}' is not supported by Prime Agent daemon sessions.`,
            });
          }
          const approvalRequired = input.runtimeMode === "approval-required";

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
            Effect.andThen(fileSystem.chmod(sessionDir, 0o700)),
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
          const identityPath = path.join(sessionDir, PRIME_AGENT_SESSION_IDENTITY_FILENAME);
          let resumeSessionId: string | undefined;
          let expectedSessionFileName: string | undefined;
          if (input.resumeCursor !== undefined) {
            const identityExists = yield* fileSystem.exists(identityPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: "Failed to inspect the Prime Agent durable session identity.",
                    cause,
                  }),
              ),
            );
            if (identityExists) {
              const identitySource = yield* fileSystem.readFileString(identityPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: "Failed to read the Prime Agent durable session identity.",
                      cause,
                    }),
                ),
              );
              const identity = decodePrimeAgentSessionIdentity(sessionDir, identitySource);
              if (identity === undefined) {
                return yield* new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "The Prime Agent durable session identity is invalid.",
                });
              }
              const sessionFileExists = yield* fileSystem.exists(identity.sessionPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: "Failed to verify the saved Prime Agent session.",
                      cause,
                    }),
                ),
              );
              if (!sessionFileExists) {
                return yield* new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "The saved Prime Agent session is no longer available.",
                });
              }
              resumeSessionId = identity.sessionId;
              expectedSessionFileName = primeAgentSessionFileName(sessionDir, identity.sessionPath);
            } else {
              const entries = yield* fileSystem.readDirectory(sessionDir).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: "Failed to inspect legacy Prime Agent sessions.",
                      cause,
                    }),
                ),
              );
              const legacySessionFiles = primeAgentLegacySessionFileNames(entries);
              if (legacySessionFiles.length !== 1) {
                return yield* new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail:
                    legacySessionFiles.length === 0
                      ? "No saved Prime Agent session is available to continue."
                      : "The legacy Prime Agent session identity is ambiguous and cannot be continued safely.",
                });
              }
              expectedSessionFileName = legacySessionFiles[0];
            }
          }

          const permissionExtensionPath = path.join(
            sessionDir,
            PRIME_AGENT_PERMISSION_EXTENSION_FILENAME,
          );
          const permissionToken = approvalRequired ? yield* randomUUIDv4 : undefined;
          const permissionExtensionSource =
            permissionToken === undefined
              ? undefined
              : makePrimeAgentPermissionExtensionSource(permissionToken);
          if (permissionExtensionSource !== undefined) {
            yield* fileSystem
              .writeFileString(permissionExtensionPath, permissionExtensionSource)
              .pipe(
                Effect.andThen(fileSystem.chmod(permissionExtensionPath, 0o600)),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: "Failed to prepare the Prime Agent execution policy extension.",
                      cause,
                    }),
                ),
              );
          }

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
            ...(approvalRequired
              ? {
                  extensions: [permissionExtensionPath],
                  disableExtensionDiscovery: true,
                  disableAutoReconnect: true,
                  requiredExtension: {
                    path: permissionExtensionPath,
                    markerCommand: PRIME_AGENT_PERMISSION_EXTENSION_MARKER_COMMAND,
                  },
                }
              : {}),
            ...(input.resumeCursor === undefined ? {} : { resumeCursor: input.resumeCursor }),
            ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((error) => runtimeStartError(input.threadId, error)),
          );

          if (permissionExtensionSource !== undefined) {
            const loadedExtensionSource = yield* fileSystem
              .readFileString(permissionExtensionPath)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: "Failed to verify the Prime Agent execution policy extension.",
                      cause,
                    }),
                ),
              );
            if (loadedExtensionSource !== permissionExtensionSource) {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail:
                  "Prime Agent loaded an execution policy extension whose source integrity could not be verified.",
              });
            }
          }

          if (
            expectedSessionFileName !== undefined &&
            primeAgentSessionFileName(sessionDir, runtime.sessionFile) !== expectedSessionFileName
          ) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "Prime Agent did not continue the expected session transcript.",
            });
          }
          const runtimeSessionFileExists = yield* fileSystem.exists(runtime.sessionFile).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to verify the active Prime Agent session file.",
                  cause,
                }),
            ),
          );
          if (!runtimeSessionFileExists) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "Prime Agent did not create its durable session file.",
            });
          }
          yield* fileSystem.chmod(runtime.sessionFile, 0o600).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to protect the Prime Agent durable session file.",
                  cause,
                }),
            ),
          );
          const identitySource = encodePrimeAgentSessionIdentity(
            sessionDir,
            runtime.sessionId,
            runtime.sessionFile,
          );
          if (identitySource === undefined) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "Prime Agent returned an invalid durable session identity.",
            });
          }
          const identityTempPath = path.join(
            sessionDir,
            PRIME_AGENT_SESSION_IDENTITY_TEMP_FILENAME,
          );
          yield* fileSystem.writeFileString(identityTempPath, identitySource).pipe(
            Effect.andThen(fileSystem.chmod(identityTempPath, 0o600)),
            Effect.andThen(fileSystem.rename(identityTempPath, identityPath)),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to persist the Prime Agent durable session identity.",
                  cause,
                }),
            ),
          );

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
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
            defaultThinkingLevel: runtime.initialSnapshot.state.thinkingLevel,
            defaultServiceTier: runtime.initialSnapshot.state.serviceTier,
            currentThinkingLevel: runtime.initialSnapshot.state.thinkingLevel,
            currentServiceTier: runtime.initialSnapshot.state.serviceTier,
            eventFiber: undefined,
            turns: [],
            pendingInteractions: new Map(),
            pendingApprovals: new Map(),
            permissionToken,
            approvalsAcceptedForSession: false,
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

    const applyTurnSelection = (
      context: PrimeAgentDaemonSessionContext,
      threadId: ThreadId,
      requestedModel: string | undefined,
      turnControls: Extract<PrimeAgentTurnControlsResult, { readonly _tag: "Valid" }>,
    ) =>
      Effect.gen(function* () {
        if (
          requestedModel !== undefined &&
          requestedModel.length > 0 &&
          requestedModel !== context.session.model
        ) {
          yield* context.runtime
            .setModel(requestedModel)
            .pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/set-model", error),
              ),
            );
          context.session = {
            ...context.session,
            model: requestedModel,
            updatedAt: yield* nowIso,
          };
        }
        const thinkingLevel =
          turnControls.thinkingLevel === PRIME_AGENT_INHERIT_MODEL_OPTION
            ? context.defaultThinkingLevel
            : turnControls.thinkingLevel;
        if (thinkingLevel !== undefined) {
          yield* context.runtime
            .setThinkingLevel(thinkingLevel)
            .pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/set-thinking-level", error),
              ),
            );
        }
        const serviceTier =
          turnControls.serviceTier === PRIME_AGENT_INHERIT_MODEL_OPTION
            ? context.defaultServiceTier
            : turnControls.serviceTier;
        if (serviceTier !== undefined) {
          yield* context.runtime
            .setServiceTier(serviceTier)
            .pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/set-service-tier", error),
              ),
            );
        }
      });

    const sendTurn: PrimeAgentAdapterShape["sendTurn"] = (input) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const prepared = yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const context = yield* requireSession(input.threadId);
              const modelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const turnControls = resolvePrimeAgentTurnControls(modelSelection);
              if (turnControls._tag === "Invalid") {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: turnControls.issue,
                });
              }
              const activeTurn = context.activeTurn;
              if (input.interactionMode !== undefined && input.interactionMode !== "default") {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Prime Agent daemon sessions support only default interaction mode.",
                });
              }

              const text = input.input?.trim() ?? "";
              if (context.session.runtimeMode === "approval-required" && text.startsWith("/")) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue:
                    "Prime Agent slash commands are unavailable in supervised mode because they bypass tool approvals.",
                });
              }
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

              const requestedModel = modelSelection?.model.trim();
              if (activeTurn !== undefined) {
                const thinkingLevel =
                  turnControls.thinkingLevel === PRIME_AGENT_INHERIT_MODEL_OPTION
                    ? context.defaultThinkingLevel
                    : turnControls.thinkingLevel;
                const serviceTier =
                  turnControls.serviceTier === PRIME_AGENT_INHERIT_MODEL_OPTION
                    ? context.defaultServiceTier
                    : turnControls.serviceTier;
                if (
                  (requestedModel !== undefined &&
                    requestedModel.length > 0 &&
                    requestedModel !== context.session.model) ||
                  (thinkingLevel !== undefined && thinkingLevel !== context.currentThinkingLevel) ||
                  (serviceTier !== undefined && serviceTier !== context.currentServiceTier)
                ) {
                  return yield* new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "sendTurn",
                    issue: "Prime Agent cannot change model controls while a run is active.",
                  });
                }
                yield* context.runtime
                  .steer({ text, ...(images.length === 0 ? {} : { images }) })
                  .pipe(
                    Effect.mapError((error) =>
                      runtimeOperationError(input.threadId, "session/steer", error),
                    ),
                  );
                activeTurn.queuedInputCount += 1;
                return {
                  _tag: "Steered" as const,
                  result: {
                    threadId: input.threadId,
                    turnId: activeTurn.id,
                    resumeCursor: context.session.resumeCursor,
                  } satisfies ProviderTurnStartResult,
                };
              }

              yield* applyTurnSelection(context, input.threadId, requestedModel, turnControls);
              const turnId = TurnId.make(yield* randomUUIDv4);
              const turn: PrimeAgentDaemonActiveTurn = {
                id: turnId,
                controller: new AbortController(),
                completed: yield* Deferred.make<void>(),
                cancellationRequested: false,
                assistantTextStreamed: false,
                queuedInputCount: 0,
                awaitingQueuedRun: false,
                queuedActionObserved: false,
                completedRunMessages: [],
              };
              context.activeTurn = turn;
              context.session = {
                ...context.session,
                activeTurnId: turnId,
                status: "running",
                updatedAt: yield* nowIso,
              };
              return {
                _tag: "Started" as const,
                context,
                turn,
                text,
                images,
                requestedModel,
                turnControls,
              };
            }),
          );
          if (prepared._tag === "Steered") return prepared.result;
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
              withThreadLock(
                context.threadId,
                Effect.gen(function* () {
                  if (context.activeTurn !== turn) return;
                  turn.cancellationRequested = true;
                  turn.controller.abort();
                  yield* context.runtime.abortAndClearQueue.pipe(Effect.ignore);
                  yield* settleActiveTurnLocked(context, turn, { state: "cancelled" });
                }),
              ),
            ),
          );
        }),
      );

    const interruptTurn: PrimeAgentAdapterShape["interruptTurn"] = (threadId, turnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const context = sessions.get(threadId);
          if (context === undefined || context.stopped || context.stopRequested) {
            return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
          }
          const turn = context.activeTurn;
          if (turnId !== undefined && turn?.id !== turnId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "interruptTurn",
              issue: `Turn '${turnId}' is not active.`,
            });
          }
          if (turn !== undefined) {
            turn.cancellationRequested = true;
            turn.controller.abort();
          }
          yield* clearPendingApprovalsLocked(context, true);
          const abortExit = yield* context.runtime.abortAndClearQueue.pipe(
            Effect.mapError((error) =>
              runtimeOperationError(threadId, "session/abort-and-clear-queue", error),
            ),
            Effect.exit,
          );
          if (turn !== undefined) {
            yield* settleActiveTurnLocked(context, turn, { state: "cancelled" });
          }
          if (Exit.isFailure(abortExit)) return yield* Effect.failCause(abortExit.cause);
        }),
      );

    const respondToRequest: PrimeAgentAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          const pending = context.pendingApprovals.get(requestId);
          if (pending === undefined) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/request",
              detail: `Unknown or stale Prime Agent approval '${requestId}' for thread '${threadId}'.`,
            });
          }
          const confirmed = decision === "accept" || decision === "acceptForSession";
          if (decision === "cancel") context.approvalsAcceptedForSession = false;
          yield* context.runtime
            .respondToExtensionUiRequest(pending.nativeId, { confirmed })
            .pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/approval-response", error),
              ),
            );
          if (!context.pendingApprovals.delete(requestId)) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/request",
              detail: `Prime Agent approval '${requestId}' was already resolved.`,
            });
          }
          if (decision === "acceptForSession") context.approvalsAcceptedForSession = true;
          yield* offerRuntimeEvent({
            type: "request.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId,
            ...(context.activeTurn === undefined ? {} : { turnId: context.activeTurn.id }),
            requestId: RuntimeRequestId.make(requestId),
            payload: { requestType: pending.requestType, decision },
          });
          if (decision === "cancel") {
            const turn = context.activeTurn;
            if (turn !== undefined) {
              turn.cancellationRequested = true;
              turn.controller.abort();
            }
            const abortExit = yield* context.runtime.abortAndClearQueue.pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/abort-and-clear-queue", error),
              ),
              Effect.exit,
            );
            if (turn !== undefined) {
              yield* settleActiveTurnLocked(context, turn, { state: "cancelled" });
            }
            if (Exit.isFailure(abortExit)) return yield* Effect.failCause(abortExit.cause);
          }
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
