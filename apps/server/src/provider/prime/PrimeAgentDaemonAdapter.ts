import * as NodeCrypto from "node:crypto";

import {
  ApprovalRequestId,
  CommandId,
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
  type ProviderSendTurnInput,
  type ProviderSession,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeSessionId,
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
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
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
import { BUILT_IN_ADAPTER_CONVERSATION_ROLLBACK_MODES } from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import { primeAgentSessionDirectory } from "../Layers/PrimeAgentAdapter.ts";
import type {
  PrimeAgentDaemonServiceTier,
  PrimeAgentDaemonThinkingLevel,
} from "./PrimeAgentDaemonBridge.ts";
import {
  PRIME_AGENT_DAEMON_MESSAGE_TEXT_MAX_CHARS,
  PRIME_AGENT_DAEMON_TRANSCRIPT_MAX_MESSAGES,
  primeAgentPromptLifecycleCanAdvance,
  primeAgentPromptLifecycleIsSame,
  primeAgentPromptLifecycleIsSuccessor,
  type PrimeDaemonEvent,
  type PrimeDaemonMessage,
  type PrimeDaemonPromptLifecycleSnapshot,
  type PrimeDaemonUsage,
} from "./PrimeAgentDaemonEvents.ts";
import type { PrimeAgentDaemonManager } from "./PrimeAgentDaemonManager.ts";
import type { PrimeAgentRuntimeContext } from "./PrimeAgentRuntimeContext.ts";
import {
  PrimeAgentRecoveryLedger,
  type PrimeAgentRecoveryAuthority,
  type PrimeAgentRecoveryLedgerShape,
} from "./PrimeAgentRecoveryLedger.ts";
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
  PRIME_AGENT_MANAGED_EXTENSION_FILENAME,
  PRIME_AGENT_MANAGED_EXTENSION_MARKER_COMMAND,
  PRIME_AGENT_PLAN_TOOL_NAME,
  makePrimeAgentManagedExtensionSource,
  projectPrimeAgentManagedPermissionRequest,
  type PrimeAgentManagedPermissionRequestType,
} from "./PrimeAgentManagedExtension.ts";
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
export const PRIME_AGENT_SESSION_TEARDOWN_TIMEOUT_MS = 5_000;
const PRIME_AGENT_SESSION_CLEANUP_CONCURRENCY = 4;
const PRIME_AGENT_TERMINAL_EVENT_TIMEOUT_MS = 100;
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
  readonly runtimeContext?: PrimeAgentRuntimeContext;
  /** Present only after the exact selected package passed Pylon managed-distribution proof. */
  readonly recoveryManagedBuildId?: string;
  readonly recoveryLedger?: PrimeAgentRecoveryLedgerShape;
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
  /** Provider-private. Never publish or persist this native ownership token. */
  readonly correlationId?: string | undefined;
  correlatedLifecycle?: PrimeDaemonPromptLifecycleSnapshot | undefined;
  cancellationRequested: boolean;
  assistantTextStreamed: boolean;
  assistantTextEmitted: string;
  assistantTextRecoveryComparable: boolean;
  nextAssistantMessageSequence: number;
  activeAssistantItemId: RuntimeItemId | undefined;
  lastAssistantHadRenderableText: boolean;
  runCompletionHandoffSequence: number;
  terminalQuiescenceGeneration: number;
  terminalQuiescenceToken: string | undefined;
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
  readonly nativeTranscriptBaselineMessageCount: number;
  readonly observedToolStarts: Set<string>;
  readonly observedToolCompletions: Set<string>;
  /** Durable assistant tool-call messages, retained only for in-memory correlation. */
  readonly durableToolCallNames: Map<string, string>;
  /** Finalized tool-result messages, retained only for in-memory correlation. */
  readonly completedToolCallNames: Map<string, string>;
  readonly projectedPlanToolCallIds: Set<string>;
  readonly command?: "compact" | undefined;
}

type PrimeAgentDaemonBlockingInteractionMethod = "select" | "confirm" | "input";

interface PrimeAgentDaemonPendingInteraction {
  readonly nativeId: string;
  readonly method: PrimeAgentDaemonBlockingInteractionMethod;
  readonly selectOptions: ReadonlySet<string> | undefined;
  readonly ownerTurnId: TurnId | undefined;
  readonly ownerCorrelationId: string | undefined;
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
  readonly ownerTurnId: TurnId | undefined;
  readonly ownerCorrelationId: string | undefined;
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
  readonly sessionIncarnationId: RuntimeSessionId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly runtime: PrimeAgentDaemonSessionRuntime;
  readonly managedExtensionPath: string;
  readonly managedExtensionSource: string;
  managedPlanProjectionEnabled: boolean;
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
  nativeTranscript: Array<PrimeDaemonMessage>;
  nativeTranscriptMessageCount: number;
  readonly nativeTranscriptFingerprints: Set<string>;
  recoveryTranscriptMessageCount: number;
  recoveryTranscriptFingerprints: Array<string>;
  readonly pendingInteractions: Map<
    SessionInteractionRequestId,
    PrimeAgentDaemonPendingInteraction
  >;
  readonly pendingApprovals: Map<ApprovalRequestId, PrimeAgentDaemonPendingApproval>;
  readonly permissionToken: string | undefined;
  approvalsAcceptedForSession: boolean;
  activeTurn: PrimeAgentDaemonActiveTurn | undefined;
  nativeRunActive: boolean;
  backgroundQuiescenceGeneration: number;
  backgroundQuiescencePending: boolean;
  backgroundQuiescenceController: AbortController | undefined;
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
  exitEnqueued: boolean;
  exitPublished: boolean;
  readonly exitPublicationSemaphore: Semaphore.Semaphore;
  teardownStarted: boolean;
  readonly teardownCompletion: Deferred.Deferred<void>;
  readonly teardownResourcesStarted: Deferred.Deferred<void>;
  readonly recoveryOwnerToken?: string;
  readonly recoveryBacklog: ReadonlyArray<PrimeDaemonMessage>;
  recoveryPendingActivation: boolean;
}

function observeNativeRunStarted(
  context: PrimeAgentDaemonSessionContext,
  turn: PrimeAgentDaemonActiveTurn | undefined,
): void {
  context.nativeRunActive = true;
  context.inputQueueClearPending = false;
  if (turn?.pendingRunCompletionHandoff !== undefined) {
    turn.completedRunMessages.push(...turn.pendingRunCompletionHandoff.event.messages);
    turn.pendingRunCompletionHandoff = undefined;
  }
  if (turn?.awaitingQueuedRun === true) {
    turn.awaitingQueuedRun = false;
    turn.queuedActionObserved = false;
  }
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
  | {
      readonly state: "completedWithoutMessage";
      readonly usageOverride?: PrimeDaemonUsage | undefined;
    }
  | {
      readonly state: "failed";
      readonly errorMessage: string;
      readonly runtimeErrorMessage?: string;
      readonly usageOverride?: PrimeDaemonUsage | undefined;
    }
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

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return rightSet.size === right.length && left.every((value) => rightSet.has(value));
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

function primeDaemonMessageFingerprint(message: PrimeDaemonMessage): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(message), "utf8").digest("hex");
}

export function planPrimeAgentRestartReplay(input: {
  readonly authorityMessageCount: number;
  readonly authorityFingerprints: ReadonlyArray<string>;
  readonly snapshotMessageCount: number;
  readonly snapshotMessages: ReadonlyArray<PrimeDaemonMessage>;
}):
  | { readonly valid: true; readonly backlog: ReadonlyArray<PrimeDaemonMessage> }
  | {
      readonly valid: false;
    } {
  const expectedFingerprintCount = Math.min(
    input.authorityMessageCount,
    PRIME_AGENT_DAEMON_TRANSCRIPT_MAX_MESSAGES,
  );
  const snapshotStart = input.snapshotMessageCount - input.snapshotMessages.length;
  const authorityStart = input.authorityMessageCount - input.authorityFingerprints.length;
  if (
    input.authorityFingerprints.length !== expectedFingerprintCount ||
    input.snapshotMessages.length !==
      Math.min(input.snapshotMessageCount, PRIME_AGENT_DAEMON_TRANSCRIPT_MAX_MESSAGES) ||
    input.snapshotMessageCount < input.authorityMessageCount ||
    snapshotStart > input.authorityMessageCount
  ) {
    return { valid: false };
  }
  const overlapStart = Math.max(authorityStart, snapshotStart);
  for (
    let absoluteIndex = overlapStart;
    absoluteIndex < input.authorityMessageCount;
    absoluteIndex += 1
  ) {
    const expected = input.authorityFingerprints[absoluteIndex - authorityStart];
    const observed = input.snapshotMessages[absoluteIndex - snapshotStart];
    if (observed === undefined || primeDaemonMessageFingerprint(observed) !== expected) {
      return { valid: false };
    }
  }
  return {
    valid: true,
    backlog: input.snapshotMessages.slice(input.authorityMessageCount - snapshotStart),
  };
}

// Reconnect snapshots keep only a bounded completed-message tail. Absolute
// message counts make a shifted tail exact without retaining the full history.
function reconcileTranscriptTail(input: {
  readonly observed: ReadonlyArray<PrimeDaemonMessage>;
  readonly observedCount: number;
  readonly snapshot: ReadonlyArray<PrimeDaemonMessage>;
  readonly snapshotCount: number;
}):
  | {
      readonly missingMessages: ReadonlyArray<PrimeDaemonMessage>;
      readonly overlapCount: number;
    }
  | undefined {
  if (
    input.observed.length !==
      Math.min(input.observedCount, PRIME_AGENT_DAEMON_TRANSCRIPT_MAX_MESSAGES) ||
    input.snapshot.length !==
      Math.min(input.snapshotCount, PRIME_AGENT_DAEMON_TRANSCRIPT_MAX_MESSAGES) ||
    input.snapshotCount < input.observedCount
  ) {
    return undefined;
  }
  const observedStart = input.observedCount - input.observed.length;
  const snapshotStart = input.snapshotCount - input.snapshot.length;
  if (snapshotStart > input.observedCount) return undefined;

  const overlapStart = Math.max(observedStart, snapshotStart);
  for (let absoluteIndex = overlapStart; absoluteIndex < input.observedCount; absoluteIndex += 1) {
    const observedMessage = input.observed[absoluteIndex - observedStart];
    const snapshotMessage = input.snapshot[absoluteIndex - snapshotStart];
    if (
      observedMessage === undefined ||
      snapshotMessage === undefined ||
      primeDaemonMessageFingerprint(observedMessage) !==
        primeDaemonMessageFingerprint(snapshotMessage)
    ) {
      return undefined;
    }
  }
  return {
    missingMessages: input.snapshot.slice(input.observedCount - snapshotStart),
    overlapCount: input.observedCount - overlapStart,
  };
}

function appendTranscriptMessages(
  transcript: Array<PrimeDaemonMessage>,
  fingerprints: Set<string>,
  messages: ReadonlyArray<PrimeDaemonMessage>,
): number {
  let appendedCount = 0;
  for (const message of messages) {
    const fingerprint = primeDaemonMessageFingerprint(message);
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    transcript.push(message);
    appendedCount += 1;
  }
  const overflow = transcript.length - PRIME_AGENT_DAEMON_TRANSCRIPT_MAX_MESSAGES;
  if (overflow > 0) {
    transcript.splice(0, overflow);
    fingerprints.clear();
    for (const message of transcript) {
      fingerprints.add(primeDaemonMessageFingerprint(message));
    }
  }
  return appendedCount;
}

