import {
  ApprovalRequestId,
  EventId,
  ProviderAskSessionSideQuestionInput,
  PROVIDER_SESSION_AGENT_DEPTH_MAX_SETTABLE,
  PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS,
  PROVIDER_SESSION_AGENT_ACTIVITY_LIFETIME_MAX_CHARS,
  PROVIDER_SESSION_AGENT_ACTIVITY_LIFETIME_MAX_UPDATES,
  PROVIDER_SESSION_AGENT_ACTIVITY_MAX_CONCURRENT_WATCHERS,
  PROVIDER_SESSION_INPUT_QUEUE_MAX_COUNT,
  type PrimeAgentSettings,
  type ProviderAskSessionSideQuestionResult,
  type ProviderCancelSessionSideQuestionResult,
  type ProviderSessionSideQuestionRequestId,
  type ProviderRefineSessionHarnessResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  SessionInteractionRequest,
  SessionInteractionRequestId,
  SessionInteractionResponse,
  SessionPresentation,
  type SessionAgentDepthUpdatedPayload,
  type SessionCompactionUpdatedPayload,
  type SessionGoalUpdatedPayload,
  type SessionHarnessRefinementUpdatedPayload,
  type SessionInputQueueUpdatedPayload,
  type ProviderSessionAgentActivitySnapshot,
  type ProviderSessionAgentActivityTimelineEntry,
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
import * as Result from "effect/Result";
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
  ProviderAdapterUnsupportedOperationError,
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
  makePrimeAgentEventPubSub,
  shutdownPrimeAgentEventPubSub,
} from "./PrimeAgentEventBuffer.ts";
import {
  PRIME_AGENT_INHERIT_MODEL_OPTION,
  type PrimeAgentTurnControlsResult,
  resolvePrimeAgentTurnControls,
} from "./PrimeAgentModelOptions.ts";
import {
  mapPrimeAgentContextUsageDraft,
  mapPrimeAgentDaemonRuntimeEventDrafts,
} from "./PrimeAgentDaemonRuntimeEvents.ts";
import {
  PRIME_AGENT_STOPPED_WITHOUT_FINAL_RESPONSE,
  PRIME_AGENT_TURN_FAILED,
  primeAgentMissingFinalResponseDetail,
} from "./PrimeAgentTerminalResponse.ts";
import {
  PRIME_AGENT_PERMISSION_EXTENSION_FILENAME,
  PRIME_AGENT_PERMISSION_EXTENSION_MARKER_COMMAND,
  makePrimeAgentPermissionExtensionSource,
  projectPrimeAgentManagedPermissionRequest,
  type PrimeAgentManagedPermissionRequestType,
} from "./PrimeAgentPermissionExtension.ts";
import {
  makePrimeAgentDaemonSessionRuntime,
  type PrimeAgentDaemonCatalogModel,
  type PrimeAgentDaemonChild,
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
/** Defers to Prime's own configured or restored model instead of forcing one. */
const PRIME_AGENT_DEFAULT_MODEL = "default";
const SESSION_STATS_TIMEOUT_MS = 1_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
export const PRIME_AGENT_FAILED_RUN_SETTLEMENT_GRACE_MS = 3_000;
export const PRIME_AGENT_SIDE_QUESTION_TIMEOUT_MS = 2 * 60_000;
const PRIME_AGENT_SIDE_QUESTION_MAX_ACTIVE = 4;
const unavailableSessionGoal: SessionGoalUpdatedPayload = {
  available: false,
  active: false,
  status: "idle",
  tokensUsed: 0,
  timeUsedSeconds: 0,
  continuationsUsed: 0,
};

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
  readonly onModelsDiscovered?: (
    models: ReadonlyArray<PrimeAgentDaemonCatalogModel>,
  ) => Effect.Effect<void>;
}

interface PrimeAgentDaemonActiveTurn {
  readonly id: TurnId;
  readonly controller: AbortController;
  readonly completed: Deferred.Deferred<void>;
  cancellationRequested: boolean;
  assistantTextStreamed: boolean;
  nextAssistantMessageSequence: number;
  activeAssistantItemId: RuntimeItemId | undefined;
  lastAssistantHadRenderableText: boolean;
  runCompletionHandoffSequence: number;
  pendingRunCompletionHandoff:
    | {
        readonly sequence: number;
        readonly event: Extract<PrimeDaemonEvent, { readonly _tag: "RunCompleted" }>;
      }
    | undefined;
  queuedInputCount: number;
  awaitingQueuedRun: boolean;
  queuedActionObserved: boolean;
  readonly completedRunMessages: Array<PrimeDaemonMessage>;
  readonly command?: "compact" | undefined;
}

type PrimeAgentDaemonBlockingInteractionMethod = "select" | "confirm" | "input";

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
const decodeAskSessionSideQuestionInput = Schema.decodeUnknownOption(
  ProviderAskSessionSideQuestionInput,
);
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

interface PrimeAgentDaemonSharedActivityStream {
  readonly nativeActiveSessionId: string;
  readonly stop: Deferred.Deferred<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly stream: Stream.Stream<
    ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>,
    PrimeAgentDaemonSessionRuntimeError
  >;
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
  autoCompactionEnabled: boolean;
  compaction: SessionCompactionUpdatedPayload;
  goal: SessionGoalUpdatedPayload;
  agentDepth: SessionAgentDepthUpdatedPayload;
  inputQueue: SessionInputQueueUpdatedPayload;
  inputQueueClearPending: boolean;
  nativeQueueActionActive: boolean;
  lifecycleStarted: boolean;
  usageRefreshSequence: number;
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
  nativeRunActive: boolean;
  nativeBashActive: boolean;
  readonly activeNativeChildren: Set<string>;
  readonly knownNativeChildren: Map<string, PrimeAgentDaemonChild>;
  readonly cancellationPendingNativeChildren: Set<string>;
  readonly activityWatchStops: Map<string, Set<Deferred.Deferred<void, ProviderAdapterError>>>;
  readonly sharedActivityStreams: Map<string, PrimeAgentDaemonSharedActivityStream>;
  activeActivityWatcherCount: number;
  agentRosterProjected: boolean;
  resourceReloadCompletion: Deferred.Deferred<void> | undefined;
  readonly restored: boolean;
  activeRefinement:
    | {
        readonly completion: Deferred.Deferred<
          ProviderRefineSessionHarnessResult,
          ProviderAdapterRequestError
        >;
      }
    | undefined;
  activeCompactionScope: { readonly turnId?: TurnId | undefined } | undefined;
  manualCompactionRequestActive: boolean;
  compactionAbortRequested: boolean;
  stopRequested: boolean;
  stopped: boolean;
  exitEmitted: boolean;
}

interface PrimeAgentDaemonActiveSideQuestion {
  readonly requestId: ProviderSessionSideQuestionRequestId;
  readonly nativeId: string;
  readonly context: PrimeAgentDaemonSessionContext;
  readonly sessionEnded: Deferred.Deferred<void>;
  cancelRequested: boolean;
}

type PrimeAgentDaemonChildDurableProjection = {
  readonly status: PrimeAgentDaemonChild["status"];
  readonly label: string;
  readonly parentId: string | undefined;
  readonly model: string | undefined;
  readonly messageable: boolean;
  readonly waiting: boolean;
  readonly lastToolName: string | undefined;
  readonly tokenCount: number | undefined;
  readonly toolUseCount: number | undefined;
  readonly terminalDurationMs: number | undefined;
};

function durableChildText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function durableChildCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function durableChildProjection(
  child: PrimeAgentDaemonChild,
): PrimeAgentDaemonChildDurableProjection {
  const active = child.status === "queued" || child.status === "running";
  return {
    status: child.status,
    label: durableChildText(child.label) ?? child.id,
    parentId: durableChildText(child.parentId),
    model: durableChildText(child.model),
    messageable: active && durableChildText(child.activeSessionId) !== undefined,
    waiting: child.status === "running" && child.activity?.kind === "waiting",
    lastToolName:
      child.status === "running" && child.activity?.kind !== "waiting"
        ? durableChildText(child.activity?.toolName)
        : undefined,
    tokenCount: durableChildCount(child.tokenCount),
    toolUseCount: durableChildCount(child.toolUseCount),
    terminalDurationMs: active ? undefined : durableChildCount(child.durationMs),
  };
}

function durableChildChanged(
  previous: PrimeAgentDaemonChild | undefined,
  next: PrimeAgentDaemonChild,
): boolean {
  if (previous === undefined) return true;
  const left = durableChildProjection(previous);
  const right = durableChildProjection(next);
  return (
    left.status !== right.status ||
    left.label !== right.label ||
    left.parentId !== right.parentId ||
    left.model !== right.model ||
    left.messageable !== right.messageable ||
    left.waiting !== right.waiting ||
    left.lastToolName !== right.lastToolName ||
    left.tokenCount !== right.tokenCount ||
    left.toolUseCount !== right.toolUseCount ||
    left.terminalDurationMs !== right.terminalDurationMs
  );
}

type TurnOutcome =
  | {
      readonly state: "completed";
      readonly event: Extract<PrimeDaemonEvent, { readonly _tag: "RunCompleted" }>;
    }
  | { readonly state: "completedWithoutMessage" }
  | { readonly state: "failed"; readonly errorMessage: string }
  | { readonly state: "cancelled" };

type PrimeAgentRunCompletedEvent = Extract<PrimeDaemonEvent, { readonly _tag: "RunCompleted" }>;