function recordCorrelatedToolName(
  names: Map<string, string>,
  toolCallId: string,
  toolName: string,
): void {
  const previous = names.get(toolCallId);
  if (previous === undefined) {
    names.set(toolCallId, toolName);
  } else if (previous !== toolName) {
    names.set(toolCallId, "");
  }
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

function rlmQuiescenceToken(turnId: TurnId, generation: number): string {
  return `${turnId}:${generation}`;
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
    const primeRuntimeContext = options?.runtimeContext;
    if (
      primeRuntimeContext !== undefined &&
      (primeRuntimeContext.backendKind !== "daemon" ||
        primeRuntimeContext.instanceId !== boundInstanceId ||
        primeRuntimeContext.instanceId !== manager.identity.instanceId ||
        primeRuntimeContext.configRevision !== manager.identity.configRevision ||
        primeRuntimeContext.effectiveHome !== manager.identity.effectiveHome ||
        primeRuntimeContext.launchEnv !== manager.identity.launchEnv)
    ) {
      return yield* Effect.die(
        new Error("The Prime Agent runtime context does not own this daemon adapter."),
      );
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const ledgerService = yield* Effect.serviceOption(PrimeAgentRecoveryLedger);
    const rawRecoveryLedger = options?.recoveryLedger ?? Option.getOrUndefined(ledgerService);
    const recoveryLedger =
      rawRecoveryLedger === undefined
        ? undefined
        : {
            putPrepared: (input: Parameters<PrimeAgentRecoveryLedgerShape["putPrepared"]>[0]) =>
              rawRecoveryLedger.putPrepared(input).pipe(Effect.orDie),
            get: (threadId: string) => rawRecoveryLedger.get(threadId).pipe(Effect.orDie),
            discardPrepared: (
              input: Parameters<PrimeAgentRecoveryLedgerShape["discardPrepared"]>[0],
            ) => rawRecoveryLedger.discardPrepared(input).pipe(Effect.orDie),
            markAdmitted: (input: Parameters<PrimeAgentRecoveryLedgerShape["markAdmitted"]>[0]) =>
              rawRecoveryLedger.markAdmitted(input).pipe(Effect.orDie),
            updateTranscriptProgress: (
              input: Parameters<PrimeAgentRecoveryLedgerShape["updateTranscriptProgress"]>[0],
            ) => rawRecoveryLedger.updateTranscriptProgress(input).pipe(Effect.orDie),
            claim: (input: Parameters<PrimeAgentRecoveryLedgerShape["claim"]>[0]) =>
              rawRecoveryLedger.claim(input).pipe(Effect.orDie),
            releaseClaim: (input: Parameters<PrimeAgentRecoveryLedgerShape["releaseClaim"]>[0]) =>
              rawRecoveryLedger.releaseClaim(input).pipe(Effect.orDie),
            commitAdoption: (
              input: Parameters<PrimeAgentRecoveryLedgerShape["commitAdoption"]>[0],
            ) => rawRecoveryLedger.commitAdoption(input).pipe(Effect.orDie),
            markNativeCleanup: (
              input: Parameters<PrimeAgentRecoveryLedgerShape["markNativeCleanup"]>[0],
            ) => rawRecoveryLedger.markNativeCleanup(input).pipe(Effect.orDie),
            markTerminalProjected: (
              input: Parameters<PrimeAgentRecoveryLedgerShape["markTerminalProjected"]>[0],
            ) => rawRecoveryLedger.markTerminalProjected(input).pipe(Effect.orDie),
            deleteIfSettled: (threadId: string) =>
              rawRecoveryLedger.deleteIfSettled(threadId).pipe(Effect.orDie),
          };
    const crypto = yield* Crypto.Crypto;
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
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
    type PendingRecoveryStart =
      | {
          readonly kind: "create";
          readonly admissionRequestId: string;
          readonly correlationId: string;
          readonly mcpOwnerId: string;
          readonly ownerToken: string;
          readonly transcriptMessageCount: number;
          readonly transcriptFingerprints: ReadonlyArray<string>;
        }
      | {
          readonly kind: "adopt";
          readonly authority: PrimeAgentRecoveryAuthority;
          readonly previousOwnerToken: string;
          readonly ownerToken: string;
          readonly requestId: string;
          readonly mcpOwnerId: string;
          readonly sessionFile: string;
        };
    const pendingRecoveryStarts = new Map<ThreadId, PendingRecoveryStart>();
    const activeTeardowns = new Map<
      ThreadId,
      {
        readonly context: PrimeAgentDaemonSessionContext;
        readonly completion: Deferred.Deferred<void>;
        readonly run: Effect.Effect<void>;
        started: boolean;
      }
    >();
    const activeSideQuestions = new Map<ThreadId, PrimeAgentDaemonActiveSideQuestion>();
    let nextModelDiscoveryGeneration = 0;
    let publishedModelDiscoveryGeneration = 0;
    const modelPublicationSemaphore = yield* Semaphore.make(1);
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* makePrimeAgentEventPubSub<ProviderRuntimeEvent>();
    type OrderedRuntimeEvent = {
      readonly event: ProviderRuntimeEvent;
      readonly terminalDelivery?:
        | {
            readonly delivered: Deferred.Deferred<void>;
            readonly markPublished: () => void;
          }
        | undefined;
    };
    // Preserve the direct bounded handoff while subscribers are keeping up.
    // Once backpressure appears, atomically queue this event and every successor
    // so mutation permits never suspend and the relay preserves exact FIFO.
    const orderedRuntimeEventQueue = yield* Queue.unbounded<OrderedRuntimeEvent>();
    let pendingOrderedRuntimeEvents = 0;
    const pendingTerminalDeliveries = new Set<Deferred.Deferred<void>>();
    const completeTerminalDelivery = (
      terminalDelivery: OrderedRuntimeEvent["terminalDelivery"],
      accepted: boolean,
    ) =>
      terminalDelivery === undefined
        ? Effect.void
        : Effect.sync(() => {
            pendingTerminalDeliveries.delete(terminalDelivery.delivered);
            if (accepted) terminalDelivery.markPublished();
          }).pipe(
            Effect.andThen(Deferred.succeed(terminalDelivery.delivered, undefined)),
            Effect.ignore,
          );
    const logRejectedRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Effect.logError("Prime Agent runtime event was not accepted.", {
        component: "daemon",
        eventType: event.type,
        threadId: event.threadId,
        outcome: "forced-drop-after-shutdown",
      });
    yield* Queue.take(orderedRuntimeEventQueue).pipe(
      Effect.flatMap(({ event, terminalDelivery }) =>
        PubSub.publish(runtimeEventPubSub, event).pipe(
          Effect.flatMap((accepted) =>
            Effect.sync(() => {
              pendingOrderedRuntimeEvents -= 1;
            }).pipe(
              Effect.andThen(completeTerminalDelivery(terminalDelivery, accepted)),
              Effect.andThen(accepted ? Effect.void : logRejectedRuntimeEvent(event)),
            ),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const offerOrderedRuntimeEvent = (entry: OrderedRuntimeEvent) =>
      Effect.sync(() => {
        if (
          pendingOrderedRuntimeEvents === 0 &&
          PubSub.publishUnsafe(runtimeEventPubSub, entry.event)
        ) {
          return "published" as const;
        }
        pendingOrderedRuntimeEvents += 1;
        if (Queue.offerUnsafe(orderedRuntimeEventQueue, entry)) return "queued" as const;
        pendingOrderedRuntimeEvents -= 1;
        return "rejected" as const;
      }).pipe(
        Effect.flatMap((outcome) =>
          outcome === "published"
            ? completeTerminalDelivery(entry.terminalDelivery, true).pipe(
                Effect.andThen(Effect.yieldNow),
                Effect.as(true),
              )
            : outcome === "queued"
              ? Effect.yieldNow.pipe(Effect.as(true))
              : completeTerminalDelivery(entry.terminalDelivery, false).pipe(
                  Effect.andThen(logRejectedRuntimeEvent(entry.event)),
                  Effect.as(false),
                ),
        ),
      );

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
      offerOrderedRuntimeEvent({ event }).pipe(Effect.asVoid);
    const publishRuntimeEvent = (
      context: PrimeAgentDaemonSessionContext,
      event: ProviderRuntimeEvent,
    ) =>
      offerRuntimeEvent({
        ...event,
        // The immutable context owns the event even after its session map entry
        // is deleted or replaced. Never infer incarnation from mutable routing.
        sessionIncarnationId: context.sessionIncarnationId,
      });

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
    const drainActiveTeardown = (threadId: ThreadId) =>
      Effect.suspend(() => {
        const teardown = activeTeardowns.get(threadId);
        if (teardown === undefined || teardown.started) return Effect.void;
        teardown.started = true;
        return teardown.run.pipe(
          Effect.forkDetach,
          Effect.andThen(
            Effect.raceFirst(
              Deferred.await(teardown.context.teardownResourcesStarted),
              Deferred.await(teardown.completion),
            ),
          ),
          Effect.andThen(Effect.yieldNow),
          Effect.asVoid,
        );
      });
    const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) =>
        semaphore.withPermit(effect).pipe(Effect.ensuring(drainActiveTeardown(threadId))),
      );

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

    const publishSessionResources = (
      context: PrimeAgentDaemonSessionContext,
      payload: PrimeAgentDaemonSessionRuntime["initialResources"],
    ) =>
      Effect.flatMap(makeEventStamp(), (eventStamp) =>
        publishRuntimeEvent(context, {
          type: "session.resources.updated",
          ...eventStamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          payload,
        }),
      );

    const publishSessionAgentDepth = (
      context: PrimeAgentDaemonSessionContext,
      payload: SessionAgentDepthUpdatedPayload,
    ) =>
      Effect.flatMap(makeEventStamp(), (eventStamp) =>
        publishRuntimeEvent(context, {
          type: "session.agent-depth.updated",
          ...eventStamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          payload,
        }),
      );

    const publishSessionCompaction = (
      context: PrimeAgentDaemonSessionContext,
      payload: SessionCompactionUpdatedPayload,
    ) =>
      Effect.flatMap(makeEventStamp(), (eventStamp) =>
        publishRuntimeEvent(context, {
          type: "session.compaction.updated",
          ...eventStamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          payload,
        }),
      );

    const publishSessionHarnessRefinement = (
      context: PrimeAgentDaemonSessionContext,
      payload: SessionHarnessRefinementUpdatedPayload,
    ) =>
      Effect.flatMap(makeEventStamp(), (eventStamp) =>
        publishRuntimeEvent(context, {
          type: "session.harness-refinement.updated",
          ...eventStamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          payload,
        }),
      );

    const publishSessionGoal = (
      context: PrimeAgentDaemonSessionContext,
      payload: SessionGoalUpdatedPayload,
    ) =>
      Effect.flatMap(makeEventStamp(), (eventStamp) =>
        publishRuntimeEvent(context, {
          type: "session.goal.updated",
          ...eventStamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
          payload,
        }),
      );

    const publishSessionInputQueue = (
      context: PrimeAgentDaemonSessionContext,
      payload: SessionInputQueueUpdatedPayload,
    ) =>
      Effect.flatMap(makeEventStamp(), (eventStamp) =>
        publishRuntimeEvent(context, {
          type: "session.input-queue.updated",
          ...eventStamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.threadId,
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
        if (changed) yield* publishSessionInputQueue(context, resolved);
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
        if (changed) yield* publishSessionGoal(context, next);
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
        yield* publishSessionAgentDepth(context, context.agentDepth);
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
        if (changed) yield* publishSessionCompaction(context, next);
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
          turn.assistantTextEmitted = "";
          turn.assistantTextRecoveryComparable = true;
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
          turn.assistantTextEmitted = "";
          turn.assistantTextRecoveryComparable = true;
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
          yield* publishRuntimeEvent(context, {
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
        const planUpdate =
          event._tag === "MessageCompleted" && event.message.role === "toolResult"
            ? event.message.planUpdate
            : undefined;
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
          if (
            draft.type === "turn.plan.updated" &&
            (!context.managedPlanProjectionEnabled ||
              turn === undefined ||
              planUpdate === undefined ||
              turn.durableToolCallNames.get(planUpdate.toolCallId) !== PRIME_AGENT_PLAN_TOOL_NAME ||
              turn.completedToolCallNames.get(planUpdate.toolCallId) !==
                PRIME_AGENT_PLAN_TOOL_NAME ||
              turn.projectedPlanToolCallIds.has(planUpdate.toolCallId))
          ) {
            continue;
          }
          yield* publishRuntimeEvent(context, { ...draft, ...(yield* makeEventStamp()) });
          if (draft.type === "turn.plan.updated" && planUpdate !== undefined) {
            turn?.projectedPlanToolCallIds.add(planUpdate.toolCallId);
          }
        }
        if (
          turn !== undefined &&
          event._tag === "AssistantStream" &&
          event.kind === "text" &&
          event.phase === "delta" &&
          event.delta !== undefined
        ) {
          if (
            turn.assistantTextEmitted.length + event.delta.length >
            PRIME_AGENT_DAEMON_MESSAGE_TEXT_MAX_CHARS
          ) {
            turn.assistantTextRecoveryComparable = false;
          }
          turn.assistantTextEmitted = (turn.assistantTextEmitted + event.delta).slice(
            0,
            PRIME_AGENT_DAEMON_MESSAGE_TEXT_MAX_CHARS,
          );
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
          if (turn.lastAssistantHadRenderableText) {
            context.runtime.noteWorkerRecoveryTerminalResponse();
          }
          turn.activeAssistantItemId = undefined;
          turn.assistantTextEmitted = "";
          turn.assistantTextRecoveryComparable = true;
        }
      });

    const correlatedTranscriptSnapshotIsExact = (
      context: PrimeAgentDaemonSessionContext,
      event: Extract<PrimeDaemonEvent, { readonly _tag: "SessionResynced" }>,
    ): boolean => {
      if (event.replayContinuity !== "complete") return false;
      const reconciliation = reconcileTranscriptTail({
        observed: context.nativeTranscript,
        observedCount: context.nativeTranscriptMessageCount,
        snapshot: event.messages,
        snapshotCount: event.state.messageCount,
      });
      return reconciliation !== undefined && reconciliation.missingMessages.length === 0;
    };

    const reconcileTranscriptSnapshotLocked = (
      context: PrimeAgentDaemonSessionContext,
      event: Extract<PrimeDaemonEvent, { readonly _tag: "SessionResynced" }>,
    ) =>
      Effect.gen(function* () {
        const reconciliation = reconcileTranscriptTail({
          observed: context.nativeTranscript,
          observedCount: context.nativeTranscriptMessageCount,
          snapshot: event.messages,
          snapshotCount: event.state.messageCount,
        });
        if (reconciliation === undefined) return false;
        if (
          event.replayContinuity !== "complete" &&
          (event.streamingMessage !== undefined ||
            (context.nativeTranscriptMessageCount > 0 && reconciliation.overlapCount === 0))
        ) {
          return false;
        }

        const turn = context.activeTurn;
        const firstMissingAssistant = reconciliation.missingMessages.find(
          (message) => message.role === "assistant",
        );
        if (
          turn?.activeAssistantItemId !== undefined &&
          ((firstMissingAssistant !== undefined &&
            (!turn.assistantTextRecoveryComparable ||
              !firstMissingAssistant.text.startsWith(turn.assistantTextEmitted))) ||
            (firstMissingAssistant === undefined &&
              event.streamingMessage === undefined &&
              !event.state.isStreaming))
        ) {
          return false;
        }

        const { missingMessages } = reconciliation;
        if (context.activeTurn === undefined && missingMessages.length > 0) return false;
        context.nativeTranscript = [...event.messages];
        context.nativeTranscriptMessageCount = event.state.messageCount;
        context.nativeTranscriptFingerprints.clear();
        for (const message of event.messages) {
          context.nativeTranscriptFingerprints.add(primeDaemonMessageFingerprint(message));
        }

        if (turn === undefined) return true;
        const snapshotStartMessageCount = event.state.messageCount - event.messages.length;
        const currentTurnMessages = event.messages.slice(
          Math.max(0, turn.nativeTranscriptBaselineMessageCount - snapshotStartMessageCount),
        );
        const missingMessageSet = new Set(missingMessages);

        // Walk the authoritative transcript once. This keeps recovered assistant,
        // tool, and managed-plan events in the same durable message order.
        for (const message of currentTurnMessages) {
          if (message.role === "assistant") {
            for (const toolCall of message.toolCalls) {
              recordCorrelatedToolName(turn.durableToolCallNames, toolCall.id, toolCall.name);
            }
            if (missingMessageSet.has(message)) {
              const recoveredPrefix =
                turn.activeAssistantItemId === undefined ? "" : turn.assistantTextEmitted;
              if (turn.activeAssistantItemId === undefined) {
                yield* publishDrafts(context, { _tag: "MessageStarted", message }, turn);
              }
              turn.assistantTextStreamed = false;
              yield* publishDrafts(
                context,
                {
                  _tag: "MessageCompleted",
                  message: { ...message, text: message.text.slice(recoveredPrefix.length) },
                },
                turn,
              );
              turn.lastAssistantHadRenderableText =
                message.text.trim().length > 0 &&
                message.stopReason !== "toolUse" &&
                message.toolCalls.length === 0;
            }
            for (const toolCall of message.toolCalls) {
              if (turn.observedToolStarts.has(toolCall.id)) continue;
              turn.observedToolStarts.add(toolCall.id);
              turn.lastAssistantHadRenderableText = false;
              yield* publishDrafts(
                context,
                {
                  _tag: "ToolStarted",
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  ...(toolCall.input === undefined ? {} : { input: toolCall.input }),
                },
                turn,
              );
            }
          } else if (message.role === "toolResult") {
            recordCorrelatedToolName(
              turn.completedToolCallNames,
              message.toolCallId,
              message.toolName,
            );
            if (!turn.observedToolStarts.has(message.toolCallId)) {
              turn.observedToolStarts.add(message.toolCallId);
              yield* publishDrafts(
                context,
                {
                  _tag: "ToolStarted",
                  toolCallId: message.toolCallId,
                  toolName: message.toolName,
                },
                turn,
              );
            }
            if (!turn.observedToolCompletions.has(message.toolCallId)) {
              turn.observedToolCompletions.add(message.toolCallId);
              yield* publishDrafts(
                context,
                {
                  _tag: "ToolCompleted",
                  toolCallId: message.toolCallId,
                  toolName: message.toolName,
                  text: message.text,
                  isError: message.isError,
                },
                turn,
              );
            }
            if (message.planUpdate !== undefined) {
              yield* publishDrafts(context, { _tag: "MessageCompleted", message }, turn);
            }
            turn.lastAssistantHadRenderableText = false;
          }
        }

        const authoritativeRunIdle =
          !event.state.isStreaming &&
          !event.state.isCompacting &&
          !event.state.isBashRunning &&
          !event.state.inputQueue.activeAction;
        const snapshotProvesRunOutput = currentTurnMessages.some(
          (message) => message.role === "assistant" || message.role === "toolResult",
        );
        if (
          authoritativeRunIdle &&
          event.replayContinuity !== "complete" &&
          snapshotProvesRunOutput &&
          !turn.awaitingQueuedRun &&
          turn.pendingRunCompletionHandoff === undefined
        ) {
          const sequence = ++turn.runCompletionHandoffSequence;
          turn.pendingRunCompletionHandoff = {
            sequence,
            event: { _tag: "RunCompleted", messages: currentTurnMessages },
          };
          context.nativeRunActive = false;
        }
        return true;
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
        const snapshotOwner = context.runtime.correlatedPromptLifecycleAvailable
          ? undefined
          : context.activeTurn;
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
              snapshotOwner,
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
          yield* publishDrafts(context, { _tag: "ChildUpdated", child: settled }, snapshotOwner);
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
        yield* publishRuntimeEvent(context, { ...draft, ...(yield* makeEventStamp()) });
      });

    /** Must be called with the thread lock held. */
    const settleActiveTurnLocked = (
      context: PrimeAgentDaemonSessionContext,
      turn: PrimeAgentDaemonActiveTurn,
      outcome: TurnOutcome,
      options?: { readonly preserveOutcomeDuringTeardown?: boolean },
    ) =>
      Effect.gen(function* () {
        if (
          (!context.teardownStarted && sessions.get(context.threadId) !== context) ||
          context.stopped ||
          context.activeTurn !== turn ||
          context.session.activeTurnId !== turn.id
        ) {
          return false;
        }

        const effectiveOutcome: TurnOutcome =
          !options?.preserveOutcomeDuringTeardown &&
          (context.stopRequested ||
            (turn.correlationId === undefined && turn.cancellationRequested))
            ? { state: "cancelled" }
            : outcome;
        turn.pendingRunCompletionHandoff = undefined;
        if (
          effectiveOutcome.state === "failed" &&
          (!turn.lastAssistantHadRenderableText ||
            effectiveOutcome.runtimeErrorMessage !== undefined)
        ) {
          yield* publishRuntimeEvent(context, {
            type: "runtime.error",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId: turn.id,
            payload: {
              message:
                effectiveOutcome.runtimeErrorMessage ?? PRIME_AGENT_STOPPED_WITHOUT_FINAL_RESPONSE,
              class: "provider_error",
              ...(effectiveOutcome.runtimeErrorMessage === undefined
                ? { detail: primeAgentMissingFinalResponseDetail("failed") }
                : {}),
            },
          });
        }
        if (effectiveOutcome.state === "completed") {
          yield* publishDrafts(context, effectiveOutcome.event, turn);
          context.turns.push({ id: turn.id, items: [] });
        } else {
          yield* publishRuntimeEvent(context, {
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            turnId: turn.id,
            payload:
              effectiveOutcome.state === "completedWithoutMessage"
                ? {
                    state: "completed",
                    ...(effectiveOutcome.usageOverride === undefined
                      ? {}
                      : {
                          usage: {
                            inputTokens: effectiveOutcome.usageOverride.inputTokens,
                            outputTokens: effectiveOutcome.usageOverride.outputTokens,
                            cachedInputTokens: effectiveOutcome.usageOverride.cachedInputTokens,
                            cacheWriteTokens: effectiveOutcome.usageOverride.cacheWriteTokens,
                            totalTokens: effectiveOutcome.usageOverride.totalTokens,
                          },
                          totalCostUsd: effectiveOutcome.usageOverride.totalCostUsd,
                        }),
                  }
                : effectiveOutcome.state === "cancelled"
                  ? { state: "cancelled", stopReason: "aborted" }
                  : {
                      state: "failed",
                      errorMessage: effectiveOutcome.errorMessage,
                      ...(effectiveOutcome.usageOverride === undefined
                        ? {}
                        : {
                            usage: {
                              inputTokens: effectiveOutcome.usageOverride.inputTokens,
                              outputTokens: effectiveOutcome.usageOverride.outputTokens,
                              cachedInputTokens: effectiveOutcome.usageOverride.cachedInputTokens,
                              cacheWriteTokens: effectiveOutcome.usageOverride.cacheWriteTokens,
                              totalTokens: effectiveOutcome.usageOverride.totalTokens,
                            },
                            totalCostUsd: effectiveOutcome.usageOverride.totalCostUsd,
                          }),
                    },
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
        if (context.recoveryOwnerToken !== undefined && !context.stopRequested) {
          context.stopRequested = true;
          yield* Effect.forkDetach(
            Effect.yieldNow.pipe(
              Effect.andThen(withThreadLock(context.threadId, stopSessionInternal(context))),
            ),
          );
        }
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

    const failCorrelatedProtocolLocked = (
      context: PrimeAgentDaemonSessionContext,
      turn: PrimeAgentDaemonActiveTurn,
    ) =>
      settleActiveTurnLocked(context, turn, {
        state: "failed",
        errorMessage: "Prime Agent returned invalid correlated prompt lifecycle data.",
        runtimeErrorMessage: "Prime Agent returned invalid correlated prompt lifecycle data.",
      });

    const applyCorrelatedPromptLifecycleLocked = (
      context: PrimeAgentDaemonSessionContext,
      lifecycle: PrimeDaemonPromptLifecycleSnapshot,
      options: { readonly authoritativeSnapshot?: boolean } = {},
    ) =>
      Effect.gen(function* () {
        const turn = context.activeTurn;
        if (turn === undefined || turn.correlationId !== lifecycle.correlationId) return false;
        const current = turn.correlatedLifecycle;
        if (current !== undefined) {
          if (lifecycle.revision === current.revision) {
            if (primeAgentPromptLifecycleIsSame(lifecycle, current)) return false;
            return yield* failCorrelatedProtocolLocked(context, turn);
          }
          const valid =
            options.authoritativeSnapshot === true
              ? primeAgentPromptLifecycleCanAdvance(current, lifecycle)
              : primeAgentPromptLifecycleIsSuccessor(current, lifecycle);
          if (!valid) return yield* failCorrelatedProtocolLocked(context, turn);
        }
        turn.correlatedLifecycle = lifecycle;
        if (
          lifecycle.phase !== "completed" &&
          lifecycle.phase !== "cancelled" &&
          lifecycle.phase !== "failed"
        ) {
          return false;
        }
        if (lifecycle.phase === "cancelled") {
          return yield* settleActiveTurnLocked(context, turn, { state: "cancelled" });
        }
        if (lifecycle.phase === "failed") {
          return yield* settleActiveTurnLocked(context, turn, {
            state: "failed",
            errorMessage: "Prime Agent prompt failed.",
            ...(lifecycle.usage === undefined ? {} : { usageOverride: lifecycle.usage }),
          });
        }
        if (lifecycle.kind !== "model_prompt") {
          return yield* settleActiveTurnLocked(context, turn, {
            state: "completedWithoutMessage",
            ...(lifecycle.usage === undefined ? {} : { usageOverride: lifecycle.usage }),
          });
        }
        return yield* settleActiveTurnLocked(context, turn, {
          state: "completed",
          event: {
            _tag: "RunCompleted",
            messages: turn.completedRunMessages,
            ...(lifecycle.usage === undefined ? {} : { usageOverride: lifecycle.usage }),
          },
        });
      });

    const cancelActiveTurnLocked = (
      context: PrimeAgentDaemonSessionContext,
      turn: PrimeAgentDaemonActiveTurn,
    ) =>
      Effect.gen(function* () {
        turn.cancellationRequested = true;
        turn.controller.abort();
        if (turn.correlationId === undefined) {
          const abortExit = yield* context.runtime.abortAndClearQueue.pipe(
            Effect.mapError((error) =>
              runtimeOperationError(context.threadId, "session/abort-and-clear-queue", error),
            ),
            Effect.exit,
          );
          yield* settleActiveTurnLocked(context, turn, { state: "cancelled" });
          if (Exit.isFailure(abortExit)) return yield* Effect.failCause(abortExit.cause);
          return;
        }
        const result = yield* context.runtime
          .cancelPromptLifecycle(turn.correlationId)
          .pipe(
            Effect.mapError((error) =>
              runtimeOperationError(context.threadId, "session/cancel-prompt", error),
            ),
          );
        if (result.status === "cancelled") {
          yield* settleActiveTurnLocked(context, turn, { state: "cancelled" });
        } else if (result.status === "expired" || result.status === "unknown") {
          yield* settleActiveTurnLocked(context, turn, {
            state: "failed",
            errorMessage: "Prime Agent could not reconcile the cancelled prompt lifecycle.",
          });
        }
      });

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
                // Prime 0.8's public RLM barrier is the authoritative boundary for
                // descendant-triggered parent continuations. Its FIFO marker settles
                // the turn; a heuristic timer must never overtake it.
                if (turn.terminalQuiescenceToken !== undefined) return;
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
          yield* publishRuntimeEvent(context, {
            type: "interaction.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(pending.ownerTurnId === undefined ? {} : { turnId: pending.ownerTurnId }),
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
          yield* publishRuntimeEvent(context, {
            type: "request.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.threadId,
            ...(pending.ownerTurnId === undefined ? {} : { turnId: pending.ownerTurnId }),
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
        if (turn?.correlationId !== undefined) {
          yield* cancelActiveTurnLocked(context, turn).pipe(Effect.ignore);
        } else {
          if (turn !== undefined) {
            turn.cancellationRequested = true;
            turn.controller.abort();
          }
          yield* context.runtime.abortAndClearQueue.pipe(Effect.ignore);
          if (turn !== undefined) {
            yield* settleActiveTurnLocked(context, turn, { state: "cancelled" });
          }
        }
        yield* publishRuntimeEvent(context, {
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

    /** Must be called with the thread lock held. */
    const startBackgroundQuiescenceWatchLocked = (context: PrimeAgentDaemonSessionContext) => {
      if (!context.runtime.rlmQuiescenceAvailable || context.stopped) return Effect.void;
      if (context.backgroundQuiescencePending) {
        // The native call may finish later, but its aborted signal prevents that older watch
        // from clearing activity observed by the replacement generation.
        context.backgroundQuiescenceController?.abort();
      }
      context.backgroundQuiescenceGeneration += 1;
      const generation = context.backgroundQuiescenceGeneration;
      const controller = new AbortController();
      context.backgroundQuiescencePending = true;
      context.backgroundQuiescenceController = controller;
      const token = `background:${context.threadId}:${generation}`;
      return context.runtime.waitForRlmQuiescence(token, controller.signal).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (context.backgroundQuiescenceGeneration === generation) {
              context.backgroundQuiescencePending = false;
              context.backgroundQuiescenceController = undefined;
            }
          }),
        ),
        Effect.ignore,
        Effect.forkDetach,
        Effect.asVoid,
      );
    };

    const activeTurnForNativeEvent = (
      context: PrimeAgentDaemonSessionContext,
      event: PrimeDaemonEvent,
    ): PrimeAgentDaemonActiveTurn | undefined => {
      const turn = context.activeTurn;
      if (
        !context.runtime.correlatedPromptLifecycleAvailable ||
        turn?.correlationId === undefined
      ) {
        return turn;
      }
      return event.attribution?.scope === "prompt" &&
        turn?.correlationId === event.attribution.correlationId &&
        turn.correlatedLifecycle?.deliveryCrossed === true
        ? turn
        : undefined;
    };

    interface CapturedExtensionOwner {
      readonly turnId: TurnId | undefined;
      readonly correlationId: string | undefined;
    }

    const captureExtensionOwnerLocked = (
      context: PrimeAgentDaemonSessionContext,
      event: Extract<PrimeDaemonEvent, { readonly _tag: "ExtensionRequest" }>,
    ): CapturedExtensionOwner | undefined => {
      if (sessions.get(context.threadId) !== context || context.stopped || context.stopRequested) {
        return undefined;
      }
      const turn = activeTurnForNativeEvent(context, event);
      if (
        context.runtime.correlatedPromptLifecycleAvailable &&
        (turn?.correlationId === undefined || turn.cancellationRequested)
      ) {
        return undefined;
      }
      return { turnId: turn?.id, correlationId: turn?.correlationId };
    };

    const capturedExtensionOwnerIsCurrentLocked = (
      context: PrimeAgentDaemonSessionContext,
      event: Extract<PrimeDaemonEvent, { readonly _tag: "ExtensionRequest" }>,
      owner: CapturedExtensionOwner,
    ): boolean => {
      if (sessions.get(context.threadId) !== context || context.stopped || context.stopRequested) {
        return false;
      }
      if (!context.runtime.correlatedPromptLifecycleAvailable) return true;
      const turn = activeTurnForNativeEvent(context, event);
      return (
        owner.turnId !== undefined &&
        owner.correlationId !== undefined &&
        turn !== undefined &&
        !turn.cancellationRequested &&
        turn.id === owner.turnId &&
        turn.correlationId === owner.correlationId
      );
    };

    const rejectExtensionRequest = (
      context: PrimeAgentDaemonSessionContext,
      event: Extract<PrimeDaemonEvent, { readonly _tag: "ExtensionRequest" }>,
    ) =>
      context.runtime
        .respondToExtensionUiRequest(event.request.id, { cancelled: true })
        .pipe(Effect.ignore);

    const consumeEvent = (context: PrimeAgentDaemonSessionContext, event: PrimeDaemonEvent) =>
      Effect.gen(function* () {
        yield* logNativeKind(context.threadId, event);
        if (event._tag === "CorrelatedProtocolViolation") {
          yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              const turn = context.activeTurn;
              if (turn?.correlationId !== undefined) {
                yield* failCorrelatedProtocolLocked(context, turn);
              }
            }),
          );
          return;
        }
        if (event._tag === "PromptLifecycleUpdated") {
          yield* withThreadLock(
            context.threadId,
            applyCorrelatedPromptLifecycleLocked(context, event.lifecycle),
          );
          return;
        }
        if (event._tag === "SessionResynced") {
          const managedSourceVerified = yield* fileSystem
            .readFileString(context.managedExtensionPath)
            .pipe(
              Effect.map((source) => source === context.managedExtensionSource),
              Effect.orElseSucceed(() => false),
            );
          let reconnectRecoveryFailed = false;
          let recoveredSnapshotRunCompletion = false;
          yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              if (sessions.get(context.threadId) === context && !context.stopped) {
                const reconnectGeneration = event.connectionGeneration;
                if (
                  reconnectGeneration !== undefined &&
                  !context.runtime.isConnectionGenerationCurrent(
                    reconnectGeneration,
                    event.correlatedProofEpoch,
                  )
                ) {
                  return;
                }
                if (!managedSourceVerified) {
                  const activeTurn = context.activeTurn;
                  if (activeTurn !== undefined) {
                    yield* settleActiveTurnLocked(context, activeTurn, {
                      state: "failed",
                      errorMessage:
                        "Prime Agent's managed provider extension could not be verified after reconnecting.",
                      runtimeErrorMessage:
                        "Prime Agent's managed provider extension could not be verified after reconnecting.",
                    });
                  }
                  context.stopRequested = true;
                  reconnectRecoveryFailed = true;
                  return;
                }
                context.managedPlanProjectionEnabled = true;
                const activeTurn = context.activeTurn;
                if (context.runtime.correlatedPromptLifecycleAvailable) {
                  if (event.initialSnapshot !== true) {
                    if (!correlatedTranscriptSnapshotIsExact(context, event)) {
                      if (reconnectGeneration !== undefined) {
                        context.runtime.resolveReconnectSnapshot(reconnectGeneration, false, false);
                      }
                      if (activeTurn?.correlationId !== undefined) {
                        yield* settleActiveTurnLocked(context, activeTurn, {
                          state: "failed",
                          errorMessage:
                            "Prime Agent transcript continuity could not be verified after synchronizing.",
                          runtimeErrorMessage:
                            "Prime Agent transcript continuity could not be verified after synchronizing.",
                        });
                      }
                      context.stopRequested = true;
                      reconnectRecoveryFailed = true;
                      return;
                    }
                    const lifecycle =
                      activeTurn?.correlationId === undefined
                        ? undefined
                        : event.promptLifecycles?.records.find(
                            (candidate) => candidate.correlationId === activeTurn.correlationId,
                          );
                    if (activeTurn?.correlationId !== undefined && lifecycle === undefined) {
                      if (reconnectGeneration !== undefined) {
                        context.runtime.resolveReconnectSnapshot(reconnectGeneration, false, false);
                      }
                      yield* settleActiveTurnLocked(context, activeTurn, {
                        state: "failed",
                        errorMessage:
                          "Prime Agent could not recover the correlated prompt lifecycle after synchronizing.",
                        runtimeErrorMessage:
                          "Prime Agent could not recover the correlated prompt lifecycle after synchronizing.",
                      });
                      context.stopRequested = true;
                      reconnectRecoveryFailed = true;
                      return;
                    }
                    if (
                      reconnectGeneration === undefined ||
                      !context.runtime.resolveReconnectSnapshot(reconnectGeneration, true, false)
                    ) {
                      reconnectRecoveryFailed = true;
                      return;
                    }
                    if (lifecycle !== undefined) {
                      yield* applyCorrelatedPromptLifecycleLocked(context, lifecycle, {
                        authoritativeSnapshot: true,
                      });
                    }
                  }
                } else if (reconnectGeneration !== undefined) {
                  const pendingRunCompletionBefore = activeTurn?.pendingRunCompletionHandoff;
                  const reconciled = yield* reconcileTranscriptSnapshotLocked(context, event);
                  recoveredSnapshotRunCompletion =
                    activeTurn !== undefined &&
                    pendingRunCompletionBefore === undefined &&
                    activeTurn.pendingRunCompletionHandoff !== undefined;
                  if (
                    !reconciled &&
                    context.runtime.retryWorkerRecoverySnapshot(reconnectGeneration)
                  ) {
                    return;
                  }
                  context.runtime.resolveReconnectSnapshot(
                    reconnectGeneration,
                    reconciled,
                    activeTurn?.lastAssistantHadRenderableText === true,
                  );
                  if (!reconciled) {
                    if (activeTurn !== undefined) {
                      yield* settleActiveTurnLocked(context, activeTurn, {
                        state: "failed",
                        errorMessage:
                          "Prime Agent could not safely recover the active turn after reconnecting.",
                        runtimeErrorMessage:
                          "Prime Agent could not safely recover the active turn after reconnecting.",
                      });
                    }
                    context.stopRequested = true;
                    reconnectRecoveryFailed = true;
                    return;
                  }
                }
                context.autoCompactionEnabled = event.state.autoCompactionEnabled;
                context.nativeRunActive = event.state.isStreaming;
                if (
                  context.activeTurn === undefined &&
                  (event.state.isStreaming ||
                    event.state.isCompacting ||
                    event.state.isBashRunning ||
                    event.state.retryAttempt > 0 ||
                    event.state.inputQueue.activeAction ||
                    event.state.inputQueue.steeringCount + event.state.inputQueue.followUpCount >
                      0 ||
                    event.children.some(
                      (child) => child.status === "queued" || child.status === "running",
                    ))
                ) {
                  yield* startBackgroundQuiescenceWatchLocked(context);
                }
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
                const turn =
                  context.runtime.correlatedPromptLifecycleAvailable &&
                  context.activeTurn?.correlationId !== undefined
                    ? undefined
                    : context.activeTurn;
                if (turn !== undefined) {
                  turn.queuedInputCount =
                    event.state.inputQueue.steeringCount + event.state.inputQueue.followUpCount;
                  if (event.state.isStreaming) {
                    // The continuation may have started while disconnected. Apply every
                    // RunStarted invariant from this authoritative snapshot too.
                    observeNativeRunStarted(context, turn);
                  }
                  const authoritativeIdle =
                    turn.queuedInputCount === 0 &&
                    !event.state.inputQueue.activeAction &&
                    !event.state.isStreaming;
                  if (turn.pendingRunCompletionHandoff !== undefined) {
                    if (
                      recoveredSnapshotRunCompletion &&
                      turn.terminalQuiescenceToken === undefined &&
                      authoritativeIdle
                    ) {
                      const pending = turn.pendingRunCompletionHandoff;
                      if (primeAgentRunCompletedNeedsHandoff(pending.event)) {
                        yield* schedulePendingRunCompletionHandoff(context, turn, pending.sequence);
                      } else {
                        const settled = yield* settleActiveTurnLocked(context, turn, {
                          state: "completed",
                          event: pending.event,
                        });
                        if (settled) yield* refreshContextUsage(context).pipe(Effect.forkDetach);
                      }
                    } else if (compactionWasActive && !event.state.isCompacting) {
                      // The compaction terminal event may have been lost while
                      // disconnected. Replace its consumed grace from the snapshot.
                      yield* restartPendingRunCompletionHandoffLocked(context, turn);
                    }
                    // An idle snapshot can be the gap before RunStarted. Keep
                    // the bounded handoff alive until the event or timeout.
                  } else if (turn.terminalQuiescenceToken !== undefined && authoritativeIdle) {
                    // The public RLM barrier, not an idle reconnect snapshot, owns
                    // settlement while descendant continuations may still arrive.
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
              stopSessionInternal(
                context,
                reconnectRecoveryFailed
                  ? "Prime Agent session closed after reconnect recovery could not be confirmed."
                  : "Prime Agent session state could not be reconciled.",
              ),
            ).pipe(Effect.ignore, Effect.forkDetach);
          } else if (
            context.lifecycleStarted &&
            !context.runtime.correlatedPromptLifecycleAvailable
          ) {
            yield* refreshContextUsage(context).pipe(Effect.forkDetach);
          }
          return;
        }
        if (event._tag === "SessionReplaced") return;

        if (event._tag === "ExtensionRequest") {
          const capturedOwner = yield* withThreadLock(
            context.threadId,
            Effect.sync(() => captureExtensionOwnerLocked(context, event)),
          );
          if (capturedOwner === undefined) {
            yield* rejectExtensionRequest(context, event);
            return;
          }
          const permissionProjection = projectPrimeAgentManagedPermissionRequest(
            event.request,
            context.permissionToken ?? "",
          );
          if (context.session.runtimeMode === "approval-required") {
            yield* withThreadLock(
              context.threadId,
              Effect.gen(function* () {
                if (!capturedExtensionOwnerIsCurrentLocked(context, event, capturedOwner)) {
                  yield* rejectExtensionRequest(context, event);
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
                      yield* publishRuntimeEvent(context, {
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
                  ownerTurnId: capturedOwner.turnId,
                  ownerCorrelationId: capturedOwner.correlationId,
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
                          yield* publishRuntimeEvent(context, {
                            type: "request.resolved",
                            ...(yield* makeEventStamp()),
                            provider: PROVIDER,
                            providerInstanceId: boundInstanceId,
                            threadId: context.threadId,
                            ...(pending.ownerTurnId === undefined
                              ? {}
                              : { turnId: pending.ownerTurnId }),
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
                yield* publishRuntimeEvent(context, {
                  type: "request.opened",
                  ...stamp,
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: context.threadId,
                  ...(capturedOwner.turnId === undefined ? {} : { turnId: capturedOwner.turnId }),
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
                    const abortExit =
                      turn?.correlationId !== undefined
                        ? yield* cancelActiveTurnLocked(context, turn).pipe(Effect.exit)
                        : yield* Effect.gen(function* () {
                            if (turn !== undefined) {
                              turn.cancellationRequested = true;
                              turn.controller.abort();
                            }
                            const exit = yield* context.runtime.abortAndClearQueue.pipe(
                              Effect.exit,
                            );
                            if (turn !== undefined) {
                              yield* settleActiveTurnLocked(context, turn, { state: "cancelled" });
                            }
                            return exit;
                          });
                    yield* publishRuntimeEvent(context, {
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
                    return abortExit._tag === "Failure";
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
                if (!capturedExtensionOwnerIsCurrentLocked(context, event, capturedOwner)) {
                  return;
                }
                yield* publishRuntimeEvent(context, {
                  type: "runtime.warning",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: context.threadId,
                  ...(capturedOwner.turnId === undefined ? {} : { turnId: capturedOwner.turnId }),
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
                if (!capturedExtensionOwnerIsCurrentLocked(context, event, capturedOwner)) {
                  yield* rejectExtensionRequest(context, event);
                  return;
                }
                yield* publishRuntimeEvent(context, {
                  type: "session-presentation.updated",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: context.threadId,
                  ...(capturedOwner.turnId === undefined ? {} : { turnId: capturedOwner.turnId }),
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
              if (!capturedExtensionOwnerIsCurrentLocked(context, event, capturedOwner)) {
                yield* rejectExtensionRequest(context, event);
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
                ownerTurnId: capturedOwner.turnId,
                ownerCorrelationId: capturedOwner.correlationId,
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
                        yield* publishRuntimeEvent(context, {
                          type: "interaction.resolved",
                          ...(yield* makeEventStamp()),
                          provider: PROVIDER,
                          providerInstanceId: boundInstanceId,
                          threadId: context.threadId,
                          ...(pending.ownerTurnId === undefined
                            ? {}
                            : { turnId: pending.ownerTurnId }),
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
              yield* publishRuntimeEvent(context, {
                type: "interaction.requested",
                ...stamp,
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: context.threadId,
                ...(capturedOwner.turnId === undefined ? {} : { turnId: capturedOwner.turnId }),
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

        if (event._tag === "RlmQuiesced") {
          const outcome = yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              const turn = context.activeTurn;
              if (turn === undefined || turn.terminalQuiescenceToken !== event.token) {
                return { settled: false, stop: false };
              }
              turn.terminalQuiescenceToken = undefined;
              if (!context.runtime.isRlmQuiescenceGenerationCurrent(event.connectionGeneration)) {
                const settled = yield* settleActiveTurnLocked(context, turn, {
                  state: "failed",
                  errorMessage:
                    "Prime Agent reconnected before descendant quiescence could be confirmed.",
                });
                context.stopRequested = true;
                return { settled, stop: true };
              }
              const pending = turn.pendingRunCompletionHandoff;
              if (pending === undefined && !turn.awaitingQueuedRun) {
                return { settled: false, stop: false };
              }
              const completionEvent: Extract<PrimeDaemonEvent, { readonly _tag: "RunCompleted" }> =
                {
                  ...(pending ?? { event: { _tag: "RunCompleted", messages: [] } }).event,
                  messages:
                    pending === undefined
                      ? turn.completedRunMessages
                      : [...turn.completedRunMessages, ...pending.event.messages],
                  ...(event.usage === undefined ? {} : { usageOverride: event.usage }),
                };
              const settled = yield* settleActiveTurnLocked(context, turn, {
                state: "completed",
                event: completionEvent,
              });
              return { settled, stop: false };
            }),
          );
          if (outcome.settled) yield* refreshContextUsage(context).pipe(Effect.forkDetach);
          if (outcome.stop) {
            yield* Effect.forkDetach(
              Effect.yieldNow.pipe(
                Effect.andThen(
                  withThreadMutationLock(
                    context.threadId,
                    stopSessionInternal(
                      context,
                      "Prime Agent session closed after descendant quiescence became uncertain.",
                    ),
                  ),
                ),
                Effect.ignore,
              ),
            );
          }
          return;
        }

        if (event._tag === "RunCompleted") {
          const settled = yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              context.nativeRunActive = false;
              const turn = activeTurnForNativeEvent(context, event);
              if (turn === undefined) return false;
              if (context.runtime.correlatedPromptLifecycleAvailable) {
                const observed = new Set(
                  turn.completedRunMessages.map(primeDaemonMessageFingerprint),
                );
                for (const message of event.messages) {
                  const fingerprint = primeDaemonMessageFingerprint(message);
                  if (observed.has(fingerprint)) continue;
                  observed.add(fingerprint);
                  turn.completedRunMessages.push(message);
                }
                return false;
              }
              if (turn.queuedInputCount > 0) {
                turn.completedRunMessages.push(...event.messages);
                turn.awaitingQueuedRun = true;
                turn.queuedActionObserved = false;
                return false;
              }
              if (turn.terminalQuiescenceToken !== undefined) {
                const previous = turn.pendingRunCompletionHandoff;
                if (previous !== undefined) {
                  turn.completedRunMessages.push(...previous.event.messages);
                }
                turn.runCompletionHandoffSequence += 1;
                turn.pendingRunCompletionHandoff = {
                  sequence: turn.runCompletionHandoffSequence,
                  event,
                };
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
              const turn = activeTurnForNativeEvent(context, event);
              if (turn === undefined) yield* startBackgroundQuiescenceWatchLocked(context);
              context.activeCompactionScope ??= turn === undefined ? {} : { turnId: turn.id };
              yield* updateCompactionProjectionLocked(context, {
                status: context.compactionAbortRequested ? "abort-requested" : "compacting",
                abortable: true,
              });
              if (!context.runtime.correlatedPromptLifecycleAvailable || turn !== undefined) {
                yield* publishDrafts(context, event, turn);
              }
            }),
          );
          return;
        }

        if (event._tag === "CompactionCompleted") {
          const terminal = yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              if (sessions.get(context.threadId) !== context || context.stopped) return false;
              const turn = activeTurnForNativeEvent(context, event);
              const compactionScope = context.activeCompactionScope;
              const compactionTurnId =
                compactionScope?.turnId ?? (turn?.command === "compact" ? turn.id : undefined);
              const pendingHandoff = turn?.pendingRunCompletionHandoff;
              // Prime reports exhausted overflow recovery with an unmatched
              // compaction_end. Only a previously observed compaction owns an item.
              if (
                compactionScope !== undefined &&
                (!context.runtime.correlatedPromptLifecycleAvailable || turn !== undefined)
              ) {
                yield* publishDrafts(context, event, turn);
              }
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
              if (turn?.correlationId !== undefined) return true;
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
          if (
            terminal &&
            (!context.runtime.correlatedPromptLifecycleAvailable ||
              event.attribution?.scope !== "prompt")
          ) {
            yield* refreshContextUsage(context).pipe(Effect.forkDetach);
          }
          return;
        }

        if (event._tag === "SessionClosed") {
          const completion = yield* withThreadLock(
            context.threadId,
            Effect.gen(function* () {
              if (
                context.teardownStarted ||
                context.stopped ||
                sessions.get(context.threadId) !== context
              ) {
                return undefined;
              }
              return yield* stopSessionInternal(
                context,
                "Prime Agent session closed unexpectedly.",
              );
            }),
          );
          void completion;
          return;
        }

        yield* withThreadLock(
          context.threadId,
          Effect.gen(function* () {
            if (sessions.get(context.threadId) !== context || context.stopped) return;
            const turn = activeTurnForNativeEvent(context, event);
            let publishEvent =
              !context.runtime.correlatedPromptLifecycleAvailable ||
              turn !== undefined ||
              event._tag === "ConnectionStatus";
            if (event._tag === "ConnectionStatus" && event.status === "reconnecting") {
              context.managedPlanProjectionEnabled = false;
            }
            if (
              turn === undefined &&
              ((event._tag === "ChildUpdated" &&
                (event.child.status === "queued" || event.child.status === "running")) ||
                event._tag === "BashStarted" ||
                event._tag === "BashOutput" ||
                event._tag === "RetryStarted" ||
                (event._tag === "QueueChanged" &&
                  (event.queuedCount > 0 || event.active !== undefined)))
            ) {
              yield* startBackgroundQuiescenceWatchLocked(context);
            }
            if (event._tag === "RunStarted") {
              if (turn === undefined) yield* startBackgroundQuiescenceWatchLocked(context);
              observeNativeRunStarted(context, turn);
            } else if (event._tag === "MessageCompleted") {
              context.nativeTranscriptMessageCount += appendTranscriptMessages(
                context.nativeTranscript,
                context.nativeTranscriptFingerprints,
                [event.message],
              );
              if (turn !== undefined) {
                if (context.runtime.correlatedPromptLifecycleAvailable) {
                  const fingerprint = primeDaemonMessageFingerprint(event.message);
                  if (
                    !turn.completedRunMessages.some(
                      (message) => primeDaemonMessageFingerprint(message) === fingerprint,
                    )
                  ) {
                    turn.completedRunMessages.push(event.message);
                  }
                }
                if (event.message.role === "assistant") {
                  for (const toolCall of event.message.toolCalls) {
                    recordCorrelatedToolName(turn.durableToolCallNames, toolCall.id, toolCall.name);
                  }
                } else if (event.message.role === "toolResult") {
                  recordCorrelatedToolName(
                    turn.completedToolCallNames,
                    event.message.toolCallId,
                    event.message.toolName,
                  );
                }
              }
            } else if (
              event._tag === "ToolStarted" ||
              event._tag === "ToolProgress" ||
              event._tag === "ToolCompleted" ||
              (event._tag === "AssistantStream" && event.kind === "toolCall")
            ) {
              if (turn !== undefined) {
                turn.lastAssistantHadRenderableText = false;
                if (event._tag === "ToolStarted") {
                  turn.observedToolStarts.add(event.toolCallId);
                } else if (event._tag === "ToolCompleted") {
                  turn.observedToolStarts.add(event.toolCallId);
                  turn.observedToolCompletions.add(event.toolCallId);
                }
              }
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
            if (event._tag === "QueueChanged") {
              const queue = {
                steeringCount: event.steeringCount,
                followUpCount: event.followUpCount,
              };
              context.nativeQueueActionActive = event.active !== undefined;
              yield* updateInputQueueProjection(context, queue);
              if (turn !== undefined && turn.correlationId === undefined) {
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
                  if (turn.terminalQuiescenceToken === undefined) {
                    const settled = yield* settleActiveTurnLocked(context, turn, {
                      state: "completed",
                      event: { _tag: "RunCompleted", messages: turn.completedRunMessages },
                    });
                    if (settled) yield* refreshContextUsage(context).pipe(Effect.forkDetach);
                  }
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
              yield* publishDrafts(context, event, turn);
            }
          }),
        );
        if (
          context.lifecycleStarted &&
          !context.runtime.correlatedPromptLifecycleAvailable &&
          event._tag === "ConnectionStatus" &&
          event.status === "connected"
        ) {
          yield* refreshContextUsage(context).pipe(Effect.forkDetach);
        }
      }).pipe(
        Effect.tap(() => {
          if (event._tag === "MessageCompleted") {
            context.recoveryTranscriptMessageCount += 1;
            context.recoveryTranscriptFingerprints.push(
              primeDaemonMessageFingerprint(event.message),
            );
            if (
              context.recoveryTranscriptFingerprints.length >
              PRIME_AGENT_DAEMON_TRANSCRIPT_MAX_MESSAGES
            ) {
              context.recoveryTranscriptFingerprints.splice(
                0,
                context.recoveryTranscriptFingerprints.length -
                  PRIME_AGENT_DAEMON_TRANSCRIPT_MAX_MESSAGES,
              );
            }
          } else if (event._tag === "SessionResynced") {
            context.recoveryTranscriptMessageCount = event.state.messageCount;
            context.recoveryTranscriptFingerprints = event.messages.map(
              primeDaemonMessageFingerprint,
            );
          }
          const ownerToken = context.recoveryOwnerToken;
          const cursor = context.runtime.recoveryCursorForEvent?.(event);
          if (ownerToken === undefined || cursor === undefined) return Effect.void;
          return Effect.gen(function* () {
            yield* recoveryLedger!.updateTranscriptProgress({
              threadId: context.threadId,
              ownerToken,
              cursor,
              messageCount: context.recoveryTranscriptMessageCount,
              fingerprints: [...context.recoveryTranscriptFingerprints],
              updatedAt: yield* nowIso,
            });
          }).pipe(Effect.asVoid);
        }),
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

    const runSessionTeardown = (
      context: PrimeAgentDaemonSessionContext,
      terminalReason: string | undefined,
      pendingApprovalNativeIds: ReadonlyArray<string>,
      pendingInteractionNativeIds: ReadonlyArray<string>,
      sideQuestionNativeId: string | undefined,
      abortNativeQueue: boolean,
      closedUnexpectedly: boolean,
    ) => {
      const publishTerminalOnce = context.exitPublicationSemaphore.withPermit(
        Effect.suspend(() => {
          if (context.exitEnqueued) return Effect.void;
          return makeEventStamp().pipe(
            Effect.flatMap((stamp) =>
              Effect.gen(function* () {
                const delivered = yield* Deferred.make<void>();
                pendingTerminalDeliveries.add(delivered);
                const accepted = yield* offerOrderedRuntimeEvent({
                  event: {
                    type: "session.exited",
                    ...stamp,
                    provider: PROVIDER,
                    providerInstanceId: boundInstanceId,
                    threadId: context.threadId,
                    sessionIncarnationId: context.sessionIncarnationId,
                    payload: {
                      exitKind: terminalReason === undefined ? "graceful" : "error",
                      ...(terminalReason === undefined ? {} : { reason: terminalReason }),
                    },
                  },
                  terminalDelivery: {
                    delivered,
                    markPublished: () => {
                      context.exitPublished = true;
                    },
                  },
                });
                if (accepted) {
                  // Enqueueing is not delivery. The handoff marks exitPublished
                  // only after the bounded public stream accepts this exact event.
                  context.exitEnqueued = true;
                  yield* Effect.yieldNow;
                  yield* Effect.yieldNow;
                }
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logError("Prime Agent terminal runtime event publication failed.", {
                component: "daemon",
                threadId: context.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }),
      );

      const lifecycleWork = Effect.gen(function* () {
        context.backgroundQuiescenceController?.abort();
        context.backgroundQuiescenceController = undefined;
        context.backgroundQuiescencePending = false;

        const activeSideQuestion = activeSideQuestions.get(context.threadId);
        if (activeSideQuestion?.context === context) {
          activeSideQuestion.cancelRequested = true;
          yield* Deferred.succeed(activeSideQuestion.sessionEnded, undefined).pipe(Effect.ignore);
        }
        for (const watchedAgentId of new Set([
          ...context.activityWatchStops.keys(),
          ...context.sharedActivityStreams.keys(),
        ])) {
          yield* signalInactiveActivityWatchesLocked(context, watchedAgentId).pipe(Effect.ignore);
        }
        yield* clearPendingApprovalsLocked(context, false).pipe(Effect.ignore);
        yield* clearPendingInteractionsLocked(context, false).pipe(Effect.ignore);
        const turn = context.activeTurn;
        if (turn !== undefined) {
          turn.cancellationRequested = true;
          turn.controller.abort();
          yield* settleActiveTurnLocked(
            context,
            turn,
            closedUnexpectedly
              ? {
                  state: "failed",
                  errorMessage: "Prime Agent daemon session closed before the turn completed.",
                }
              : { state: "cancelled" },
            closedUnexpectedly ? { preserveOutcomeDuringTeardown: true } : undefined,
          ).pipe(Effect.ignore);
        }
        context.inputQueueClearPending = false;
        context.nativeQueueActionActive = false;
        yield* updateInputQueueProjection(
          context,
          { steeringCount: 0, followUpCount: 0 },
          { preserveModes: false },
        ).pipe(Effect.ignore);
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
          ).pipe(Effect.ignore);
        }
      }).pipe(
        Effect.timeoutOption(Duration.millis(PRIME_AGENT_TERMINAL_EVENT_TIMEOUT_MS)),
        Effect.catchCause((cause) =>
          Effect.logError("Prime Agent local session teardown failed.", {
            threadId: context.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(Option.none())),
        ),
        Effect.ensuring(
          publishTerminalOnce.pipe(Effect.ensuring(Effect.sync(() => (context.stopped = true)))),
        ),
        Effect.asVoid,
      );

      const cancellationSteps = [
        ...pendingApprovalNativeIds.map((nativeId) => ({
          label: "approval-cancel",
          effect: context.runtime.respondToExtensionUiRequest(nativeId, { cancelled: true }),
        })),
        ...pendingInteractionNativeIds.map((nativeId) => ({
          label: "interaction-cancel",
          effect: context.runtime.respondToExtensionUiRequest(nativeId, { cancelled: true }),
        })),
        ...(sideQuestionNativeId === undefined
          ? []
          : [
              {
                label: "side-question-abort",
                effect: context.runtime.abortSideQuestion(sideQuestionNativeId),
              },
            ]),
        ...(abortNativeQueue
          ? [{ label: "queue-abort", effect: context.runtime.abortAndClearQueue }]
          : []),
      ];
      const runCleanupStep = (cleanup: {
        readonly label: string;
        readonly effect: Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
      }) =>
        cleanup.effect.pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.logError("Prime Agent daemon session teardown step failed.", {
                  threadId: context.threadId,
                  step: cleanup.label,
                  cause: Cause.pretty(exit.cause),
                }),
          ),
        );
      const resourceWork = Deferred.succeed(context.teardownResourcesStarted, undefined).pipe(
        Effect.andThen(
          Effect.all(
            [
              // Dispose owns its own lane so a full batch of hung native
              // cancellation calls cannot delay process/resource teardown.
              runCleanupStep({
                label: "runtime-dispose",
                effect:
                  context.recoveryOwnerToken === undefined
                    ? context.runtime.dispose
                    : context.runtime.dispose.pipe(
                        Effect.tap(() =>
                          Effect.gen(function* () {
                            yield* recoveryLedger!.markNativeCleanup({
                              threadId: context.threadId,
                              ownerToken: context.recoveryOwnerToken!,
                              updatedAt: yield* nowIso,
                            });
                            yield* recoveryLedger!.deleteIfSettled(context.threadId);
                          }),
                        ),
                      ),
              }),
              Effect.forEach(cancellationSteps, runCleanupStep, {
                concurrency: PRIME_AGENT_SESSION_CLEANUP_CONCURRENCY,
                discard: true,
              }),
            ],
            { concurrency: 2, discard: true },
          ),
        ),
      );
      const teardownWork = Effect.all([lifecycleWork, resourceWork], {
        concurrency: 2,
        discard: true,
      });

      return Effect.gen(function* () {
        yield* Scope.close(context.scope, Exit.void).pipe(
          Effect.timeoutOption(Duration.millis(PRIME_AGENT_SESSION_TEARDOWN_TIMEOUT_MS)),
          Effect.catchCause((cause) =>
            Effect.logError("Prime Agent daemon session scope cleanup failed.", {
              threadId: context.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(Option.none())),
          ),
          Effect.forkDetach,
        );
        const workFiber = yield* teardownWork.pipe(Effect.forkDetach);
        const workResult = yield* Fiber.join(workFiber).pipe(
          Effect.exit,
          Effect.timeoutOption(Duration.millis(PRIME_AGENT_SESSION_TEARDOWN_TIMEOUT_MS)),
        );
        if (Option.isNone(workResult)) {
          yield* Effect.logWarning("Prime Agent daemon session teardown timed out.", {
            threadId: context.threadId,
            timeoutMs: PRIME_AGENT_SESSION_TEARDOWN_TIMEOUT_MS,
          });
          yield* Fiber.interrupt(workFiber).pipe(Effect.forkDetach);
        } else if (Exit.isFailure(workResult.value)) {
          yield* Effect.logError("Prime Agent daemon session teardown finalization failed.", {
            threadId: context.threadId,
            cause: Cause.pretty(workResult.value.cause),
          });
        }
        yield* publishTerminalOnce;
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(context.teardownCompletion, undefined).pipe(
            Effect.andThen(
              Effect.sync(() => {
                const activeTeardown = activeTeardowns.get(context.threadId);
                if (activeTeardown?.context === context) {
                  activeTeardowns.delete(context.threadId);
                }
              }),
            ),
            Effect.ignore,
          ),
        ),
      );
    };

    /** Must be called with the thread lock held. Teardown starts outside the permit. */
    const stopSessionInternal = (
      context: PrimeAgentDaemonSessionContext,
      terminalReason?: string,
    ) =>
      Effect.sync(() => {
        if (context.teardownStarted) return context.teardownCompletion;
        if (context.stopped) return context.teardownCompletion;

        const activeSideQuestion = activeSideQuestions.get(context.threadId);
        const sideQuestionNativeId =
          activeSideQuestion?.context === context ? activeSideQuestion.nativeId : undefined;
        const pendingApprovalNativeIds = Array.from(
          context.pendingApprovals.values(),
          (pending) => pending.nativeId,
        );
        const pendingInteractionNativeIds = Array.from(
          context.pendingInteractions.values(),
          (pending) => pending.nativeId,
        );
        const runtimeAlreadyClosed = terminalReason === "Prime Agent session closed unexpectedly.";
        const closedUnexpectedly = runtimeAlreadyClosed && !context.stopRequested;
        const abortNativeQueue = !runtimeAlreadyClosed && context.activeTurn !== undefined;

        context.teardownStarted = true;
        context.stopRequested = true;
        if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
        activeTeardowns.set(context.threadId, {
          context,
          completion: context.teardownCompletion,
          run: Effect.suspend(() =>
            runSessionTeardown(
              context,
              terminalReason,
              runtimeAlreadyClosed ? [] : pendingApprovalNativeIds,
              runtimeAlreadyClosed ? [] : pendingInteractionNativeIds,
              runtimeAlreadyClosed ? undefined : sideQuestionNativeId,
              abortNativeQueue,
              closedUnexpectedly,
            ),
          ),
          started: false,
        });
        return context.teardownCompletion;
      });

    const awaitRlmQuiescence = (
      context: PrimeAgentDaemonSessionContext,
      turn: PrimeAgentDaemonActiveTurn,
      token: string,
    ) =>
      context.runtime
        .waitForRlmQuiescence(token, turn.controller.signal)
        .pipe(
          Effect.mapError((error) =>
            runtimeOperationError(context.threadId, "session/rlm-quiescence", error),
          ),
        );

    const stopAfterRlmQuiescenceFailure = (
      context: PrimeAgentDaemonSessionContext,
      turn: PrimeAgentDaemonActiveTurn,
      token: string,
    ) =>
      withThreadMutationLock(
        context.threadId,
        Effect.gen(function* () {
          if (
            sessions.get(context.threadId) !== context ||
            context.stopped ||
            context.activeTurn !== turn ||
            turn.cancellationRequested ||
            turn.terminalQuiescenceToken !== token
          ) {
            return;
          }
          yield* settleActiveTurnLocked(context, turn, {
            state: "failed",
            errorMessage: "Prime Agent could not confirm descendant quiescence.",
          });
          yield* stopSessionInternal(
            context,
            "Prime Agent session closed after descendant quiescence could not be confirmed.",
          ).pipe(Effect.ignore);
        }),
      );

    /** Must be called with the thread lock held. */
    const rearmRlmQuiescenceLocked = (
      context: PrimeAgentDaemonSessionContext,
      turn: PrimeAgentDaemonActiveTurn,
    ) =>
      Effect.gen(function* () {
        if (turn.correlationId !== undefined || !context.runtime.rlmQuiescenceAvailable) return;
        turn.terminalQuiescenceGeneration += 1;
        const token = rlmQuiescenceToken(turn.id, turn.terminalQuiescenceGeneration);
        turn.terminalQuiescenceToken = token;
        yield* Effect.forkDetach(
          awaitRlmQuiescence(context, turn, token).pipe(
            Effect.catch(() => stopAfterRlmQuiescenceFailure(context, turn, token)),
          ),
        );
      });

    const startSessionAttempt = (input: Parameters<PrimeAgentAdapterShape["startSession"]>[0]) =>
      withThreadMutationLock(
        input.threadId,
        Effect.gen(function* () {
          const activeTeardown = activeTeardowns.get(input.threadId);
          if (activeTeardown !== undefined) {
            return {
              _tag: "AwaitTeardown" as const,
              completion: activeTeardown.completion,
            };
          }
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
          const recoveryStart = pendingRecoveryStarts.get(input.threadId);
          if (recoveryStart !== undefined && approvalRequired) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Recoverable Prime Agent execution requires full-access mode.",
            });
          }

          const existing = sessions.get(input.threadId);
          if (existing !== undefined && !existing.stopped) {
            return {
              _tag: "AwaitTeardown" as const,
              completion: yield* stopSessionInternal(existing),
            };
          }

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

          const managedExtensionPath = path.join(
            sessionDir,
            PRIME_AGENT_MANAGED_EXTENSION_FILENAME,
          );
          const permissionToken = approvalRequired ? yield* randomUUIDv4 : undefined;
          const managedExtensionSource = makePrimeAgentManagedExtensionSource({
            rootSessionDir: sessionDir,
            ...(permissionToken === undefined ? {} : { permissionToken }),
          });
          yield* fileSystem.writeFileString(managedExtensionPath, managedExtensionSource).pipe(
            Effect.andThen(fileSystem.chmod(managedExtensionPath, 0o600)),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to prepare the Prime Agent managed provider extension.",
                  cause,
                }),
            ),
          );

          const sessionScope = yield* Scope.make("sequential");
          let scopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            scopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          const agentDir =
            primeRuntimeContext?.effectiveHome ?? primeAgentSettings.agentHomePath.trim();
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          if (mcpSession !== undefined && mcpSession.providerInstanceId !== boundInstanceId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "The MCP route does not belong to this provider instance.",
            });
          }
          const runtime = yield* runtimeFactory({
            manager,
            ...(primeRuntimeContext === undefined ? {} : { runtimeContext: primeRuntimeContext }),
            cwd,
            sessionDir,
            ...(mcpSession === undefined
              ? {}
              : {
                  mcpServer: {
                    ownerId: `pylon:${mcpSession.providerSessionId}`,
                    server: {
                      name: "t3-code",
                      type: "http" as const,
                      url: mcpSession.endpoint,
                      headers: { Authorization: mcpSession.authorizationHeader },
                    },
                  },
                }),
            ...(agentDir.length === 0 ? {} : { agentDir: resolveProviderHomePath(agentDir) }),
            ...(model === "default" ? {} : { model }),
            extensions: [managedExtensionPath],
            expectedExtension: {
              path: managedExtensionPath,
              markerCommand: PRIME_AGENT_MANAGED_EXTENSION_MARKER_COMMAND,
              verifySource: () =>
                runPromise(
                  fileSystem.readFileString(managedExtensionPath).pipe(
                    Effect.map((source) => source === managedExtensionSource),
                    Effect.orElseSucceed(() => false),
                  ),
                ),
            },
            ...(approvalRequired
              ? {
                  disableExtensionDiscovery: true,
                  disableAutoReconnect: true,
                  requiredExtension: {
                    path: managedExtensionPath,
                    markerCommand: PRIME_AGENT_MANAGED_EXTENSION_MARKER_COMMAND,
                  },
                }
              : {}),
            ...(recoveryStart === undefined
              ? {}
              : recoveryStart.kind === "create"
                ? {
                    recovery: {
                      kind: "create" as const,
                      requestId: yield* randomUUIDv4,
                      correlationId: recoveryStart.correlationId,
                      mcpOwnerId: recoveryStart.mcpOwnerId,
                      onAuthorityReady: (authority) =>
                        runPromise(
                          Effect.gen(function* () {
                            const sessionIncarnationId = input.sessionIncarnationId;
                            if (sessionIncarnationId === undefined) {
                              return yield* new ProviderAdapterProcessError({
                                provider: PROVIDER,
                                threadId: input.threadId,
                                detail:
                                  "Recoverable Prime Agent execution is missing its session incarnation.",
                              });
                            }
                            yield* recoveryLedger!.putPrepared({
                              threadId: input.threadId,
                              providerInstanceId: boundInstanceId,
                              sessionIncarnationId,
                              admissionRequestId: recoveryStart.admissionRequestId,
                              turnId: null,
                              packageRoot: manager.bridge.packageRoot,
                              packageVersion: manager.bridge.version,
                              managedBuildId: options?.recoveryManagedBuildId ?? "",
                              sdkFeatures: [...(manager.bridge.sdkFeatures ?? [])],
                              daemonCapabilities: [...authority.daemonCapabilities],
                              protocolName: manager.bridge.protocolName,
                              protocolVersion: manager.bridge.protocolVersion,
                              schemaRevision: authority.schemaRevision,
                              activeSessionId: authority.activeSessionId,
                              nativeSessionId: authority.sessionId,
                              recoveryHandle: authority.recoveryHandle,
                              supervisorGeneration: authority.supervisorGeneration,
                              ownershipGeneration: authority.ownershipGeneration,
                              cursor: authority.cursor,
                              correlationId: recoveryStart.correlationId,
                              mcpOwnerId: recoveryStart.mcpOwnerId,
                              recoveryConfig: authority.recoveryConfig,
                              launchEnvironment:
                                primeRuntimeContext?.launchEnv ?? authority.launchEnvironment,
                              transcriptMessageCount: recoveryStart.transcriptMessageCount,
                              transcriptFingerprints: [...recoveryStart.transcriptFingerprints],
                              ownerToken: recoveryStart.ownerToken,
                              state: "prepared",
                              nativeCleanupProven: false,
                              terminalProjected: false,
                              checkpointQuiesced: false,
                              updatedAt: yield* nowIso,
                            });
                          }),
                        ),
                    },
                  }
                : {
                    recovery: {
                      kind: "adopt" as const,
                      requestId: recoveryStart.requestId,
                      recoveryHandle: recoveryStart.authority.recoveryHandle,
                      expectedSupervisorGeneration: recoveryStart.authority.supervisorGeneration,
                      activeSessionId: recoveryStart.authority.activeSessionId,
                      sessionId: recoveryStart.authority.nativeSessionId,
                      sessionFile: recoveryStart.sessionFile,
                      correlationId: recoveryStart.authority.correlationId,
                      cursor: recoveryStart.authority.cursor,
                      previousMcpOwnerId: recoveryStart.authority.mcpOwnerId,
                      mcpOwnerId: recoveryStart.mcpOwnerId,
                      recoveryConfig: recoveryStart.authority.recoveryConfig,
                      launchEnvironment:
                        primeRuntimeContext?.launchEnv ?? recoveryStart.authority.launchEnvironment,
                      onAdoptionCommitted: ({ recoveryHandle, proof }) =>
                        runPromise(
                          Effect.gen(function* () {
                            const committed = yield* recoveryLedger!.commitAdoption({
                              threadId: input.threadId,
                              ownerToken: recoveryStart.ownerToken,
                              recoveryHandle,
                              ownershipGeneration: proof.ownershipGeneration,
                              cursor: proof.cursor,
                              mcpOwnerId: proof.mcpOwnerId,
                              updatedAt: yield* nowIso,
                            });
                            if (!committed) {
                              return yield* new ProviderAdapterProcessError({
                                provider: PROVIDER,
                                threadId: input.threadId,
                                detail: "Recoverable Prime Agent ownership was superseded.",
                              });
                            }
                          }),
                        ),
                    },
                  }),
            ...(input.resumeCursor === undefined ? {} : { resumeCursor: input.resumeCursor }),
            ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((error) => runtimeStartError(input.threadId, error)),
          );

          const loadedExtensionSource = yield* fileSystem.readFileString(managedExtensionPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to verify the Prime Agent managed provider extension.",
                  cause,
                }),
            ),
          );
          if (loadedExtensionSource !== managedExtensionSource) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail:
                "Prime Agent loaded a managed provider extension whose source integrity could not be verified.",
            });
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

          let recoveryBacklog: ReadonlyArray<PrimeDaemonMessage> = [];
          if (recoveryStart?.kind === "adopt") {
            const authority = recoveryStart.authority;
            const replay = planPrimeAgentRestartReplay({
              authorityMessageCount: authority.transcriptMessageCount,
              authorityFingerprints: authority.transcriptFingerprints,
              snapshotMessageCount: runtime.initialSnapshot.state.messageCount,
              snapshotMessages: runtime.initialSnapshot.messages,
            });
            if (authority.turnId === null || !replay.valid) {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: "Prime Agent restart recovery could not prove complete event continuity.",
              });
            }
            recoveryBacklog = replay.backlog;
          }

          const now = yield* nowIso;
          const sessionIncarnationId =
            input.sessionIncarnationId ?? RuntimeSessionId.make(yield* randomUUIDv4);
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: recoveryStart?.kind === "adopt" ? "running" : "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model,
            threadId: input.threadId,
            resumeCursor: runtime.resumeCursor,
            ...(input.resumeCursor !== undefined ? { restored: true } : {}),
            ...(recoveryStart?.kind === "adopt" && recoveryStart.authority.turnId !== null
              ? {
                  activeTurnId: TurnId.make(recoveryStart.authority.turnId),
                  activeTurnRequestId: CommandId.make(recoveryStart.authority.admissionRequestId),
                }
              : {}),
            sessionIncarnationId,
            createdAt: now,
            updatedAt: now,
          };
          const context: PrimeAgentDaemonSessionContext = {
            threadId: input.threadId,
            sessionIncarnationId,
            session,
            scope: sessionScope,
            runtime,
            managedExtensionPath,
            managedExtensionSource,
            managedPlanProjectionEnabled: true,
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
            nativeTranscript: [...runtime.initialSnapshot.messages],
            nativeTranscriptMessageCount: runtime.initialSnapshot.state.messageCount,
            nativeTranscriptFingerprints: new Set(
              runtime.initialSnapshot.messages.map(primeDaemonMessageFingerprint),
            ),
            recoveryTranscriptMessageCount: runtime.initialSnapshot.state.messageCount,
            recoveryTranscriptFingerprints: runtime.initialSnapshot.messages.map(
              primeDaemonMessageFingerprint,
            ),
            pendingInteractions: new Map(),
            pendingApprovals: new Map(),
            permissionToken,
            approvalsAcceptedForSession: false,
            activeTurn:
              recoveryStart?.kind === "adopt" && recoveryStart.authority.turnId !== null
                ? {
                    id: TurnId.make(recoveryStart.authority.turnId),
                    controller: new AbortController(),
                    completed: yield* Deferred.make<void>(),
                    correlationId: recoveryStart.authority.correlationId,
                    cancellationRequested: false,
                    assistantTextStreamed: false,
                    assistantTextEmitted: "",
                    assistantTextRecoveryComparable: true,
                    nextAssistantMessageSequence: 0,
                    activeAssistantItemId: undefined,
                    lastAssistantHadRenderableText: false,
                    runCompletionHandoffSequence: 0,
                    terminalQuiescenceGeneration: 0,
                    terminalQuiescenceToken: undefined,
                    pendingRunCompletionHandoff: undefined,
                    queuedInputCount: 0,
                    awaitingQueuedRun: false,
                    queuedActionObserved: false,
                    completedRunMessages: [],
                    nativeTranscriptBaselineMessageCount:
                      recoveryStart.authority.transcriptMessageCount,
                    observedToolStarts: new Set(),
                    observedToolCompletions: new Set(),
                    durableToolCallNames: new Map(),
                    completedToolCallNames: new Map(),
                    projectedPlanToolCallIds: new Set(),
                  }
                : undefined,
            nativeRunActive: runtime.initialSnapshot.state.isStreaming,
            backgroundQuiescenceGeneration: 0,
            backgroundQuiescencePending: false,
            backgroundQuiescenceController: undefined,
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
            exitEnqueued: false,
            exitPublished: false,
            exitPublicationSemaphore: yield* Semaphore.make(1),
            teardownStarted: false,
            teardownCompletion: yield* Deferred.make<void>(),
            teardownResourcesStarted: yield* Deferred.make<void>(),
            ...(recoveryStart === undefined
              ? {}
              : { recoveryOwnerToken: recoveryStart.ownerToken }),
            recoveryBacklog,
            recoveryPendingActivation: recoveryStart !== undefined,
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
          if (recoveryStart === undefined) {
            yield* publishRuntimeEvent(context, {
              type: "session.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              payload: { resume: input.resumeCursor !== undefined },
            });
            yield* publishSessionResources(context, runtime.initialResources);
            yield* publishSessionAgentDepth(context, context.agentDepth);
            yield* publishSessionCompaction(context, context.compaction);
            yield* publishSessionGoal(context, context.goal);
            yield* publishSessionInputQueue(context, context.inputQueue);
            yield* publishRuntimeEvent(context, {
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              payload: { state: "ready", reason: "Prime Agent daemon session ready" },
            });
            yield* publishRuntimeEvent(context, {
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
          }
          if (recoveryStart === undefined) {
            context.eventFiber = yield* runtime.events.pipe(
              Stream.runForEach((event) => consumeEvent(context, event)),
              Effect.forkChild,
            );
          }
          if (recoveryStart === undefined && runtime.inputAdmissionBusy) {
            yield* startBackgroundQuiescenceWatchLocked(context);
          }

          context.lifecycleStarted = true;
          pendingRecoveryStarts.delete(input.threadId);
          yield* refreshContextUsage(context).pipe(Effect.forkDetach);
          yield* refreshDiscoveredModels(context);
          return { _tag: "Started" as const, session };
        }).pipe(Effect.scoped),
      );

    const startSession: PrimeAgentAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const pendingTeardown = activeTeardowns.get(input.threadId);
        if (pendingTeardown !== undefined) {
          yield* Deferred.await(pendingTeardown.completion);
        }
        const attempt = yield* startSessionAttempt(input);
        if (attempt._tag === "AwaitTeardown") {
          yield* Deferred.await(attempt.completion);
          return yield* startSession(input);
        }
        return attempt.session;
      });

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

    const recoveryPlatformEligible =
      recoveryLedger !== undefined &&
      manager.recoveryEnabled &&
      options?.recoveryManagedBuildId !== undefined &&
      (manager.platform === "darwin" || manager.platform === "linux") &&
      (manager.architecture === "arm64" || manager.architecture === "x64");

    const silentlyCloseSessionForRecovery = (context: PrimeAgentDaemonSessionContext) =>
      Effect.gen(function* () {
        context.stopped = true;
        sessions.delete(context.threadId);
        if (context.eventFiber !== undefined) yield* Fiber.interrupt(context.eventFiber);
        context.backgroundQuiescenceController?.abort();
        context.backgroundQuiescenceController = undefined;
        yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
      });

    const prepareTurnRecovery = Effect.fn("PrimeAgentDaemonAdapter.prepareTurnRecovery")(function* (
      input: ProviderSendTurnInput,
    ) {
      if (!recoveryPlatformEligible) return;
      const plan = yield* withThreadMutationLock(
        input.threadId,
        Effect.gen(function* () {
          const context = sessions.get(input.threadId);
          if (
            context === undefined ||
            context.stopped ||
            context.session.status !== "ready" ||
            context.activeTurn !== undefined ||
            context.session.runtimeMode !== "full-access" ||
            context.sessionIncarnationId === undefined ||
            context.recoveryOwnerToken !== undefined
          ) {
            return undefined;
          }
          const admissionRequestId = input.admissionRequestId?.trim();
          if (admissionRequestId === undefined || admissionRequestId.length === 0) {
            return undefined;
          }
          const candidateMcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          if (
            candidateMcpSession !== undefined &&
            candidateMcpSession.providerInstanceId !== boundInstanceId
          ) {
            return undefined;
          }
          const ownerToken = yield* randomUUIDv4;
          const mcpSession = candidateMcpSession;
          const recoveryStart: PendingRecoveryStart = {
            kind: "create",
            admissionRequestId,
            correlationId: yield* randomUUIDv4,
            mcpOwnerId:
              mcpSession === undefined
                ? `pylon:none:${yield* randomUUIDv4}`
                : `pylon:${mcpSession.providerSessionId}`,
            ownerToken,
            transcriptMessageCount: context.recoveryTranscriptMessageCount,
            transcriptFingerprints: [...context.recoveryTranscriptFingerprints],
          };
          const restartInput = {
            threadId: context.threadId,
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            runtimeMode: context.session.runtimeMode,
            ...(context.session.cwd === undefined ? {} : { cwd: context.session.cwd }),
            ...(context.session.model === undefined
              ? {}
              : {
                  modelSelection: {
                    instanceId: boundInstanceId,
                    model: context.session.model,
                  },
                }),
            resumeCursor: context.session.resumeCursor,
            sessionIncarnationId: context.sessionIncarnationId,
          } as const;
          yield* silentlyCloseSessionForRecovery(context);
          pendingRecoveryStarts.set(input.threadId, recoveryStart);
          return { restartInput, ownerToken } as const;
        }),
      );
      if (plan === undefined) return;
      const recoveryResult = yield* Effect.result(startSession(plan.restartInput));
      if (Result.isSuccess(recoveryResult)) return;

      pendingRecoveryStarts.delete(input.threadId);
      yield* recoveryLedger!.discardPrepared({
        threadId: input.threadId,
        ownerToken: plan.ownerToken,
      });
      const fallback = yield* Effect.result(startSession(plan.restartInput));
      if (Result.isFailure(fallback)) return yield* fallback.failure;
    });

    const recoverSession = Effect.fn("PrimeAgentDaemonAdapter.recoverSession")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly sessionIncarnationId: RuntimeSessionId;
      readonly runtimeMode: Parameters<PrimeAgentAdapterShape["startSession"]>[0]["runtimeMode"];
      readonly cwd: string;
      readonly modelSelection?: ModelSelection;
      readonly resumeCursor: unknown;
    }) {
      if (!recoveryPlatformEligible || input.runtimeMode !== "full-access") return null;
      const authorityOption = yield* recoveryLedger!.get(input.threadId);
      const authority = Option.getOrUndefined(authorityOption);
      if (
        authority === undefined ||
        authority.state !== "active" ||
        authority.turnId === null ||
        authority.providerInstanceId !== input.providerInstanceId ||
        authority.sessionIncarnationId !== input.sessionIncarnationId ||
        authority.packageRoot !== manager.bridge.packageRoot ||
        authority.packageVersion !== manager.bridge.version ||
        authority.managedBuildId !== options?.recoveryManagedBuildId ||
        authority.protocolName !== manager.bridge.protocolName ||
        authority.protocolVersion !== manager.bridge.protocolVersion ||
        !sameStrings(authority.sdkFeatures, manager.bridge.sdkFeatures ?? [])
      ) {
        return null;
      }
      yield* manager.prepare().pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "Could not validate the surviving Prime Agent daemon.",
              cause,
            }),
        ),
      );
      const readinessClient = yield* manager.openClient().pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "Could not inspect the surviving Prime Agent daemon.",
              cause,
            }),
        ),
      );
      const hello = readinessClient.hello;
      readinessClient.close();
      if (
        hello?.supervisorGeneration !== authority.supervisorGeneration ||
        hello?.schemaRevision !== authority.schemaRevision ||
        !sameStrings(hello?.serverCapabilities ?? [], authority.daemonCapabilities) ||
        !sameStringRecord(manager.launchEnvironment ?? {}, authority.launchEnvironment)
      ) {
        return null;
      }
      const candidateMcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
      if (
        candidateMcpSession !== undefined &&
        candidateMcpSession.providerInstanceId !== boundInstanceId
      ) {
        return null;
      }
      const ownerToken = yield* randomUUIDv4;
      const claimedAt = yield* nowIso;
      const claimed = yield* recoveryLedger!.claim({
        threadId: input.threadId,
        expectedOwnerToken: authority.ownerToken,
        nextOwnerToken: ownerToken,
        updatedAt: claimedAt,
      });
      if (Option.isNone(claimed)) return null;
      const requestId = yield* randomUUIDv4;
      const mcpSession = candidateMcpSession;
      const mcpOwnerId =
        mcpSession === undefined
          ? `pylon:none:${yield* randomUUIDv4}`
          : `pylon:${mcpSession.providerSessionId}`;
      pendingRecoveryStarts.set(input.threadId, {
        kind: "adopt",
        authority,
        previousOwnerToken: authority.ownerToken,
        ownerToken,
        requestId,
        mcpOwnerId,
        sessionFile: `${authority.nativeSessionId}.jsonl`,
      });
      const started = yield* Effect.result(
        startSession({
          threadId: input.threadId,
          provider: PROVIDER,
          providerInstanceId: input.providerInstanceId,
          runtimeMode: input.runtimeMode,
          cwd: input.cwd,
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
          resumeCursor: input.resumeCursor,
          sessionIncarnationId: input.sessionIncarnationId,
        }),
      );
      if (Result.isFailure(started)) {
        pendingRecoveryStarts.delete(input.threadId);
        yield* recoveryLedger!.releaseClaim({
          threadId: input.threadId,
          ownerToken,
          previousOwnerToken: authority.ownerToken,
          updatedAt: yield* nowIso,
        });
        return null;
      }
      return started.success;
    });

    const activateRecoveredSession = Effect.fn("PrimeAgentDaemonAdapter.activateRecoveredSession")(
      function* (threadId: ThreadId) {
        yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const context = sessions.get(threadId);
            if (context === undefined || context.stopped || !context.recoveryPendingActivation)
              return;
            const turn = context.activeTurn;
            if (turn === undefined) {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: "Recovered Prime Agent execution lost its admitted turn.",
              });
            }
            for (const message of context.recoveryBacklog) {
              yield* publishDrafts(context, { _tag: "MessageCompleted", message }, turn);
            }
            context.recoveryPendingActivation = false;
            context.eventFiber = yield* context.runtime.events.pipe(
              Stream.runForEach((event) => consumeEvent(context, event)),
              Effect.forkChild,
            );
            if (context.runtime.inputAdmissionBusy) {
              yield* startBackgroundQuiescenceWatchLocked(context);
            }
          }),
        );
      },
    );

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
                // Prime Agent runs models on Anthropic and OpenAI Codex, so it
                // ingests images only, like those providers' own adapters.
                // Generic files reach the agent through the path line
                // ProviderService puts in the prompt.
                if (attachment.type !== "image") {
                  continue;
                }
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
              const thinkingLevel =
                turnControls.thinkingLevel === PRIME_AGENT_INHERIT_MODEL_OPTION
                  ? context.defaultThinkingLevel
                  : turnControls.thinkingLevel;
              const serviceTier =
                turnControls.serviceTier === PRIME_AGENT_INHERIT_MODEL_OPTION
                  ? context.defaultServiceTier
                  : turnControls.serviceTier;
              const controlsMatchCurrent =
                (requestedModel === undefined ||
                  requestedModel.length === 0 ||
                  requestedModel === context.session.model) &&
                (thinkingLevel === undefined || thinkingLevel === context.currentThinkingLevel) &&
                (serviceTier === undefined || serviceTier === context.currentServiceTier);
              if (activeTurn !== undefined) {
                if (
                  activeTurn.correlationId !== undefined &&
                  activeTurn.correlatedLifecycle?.deliveryCrossed !== true
                ) {
                  return yield* new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "sendTurn",
                    reason: "busy",
                    issue:
                      "Prime Agent background work is still running. Try again after it finishes.",
                  });
                }
                if (activeTurn.command === "compact") {
                  return yield* new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "sendTurn",
                    issue: "Prime Agent cannot steer an active context compaction.",
                  });
                }
                if (!controlsMatchCurrent) {
                  return yield* new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "sendTurn",
                    issue: "Prime Agent cannot change model controls while a run is active.",
                  });
                }
                const admission = yield* context.runtime
                  .steer({ text, ...(images.length === 0 ? {} : { images }) })
                  .pipe(
                    Effect.mapError((error) =>
                      runtimeOperationError(input.threadId, "session/steer", error),
                    ),
                  );
                if (admission === "recovering") {
                  return yield* new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "sendTurn",
                    reason: "busy",
                    issue:
                      "Prime Agent is recovering. Try steering again after recovery completes.",
                  });
                }
                activeTurn.queuedInputCount += 1;
                promotePendingRunCompletionToQueuedRun(activeTurn);
                yield* rearmRlmQuiescenceLocked(context, activeTurn);
                return {
                  _tag: "Steered" as const,
                  result: {
                    threadId: input.threadId,
                    turnId: activeTurn.id,
                    resumeCursor: context.session.resumeCursor,
                  } satisfies ProviderTurnStartResult,
                };
              }

              const knownCompactionBusy =
                context.activeCompactionScope !== undefined ||
                context.manualCompactionRequestActive;
              const correlatedRecoveryBusy =
                context.runtime.correlatedPromptLifecycleAdmissionBlocked;
              const nativeInputBusy = context.runtime.inputAdmissionBusy;
              const admissionBusy =
                nativeInputBusy ||
                (context.runtime.correlatedPromptLifecycleAvailable && knownCompactionBusy);
              if (
                correlatedRecoveryBusy ||
                (admissionBusy &&
                  (!context.runtime.correlatedPromptLifecycleAvailable || !controlsMatchCurrent))
              ) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  reason: "busy",
                  issue:
                    "Prime Agent background work is still running. Try again after it finishes.",
                });
              }

              if (!context.runtime.correlatedPromptLifecycleAvailable && knownCompactionBusy) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  reason: "busy",
                  issue: "Prime Agent cannot start a turn during context compaction.",
                });
              }
              // "default" defers to Prime's own model rather than naming one, and Prime
              // exposes no daemon method to restore that choice inside a running session:
              // `setModel` demands an explicit provider and id, and `getModelCatalog`
              // returns only models and configuredProviders with no default to re-select.
              // Reject the switch rather than run the old model behind a default label.
              //
              // Revisit when Prime publishes either a session method that returns model
              // choice to its own default, or an authoritative default id in the catalog.
              // Either one turns this into a real selection: probe for the capability and
              // apply it here instead of failing. Tracked in the parity ledger.
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
              if (!admissionBusy) {
                yield* applyTurnSelection(context, input.threadId, requestedModel, turnControls);
              }
              const turnId = TurnId.make(yield* randomUUIDv4);
              const correlationId = context.runtime.correlatedPromptLifecycleAvailable
                ? (context.runtime.recoveryCorrelationId ?? (yield* randomUUIDv4))
                : undefined;
              const turn: PrimeAgentDaemonActiveTurn = {
                id: turnId,
                controller: new AbortController(),
                completed: yield* Deferred.make<void>(),
                ...(correlationId === undefined ? {} : { correlationId }),
                cancellationRequested: false,
                assistantTextStreamed: false,
                assistantTextEmitted: "",
                assistantTextRecoveryComparable: true,
                nextAssistantMessageSequence: 0,
                activeAssistantItemId: undefined,
                lastAssistantHadRenderableText: false,
                runCompletionHandoffSequence: 0,
                terminalQuiescenceGeneration:
                  correlationId === undefined && context.runtime.rlmQuiescenceAvailable ? 1 : 0,
                terminalQuiescenceToken:
                  correlationId === undefined && context.runtime.rlmQuiescenceAvailable
                    ? rlmQuiescenceToken(turnId, 1)
                    : undefined,
                pendingRunCompletionHandoff: undefined,
                queuedInputCount: 0,
                awaitingQueuedRun: false,
                queuedActionObserved: false,
                completedRunMessages: [],
                nativeTranscriptBaselineMessageCount: context.nativeTranscriptMessageCount,
                observedToolStarts: new Set(),
                observedToolCompletions: new Set(),
                durableToolCallNames: new Map(),
                completedToolCallNames: new Map(),
                projectedPlanToolCallIds: new Set(),
                ...(/^\/compact(?:\s|$)/.test(text) ? { command: "compact" as const } : {}),
              };
              if (context.runtime.correlatedPromptLifecycleAdmissionBlocked) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  reason: "busy",
                  issue: "Prime Agent is still reconciling its correlated prompt lifecycle.",
                });
              }
              context.activeTurn = turn;
              context.session = {
                ...context.session,
                activeTurnId: turnId,
                ...(input.admissionRequestId !== undefined
                  ? { activeTurnRequestId: input.admissionRequestId }
                  : {}),
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

          const initialRlmQuiescenceToken = turn.terminalQuiescenceToken;
          const runPrompt = Effect.gen(function* () {
            const turnModel = requestedModel || context.session.model || "default";
            if (turn.correlationId !== undefined) {
              const lifecycle = yield* context.runtime
                .submitCorrelatedPrompt({
                  text,
                  correlationId: turn.correlationId,
                  queueIfBusy: true,
                  ...(images.length === 0 ? {} : { images }),
                  signal: turn.controller.signal,
                })
                .pipe(
                  Effect.mapError((error) =>
                    runtimeOperationError(input.threadId, "session/prompt", error),
                  ),
                );
              yield* withThreadLock(
                context.threadId,
                applyCorrelatedPromptLifecycleLocked(context, lifecycle),
              );
            } else {
              yield* context.runtime
                .prompt({
                  text,
                  ...(images.length === 0 ? {} : { images }),
                  ...(initialRlmQuiescenceToken === undefined
                    ? {}
                    : { rlmQuiescenceToken: initialRlmQuiescenceToken }),
                  signal: turn.controller.signal,
                })
                .pipe(
                  Effect.mapError((error) =>
                    runtimeOperationError(input.threadId, "session/prompt", error),
                  ),
                );
            }
            if (context.recoveryOwnerToken !== undefined) {
              const admissionRequestId = input.admissionRequestId?.trim();
              if (admissionRequestId === undefined || admissionRequestId.length === 0) {
                return yield* new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Recoverable Prime Agent admission lost its durable request identity.",
                });
              }
              const admitted = yield* recoveryLedger!.markAdmitted({
                threadId: input.threadId,
                ownerToken: context.recoveryOwnerToken,
                turnId: turn.id,
                updatedAt: yield* nowIso,
              });
              if (!admitted) {
                return yield* new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Recoverable Prime Agent admission lost its durable owner.",
                });
              }
            }
            yield* publishRuntimeEvent(context, {
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              turnId: turn.id,
              ...(input.admissionRequestId !== undefined
                ? { admissionRequestId: input.admissionRequestId }
                : {}),
              payload: { model: turnModel },
            });
            if (context.recoveryPendingActivation) {
              context.recoveryPendingActivation = false;
              context.eventFiber = yield* context.runtime.events.pipe(
                Stream.runForEach((event) => consumeEvent(context, event)),
                Effect.forkChild,
              );
              if (context.runtime.inputAdmissionBusy) {
                yield* startBackgroundQuiescenceWatchLocked(context);
              }
            }
            if (initialRlmQuiescenceToken !== undefined) {
              yield* awaitRlmQuiescence(context, turn, initialRlmQuiescenceToken).pipe(
                Effect.catch((error) =>
                  withThreadMutationLock(
                    context.threadId,
                    Effect.gen(function* () {
                      if (
                        context.activeTurn !== turn ||
                        turn.terminalQuiescenceToken !== initialRlmQuiescenceToken
                      ) {
                        return;
                      }
                      if (turn.cancellationRequested || turn.controller.signal.aborted) {
                        return yield* error;
                      }
                      yield* settleActiveTurnLocked(context, turn, {
                        state: "failed",
                        errorMessage: "Prime Agent could not confirm descendant quiescence.",
                      });
                      yield* stopSessionInternal(
                        context,
                        "Prime Agent session closed after descendant quiescence could not be confirmed.",
                      ).pipe(Effect.ignore);
                      return yield* error;
                    }),
                  ),
                ),
              );
            }
            yield* Deferred.await(turn.completed);
            return result;
          });

          return yield* restore(runPrompt).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (context.recoveryPendingActivation && context.recoveryOwnerToken !== undefined) {
                  yield* stopSessionInternal(
                    context,
                    "Prime Agent recoverable prompt admission could not be proven.",
                  ).pipe(Effect.ignore);
                  return yield* error;
                }
                if (turn.correlationId !== undefined && turn.cancellationRequested) {
                  yield* Deferred.await(turn.completed);
                  return result;
                }
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
                  yield* cancelActiveTurnLocked(context, turn).pipe(Effect.ignore);
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
          yield* clearPendingApprovalsLocked(context, true);
          if (context.runtime.correlatedPromptLifecycleAvailable) {
            yield* clearPendingInteractionsLocked(context, true);
          }
          if (turn !== undefined) yield* cancelActiveTurnLocked(context, turn);
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
          const activeTurn = context.activeTurn;
          if (
            pending === undefined ||
            (context.runtime.correlatedPromptLifecycleAvailable &&
              (pending.ownerTurnId === undefined ||
                pending.ownerCorrelationId === undefined ||
                activeTurn === undefined ||
                activeTurn.cancellationRequested ||
                pending.ownerTurnId !== activeTurn.id ||
                pending.ownerCorrelationId !== activeTurn.correlationId))
          ) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/request",
              detail: `Unknown or stale Prime Agent approval '${requestId}' for thread '${threadId}'.`,
            });
          }
          const confirmed =
            decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways";
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
          if (decision === "acceptForSession" || decision === "acceptAlways")
            context.approvalsAcceptedForSession = true;
          yield* syncAgentDepthSettableLocked(context);
          yield* updateCompactionProjectionLocked(context);
          yield* publishRuntimeEvent(context, {
            type: "request.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId,
            ...(pending.ownerTurnId === undefined ? {} : { turnId: pending.ownerTurnId }),
            requestId: RuntimeRequestId.make(requestId),
            payload: { requestType: pending.requestType, decision },
          });
          if (decision === "cancel") {
            const turn = context.activeTurn;
            if (turn !== undefined) yield* cancelActiveTurnLocked(context, turn);
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
          const activeTurn = context.activeTurn;
          if (
            pending === undefined ||
            (context.runtime.correlatedPromptLifecycleAvailable &&
              (pending.ownerTurnId === undefined ||
                pending.ownerCorrelationId === undefined ||
                activeTurn === undefined ||
                activeTurn.cancellationRequested ||
                pending.ownerTurnId !== activeTurn.id ||
                pending.ownerCorrelationId !== activeTurn.correlationId))
          ) {
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
          yield* publishRuntimeEvent(context, {
            type: "interaction.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId,
            ...(pending.ownerTurnId === undefined ? {} : { turnId: pending.ownerTurnId }),
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
        if (changed) yield* publishSessionAgentDepth(context, projected);
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
              // Prime Agent runs models on Anthropic and OpenAI Codex, so it
              // ingests images only, like those providers' own adapters.
              // Generic files reach the agent through the path line
              // ProviderService puts in the prompt.
              if (attachment.type !== "image") {
                continue;
              }
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
            if (Exit.isSuccess(admission) && admission.value === "recovering") {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "followUp",
                reason: "busy",
                issue:
                  "Prime Agent is recovering. Try the follow-up again after recovery completes.",
              });
            }
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
              yield* rearmRlmQuiescenceLocked(context, turn);
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
                  if (turn.terminalQuiescenceToken === undefined) {
                    const settled = yield* settleActiveTurnLocked(context, turn, {
                      state: "completed",
                      event: { _tag: "RunCompleted", messages: turn.completedRunMessages },
                    });
                    if (settled) yield* refreshContextUsage(context).pipe(Effect.forkDetach);
                  }
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
                  if (turn.terminalQuiescenceToken === undefined) {
                    const settled = yield* settleActiveTurnLocked(context, turn, {
                      state: "completed",
                      event: { _tag: "RunCompleted", messages: turn.completedRunMessages },
                    });
                    if (settled) yield* refreshContextUsage(context).pipe(Effect.forkDetach);
                  }
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

        yield* publishSessionHarnessRefinement(reserved, {
          sessionStartedAt: reserved.session.createdAt,
          status: "running",
        });
        const request = reserved.runtime.refineLocalHarness.pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              // A rejected or timed-out public request is outcome-ambiguous. Keep the
              // reservation until session stop so a late apply cannot overlap a newer call.
              Effect.gen(function* () {
                yield* publishSessionHarnessRefinement(reserved, {
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
                    yield* publishSessionHarnessRefinement(reserved, {
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
              yield* publishSessionHarnessRefinement(reserved, {
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
                    yield* publishRuntimeEvent(reserved, {
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
            const outcome = yield* Effect.gen(function* () {
              const source = yield* fileSystem.readFileString(context.managedExtensionPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId,
                      detail:
                        "Failed to verify the Prime Agent managed provider extension before reload.",
                      cause,
                    }),
                ),
              );
              if (source !== context.managedExtensionSource) {
                return yield* new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId,
                  detail: "Prime Agent's managed provider extension source changed before reload.",
                });
              }
              return yield* context.runtime.reloadResources.pipe(
                Effect.mapError((error) =>
                  runtimeOperationError(threadId, "session/reload-resources", error),
                ),
              );
            }).pipe(Effect.exit);
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
                yield* publishSessionResources(context, payload);
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
        Effect.gen(function* () {
          const outcome = yield* withThreadMutationLock(
            threadId,
            Effect.gen(function* () {
              const context = sessions.get(threadId);
              if (context !== undefined && !context.stopped && !context.stopRequested) {
                return {
                  _tag: "Stopping" as const,
                  completion: yield* stopSessionInternal(context),
                };
              }
              const teardown = activeTeardowns.get(threadId);
              if (teardown !== undefined) {
                return { _tag: "AlreadyStopping" as const, completion: teardown.completion };
              }
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId,
              });
            }),
          );
          yield* Deferred.await(outcome.completion);
          if (outcome._tag === "AlreadyStopping") {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
        }),
      );
    const listSessions: PrimeAgentAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values())
          .filter((context) => !context.stopRequested && !context.stopped)
          .map((context) => ({ ...context.session })),
      );
    const hasSession: PrimeAgentAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped && !context.stopRequested;
      });
    const stopAll: PrimeAgentAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = Array.from(sessions.values());
        const started = yield* Effect.forEach(
          contexts,
          (context) =>
            withThreadMutationLock(
              context.threadId,
              Effect.gen(function* () {
                if (sessions.get(context.threadId) !== context || context.stopped) return undefined;
                return yield* stopSessionInternal(context);
              }),
            ),
          { concurrency: "unbounded" },
        );
        const completions = new Set([
          ...started.filter((completion) => completion !== undefined),
          ...Array.from(activeTeardowns.values(), (teardown) => teardown.completion),
        ]);
        const drained = yield* Effect.forEach(completions, Deferred.await, {
          concurrency: "unbounded",
          discard: true,
        }).pipe(Effect.timeoutOption(Duration.millis(PRIME_AGENT_SESSION_TEARDOWN_TIMEOUT_MS)));
        if (Option.isNone(drained) && completions.size > 0) {
          yield* Effect.logWarning("Prime Agent stopAll reached its global teardown bound.", {
            sessionCount: completions.size,
            timeoutMs: PRIME_AGENT_SESSION_TEARDOWN_TIMEOUT_MS,
          });
        }
      });

    const shutdown: NonNullable<PrimeAgentAdapterShape["shutdown"]> = () =>
      Effect.gen(function* () {
        const contexts = Array.from(sessions.values());
        const ordinaryCompletions = yield* Effect.forEach(
          contexts,
          (context) =>
            withThreadMutationLock(
              context.threadId,
              Effect.gen(function* () {
                if (sessions.get(context.threadId) !== context || context.stopped) return undefined;
                if (context.recoveryOwnerToken !== undefined) {
                  context.stopped = true;
                  sessions.delete(context.threadId);
                  if (context.eventFiber !== undefined) yield* Fiber.interrupt(context.eventFiber);
                  context.backgroundQuiescenceController?.abort();
                  context.backgroundQuiescenceController = undefined;
                  yield* (context.runtime.detach ?? context.runtime.dispose).pipe(
                    Effect.mapError((error) =>
                      runtimeOperationError(context.threadId, "shutdown", error),
                    ),
                  );
                  yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
                  return undefined;
                }
                return yield* stopSessionInternal(context);
              }),
            ),
          { concurrency: "unbounded" },
        );
        yield* Effect.forEach(
          ordinaryCompletions.filter((completion) => completion !== undefined),
          Deferred.await,
          { concurrency: "unbounded", discard: true },
        );
      });

    yield* Effect.addFinalizer(() =>
      shutdownPrimeAgentEventPubSub({
        component: "daemon",
        pubSub: runtimeEventPubSub,
        drain: shutdown().pipe(
          Effect.andThen(
            Effect.suspend(() =>
              Effect.forEach(Array.from(pendingTerminalDeliveries), Deferred.await, {
                concurrency: "unbounded",
                discard: true,
              }),
            ),
          ),
        ),
      }).pipe(
        Effect.ensuring(Queue.shutdown(orderedRuntimeEventQueue)),
        Effect.ensuring(managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        conversationRollback: BUILT_IN_ADAPTER_CONVERSATION_ROLLBACK_MODES.primeDaemon,
      },
      startSession,
      prepareTurnRecovery,
      recoverSession,
      activateRecoveredSession,
      shutdown,
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