function primeAgentRunCompletedNeedsHandoff(event: PrimeAgentRunCompletedEvent): boolean {
  const lastAssistant = event.messages.findLast((message) => message.role === "assistant");
  if (lastAssistant?.stopReason === "aborted") return false;
  return (
    lastAssistant?.stopReason === "error" ||
    (lastAssistant?.errorMessage?.trim().length ?? 0) > 0 ||
    lastAssistant?.stopReason === "toolUse" ||
    (lastAssistant?.toolCalls.length ?? 0) > 0
  );
}

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
    const activeSideQuestions = new Map<ThreadId, PrimeAgentDaemonActiveSideQuestion>();
    let nextModelDiscoveryGeneration = 0;
    let publishedModelDiscoveryGeneration = 0;
    const modelPublicationSemaphore = yield* Semaphore.make(1);
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* makePrimeAgentEventPubSub<ProviderRuntimeEvent>();

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
      PubSub.publish(runtimeEventPubSub, event).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.void
            : Effect.logError("Prime Agent runtime event was not accepted.", {
                component: "daemon",
                eventType: event.type,
                threadId: event.threadId,
                outcome: "forced-drop-after-shutdown",
              }),
        ),
      );

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

    const withThreadMutationLock = <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
      interruptibleWait = false,
    ): Effect.Effect<A, E, R> =>
      Effect.suspend(() =>
        withThreadLock(
          threadId,
          Effect.gen(function* () {
            const completion = sessions.get(threadId)?.resourceReloadCompletion;
            if (completion !== undefined) {
              return { _tag: "Wait" as const, completion };
            }
            return { _tag: "Result" as const, value: yield* effect };
          }),
        ).pipe(
          Effect.flatMap((outcome) =>
            outcome._tag === "Result"
              ? Effect.succeed(outcome.value)
              : (interruptibleWait
                  ? Effect.interruptible(Deferred.await(outcome.completion))
                  : Deferred.await(outcome.completion)
                ).pipe(Effect.andThen(withThreadMutationLock(threadId, effect, interruptibleWait))),
          ),
        ),
      );

    const refreshDiscoveredModels = (context: PrimeAgentDaemonSessionContext) => {
      const publish = options?.onModelsDiscovered;
      if (publish === undefined) return Effect.void;

      const generation = ++nextModelDiscoveryGeneration;
      return context.runtime.discoverAvailableModels.pipe(
        Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.logWarning(
                "Prime Agent daemon model discovery timed out; keeping the last catalog.",
              ),
            onSome: (models) =>
              modelPublicationSemaphore.withPermits(1)(
                withThreadLock(
                  context.threadId,
                  Effect.sync(() => {
                    if (
                      sessions.get(context.threadId) !== context ||
                      context.stopped ||
                      context.stopRequested ||
                      generation < publishedModelDiscoveryGeneration
                    ) {
                      return false;
                    }
                    publishedModelDiscoveryGeneration = generation;
                    return true;
                  }),
                ).pipe(
                  Effect.flatMap((shouldPublish) =>
                    shouldPublish ? publish(models) : Effect.void,
                  ),
                ),
              ),
          }),
        ),
        Effect.catch(() =>
          Effect.logWarning("Prime Agent daemon model discovery failed; keeping the last catalog."),
        ),
        Effect.forkIn(context.scope),
        Effect.asVoid,
      );
    };

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

    /** Must be called with the thread lock held. */
    const requestActiveSideQuestionAbortLocked = (context: PrimeAgentDaemonSessionContext) =>
      Effect.gen(function* () {
        const active = activeSideQuestions.get(context.threadId);
        if (active === undefined || active.context !== context) return false;
        if (!active.cancelRequested) {
          active.cancelRequested = true;
          yield* context.runtime.abortSideQuestion(active.nativeId).pipe(Effect.ignore);
        }
        return true;
      });

    /** Must be called with the thread lock held. */
    const endActiveSideQuestionLocked = (context: PrimeAgentDaemonSessionContext) =>
      Effect.gen(function* () {
        const active = activeSideQuestions.get(context.threadId);
        if (active === undefined || active.context !== context) return false;
        if (!active.cancelRequested) {
          active.cancelRequested = true;
          yield* context.runtime.abortSideQuestion(active.nativeId).pipe(Effect.ignore);
        }
        yield* Deferred.succeed(active.sessionEnded, undefined);
        return true;
      });

    const publishSessionResources = (
      threadId: ThreadId,
      payload: PrimeAgentDaemonSessionRuntime["initialResources"],
    ) =>
      Effect.flatMap(makeEventStamp(), (eventStamp) =>
        offerRuntimeEvent({
          type: "session.resources.updated",
          ...eventStamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          payload,
        }),
      );

    const publishSessionAgentDepth = (
      threadId: ThreadId,
      payload: SessionAgentDepthUpdatedPayload,
    ) =>
      Effect.flatMap(makeEventStamp(), (eventStamp) =>
        offerRuntimeEvent({
          type: "session.agent-depth.updated",
          ...eventStamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          payload,
        }),
      );

    const publishSessionCompaction = (
      threadId: ThreadId,
      payload: SessionCompactionUpdatedPayload,
    ) =>
      Effect.flatMap(makeEventStamp(), (eventStamp) =>
        offerRuntimeEvent({
          type: "session.compaction.updated",
          ...eventStamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          payload,
        }),
      );

    const publishSessionHarnessRefinement = (
      threadId: ThreadId,
      payload: SessionHarnessRefinementUpdatedPayload,
    ) =>
      Effect.flatMap(makeEventStamp(), (eventStamp) =>
        offerRuntimeEvent({
          type: "session.harness-refinement.updated",
          ...eventStamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          payload,
        }),
      );

    const publishSessionGoal = (threadId: ThreadId, payload: SessionGoalUpdatedPayload) =>
      Effect.flatMap(makeEventStamp(), (eventStamp) =>
        offerRuntimeEvent({
          type: "session.goal.updated",
          ...eventStamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          payload,
        }),
      );

    const publishSessionInputQueue = (
      threadId: ThreadId,
      payload: SessionInputQueueUpdatedPayload,
    ) =>
      Effect.flatMap(makeEventStamp(), (eventStamp) =>
        offerRuntimeEvent({
          type: "session.input-queue.updated",
          ...eventStamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          payload,
        }),
      );

    /** Must be called with the thread lock held. */
    const updateInputQueueProjection = (
      context: PrimeAgentDaemonSessionContext,
      next: SessionInputQueueUpdatedPayload,
      options?: { readonly preserveModes?: boolean },
    ) =>
      Effect.gen(function* () {
        const preserveModes = options?.preserveModes ?? true;
        const steeringMode =
          next.steeringMode ?? (preserveModes ? context.inputQueue.steeringMode : undefined);
        const followUpMode =
          next.followUpMode ?? (preserveModes ? context.inputQueue.followUpMode : undefined);
        const resolved = {
          steeringCount: next.steeringCount,
          followUpCount: next.followUpCount,
          ...(steeringMode === undefined ? {} : { steeringMode }),
          ...(followUpMode === undefined ? {} : { followUpMode }),
        } satisfies SessionInputQueueUpdatedPayload;
        const changed =
          context.inputQueue.steeringCount !== resolved.steeringCount ||
          context.inputQueue.followUpCount !== resolved.followUpCount ||
          context.inputQueue.steeringMode !== resolved.steeringMode ||
          context.inputQueue.followUpMode !== resolved.followUpMode;
        context.inputQueue = resolved;
        if (changed) yield* publishSessionInputQueue(context.threadId, resolved);
      });

    /** Must be called with the thread lock held. */
    const updateGoalProjection = (
      context: PrimeAgentDaemonSessionContext,
      next: SessionGoalUpdatedPayload,
    ) =>
      Effect.gen(function* () {
        const changed =
          context.goal.available !== next.available ||
          context.goal.active !== next.active ||
          context.goal.status !== next.status ||
          context.goal.objective !== next.objective ||
          context.goal.tokenBudget !== next.tokenBudget ||
          context.goal.tokensUsed !== next.tokensUsed ||
          context.goal.timeUsedSeconds !== next.timeUsedSeconds ||
          context.goal.continuationsUsed !== next.continuationsUsed;
        context.goal = next;
        if (changed) yield* publishSessionGoal(context.threadId, next);
      });

    const isAgentDepthSettable = (context: PrimeAgentDaemonSessionContext): boolean =>
      context.agentDepth.writable &&
      context.resourceReloadCompletion === undefined &&
      context.session.status === "ready" &&
      context.activeTurn === undefined &&
      !context.nativeRunActive &&
      !context.nativeBashActive &&
      context.activeNativeChildren.size === 0 &&
      context.activeCompactionScope === undefined &&
      !context.manualCompactionRequestActive &&
      context.pendingApprovals.size === 0 &&
      context.pendingInteractions.size === 0;

    /** Must be called with the thread lock held. */
    const syncAgentDepthSettableLocked = (context: PrimeAgentDaemonSessionContext) =>
      Effect.gen(function* () {
        const settable = isAgentDepthSettable(context);
        if (context.agentDepth.settable === settable) return;
        context.agentDepth = { ...context.agentDepth, settable };
        yield* publishSessionAgentDepth(context.threadId, context.agentDepth);
      });

    const isManualCompactionSettable = (context: PrimeAgentDaemonSessionContext): boolean =>
      context.compaction.available &&
      context.compaction.status === "idle" &&
      context.resourceReloadCompletion === undefined &&
      context.session.status === "ready" &&
      context.activeTurn === undefined &&
      !context.nativeRunActive &&
      !context.nativeBashActive &&
      !context.nativeQueueActionActive &&
      context.inputQueue.steeringCount === 0 &&
      context.inputQueue.followUpCount === 0 &&
      context.activeNativeChildren.size === 0 &&
      context.activeCompactionScope === undefined &&
      !context.manualCompactionRequestActive &&
      context.pendingApprovals.size === 0 &&
      context.pendingInteractions.size === 0;

    /** Must be called with the thread lock held. */
    const updateCompactionProjectionLocked = (
      context: PrimeAgentDaemonSessionContext,
      patch: Partial<SessionCompactionUpdatedPayload> = {},
    ) =>
      Effect.gen(function* () {
        const base = { ...context.compaction, ...patch };
        const next = {
          ...base,
          manualCompactionSettable:
            base.available && base.status === "idle"
              ? isManualCompactionSettable({ ...context, compaction: base })
              : false,
        } satisfies SessionCompactionUpdatedPayload;
        const changed =
          context.compaction.available !== next.available ||
          context.compaction.status !== next.status ||
          context.compaction.abortable !== next.abortable ||
          context.compaction.autoCompactionEnabled !== next.autoCompactionEnabled ||
          context.compaction.autoCompactionWritable !== next.autoCompactionWritable ||
          context.compaction.manualCompactionSettable !== next.manualCompactionSettable ||
          context.compaction.autoCompactionScope !== next.autoCompactionScope;
        context.compaction = next;
        context.autoCompactionEnabled = next.autoCompactionEnabled ?? false;
        if (changed) yield* publishSessionCompaction(context.threadId, next);
      });

    const publishDrafts = (
      context: PrimeAgentDaemonSessionContext,
      event: PrimeDaemonEvent,
      turn: PrimeAgentDaemonActiveTurn | undefined,
    ) =>
      Effect.gen(function* () {
        let allocatedAssistantItemLazily = false;
        const allocateAssistantItemId = () => {
          if (turn === undefined) return undefined;
          const itemId = RuntimeItemId.make(
            `assistant:${turn.id}:segment:${turn.nextAssistantMessageSequence}`,
          );
          turn.nextAssistantMessageSequence += 1;
          turn.activeAssistantItemId = itemId;
          return itemId;
        };
        if (
          turn !== undefined &&
          event._tag === "MessageStarted" &&
          event.message.role === "assistant"
        ) {
          // Prime emits one assistant message per model/tool loop. A turn-scoped
          // item id strands later final text at the first message's timestamp.
          // Use an opaque subscriber-local sequence instead of native identity.
          allocateAssistantItemId();
          turn.assistantTextStreamed = false;
        } else if (
          turn !== undefined &&
          turn.activeAssistantItemId === undefined &&
          ((event._tag === "AssistantStream" && event.kind === "text") ||
            (event._tag === "MessageCompleted" && event.message.role === "assistant"))
        ) {
          // The public stream is ordered, but reconnect recovery can omit a
          // start. Allocate lazily rather than merging into an earlier item.
          allocateAssistantItemId();
          turn.assistantTextStreamed = false;
          allocatedAssistantItemLazily = true;
        }
        const compactionScope =
          event._tag === "CompactionStarted" || event._tag === "CompactionCompleted"
            ? context.activeCompactionScope
            : undefined;
        const runtimeTurnId = compactionScope === undefined ? turn?.id : compactionScope.turnId;
        if (
          allocatedAssistantItemLazily &&
          runtimeTurnId !== undefined &&
          turn?.activeAssistantItemId !== undefined
        ) {
          yield* offerRuntimeEvent({
            type: "item.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId: runtimeTurnId,
            itemId: turn.activeAssistantItemId,
            payload: { itemType: "assistant_message", status: "inProgress" },
          });
        }
        const drafts = mapPrimeAgentDaemonRuntimeEventDrafts({
          event,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          ...(runtimeTurnId === undefined ? {} : { turnId: runtimeTurnId }),
          ...(turn === undefined
            ? {}
            : {
                assistantItemId: turn.activeAssistantItemId,
                assistantTextStreamed: turn.assistantTextStreamed,
              }),
        });
        for (const draft of drafts) {
          yield* offerRuntimeEvent({ ...draft, ...(yield* makeEventStamp()) });
        }
        if (
          turn !== undefined &&
          event._tag === "AssistantStream" &&
          event.kind === "text" &&
          event.phase === "delta" &&
          event.delta !== undefined &&
          event.delta.trim().length > 0
        ) {
          turn.assistantTextStreamed = true;
        }
        if (
          turn !== undefined &&
          event._tag === "MessageCompleted" &&
          event.message.role === "assistant"
        ) {
          turn.lastAssistantHadRenderableText =
            event.message.text.trim().length > 0 &&
            event.message.stopReason !== "toolUse" &&
            event.message.toolCalls.length === 0;
          turn.activeAssistantItemId = undefined;
        }
      });

    /** Must be called with the thread lock held. Reservations leave only in stream finalizers. */
    const signalInactiveActivityWatchesLocked = (
      context: PrimeAgentDaemonSessionContext,
      agentId?: string,
    ) =>
      Effect.gen(function* () {
        const endpointChangedAgents = new Set<string>();
        const sharedEntries =
          agentId === undefined
            ? [...context.sharedActivityStreams.entries()]
            : ([[agentId, context.sharedActivityStreams.get(agentId)]] as const);
        for (const [watchedAgentId, shared] of sharedEntries) {
          if (shared === undefined) continue;
          const child = context.knownNativeChildren.get(watchedAgentId);
          const nativeActiveSessionId = child?.activeSessionId?.trim();
          const childActive =
            child !== undefined && (child.status === "queued" || child.status === "running");
          const endpointChanged =
            childActive && nativeActiveSessionId !== shared.nativeActiveSessionId;
          const remainsWatchable = agentId === undefined && childActive && !endpointChanged;
          if (remainsWatchable) continue;
          if (endpointChanged) endpointChangedAgents.add(watchedAgentId);
          context.sharedActivityStreams.delete(watchedAgentId);
          if (!endpointChanged) {
            yield* Deferred.succeed(shared.stop, undefined).pipe(Effect.ignore, Effect.forkDetach);
          }
        }

        const watchEntries =
          agentId === undefined
            ? context.activityWatchStops.entries()
            : ([[agentId, context.activityWatchStops.get(agentId)]] as const);
        for (const [watchedAgentId, stops] of watchEntries) {
          if (stops === undefined) continue;
          const child = context.knownNativeChildren.get(watchedAgentId);
          const endpointChanged = endpointChangedAgents.has(watchedAgentId);
          if (
            !endpointChanged &&
            agentId === undefined &&
            child !== undefined &&
            (child.status === "queued" || child.status === "running")
          ) {
            continue;
          }
          for (const stop of stops) {
            yield* (
              endpointChanged
                ? Deferred.fail(
                    stop,
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/watch-agent-activity",
                      detail: "The live agent activity endpoint changed.",
                    }),
                  )
                : Deferred.succeed(stop, undefined)
            ).pipe(Effect.ignore, Effect.forkDetach);
          }
        }
      });

    const applyAgentRosterSnapshot = (
      context: PrimeAgentDaemonSessionContext,
      children: ReadonlyArray<PrimeAgentDaemonChild>,
      publishChildren = true,
    ) =>
      Effect.gen(function* () {
        const previousChildren = new Map(context.knownNativeChildren);
        const initialProjection = !context.agentRosterProjected;
        const previousActive = new Map(
          [...previousChildren].filter(
            ([, child]) => child.status === "queued" || child.status === "running",
          ),
        );
        context.knownNativeChildren.clear();
        context.activeNativeChildren.clear();
        for (const child of children) {
          const previous = previousChildren.get(child.id);
          const previousSettled =
            previous !== undefined && previous.status !== "queued" && previous.status !== "running";
          const authoritativeChild = previousSettled ? previous : child;
          context.knownNativeChildren.set(authoritativeChild.id, authoritativeChild);
          previousActive.delete(child.id);
          if (authoritativeChild.status === "queued" || authoritativeChild.status === "running") {
            context.activeNativeChildren.add(authoritativeChild.id);
          } else {
            context.cancellationPendingNativeChildren.delete(authoritativeChild.id);
          }
          if (
            publishChildren &&
            !previousSettled &&
            (initialProjection || durableChildChanged(previous, authoritativeChild))
          ) {
            yield* publishDrafts(
              context,
              { _tag: "ChildUpdated", child: authoritativeChild },
              context.activeTurn,
            );
          }
        }
        // A replacement snapshot is authoritative for live descendants. If a previously
        // active child disappeared while disconnected, settle its stable row instead of
        // leaving every client showing an agent that can no longer be controlled.
        for (const child of previousActive.values()) {
          const settled = { ...child, status: "cancelled" as const, error: undefined };
          context.knownNativeChildren.set(settled.id, settled);
          context.cancellationPendingNativeChildren.delete(settled.id);
          yield* publishDrafts(
            context,
            { _tag: "ChildUpdated", child: settled },
            context.activeTurn,
          );
        }
        yield* signalInactiveActivityWatchesLocked(context);
        context.agentRosterProjected = true;
        yield* syncAgentDepthSettableLocked(context);
        yield* updateCompactionProjectionLocked(context);
      });

    const refreshContextUsage = (context: PrimeAgentDaemonSessionContext) =>
      Effect.gen(function* () {
        const refreshSequence = ++context.usageRefreshSequence;
        const statsOption = yield* context.runtime.getSessionStats.pipe(
          Effect.timeoutOption(SESSION_STATS_TIMEOUT_MS),
          Effect.orElseSucceed(() => Option.none()),
        );
        if (Option.isNone(statsOption)) {
          yield* Effect.logWarning("Prime Agent session usage could not be refreshed.", {
            threadId: context.threadId,
          });
          return;
        }
        if (
          sessions.get(context.threadId) !== context ||
          context.stopped ||
          context.usageRefreshSequence !== refreshSequence
        ) {
          return;
        }
        const draft = mapPrimeAgentContextUsageDraft({
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          stats: statsOption.value,
          compactsAutomatically: context.autoCompactionEnabled,
        });
        yield* offerRuntimeEvent({ ...draft, ...(yield* makeEventStamp()) });
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
        turn.pendingRunCompletionHandoff = undefined;
        if (effectiveOutcome.state === "failed" && !turn.lastAssistantHadRenderableText) {
          yield* offerRuntimeEvent({
            type: "runtime.error",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId: turn.id,
            payload: {
              message: PRIME_AGENT_STOPPED_WITHOUT_FINAL_RESPONSE,
              class: "provider_error",
              detail: primeAgentMissingFinalResponseDetail("failed"),
            },
          });
        }
        if (effectiveOutcome.state === "completed") {
          yield* publishDrafts(context, effectiveOutcome.event, turn);
          context.turns.push({ id: turn.id, items: [] });
        } else {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId: turn.id,
            payload:
              effectiveOutcome.state === "completedWithoutMessage"
                ? { state: "completed" }
                : effectiveOutcome.state === "cancelled"
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

    const promotePendingRunCompletionToQueuedRun = (turn: PrimeAgentDaemonActiveTurn) => {
      const pending = turn.pendingRunCompletionHandoff;
      if (pending === undefined) return;
      turn.completedRunMessages.push(...pending.event.messages);
      turn.pendingRunCompletionHandoff = undefined;
      turn.awaitingQueuedRun = true;
      turn.queuedActionObserved = false;
    };

    const schedulePendingRunCompletionHandoff = (
      context: PrimeAgentDaemonSessionContext,
      turn: PrimeAgentDaemonActiveTurn,
      sequence: number,
    ) =>
      Effect.forkIn(
        Effect.sleep(PRIME_AGENT_FAILED_RUN_SETTLEMENT_GRACE_MS).pipe(
          Effect.andThen(
            withThreadLock(
              context.threadId,
              Effect.gen(function* () {
                const pending = turn.pendingRunCompletionHandoff;
                if (pending === undefined || pending.sequence !== sequence) return;
                // Prime emits agent_end before it checks for automatic compaction. A
                // long compaction must not exhaust the short reconnect handoff grace;
                // its terminal event or snapshot starts fresh continuation grace.
                if (context.activeCompactionScope !== undefined) return;
                turn.pendingRunCompletionHandoff = undefined;
                const completionEvent =
                  turn.completedRunMessages.length === 0
                    ? pending.event
                    : {
                        ...pending.event,
                        messages: [...turn.completedRunMessages, ...pending.event.messages],
                      };
                const settled = yield* settleActiveTurnLocked(context, turn, {
                  state: "completed",
                  event: completionEvent,
                });
                if (settled) yield* refreshContextUsage(context).pipe(Effect.forkDetach);
              }),
            ),
          ),
        ),
        context.scope,
      ).pipe(Effect.asVoid);

    /** Must be called with the thread lock held. */
    const restartPendingRunCompletionHandoffLocked = (
      context: PrimeAgentDaemonSessionContext,
      turn: PrimeAgentDaemonActiveTurn,
    ) =>
      Effect.gen(function* () {
        const pending = turn.pendingRunCompletionHandoff;
        if (pending === undefined) return;
        turn.runCompletionHandoffSequence += 1;
        const sequence = turn.runCompletionHandoffSequence;
        turn.pendingRunCompletionHandoff = { ...pending, sequence };
        yield* schedulePendingRunCompletionHandoff(context, turn, sequence);
      });

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
        yield* syncAgentDepthSettableLocked(context);
        yield* updateCompactionProjectionLocked(context);
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
        yield* syncAgentDepthSettableLocked(context);
        yield* updateCompactionProjectionLocked(context);
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
        if (event._tag === "SessionResynced") {
          yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              if (sessions.get(context.threadId) === context && !context.stopped) {
                context.autoCompactionEnabled = event.state.autoCompactionEnabled;
                context.nativeRunActive = event.state.isStreaming;
                context.nativeBashActive = event.state.isBashRunning;
                const compactionWasActive = context.activeCompactionScope !== undefined;
                context.activeCompactionScope = event.state.isCompacting
                  ? (context.activeCompactionScope ?? {})
                  : undefined;
                if (!event.state.isCompacting && !context.manualCompactionRequestActive) {
                  context.compactionAbortRequested = false;
                }
                const initialRosterAlreadyProjected =
                  context.agentRosterProjected &&
                  event.lastEventSequence !== undefined &&
                  event.lastEventSequence === context.runtime.initialSnapshot.lastEventSequence;
                yield* applyAgentRosterSnapshot(
                  context,
                  event.children,
                  !initialRosterAlreadyProjected,
                );
                context.nativeQueueActionActive = event.state.inputQueue.activeAction;
                yield* updateInputQueueProjection(context, event.state.inputQueue);
                yield* updateGoalProjection(
                  context,
                  context.session.runtimeMode === "full-access"
                    ? event.state.goal
                    : unavailableSessionGoal,
                );
                yield* updateCompactionProjectionLocked(context, {
                  status:
                    (context.manualCompactionRequestActive &&
                      context.compaction.status === "starting") ||
                    (context.compactionAbortRequested &&
                      event.state.isCompacting &&
                      context.compaction.status === "abort-requested")
                      ? context.compaction.status
                      : event.state.isCompacting
                        ? "compacting"
                        : "idle",
                  abortable:
                    event.state.isCompacting && context.manualCompactionRequestActive
                      ? context.compaction.abortable
                      : false,
                  ...(context.compaction.available
                    ? { autoCompactionEnabled: event.state.autoCompactionEnabled }
                    : {}),
                });
                const turn = context.activeTurn;
                if (turn !== undefined) {
                  turn.queuedInputCount =
                    event.state.inputQueue.steeringCount + event.state.inputQueue.followUpCount;
                  const authoritativeIdle =
                    turn.queuedInputCount === 0 &&
                    !event.state.inputQueue.activeAction &&
                    !event.state.isStreaming;
                  if (turn.pendingRunCompletionHandoff !== undefined) {
                    if (event.state.isStreaming) {
                      // The continuation may have started while disconnected,
                      // so the resync snapshot is an authoritative RunStarted.
                      turn.completedRunMessages.push(
                        ...turn.pendingRunCompletionHandoff.event.messages,
                      );
                      turn.pendingRunCompletionHandoff = undefined;
                    } else if (compactionWasActive && !event.state.isCompacting) {
                      // The compaction terminal event may have been lost while
                      // disconnected. Replace its consumed grace from the snapshot.
                      yield* restartPendingRunCompletionHandoffLocked(context, turn);
                    }
                    // An idle snapshot can be the gap before RunStarted. Keep
                    // the bounded handoff alive until the event or timeout.
                  } else if (turn.awaitingQueuedRun && authoritativeIdle) {
                    const explicitClear = context.inputQueueClearPending;
                    context.inputQueueClearPending = false;
                    if (explicitClear) {
                      const settled = yield* settleActiveTurnLocked(context, turn, {
                        state: "completed",
                        event: { _tag: "RunCompleted", messages: turn.completedRunMessages },
                      });
                      if (settled) yield* refreshContextUsage(context).pipe(Effect.forkDetach);
                    } else {
                      yield* settleActiveTurnLocked(context, turn, {
                        state: "failed",
                        errorMessage: turn.queuedActionObserved
                          ? "Prime Agent queued input ended before a native run started."
                          : "Prime Agent could not reconcile the active turn after reconnecting.",
                      });
                      context.stopRequested = true;
                    }
                  } else if (authoritativeIdle) {
                    yield* settleActiveTurnLocked(context, turn, {
                      state: "failed",
                      errorMessage:
                        "Prime Agent could not reconcile the active turn after reconnecting.",
                    });
                    context.stopRequested = true;
                  }
                }
              }
            }),
          );
          if (context.stopRequested && !context.stopped) {
            yield* withThreadMutationLock(
              context.threadId,
              stopSessionInternal(context, "Prime Agent session state could not be reconciled."),
            ).pipe(Effect.ignore, Effect.forkDetach);
          } else if (context.lifecycleStarted) {
            yield* refreshContextUsage(context).pipe(Effect.forkDetach);
          }
          return;
        }
        if (event._tag === "SessionReplaced") return;

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
                          yield* syncAgentDepthSettableLocked(context);
                          yield* updateCompactionProjectionLocked(context);
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
          const unsupportedEditor = event.request.method === "editor";
          const isBlocking =
            event.request.method === "select" ||
            event.request.method === "confirm" ||
            event.request.method === "input" ||
            unsupportedEditor;
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
                    message: unsupportedEditor
                      ? "Prime Agent editor interactions are disabled because their prefills cannot be stored safely."
                      : isBlocking
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
                        yield* syncAgentDepthSettableLocked(context);
                        yield* updateCompactionProjectionLocked(context);
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
          const settled = yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              context.nativeRunActive = false;
              const turn = context.activeTurn;
              if (turn === undefined) return false;
              if (turn.queuedInputCount > 0) {
                turn.completedRunMessages.push(...event.messages);
                turn.awaitingQueuedRun = true;
                turn.queuedActionObserved = false;
                return false;
              }
              if (primeAgentRunCompletedNeedsHandoff(event)) {
                turn.lastAssistantHadRenderableText = false;
                // A daemon/kernel reconnect can emit a non-final agent_end
                // and immediately continue the same public run. Keep the Pylon
                // turn bound briefly so the following RunStarted is not orphaned.
                turn.runCompletionHandoffSequence += 1;
                const sequence = turn.runCompletionHandoffSequence;
                turn.pendingRunCompletionHandoff = { sequence, event };
                yield* schedulePendingRunCompletionHandoff(context, turn, sequence);
                return false;
              }
              const completionEvent =
                turn.completedRunMessages.length === 0
                  ? event
                  : {
                      ...event,
                      messages: [...turn.completedRunMessages, ...event.messages],
                    };
              return yield* settleActiveTurnLocked(context, turn, {
                state: "completed",
                event: completionEvent,
              });
            }),
          );
          if (settled) {
            yield* refreshContextUsage(context).pipe(Effect.forkDetach);
          }
          return;
        }

        if (event._tag === "CompactionStarted") {
          yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              if (sessions.get(context.threadId) !== context || context.stopped) return;
              const turn = context.activeTurn;
              context.activeCompactionScope ??= turn === undefined ? {} : { turnId: turn.id };
              yield* updateCompactionProjectionLocked(context, {
                status: context.compactionAbortRequested ? "abort-requested" : "compacting",
                abortable: true,
              });
              yield* publishDrafts(context, event, turn);
            }),
          );
          return;
        }

        if (event._tag === "CompactionCompleted") {
          const terminal = yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              if (sessions.get(context.threadId) !== context || context.stopped) return false;
              const turn = context.activeTurn;
              const compactionScope = context.activeCompactionScope;
              const compactionTurnId =
                compactionScope?.turnId ?? (turn?.command === "compact" ? turn.id : undefined);
              const pendingHandoff = turn?.pendingRunCompletionHandoff;
              // Prime reports exhausted overflow recovery with an unmatched
              // compaction_end. Only a previously observed compaction owns an item.
              if (compactionScope !== undefined) yield* publishDrafts(context, event, turn);
              // willRetry means the model prompt will continue after this completed
              // compaction; it does not mean another compaction attempt is active.
              context.activeCompactionScope = undefined;
              context.compactionAbortRequested = false;
              yield* updateCompactionProjectionLocked(context, {
                status: "idle",
                abortable: false,
              });
              if (turn !== undefined && pendingHandoff !== undefined) {
                // Invalidate the timer created by agent_end and grant the native
                // post-compaction continuation its own complete handoff window.
                yield* restartPendingRunCompletionHandoffLocked(context, turn);
              }
              if (turn?.command !== "compact" || compactionTurnId !== turn.id) return true;
              yield* settleActiveTurnLocked(
                context,
                turn,
                event.outcome === "completed" || event.outcome === "skipped"
                  ? { state: "completedWithoutMessage" }
                  : {
                      state: "failed",
                      errorMessage:
                        event.outcome === "aborted"
                          ? "Prime Agent context compaction was aborted."
                          : "Prime Agent context compaction failed.",
                    },
              );
              return true;
            }),
          );
          if (terminal) yield* refreshContextUsage(context).pipe(Effect.forkDetach);
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
              context.inputQueueClearPending = false;
              context.nativeQueueActionActive = false;
              yield* updateInputQueueProjection(
                context,
                { steeringCount: 0, followUpCount: 0 },
                { preserveModes: false },
              );
              if (context.activeRefinement !== undefined) {
                const activeRefinement = context.activeRefinement;
                context.activeRefinement = undefined;
                yield* Deferred.fail(
                  activeRefinement.completion,
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/refine-harness",
                    detail: "Prime Agent session stopped before harness refinement completed.",
                  }),
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
            let publishEvent = true;
            if (event._tag === "RunStarted") {
              context.nativeRunActive = true;
              if (turn?.pendingRunCompletionHandoff !== undefined) {
                turn.completedRunMessages.push(...turn.pendingRunCompletionHandoff.event.messages);
                turn.pendingRunCompletionHandoff = undefined;
              }
            } else if (
              event._tag === "ToolStarted" ||
              event._tag === "ToolProgress" ||
              event._tag === "ToolCompleted" ||
              (event._tag === "AssistantStream" && event.kind === "toolCall")
            ) {
              if (turn !== undefined) turn.lastAssistantHadRenderableText = false;
            } else if (event._tag === "BashStarted" || event._tag === "BashOutput") {
              context.nativeBashActive = true;
              if (turn !== undefined) turn.lastAssistantHadRenderableText = false;
            } else if (event._tag === "BashCompleted") {
              context.nativeBashActive = false;
              if (turn !== undefined) turn.lastAssistantHadRenderableText = false;
            } else if (event._tag === "GoalUpdated") {
              publishEvent = false;
              yield* updateGoalProjection(
                context,
                context.session.runtimeMode === "full-access" ? event.goal : unavailableSessionGoal,
              );
            } else if (event._tag === "ChildUpdated") {
              const previous = context.knownNativeChildren.get(event.child.id);
              const previousSettled =
                previous !== undefined &&
                previous.status !== "queued" &&
                previous.status !== "running";
              if (previousSettled) {
                publishEvent = false;
              } else {
                publishEvent = durableChildChanged(previous, event.child);
                context.knownNativeChildren.set(event.child.id, event.child);
              }
              const authoritative = context.knownNativeChildren.get(event.child.id) ?? event.child;
              if (authoritative.status === "queued" || authoritative.status === "running") {
                context.activeNativeChildren.add(authoritative.id);
                yield* signalInactiveActivityWatchesLocked(context);
              } else {
                context.activeNativeChildren.delete(authoritative.id);
                context.cancellationPendingNativeChildren.delete(authoritative.id);
                yield* signalInactiveActivityWatchesLocked(context, authoritative.id);
              }
            }
            if (event._tag === "ThinkingLevelChanged") {
              context.currentThinkingLevel = event.level;
            } else if (event._tag === "ServiceTierChanged") {
              context.currentServiceTier = event.serviceTier;
            }
            if (event._tag === "RunStarted") {
              context.inputQueueClearPending = false;
              if (turn?.awaitingQueuedRun === true) {
                turn.awaitingQueuedRun = false;
                turn.queuedActionObserved = false;
              }
            }
            if (event._tag === "QueueChanged") {
              const queue = {
                steeringCount: event.steeringCount,
                followUpCount: event.followUpCount,
              };
              context.nativeQueueActionActive = event.active !== undefined;
              yield* updateInputQueueProjection(context, queue);
              if (turn !== undefined) {
                turn.queuedInputCount = event.queuedCount;
                if (turn.awaitingQueuedRun && event.active !== undefined) {
                  context.inputQueueClearPending = false;
                  turn.queuedActionObserved = true;
                } else if (
                  turn.awaitingQueuedRun &&
                  context.inputQueueClearPending &&
                  event.queuedCount === 0
                ) {
                  context.inputQueueClearPending = false;
                  const settled = yield* settleActiveTurnLocked(context, turn, {
                    state: "completed",
                    event: { _tag: "RunCompleted", messages: turn.completedRunMessages },
                  });
                  if (settled) yield* refreshContextUsage(context).pipe(Effect.forkDetach);
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
                } else if (!turn.awaitingQueuedRun) {
                  context.inputQueueClearPending = false;
                }
              } else {
                context.inputQueueClearPending = false;
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
            if (publishEvent) {
              yield* publishDrafts(context, event, context.activeTurn);
            }
          }),
        );
        if (
          context.lifecycleStarted &&
          event._tag === "ConnectionStatus" &&
          event.status === "connected"
        ) {
          yield* refreshContextUsage(context).pipe(Effect.forkDetach);
        }
      }).pipe(
        Effect.ensuring(
          withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              if (sessions.get(context.threadId) !== context || context.stopped) return;
              yield* syncAgentDepthSettableLocked(context);
              yield* updateCompactionProjectionLocked(context);
            }),
          ).pipe(Effect.ignore),
        ),
        Effect.catchCause((cause) =>
          Effect.logError("Failed to consume a Prime Agent daemon event.", {
            cause,
            threadId: context.threadId,
            eventType: event._tag,
          }),
        ),
      );

    /** Must be called with the thread lock held. */
    const stopSessionInternal = (
      context: PrimeAgentDaemonSessionContext,
      terminalReason?: string,
    ) =>
      Effect.gen(function* () {
        if (sessions.get(context.threadId) !== context || context.stopped) return;
        context.stopRequested = true;
        yield* endActiveSideQuestionLocked(context);
        for (const watchedAgentId of new Set([
          ...context.activityWatchStops.keys(),
          ...context.sharedActivityStreams.keys(),
        ])) {
          yield* signalInactiveActivityWatchesLocked(context, watchedAgentId);
        }
        yield* clearPendingApprovalsLocked(context, true);
        yield* clearPendingInteractionsLocked(context, true);
        const turn = context.activeTurn;
        if (turn !== undefined) {
          turn.cancellationRequested = true;
          turn.controller.abort();
          yield* context.runtime.abortAndClearQueue.pipe(Effect.ignore);
          yield* settleActiveTurnLocked(context, turn, { state: "cancelled" });
        }

        context.inputQueueClearPending = false;
        context.nativeQueueActionActive = false;
        yield* updateInputQueueProjection(
          context,
          { steeringCount: 0, followUpCount: 0 },
          { preserveModes: false },
        );
        if (context.activeRefinement !== undefined) {
          const activeRefinement = context.activeRefinement;
          context.activeRefinement = undefined;
          yield* Deferred.fail(
            activeRefinement.completion,
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/refine-harness",
              detail: "Prime Agent session stopped before harness refinement completed.",
            }),
          );
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
              exitKind:
                Exit.isSuccess(disposeExit) && terminalReason === undefined ? "graceful" : "error",
              ...(terminalReason !== undefined
                ? { reason: terminalReason }
                : Exit.isSuccess(disposeExit)
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
      withThreadMutationLock(
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
          if (runtime.refinementAvailable) {
            if (
              runtime.sessionId === "." ||
              runtime.sessionId === ".." ||
              path.basename(runtime.sessionId) !== runtime.sessionId
            ) {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: "Prime Agent returned an invalid local harness identity.",
              });
            }
            const artifactRoot = path.join(
              path.dirname(sessionDir),
              "session-artifacts",
              runtime.sessionId,
            );
            const harnessRoot = path.join(artifactRoot, "harness");
            yield* fileSystem.makeDirectory(harnessRoot, { recursive: true }).pipe(
              Effect.andThen(fileSystem.chmod(artifactRoot, 0o700)),
              Effect.andThen(fileSystem.chmod(harnessRoot, 0o700)),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: "Failed to protect the Prime Agent local harness directory.",
                    cause,
                  }),
              ),
            );
          }
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
            ...(input.resumeCursor !== undefined ? { restored: true } : {}),
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
            autoCompactionEnabled: runtime.initialSnapshot.state.autoCompactionEnabled,
            compaction: {
              available: runtime.compactionAvailable && input.runtimeMode === "full-access",
              status: runtime.initialCompactionState.isCompacting ? "compacting" : "idle",
              abortable: false,
              ...(runtime.compactionAvailable && input.runtimeMode === "full-access"
                ? { autoCompactionEnabled: runtime.initialCompactionState.autoCompactionEnabled }
                : {}),
              autoCompactionWritable:
                runtime.autoCompactionWritable && input.runtimeMode === "full-access",
              manualCompactionSettable: false,
              ...(runtime.autoCompactionWritable && input.runtimeMode === "full-access"
                ? { autoCompactionScope: "session-and-provider-default" as const }
                : {}),
            },
            goal:
              input.runtimeMode === "full-access"
                ? runtime.initialSnapshot.state.goal
                : unavailableSessionGoal,
            agentDepth: runtime.initialAgentDepth,
            inputQueue: runtime.initialInputQueue,
            inputQueueClearPending: false,
            nativeQueueActionActive: runtime.initialSnapshot.state.inputQueue.activeAction,
            lifecycleStarted: false,
            usageRefreshSequence: 0,
            eventFiber: undefined,
            turns: [],
            pendingInteractions: new Map(),
            pendingApprovals: new Map(),
            permissionToken,
            approvalsAcceptedForSession: false,
            activeTurn: undefined,
            nativeRunActive: runtime.initialSnapshot.state.isStreaming,
            nativeBashActive: runtime.initialSnapshot.state.isBashRunning,
            activeNativeChildren: new Set(
              runtime.initialSnapshot.children
                .filter((child) => child.status === "queued" || child.status === "running")
                .map((child) => child.id),
            ),
            knownNativeChildren: new Map(
              runtime.initialSnapshot.children.map((child) => [child.id, child]),
            ),
            cancellationPendingNativeChildren: new Set(),
            activityWatchStops: new Map(),
            sharedActivityStreams: new Map(),
            activeActivityWatcherCount: 0,
            agentRosterProjected: false,
            resourceReloadCompletion: undefined,
            restored: input.resumeCursor !== undefined,
            activeRefinement: undefined,
            activeCompactionScope: runtime.initialSnapshot.state.isCompacting ? {} : undefined,
            manualCompactionRequestActive: false,
            compactionAbortRequested: false,
            stopRequested: false,
            stopped: false,
            exitEmitted: false,
          };
          context.agentDepth = {
            ...context.agentDepth,
            settable: isAgentDepthSettable(context),
          };
          context.compaction = {
            ...context.compaction,
            manualCompactionSettable: isManualCompactionSettable(context),
          };
          sessions.set(input.threadId, context);
          scopeTransferred = true;
          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: { resume: input.resumeCursor !== undefined },
          });
          yield* publishSessionResources(input.threadId, runtime.initialResources);
          yield* publishSessionAgentDepth(input.threadId, context.agentDepth);
          yield* publishSessionCompaction(input.threadId, context.compaction);
          yield* publishSessionGoal(input.threadId, context.goal);
          yield* publishSessionInputQueue(input.threadId, context.inputQueue);
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
          if (!context.agentRosterProjected) {
            for (const child of runtime.initialSnapshot.children) {
              if (child.status === "queued" || child.status === "running") {
                yield* publishDrafts(context, { _tag: "ChildUpdated", child }, undefined);
              }
            }
            context.agentRosterProjected = true;
          }
          context.eventFiber = yield* runtime.events.pipe(
            Stream.runForEach((event) => consumeEvent(context, event)),
            Effect.forkChild,
          );

          context.lifecycleStarted = true;
          yield* refreshContextUsage(context).pipe(Effect.forkDetach);
          yield* refreshDiscoveredModels(context);
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
          yield* refreshContextUsage(context).pipe(Effect.forkDetach);
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
          const prepared = yield* withThreadMutationLock(
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
                if (activeTurn.command === "compact") {
                  return yield* new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "sendTurn",
                    issue: "Prime Agent cannot steer an active context compaction.",
                  });
                }
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
                promotePendingRunCompletionToQueuedRun(activeTurn);
                return {
                  _tag: "Steered" as const,
                  result: {
                    threadId: input.threadId,
                    turnId: activeTurn.id,
                    resumeCursor: context.session.resumeCursor,
                  } satisfies ProviderTurnStartResult,
                };
              }

              if (
                context.activeCompactionScope !== undefined ||
                context.manualCompactionRequestActive
              ) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  reason: "busy",
                  issue: "Prime Agent cannot start a turn during context compaction.",
                });
              }
              // "default" defers to Prime's own model rather than naming one, and Prime
              // exposes no daemon method to restore that choice inside a running session.
              // Reject the switch rather than run the old model behind a default label.
              if (
                requestedModel === PRIME_AGENT_DEFAULT_MODEL &&
                context.session.model !== PRIME_AGENT_DEFAULT_MODEL
              ) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue:
                    "Prime Agent cannot return to its own default model in a running session. Start a new thread to use Prime Agent Default.",
                });
              }
              yield* applyTurnSelection(context, input.threadId, requestedModel, turnControls);
              const turnId = TurnId.make(yield* randomUUIDv4);
              const turn: PrimeAgentDaemonActiveTurn = {
                id: turnId,
                controller: new AbortController(),
                completed: yield* Deferred.make<void>(),
                cancellationRequested: false,
                assistantTextStreamed: false,
                nextAssistantMessageSequence: 0,
                activeAssistantItemId: undefined,
                lastAssistantHadRenderableText: false,
                runCompletionHandoffSequence: 0,
                pendingRunCompletionHandoff: undefined,
                queuedInputCount: 0,
                awaitingQueuedRun: false,
                queuedActionObserved: false,
                completedRunMessages: [],
                ...(/^\/compact(?:\s|$)/.test(text) ? { command: "compact" as const } : {}),
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
            true,
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
            Effect.catch(() =>
              Effect.gen(function* () {
                const cancelled = turn.cancellationRequested || turn.controller.signal.aborted;
                yield* settleActiveTurn(
                  context,
                  turn,
                  cancelled
                    ? { state: "cancelled" }
                    : { state: "failed", errorMessage: PRIME_AGENT_TURN_FAILED },
                );
                // The prompt was admitted. Its runtime events already carry
                // the authoritative failed terminal, so do not reclassify it
                // as a second turn-start failure in orchestration.
                return result;
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
      withThreadMutationLock(
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
          yield* syncAgentDepthSettableLocked(context);
          yield* updateCompactionProjectionLocked(context);
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
              reason: "stale",
            });
          }
          const decodedResponse = decodeSessionInteractionResponse(response);
          if (Option.isNone(decodedResponse)) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/interaction-response",
              detail: `The response is invalid for interaction '${requestId}'.`,
              reason: "stale",
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
              reason: "stale",
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
                reason: "stale",
              });
            }
            safeResponse = { kind: "selected", value: normalizedResponse.value };
            nativeResponse = { value: normalizedResponse.value };
          } else if (pending.method === "confirm" && normalizedResponse.kind === "confirmed") {
            safeResponse = { kind: "confirmed", confirmed: normalizedResponse.confirmed };
            nativeResponse = { confirmed: normalizedResponse.confirmed };
          } else if (pending.method === "input" && normalizedResponse.kind === "submitted") {
            safeResponse = { kind: "submitted", value: "" };
            nativeResponse = { value: normalizedResponse.value };
          } else {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/interaction-response",
              detail: `The response kind does not match interaction '${requestId}'.`,
              reason: "stale",
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
          yield* syncAgentDepthSettableLocked(context);
          yield* updateCompactionProjectionLocked(context);
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
    const updateAgentDepthProjection = (
      context: PrimeAgentDaemonSessionContext,
      next: SessionAgentDepthUpdatedPayload,
    ) =>
      Effect.gen(function* () {
        const projected = {
          ...next,
          settable: next.writable && isAgentDepthSettable(context),
        };
        const changed =
          context.agentDepth.maxDepth !== projected.maxDepth ||
          context.agentDepth.source !== projected.source ||
          context.agentDepth.writable !== projected.writable ||
          context.agentDepth.settable !== projected.settable ||
          context.agentDepth.maxSettableDepth !== projected.maxSettableDepth;
        context.agentDepth = projected;
        if (changed) yield* publishSessionAgentDepth(context.threadId, projected);
      });

    const askSessionSideQuestion: NonNullable<PrimeAgentAdapterShape["askSessionSideQuestion"]> = (
      threadId,
      requestId,
      question,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const decoded = decodeAskSessionSideQuestionInput({ threadId, requestId, question });
          if (Option.isNone(decoded)) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "askSessionSideQuestion",
              issue: "The side-question request is invalid.",
            });
          }
          const safeQuestion = decoded.value.question;
          const sessionEnded = yield* Deferred.make<void>();
          const nativeId = yield* randomUUIDv4;
          const reserved = yield* withThreadMutationLock(
            threadId,
            Effect.gen(function* () {
              const context = yield* requireSession(threadId);
              if (
                context.session.runtimeMode !== "approval-required" ||
                context.permissionToken === undefined ||
                context.restored ||
                !context.runtime.sideQuestionsAvailable
              ) {
                return yield* new ProviderAdapterUnsupportedOperationError({
                  provider: PROVIDER,
                  operation: "askSessionSideQuestion",
                });
              }
              if (
                activeSideQuestions.has(threadId) ||
                activeSideQuestions.size >= PRIME_AGENT_SIDE_QUESTION_MAX_ACTIVE
              ) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "askSessionSideQuestion",
                  reason: "busy",
                  issue: "The Prime Agent side-question capacity is currently busy.",
                });
              }
              const active: PrimeAgentDaemonActiveSideQuestion = {
                requestId,
                nativeId,
                context,
                sessionEnded,
                cancelRequested: false,
              };
              activeSideQuestions.set(threadId, active);
              return active;
            }),
          );

          const nativeResult = reserved.context.runtime
            .askSideQuestion(nativeId, safeQuestion)
            .pipe(
              Effect.map(
                (result): ProviderAskSessionSideQuestionResult =>
                  result.disposition === "answered"
                    ? { requestId, disposition: "answered", answer: result.answer }
                    : { requestId, disposition: result.disposition },
              ),
              Effect.orElseSucceed(
                (): ProviderAskSessionSideQuestionResult => ({
                  requestId,
                  disposition: "outcome-unknown",
                }),
              ),
            );
          const sessionEndedResult = Deferred.await(sessionEnded).pipe(
            Effect.as<ProviderAskSessionSideQuestionResult>({
              requestId,
              disposition: "outcome-unknown",
            }),
          );
          const boundedResult = Effect.raceFirst(nativeResult, sessionEndedResult).pipe(
            Effect.timeoutOption(PRIME_AGENT_SIDE_QUESTION_TIMEOUT_MS),
            Effect.map(
              Option.match({
                onNone: (): ProviderAskSessionSideQuestionResult => ({
                  requestId,
                  disposition: "timed-out",
                }),
                onSome: (result) => result,
              }),
            ),
          );

          return yield* restore(boundedResult).pipe(
            Effect.ensuring(
              withThreadLock(
                threadId,
                Effect.sync(() => {
                  if (activeSideQuestions.get(threadId) === reserved) {
                    activeSideQuestions.delete(threadId);
                  }
                }),
              ),
            ),
          );
        }),
      );

    const cancelSessionSideQuestion: NonNullable<
      PrimeAgentAdapterShape["cancelSessionSideQuestion"]
    > = (threadId, requestId) =>
      Effect.uninterruptible(
        withThreadMutationLock(
          threadId,
          Effect.gen(function* (): Effect.fn.Return<
            ProviderCancelSessionSideQuestionResult,
            ProviderAdapterError
          > {
            const context = yield* requireSession(threadId);
            const active = activeSideQuestions.get(threadId);
            if (
              active === undefined ||
              active.context !== context ||
              active.requestId !== requestId
            ) {
              return { requestId, disposition: "already-settled" };
            }
            yield* requestActiveSideQuestionAbortLocked(context);
            return { requestId, disposition: "cancel-requested" };
          }),
        ),
      );

    const cancelSessionAgent: NonNullable<PrimeAgentAdapterShape["cancelSessionAgent"]> = (
      threadId,
      agentId,
    ) =>
      Effect.uninterruptible(
        withThreadMutationLock(
          threadId,
          Effect.gen(function* () {
            const context = yield* requireSession(threadId);
            if (context.session.runtimeMode !== "full-access") {
              return yield* new ProviderAdapterUnsupportedOperationError({
                provider: PROVIDER,
                operation: "cancelSessionAgent",
              });
            }
            const known = context.knownNativeChildren.get(agentId);
            if (known === undefined) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "cancelSessionAgent",
                issue: "The agent is not part of this provider session.",
                reason: "invalid-input",
              });
            }
            if (known.status !== "queued" && known.status !== "running") {
              context.cancellationPendingNativeChildren.delete(agentId);
              return { agentId, disposition: "already-settled" as const };
            }
            if (context.cancellationPendingNativeChildren.has(agentId)) {
              return { agentId, disposition: "cancel-requested" as const };
            }

            const cancellation = yield* context.runtime.cancelAgent(agentId).pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/cancel-agent", error),
              ),
              Effect.exit,
            );
            if (Exit.isSuccess(cancellation) && cancellation.value) {
              context.cancellationPendingNativeChildren.add(agentId);
              return { agentId, disposition: "cancel-requested" as const };
            }

            // `false`, a transport failure, and a lost response may all race a natural
            // completion. Re-read the authoritative roster exactly once; never retry the
            // mutation or attribute an aggregate lifecycle change to this caller.
            const roster = yield* context.runtime.getAgentRoster.pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/get-agent-roster", error),
              ),
              Effect.exit,
            );
            if (Exit.isSuccess(roster)) {
              yield* applyAgentRosterSnapshot(context, roster.value);
              const reconciled = context.knownNativeChildren.get(agentId);
              if (
                reconciled === undefined ||
                (reconciled.status !== "queued" && reconciled.status !== "running")
              ) {
                return { agentId, disposition: "already-settled" as const };
              }
              yield* stopSessionInternal(
                context,
                Exit.isFailure(cancellation)
                  ? "Prime Agent session closed after a failed agent cancellation remained ambiguous."
                  : "Prime Agent session closed after agent cancellation returned contradictory state.",
              ).pipe(Effect.ignore);
              if (Exit.isFailure(cancellation)) {
                return yield* Effect.failCause(cancellation.cause);
              }
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/cancel-agent",
                detail: "Prime Agent did not confirm that the agent was cancelled.",
              });
            }

            yield* stopSessionInternal(
              context,
              "Prime Agent session closed after agent cancellation could not be reconciled safely.",
            ).pipe(Effect.ignore);
            if (Exit.isFailure(cancellation)) {
              return yield* Effect.failCause(cancellation.cause);
            }
            return yield* Effect.failCause(roster.cause);
          }),
        ),
      );

    const messageSessionAgent: NonNullable<PrimeAgentAdapterShape["messageSessionAgent"]> = (
      threadId,
      agentId,
      rawMessage,
    ) =>
      Effect.uninterruptible(
        withThreadMutationLock(
          threadId,
          Effect.gen(function* () {
            const context = yield* requireSession(threadId);
            if (context.session.runtimeMode !== "full-access") {
              return yield* new ProviderAdapterUnsupportedOperationError({
                provider: PROVIDER,
                operation: "messageSessionAgent",
              });
            }
            if (!context.runtime.agentMessageAvailable) {
              return yield* new ProviderAdapterUnsupportedOperationError({
                provider: PROVIDER,
                operation: "messageSessionAgent",
              });
            }
            const message = rawMessage.trim();
            if (message.length === 0 || message.length > PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/message-agent-invalid-message",
                detail: `Message must contain at most ${PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS} non-empty characters.`,
              });
            }

            // The runtime's private roster is seeded by attach/resync and updated before each
            // decoded child event is exposed. Client-projected rows never supply native endpoints.
            const roster = yield* context.runtime.getAgentRoster.pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/get-agent-roster", error),
              ),
            );
            yield* applyAgentRosterSnapshot(context, roster);
            const known = context.knownNativeChildren.get(agentId);
            if (known === undefined) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "messageSessionAgent",
                issue: "The agent is not part of this provider session.",
                reason: "invalid-input",
              });
            }
            if (known.status !== "queued" && known.status !== "running") {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "messageSessionAgent",
                issue: "The agent is no longer active.",
                reason: "invalid-input",
              });
            }
            const targetActiveSessionId = known.activeSessionId?.trim();
            if (targetActiveSessionId === undefined || targetActiveSessionId.length === 0) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/message-agent-not-ready",
                detail: "The active agent does not expose a direct-message endpoint.",
              });
            }
            if (context.cancellationPendingNativeChildren.has(agentId)) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "messageSessionAgent",
                issue: "The agent has a cancellation request pending.",
                reason: "invalid-input",
              });
            }

            const delivery = yield* context.runtime
              .messageAgent(targetActiveSessionId, message)
              .pipe(Effect.result);
            if (Result.isSuccess(delivery)) {
              return { agentId, disposition: delivery.success };
            }
            if (
              delivery.failure.reason !== "request-failed" &&
              delivery.failure.reason !== "request-timed-out" &&
              delivery.failure.reason !== "invalid-response"
            ) {
              return yield* runtimeOperationError(
                threadId,
                "session/message-agent",
                delivery.failure,
              );
            }

            // Delivery may already have happened. Refresh the row once for freshness, but
            // never retry the non-idempotent send and never close an otherwise healthy chat.
            const reconciled = yield* context.runtime.getAgentRoster.pipe(Effect.result);
            if (Result.isSuccess(reconciled)) {
              yield* applyAgentRosterSnapshot(context, reconciled.success);
            }
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/message-agent-delivery-unknown",
              detail: "Prime Agent message delivery could not be confirmed.",
            });
          }),
        ),
      );

    const watchSessionAgentActivity: NonNullable<
      PrimeAgentAdapterShape["watchSessionAgentActivity"]
    > = (threadId, agentId) =>
      Stream.unwrap(
        Effect.acquireRelease(
          withThreadLock(
            threadId,
            Effect.gen(function* () {
              const context = yield* requireSession(threadId);
              if (
                context.session.runtimeMode !== "full-access" ||
                !context.runtime.watchAgentActivityAvailable
              ) {
                return yield* new ProviderAdapterUnsupportedOperationError({
                  provider: PROVIDER,
                  operation: "watchSessionAgentActivity",
                });
              }
              const roster = yield* context.runtime.getAgentRoster.pipe(
                Effect.mapError((error) =>
                  runtimeOperationError(threadId, "session/get-agent-roster", error),
                ),
              );
              yield* applyAgentRosterSnapshot(context, roster);
              const known = context.knownNativeChildren.get(agentId);
              const nativeActiveSessionId = known?.activeSessionId?.trim();
              if (
                known === undefined ||
                (known.status !== "queued" && known.status !== "running") ||
                nativeActiveSessionId === undefined ||
                nativeActiveSessionId.length === 0 ||
                context.cancellationPendingNativeChildren.has(agentId)
              ) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "watchSessionAgentActivity",
                  issue: "The agent is not an active watchable member of this provider session.",
                  reason: "invalid-input",
                });
              }
              if (
                context.activeActivityWatcherCount >=
                PROVIDER_SESSION_AGENT_ACTIVITY_MAX_CONCURRENT_WATCHERS
              ) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "watchSessionAgentActivity",
                  issue: "The provider session has reached its live activity watcher limit.",
                  reason: "busy",
                });
              }
              let shared = context.sharedActivityStreams.get(agentId);
              if (shared !== undefined && shared.nativeActiveSessionId !== nativeActiveSessionId) {
                context.sharedActivityStreams.delete(agentId);
                yield* Deferred.succeed(shared.stop, undefined).pipe(
                  Effect.ignore,
                  Effect.forkDetach,
                );
                shared = undefined;
              }
              if (shared === undefined) {
                const sharedStop = yield* Deferred.make<
                  void,
                  PrimeAgentDaemonSessionRuntimeError
                >();
                const stream = yield* context.runtime
                  .watchAgentActivity(nativeActiveSessionId)
                  .pipe(
                    Stream.interruptWhen(Deferred.await(sharedStop)),
                    Stream.share({ capacity: 1, strategy: "sliding", replay: 1 }),
                    Effect.provideService(Scope.Scope, context.scope),
                  );
                shared = { nativeActiveSessionId, stop: sharedStop, stream };
                context.sharedActivityStreams.set(agentId, shared);
              }

              const stop = yield* Deferred.make<void, ProviderAdapterError>();
              const stops = context.activityWatchStops.get(agentId) ?? new Set();
              stops.add(stop);
              context.activityWatchStops.set(agentId, stops);
              context.activeActivityWatcherCount += 1;
              return { context, shared, stop };
            }),
          ),
          ({ context, stop }) =>
            withThreadLock(
              threadId,
              Effect.sync(() => {
                const stops = context.activityWatchStops.get(agentId);
                if (stops?.delete(stop) && context.activeActivityWatcherCount > 0) {
                  context.activeActivityWatcherCount -= 1;
                }
                if (stops?.size === 0) context.activityWatchStops.delete(agentId);
              }),
            ).pipe(Effect.ignore),
        ).pipe(
          Effect.map(({ shared, stop }) => {
            let revision = 0;
            let lifetimeUpdates = 0;
            let lifetimeCharacters = 0;
            return shared.stream.pipe(
              Stream.mapError((error) =>
                error.reason === "incompatible-api"
                  ? new ProviderAdapterUnsupportedOperationError({
                      provider: PROVIDER,
                      operation: "watchSessionAgentActivity",
                    })
                  : error.reason === "agent-not-active"
                    ? new ProviderAdapterValidationError({
                        provider: PROVIDER,
                        operation: "watchSessionAgentActivity",
                        issue: "The agent is no longer active.",
                        reason: "invalid-input",
                      })
                    : runtimeOperationError(threadId, "session/watch-agent-activity", error),
              ),
              Stream.mapEffect((entries) => {
                const snapshotCharacters = entries.reduce(
                  (total, entry) =>
                    total + [...("speaker" in entry ? entry.text : entry.label)].length,
                  0,
                );
                if (
                  lifetimeUpdates >= PROVIDER_SESSION_AGENT_ACTIVITY_LIFETIME_MAX_UPDATES ||
                  lifetimeCharacters + snapshotCharacters >
                    PROVIDER_SESSION_AGENT_ACTIVITY_LIFETIME_MAX_CHARS
                ) {
                  return Effect.fail(
                    new ProviderAdapterValidationError({
                      provider: PROVIDER,
                      operation: "watchSessionAgentActivity",
                      issue: "The live activity watcher reached its lifetime limit.",
                      reason: "busy",
                    }),
                  );
                }
                lifetimeUpdates += 1;
                lifetimeCharacters += snapshotCharacters;
                revision += 1;
                const assistantEntries = entries.flatMap((entry) =>
                  "speaker" in entry ? [entry] : [],
                );
                return Effect.succeed({
                  agentId,
                  revision,
                  entries: assistantEntries,
                  ...(assistantEntries.length === entries.length ? {} : { activity: entries }),
                } satisfies ProviderSessionAgentActivitySnapshot);
              }),
              Stream.interruptWhen(Deferred.await(stop)),
            );
          }),
        ),
      );

    const getSessionAgentDepth: NonNullable<PrimeAgentAdapterShape["getSessionAgentDepth"]> = (
      threadId,
    ) =>
      withThreadMutationLock(
        threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          if (!context.agentDepth.writable) return context.agentDepth;
          const next = yield* context.runtime.getAgentDepth.pipe(
            Effect.mapError((error) =>
              runtimeOperationError(threadId, "session/get-agent-depth", error),
            ),
          );
          yield* updateAgentDepthProjection(context, next);
          return context.agentDepth;
        }),
      );

    const setSessionAgentDepth: NonNullable<PrimeAgentAdapterShape["setSessionAgentDepth"]> = (
      threadId,
      maxDepth,
    ) =>
      withThreadMutationLock(
        threadId,
        Effect.uninterruptible(
          Effect.gen(function* () {
            const context = yield* requireSession(threadId);
            if (!context.agentDepth.writable) {
              return yield* new ProviderAdapterUnsupportedOperationError({
                provider: PROVIDER,
                operation: "setSessionAgentDepth",
              });
            }
            if (
              !Number.isInteger(maxDepth) ||
              maxDepth < 0 ||
              maxDepth > PROVIDER_SESSION_AGENT_DEPTH_MAX_SETTABLE
            ) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "setSessionAgentDepth",
                reason: "invalid-input",
                issue: `Agent depth must be an integer from 0 to ${PROVIDER_SESSION_AGENT_DEPTH_MAX_SETTABLE}.`,
              });
            }
            if (!isAgentDepthSettable(context)) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "setSessionAgentDepth",
                reason: "busy",
                issue: "Agent depth can only be changed while the session is idle.",
              });
            }
            const outcome = yield* context.runtime.setAgentDepth(maxDepth).pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/set-agent-depth", error),
              ),
              Effect.exit,
            );
            if (Exit.isSuccess(outcome)) {
              yield* updateAgentDepthProjection(context, outcome.value);
              return outcome.value;
            }

            const reconciled = yield* context.runtime.getAgentDepth.pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/get-agent-depth", error),
              ),
              Effect.exit,
            );
            if (Exit.isSuccess(reconciled)) {
              yield* updateAgentDepthProjection(context, reconciled.value);
            } else {
              yield* stopSessionInternal(
                context,
                "Prime Agent session closed after its agent depth could not be reconciled safely.",
              ).pipe(Effect.ignore);
            }
            return yield* Effect.failCause(outcome.cause);
          }),
        ),
      );

    const getSessionInputQueue: NonNullable<PrimeAgentAdapterShape["getSessionInputQueue"]> = (
      threadId,
    ) =>
      withThreadMutationLock(
        threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          const next = yield* context.runtime.getInputQueue.pipe(
            Effect.mapError((error) =>
              runtimeOperationError(threadId, "session/get-input-queue", error),
            ),
          );
          yield* updateInputQueueProjection(context, next);
          return context.inputQueue;
        }),
      );

    const followUp: NonNullable<PrimeAgentAdapterShape["followUp"]> = (input) =>
      Effect.uninterruptible(
        withThreadMutationLock(
          input.threadId,
          Effect.gen(function* () {
            const context = yield* requireSession(input.threadId);
            const turn = context.activeTurn;
            if (turn === undefined || context.session.status !== "running") {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "followUp",
                reason: "busy",
                issue: "A follow-up requires an active Prime Agent run.",
              });
            }
            if (
              turn.command === "compact" ||
              context.activeCompactionScope !== undefined ||
              context.manualCompactionRequestActive
            ) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "followUp",
                reason: "busy",
                issue: "Prime Agent cannot queue a follow-up during context compaction.",
              });
            }
            const text = input.input?.trim() ?? "";
            if (context.session.runtimeMode === "approval-required" && text.startsWith("/")) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "followUp",
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
                  method: "session/follow-up",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/follow-up",
                      detail: "Failed to read a follow-up attachment.",
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
                operation: "followUp",
                reason: "invalid-input",
                issue: "Follow-up requires non-empty text or attachments.",
              });
            }

            const before = context.inputQueue;
            const admission = yield* context.runtime.followUp({ text, images }).pipe(
              Effect.mapError((error) =>
                runtimeOperationError(input.threadId, "session/follow-up", error),
              ),
              Effect.exit,
            );
            const reconciled = yield* context.runtime.getInputQueue.pipe(
              Effect.mapError((error) =>
                runtimeOperationError(input.threadId, "session/get-input-queue", error),
              ),
              Effect.exit,
            );
            if (Exit.isSuccess(admission)) {
              const next = Exit.isSuccess(reconciled)
                ? reconciled.value
                : {
                    steeringCount: before.steeringCount,
                    followUpCount: Math.min(
                      PROVIDER_SESSION_INPUT_QUEUE_MAX_COUNT,
                      before.followUpCount + 1,
                    ),
                  };
              yield* updateInputQueueProjection(context, next);
              turn.queuedInputCount = Math.max(1, next.steeringCount + next.followUpCount);
              promotePendingRunCompletionToQueuedRun(turn);
              return context.inputQueue;
            }
            if (Exit.isSuccess(reconciled)) {
              yield* updateInputQueueProjection(context, reconciled.value);
            }
            yield* stopSessionInternal(
              context,
              "Prime Agent session closed after follow-up admission could not be reconciled safely.",
            ).pipe(Effect.ignore);
            return yield* Effect.failCause(admission.cause);
          }),
        ),
      );

    const clearSessionInputQueue: NonNullable<PrimeAgentAdapterShape["clearSessionInputQueue"]> = (
      threadId,
    ) =>
      Effect.uninterruptible(
        withThreadMutationLock(
          threadId,
          Effect.gen(function* () {
            const context = yield* requireSession(threadId);
            context.inputQueueClearPending = true;
            const applyStatus = (status: {
              readonly queue: SessionInputQueueUpdatedPayload;
              readonly activeAction: boolean;
              readonly isStreaming: boolean;
            }) =>
              Effect.gen(function* () {
                context.nativeQueueActionActive = status.activeAction;
                context.nativeRunActive = status.isStreaming;
                yield* updateInputQueueProjection(context, status.queue);
                const turn = context.activeTurn;
                if (turn === undefined) {
                  context.inputQueueClearPending = false;
                  return;
                }
                turn.queuedInputCount = status.queue.steeringCount + status.queue.followUpCount;
                if (
                  turn.awaitingQueuedRun &&
                  turn.queuedInputCount === 0 &&
                  !status.activeAction &&
                  !status.isStreaming
                ) {
                  context.inputQueueClearPending = false;
                  const settled = yield* settleActiveTurnLocked(context, turn, {
                    state: "completed",
                    event: { _tag: "RunCompleted", messages: turn.completedRunMessages },
                  });
                  if (settled) yield* refreshContextUsage(context).pipe(Effect.forkDetach);
                } else if (status.activeAction || status.isStreaming) {
                  context.inputQueueClearPending = false;
                }
              });

            const cleared = yield* context.runtime.clearInputQueue.pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/clear-input-queue", error),
              ),
              Effect.exit,
            );
            if (Exit.isSuccess(cleared)) {
              yield* applyStatus(cleared.value);
              return context.inputQueue;
            }
            const reconciled = yield* context.runtime.getInputQueueStatus.pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/get-input-queue", error),
              ),
              Effect.exit,
            );
            if (Exit.isSuccess(reconciled)) {
              yield* applyStatus(reconciled.value);
            } else {
              context.inputQueueClearPending = false;
              yield* stopSessionInternal(
                context,
                "Prime Agent session closed after its input queue could not be reconciled safely.",
              ).pipe(Effect.ignore);
            }
            return yield* Effect.failCause(cleared.cause);
          }),
        ),
      );

    const removeOnlySessionInputQueueItem: NonNullable<
      PrimeAgentAdapterShape["removeOnlySessionInputQueueItem"]
    > = (input) =>
      Effect.uninterruptible(
        withThreadMutationLock(
          input.threadId,
          Effect.gen(function* () {
            const context = yield* requireSession(input.threadId);
            if (!context.runtime.inputQueueMutationAvailable) {
              return yield* new ProviderAdapterUnsupportedOperationError({
                provider: PROVIDER,
                operation: "removeOnlySessionInputQueueItem",
              });
            }
            if (context.session.status !== "ready" && context.session.status !== "running") {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "removeOnlySessionInputQueueItem",
                issue: "A queued input cannot be removed while the session is reconnecting.",
                reason: "busy",
              });
            }
            const selectedCount =
              input.queue === "steering"
                ? context.inputQueue.steeringCount
                : context.inputQueue.followUpCount;
            if (selectedCount !== 1) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "removeOnlySessionInputQueueItem",
                issue: "The selected input queue must contain exactly one item.",
                reason: "invalid-input",
              });
            }

            context.inputQueueClearPending = true;
            const mutation = yield* context.runtime.removeOnlyInputQueueItem(input.queue).pipe(
              Effect.mapError((error) =>
                runtimeOperationError(
                  input.threadId,
                  "session/remove-only-input-queue-item",
                  error,
                ),
              ),
              Effect.exit,
            );
            const reconciled = yield* context.runtime.getInputQueueStatus.pipe(
              Effect.mapError((error) =>
                runtimeOperationError(input.threadId, "session/get-input-queue", error),
              ),
              Effect.exit,
            );
            if (Exit.isSuccess(reconciled)) {
              const status = reconciled.value;
              context.nativeQueueActionActive = status.activeAction;
              context.nativeRunActive = status.isStreaming;
              yield* updateInputQueueProjection(context, status.queue);
              const turn = context.activeTurn;
              if (turn !== undefined) {
                turn.queuedInputCount = status.queue.steeringCount + status.queue.followUpCount;
                if (
                  turn.awaitingQueuedRun &&
                  turn.queuedInputCount === 0 &&
                  !status.activeAction &&
                  !status.isStreaming
                ) {
                  context.inputQueueClearPending = false;
                  const settled = yield* settleActiveTurnLocked(context, turn, {
                    state: "completed",
                    event: { _tag: "RunCompleted", messages: turn.completedRunMessages },
                  });
                  if (settled) yield* refreshContextUsage(context).pipe(Effect.forkDetach);
                }
              }
              context.inputQueueClearPending = false;
            } else {
              context.inputQueueClearPending = false;
              yield* stopSessionInternal(
                context,
                "Prime Agent session closed after a queued input mutation could not be reconciled safely.",
              ).pipe(Effect.ignore);
              if (Exit.isSuccess(mutation) && mutation.value === "applied") {
                return yield* Effect.failCause(reconciled.cause);
              }
            }

            if (Exit.isFailure(mutation)) return yield* Effect.failCause(mutation.cause);
            switch (mutation.value) {
              case "applied":
                return context.inputQueue;
              case "unsupported":
                return yield* new ProviderAdapterUnsupportedOperationError({
                  provider: PROVIDER,
                  operation: "removeOnlySessionInputQueueItem",
                });
              case "rejected":
              case "invalid":
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "removeOnlySessionInputQueueItem",
                  issue: "The queued input changed before it could be removed.",
                  reason: "invalid-input",
                });
            }
          }),
        ),
      );

    const setSessionInputQueueMode: NonNullable<
      PrimeAgentAdapterShape["setSessionInputQueueMode"]
    > = (input) =>
      Effect.uninterruptible(
        withThreadMutationLock(
          input.threadId,
          Effect.gen(function* () {
            const context = yield* requireSession(input.threadId);
            if (
              !context.runtime.inputQueueModesAvailable ||
              context.inputQueue.steeringMode === undefined ||
              context.inputQueue.followUpMode === undefined
            ) {
              return yield* new ProviderAdapterUnsupportedOperationError({
                provider: PROVIDER,
                operation: "setSessionInputQueueMode",
              });
            }
            if (context.session.status !== "ready" && context.session.status !== "running") {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "setSessionInputQueueMode",
                issue: "Session input delivery cannot change while the session is reconnecting.",
                reason: "busy",
              });
            }
            if (
              context.activeCompactionScope !== undefined ||
              context.manualCompactionRequestActive
            ) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "setSessionInputQueueMode",
                issue: "Session input delivery cannot change during context compaction.",
                reason: "busy",
              });
            }
            const currentMode =
              input.queue === "steering"
                ? context.inputQueue.steeringMode
                : context.inputQueue.followUpMode;
            if (currentMode === input.mode) return context.inputQueue;

            const outcome = yield* Effect.result(
              context.runtime.setInputQueueMode({ queue: input.queue, mode: input.mode }),
            );
            if (Result.isFailure(outcome) && outcome.failure.reason === "request-timed-out") {
              yield* stopSessionInternal(
                context,
                "Prime Agent session closed after an input delivery mode update timed out.",
              ).pipe(Effect.ignore);
              return yield* runtimeOperationError(
                input.threadId,
                "session/set-input-queue-mode",
                outcome.failure,
              );
            }

            const reconciled = yield* Effect.result(context.runtime.getInputQueueStatus);
            if (Result.isFailure(reconciled)) {
              yield* stopSessionInternal(
                context,
                "Prime Agent session closed after its input delivery modes could not be reconciled safely.",
              ).pipe(Effect.ignore);
              const error = Result.isFailure(outcome) ? outcome.failure : reconciled.failure;
              return yield* runtimeOperationError(
                input.threadId,
                "session/set-input-queue-mode",
                error,
              );
            }

            context.nativeQueueActionActive = reconciled.success.activeAction;
            context.nativeRunActive = reconciled.success.isStreaming;
            yield* updateInputQueueProjection(context, reconciled.success.queue);
            const authoritativeMode =
              input.queue === "steering"
                ? context.inputQueue.steeringMode
                : context.inputQueue.followUpMode;
            if (authoritativeMode === input.mode) return context.inputQueue;

            if (Result.isFailure(outcome)) {
              return yield* runtimeOperationError(
                input.threadId,
                "session/set-input-queue-mode",
                outcome.failure,
              );
            }

            yield* stopSessionInternal(
              context,
              "Prime Agent session closed after it did not confirm an input delivery mode update.",
            ).pipe(Effect.ignore);
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/set-input-queue-mode",
              detail: "Prime Agent did not confirm the requested input delivery mode.",
            });
          }),
        ),
      );

    const refineSessionHarness: NonNullable<PrimeAgentAdapterShape["refineSessionHarness"]> = (
      threadId,
    ) =>
      Effect.gen(function* () {
        const completion = yield* Deferred.make<
          ProviderRefineSessionHarnessResult,
          ProviderAdapterRequestError
        >();
        const reserved = yield* Effect.uninterruptible(
          withThreadMutationLock(
            threadId,
            Effect.gen(function* () {
              const context = yield* requireSession(threadId);
              if (
                context.session.runtimeMode !== "full-access" ||
                context.restored ||
                !context.runtime.refinementAvailable
              ) {
                return yield* new ProviderAdapterUnsupportedOperationError({
                  provider: PROVIDER,
                  operation: "refineSessionHarness",
                });
              }
              if (context.activeRefinement !== undefined) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "refineSessionHarness",
                  reason: "busy",
                  issue: "A harness refinement is already active for this session.",
                });
              }
              context.activeRefinement = { completion };
              return context;
            }),
          ),
        );

        yield* publishSessionHarnessRefinement(threadId, {
          sessionStartedAt: reserved.session.createdAt,
          status: "running",
        });
        const request = reserved.runtime.refineLocalHarness.pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              // A rejected or timed-out public request is outcome-ambiguous. Keep the
              // reservation until session stop so a late apply cannot overlap a newer call.
              Effect.gen(function* () {
                yield* publishSessionHarnessRefinement(threadId, {
                  sessionStartedAt: reserved.session.createdAt,
                  status: "outcome-unknown",
                });
                yield* Deferred.fail(
                  completion,
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/refine-harness",
                    detail: "Prime Agent local harness refinement outcome is unavailable.",
                    cause: error,
                  }),
                );
              }).pipe(Effect.asVoid),
            onSuccess: (result) =>
              Effect.gen(function* () {
                const harnessRoot = path.join(
                  path.dirname(path.dirname(reserved.runtime.sessionFile)),
                  "session-artifacts",
                  reserved.runtime.sessionId,
                  "harness",
                );
                for (const fileName of ["harness_state.json", "refinements.jsonl"]) {
                  const filePath = path.join(harnessRoot, fileName);
                  if (yield* fileSystem.exists(filePath)) {
                    yield* fileSystem.chmod(filePath, 0o600);
                  }
                }
                yield* withThreadMutationLock(
                  threadId,
                  Effect.gen(function* () {
                    if (
                      sessions.get(threadId) === reserved &&
                      reserved.activeRefinement?.completion === completion
                    ) {
                      reserved.activeRefinement = undefined;
                    }
                    yield* publishSessionHarnessRefinement(threadId, {
                      sessionStartedAt: reserved.session.createdAt,
                      status: "available",
                    });
                    yield* Deferred.succeed(completion, result);
                  }),
                );
              }).pipe(Effect.asVoid),
          }),
          Effect.catchCause(() =>
            Effect.gen(function* () {
              yield* publishSessionHarnessRefinement(threadId, {
                sessionStartedAt: reserved.session.createdAt,
                status: "outcome-unknown",
              });
              yield* Deferred.fail(
                completion,
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/refine-harness",
                  detail: "Prime Agent local harness refinement outcome is unavailable.",
                }),
              );
            }).pipe(Effect.asVoid),
          ),
        );
        yield* Effect.uninterruptible(Effect.forkIn(request, reserved.scope));
        return yield* Deferred.await(completion);
      });

    /** Must be called with the thread lock held. */
    const applyCompactionStateLocked = (
      context: PrimeAgentDaemonSessionContext,
      state: {
        readonly isCompacting: boolean;
        readonly autoCompactionEnabled: boolean;
        readonly isStreaming: boolean;
        readonly isBashRunning: boolean;
        readonly inputQueueActive: boolean;
        readonly steeringCount: number;
        readonly followUpCount: number;
      },
      options?: { readonly preservePendingStatus?: boolean },
    ) =>
      Effect.gen(function* () {
        context.nativeRunActive = state.isStreaming;
        context.nativeBashActive = state.isBashRunning;
        context.nativeQueueActionActive = state.inputQueueActive;
        yield* updateInputQueueProjection(context, {
          steeringCount: state.steeringCount,
          followUpCount: state.followUpCount,
        });
        const preservePending =
          options?.preservePendingStatus === true &&
          ((context.manualCompactionRequestActive && context.compaction.status === "starting") ||
            (context.compactionAbortRequested &&
              context.compaction.status === "abort-requested" &&
              (state.isCompacting || context.manualCompactionRequestActive)));
        if (!state.isCompacting && !context.manualCompactionRequestActive) {
          context.compactionAbortRequested = false;
        }
        context.activeCompactionScope = state.isCompacting
          ? (context.activeCompactionScope ?? {})
          : preservePending
            ? (context.activeCompactionScope ?? {})
            : undefined;
        const status = state.isCompacting
          ? preservePending
            ? context.compaction.status
            : "compacting"
          : preservePending
            ? context.compaction.status
            : "idle";
        yield* updateCompactionProjectionLocked(context, {
          status,
          abortable: state.isCompacting || preservePending ? context.compaction.abortable : false,
          autoCompactionEnabled: state.autoCompactionEnabled,
        });
        yield* syncAgentDepthSettableLocked(context);
      });

    const requireCompactionControls = (
      context: PrimeAgentDaemonSessionContext,
      operation: string,
    ) =>
      context.session.runtimeMode === "full-access" &&
      context.runtime.compactionAvailable &&
      context.compaction.available
        ? Effect.void
        : Effect.fail(
            new ProviderAdapterUnsupportedOperationError({ provider: PROVIDER, operation }),
          );

    const getSessionCompaction: NonNullable<PrimeAgentAdapterShape["getSessionCompaction"]> = (
      threadId,
    ) =>
      withThreadMutationLock(
        threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          yield* requireCompactionControls(context, "getSessionCompaction");
          const state = yield* context.runtime.getCompactionState.pipe(
            Effect.mapError((error) =>
              runtimeOperationError(threadId, "session/get-compaction-state", error),
            ),
          );
          yield* applyCompactionStateLocked(context, state, { preservePendingStatus: true });
          return context.compaction;
        }),
      );

    const compactSession: NonNullable<PrimeAgentAdapterShape["compactSession"]> = (threadId) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const reserved = yield* withThreadMutationLock(
            threadId,
            Effect.gen(function* () {
              const context = yield* requireSession(threadId);
              yield* requireCompactionControls(context, "compactSession");
              const state = yield* context.runtime.getCompactionState.pipe(
                Effect.mapError((error) =>
                  runtimeOperationError(threadId, "session/get-compaction-state", error),
                ),
              );
              yield* applyCompactionStateLocked(context, state);
              if (!isManualCompactionSettable(context)) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "compactSession",
                  reason: "busy",
                  issue: "Context can only be compacted while the session is authoritatively idle.",
                });
              }
              context.activeCompactionScope = {};
              context.manualCompactionRequestActive = true;
              yield* updateCompactionProjectionLocked(context, {
                status: "starting",
                abortable: true,
              });
              yield* syncAgentDepthSettableLocked(context);
              return context;
            }),
          );

          const runCompaction = reserved.runtime.compact.pipe(
            Effect.exit,
            Effect.flatMap((outcome) =>
              withThreadMutationLock(
                threadId,
                Effect.gen(function* () {
                  if (
                    sessions.get(threadId) !== reserved ||
                    reserved.stopped ||
                    reserved.stopRequested
                  ) {
                    return;
                  }
                  const terminalObserved =
                    reserved.compaction.status === "idle" &&
                    reserved.activeCompactionScope === undefined;
                  reserved.manualCompactionRequestActive = false;
                  const reconciled = yield* reserved.runtime.getCompactionState.pipe(Effect.exit);
                  if (Exit.isSuccess(reconciled)) {
                    yield* applyCompactionStateLocked(reserved, reconciled.value);
                    if (
                      Exit.isSuccess(outcome) ||
                      reconciled.value.isCompacting ||
                      terminalObserved
                    ) {
                      return;
                    }
                    yield* offerRuntimeEvent({
                      type: "runtime.error",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      providerInstanceId: boundInstanceId,
                      threadId,
                      payload: {
                        message: "Prime Agent context compaction did not complete.",
                        class: "provider_error",
                      },
                    });
                    return;
                  }
                  yield* stopSessionInternal(
                    reserved,
                    "Prime Agent session closed after context compaction could not be reconciled safely.",
                  ).pipe(Effect.ignore);
                }),
              ),
            ),
            Effect.catchCause(() => Effect.void),
          );
          yield* Effect.forkIn(runCompaction, reserved.scope);
          return reserved.compaction;
        }),
      );

    const abortSessionCompaction: NonNullable<PrimeAgentAdapterShape["abortSessionCompaction"]> = (
      threadId,
    ) =>
      Effect.uninterruptible(
        withThreadMutationLock(
          threadId,
          Effect.gen(function* () {
            const context = yield* requireSession(threadId);
            yield* requireCompactionControls(context, "abortSessionCompaction");
            const before = yield* context.runtime.getCompactionState.pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/get-compaction-state", error),
              ),
            );
            yield* applyCompactionStateLocked(context, before, { preservePendingStatus: true });
            if (!before.isCompacting && context.compaction.status !== "starting") {
              return context.compaction;
            }
            if (!context.compaction.abortable) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "abortSessionCompaction",
                reason: "busy",
                issue: "The active context operation cannot be aborted by this control.",
              });
            }
            context.compactionAbortRequested = true;
            yield* updateCompactionProjectionLocked(context, { status: "abort-requested" });
            const outcome = yield* Effect.result(context.runtime.abortCompaction);
            if (Result.isFailure(outcome) && outcome.failure.reason === "request-timed-out") {
              yield* stopSessionInternal(
                context,
                "Prime Agent session closed after compaction cancellation timed out.",
              ).pipe(Effect.ignore);
              return yield* runtimeOperationError(
                threadId,
                "session/abort-compaction",
                outcome.failure,
              );
            }
            const reconciled = yield* Effect.result(context.runtime.getCompactionState);
            if (Result.isFailure(outcome)) context.compactionAbortRequested = false;
            if (Result.isSuccess(reconciled)) {
              yield* applyCompactionStateLocked(context, reconciled.success, {
                preservePendingStatus: true,
              });
            } else {
              yield* stopSessionInternal(
                context,
                "Prime Agent session closed after compaction cancellation could not be reconciled safely.",
              ).pipe(Effect.ignore);
            }
            if (Result.isFailure(outcome)) {
              return yield* runtimeOperationError(
                threadId,
                "session/abort-compaction",
                outcome.failure,
              );
            }
            return context.compaction;
          }),
        ),
      );

    const setSessionAutoCompaction: NonNullable<
      PrimeAgentAdapterShape["setSessionAutoCompaction"]
    > = (input) =>
      Effect.uninterruptible(
        withThreadMutationLock(
          input.threadId,
          Effect.gen(function* () {
            const context = yield* requireSession(input.threadId);
            yield* requireCompactionControls(context, "setSessionAutoCompaction");
            if (
              !context.runtime.autoCompactionWritable ||
              !context.compaction.autoCompactionWritable
            ) {
              return yield* new ProviderAdapterUnsupportedOperationError({
                provider: PROVIDER,
                operation: "setSessionAutoCompaction",
              });
            }
            if (context.session.status !== "ready" && context.session.status !== "running") {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "setSessionAutoCompaction",
                reason: "busy",
                issue: "Automatic compaction cannot change while the session is reconnecting.",
              });
            }
            if (
              context.activeCompactionScope !== undefined ||
              context.manualCompactionRequestActive
            ) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "setSessionAutoCompaction",
                reason: "busy",
                issue: "Automatic compaction cannot change during an active compaction.",
              });
            }
            const before = yield* context.runtime.getCompactionState.pipe(
              Effect.mapError((error) =>
                runtimeOperationError(input.threadId, "session/get-compaction-state", error),
              ),
            );
            yield* applyCompactionStateLocked(context, before);
            if (before.isCompacting || context.manualCompactionRequestActive) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "setSessionAutoCompaction",
                reason: "busy",
                issue: "Automatic compaction cannot change during an active compaction.",
              });
            }
            if (before.autoCompactionEnabled === input.enabled) return context.compaction;
            const outcome = yield* Effect.result(
              context.runtime.setAutoCompactionEnabled(input.enabled),
            );
            const reconciled = yield* Effect.result(context.runtime.getCompactionState);
            if (Result.isFailure(reconciled)) {
              yield* stopSessionInternal(
                context,
                "Prime Agent session closed after automatic compaction could not be reconciled safely.",
              ).pipe(Effect.ignore);
              const error = Result.isFailure(outcome) ? outcome.failure : reconciled.failure;
              return yield* runtimeOperationError(
                input.threadId,
                "session/set-auto-compaction",
                error,
              );
            }
            yield* applyCompactionStateLocked(context, reconciled.success);
            if (reconciled.success.autoCompactionEnabled === input.enabled) {
              return context.compaction;
            }
            if (Result.isFailure(outcome)) {
              return yield* runtimeOperationError(
                input.threadId,
                "session/set-auto-compaction",
                outcome.failure,
              );
            }
            yield* stopSessionInternal(
              context,
              "Prime Agent session closed after it did not confirm automatic compaction configuration.",
            ).pipe(Effect.ignore);
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/set-auto-compaction",
              detail: "Prime Agent did not confirm automatic compaction configuration.",
            });
          }),
        ),
      );

    const reloadSessionResources: NonNullable<PrimeAgentAdapterShape["reloadSessionResources"]> = (
      threadId,
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { context, completion } = yield* withThreadLock(
            threadId,
            Effect.gen(function* () {
              const context = yield* requireSession(threadId);
              if (context.session.runtimeMode !== "full-access") {
                return yield* new ProviderAdapterUnsupportedOperationError({
                  provider: PROVIDER,
                  operation: "reloadSessionResources",
                });
              }
              if (
                context.resourceReloadCompletion !== undefined ||
                context.session.status !== "ready" ||
                context.activeTurn !== undefined ||
                context.nativeRunActive ||
                context.nativeBashActive ||
                context.activeNativeChildren.size > 0 ||
                context.activeCompactionScope !== undefined ||
                context.manualCompactionRequestActive ||
                context.pendingApprovals.size > 0 ||
                context.pendingInteractions.size > 0
              ) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "reloadSessionResources",
                  issue: "Session resources can only be reloaded while the session is idle.",
                });
              }
              const completion = yield* Deferred.make<void>();
              context.resourceReloadCompletion = completion;
              yield* syncAgentDepthSettableLocked(context);
              yield* updateCompactionProjectionLocked(context);
              return { context, completion };
            }),
          );

          return yield* Effect.gen(function* () {
            const outcome = yield* context.runtime.reloadResources.pipe(
              Effect.mapError((error) =>
                runtimeOperationError(threadId, "session/reload-resources", error),
              ),
              Effect.exit,
            );
            return yield* withThreadLock(
              threadId,
              Effect.gen(function* () {
                if (
                  context.stopRequested ||
                  context.stopped ||
                  sessions.get(threadId) !== context
                ) {
                  return yield* new ProviderAdapterSessionNotFoundError({
                    provider: PROVIDER,
                    threadId,
                  });
                }
                const payload = Exit.isSuccess(outcome)
                  ? outcome.value.resources
                  : { available: false as const, skills: [], prompts: [], commands: [] };
                yield* publishSessionResources(threadId, payload);
                if (Exit.isSuccess(outcome)) {
                  yield* updateAgentDepthProjection(context, outcome.value.agentDepth);
                }
                if (Exit.isFailure(outcome)) {
                  yield* stopSessionInternal(
                    context,
                    "Prime Agent session closed after session resources could not be reloaded safely.",
                  ).pipe(Effect.ignore);
                  return yield* Effect.failCause(outcome.cause);
                }
                return payload;
              }),
            );
          }).pipe(
            Effect.ensuring(
              withThreadLock(
                threadId,
                Effect.gen(function* () {
                  if (context.resourceReloadCompletion === completion) {
                    context.resourceReloadCompletion = undefined;
                    yield* syncAgentDepthSettableLocked(context);
                    yield* updateCompactionProjectionLocked(context);
                  }
                  yield* Deferred.succeed(completion, undefined).pipe(Effect.ignore);
                }),
              ).pipe(Effect.ignore),
            ),
          );
        }),
      );

    const stopSession: PrimeAgentAdapterShape["stopSession"] = (threadId) =>
      Effect.uninterruptible(
        withThreadMutationLock(
          threadId,
          Effect.gen(function* () {
            const context = sessions.get(threadId);
            if (context === undefined || context.stopped) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId,
              });
            }
            context.stopRequested = true;
            if (context.activeTurn !== undefined) {
              context.activeTurn.cancellationRequested = true;
              context.activeTurn.controller.abort();
            }
            yield* stopSessionInternal(context);
          }),
        ),
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
        yield* Effect.forEach(
          contexts,
          (context) =>
            withThreadMutationLock(
              context.threadId,
              Effect.gen(function* () {
                if (sessions.get(context.threadId) !== context || context.stopped) return;
                context.stopRequested = true;
                if (context.activeTurn !== undefined) {
                  context.activeTurn.cancellationRequested = true;
                  context.activeTurn.controller.abort();
                }
                yield* stopSessionInternal(context);
              }),
            ),
          { discard: true },
        );
      }).pipe(Effect.uninterruptible);

    yield* Effect.addFinalizer(() =>
      shutdownPrimeAgentEventPubSub({
        component: "daemon",
        pubSub: runtimeEventPubSub,
        drain: stopAll(),
      }).pipe(Effect.ensuring(managedNativeEventLogger?.close() ?? Effect.void)),
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
      reloadSessionResources,
      askSessionSideQuestion,
      cancelSessionSideQuestion,
      cancelSessionAgent,
      messageSessionAgent,
      watchSessionAgentActivity,
      getSessionAgentDepth,
      setSessionAgentDepth,
      followUp,
      getSessionInputQueue,
      clearSessionInputQueue,
      removeOnlySessionInputQueueItem,
      setSessionInputQueueMode,
      getSessionCompaction,
      compactSession,
      abortSessionCompaction,
      setSessionAutoCompaction,
      refineSessionHarness,
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
