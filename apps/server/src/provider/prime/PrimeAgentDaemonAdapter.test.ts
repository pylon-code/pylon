// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  defaultInstanceIdForDriver,
  EnvironmentId,
  PrimeAgentSettings,
  PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionSideQuestionRequestId,
  type ProviderRuntimeEvent,
  type ProviderSessionAgentActivityTimelineEntry,
  RuntimeSessionId,
  RuntimeTaskId,
  SessionInteractionRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "../Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../Layers/ProviderSessionDirectory.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import type {
  PrimeAgentDaemonExtensionUiResponse,
  PrimeAgentDaemonServiceTier,
  PrimeAgentDaemonThinkingLevel,
} from "./PrimeAgentDaemonBridge.ts";
import {
  PRIME_AGENT_DAEMON_TRANSCRIPT_MAX_MESSAGES,
  type PrimeDaemonEvent,
  type PrimeDaemonMessage,
  type PrimeDaemonPromptLifecycleCancellationResult,
  type PrimeDaemonPromptLifecycleSnapshot,
  type PrimeDaemonUsage,
} from "./PrimeAgentDaemonEvents.ts";
import type { PrimeAgentDaemonManager } from "./PrimeAgentDaemonManager.ts";
import { PRIME_AGENT_EVENT_BUFFER_CAPACITY } from "./PrimeAgentEventBuffer.ts";
import { PRIME_AGENT_PLAN_TOOL_NAME } from "./PrimeAgentManagedExtension.ts";
import {
  makePrimeAgentDaemonAdapter,
  PRIME_AGENT_FAILED_RUN_SETTLEMENT_GRACE_MS,
  PRIME_AGENT_SESSION_TEARDOWN_TIMEOUT_MS,
  PRIME_AGENT_SIDE_QUESTION_TIMEOUT_MS,
  type PrimeAgentDaemonAdapterLiveOptions,
} from "./PrimeAgentDaemonAdapter.ts";
import {
  PRIME_AGENT_DAEMON_RESUME_CURSOR,
  type PrimeAgentDaemonCatalogModel,
  type PrimeAgentDaemonSessionRuntime,
  type PrimeAgentDaemonSessionStats,
  type PrimeAgentDaemonSideQuestionResult,
  PrimeAgentDaemonSessionRuntimeError,
  type PrimeAgentDaemonSessionRuntimeInput,
} from "./PrimeAgentDaemonSessionRuntime.ts";

const decodeSettings = Schema.decodeSync(PrimeAgentSettings);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const instanceId = ProviderInstanceId.make("prime-daemon-test");
const threadId = ThreadId.make("prime-daemon/thread");
const manager = {} as PrimeAgentDaemonManager;
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pylon-prime-daemon-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const usage = {
  inputTokens: 11,
  outputTokens: 7,
  cachedInputTokens: 3,
  cacheWriteTokens: 2,
  totalTokens: 23,
  totalCostUsd: 0.012,
};

function assistantMessage(
  text: string,
  stopReason: Extract<PrimeDaemonMessage, { readonly role: "assistant" }>["stopReason"] = "stop",
) {
  return {
    role: "assistant",
    timestamp: 1,
    provider: "prime",
    model: "model",
    text,
    thinking: "",
    toolCalls: [],
    usage,
    stopReason,
  } satisfies PrimeDaemonMessage;
}

function lifecycleSnapshot(
  correlationId: string,
  phase: PrimeDaemonPromptLifecycleSnapshot["phase"],
  revision: number,
  options: {
    readonly kind?: PrimeDaemonPromptLifecycleSnapshot["kind"];
    readonly deliveryCrossed?: boolean;
    readonly usage?: PrimeDaemonUsage;
  } = {},
): PrimeDaemonPromptLifecycleSnapshot {
  return {
    correlationId,
    phase,
    kind: options.kind ?? "model_prompt",
    revision,
    deliveryCrossed:
      options.deliveryCrossed ??
      (phase === "delivered" || phase === "completed" || phase === "failed"),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  };
}

function initialSnapshot(): Extract<PrimeDaemonEvent, { readonly _tag: "SessionResynced" }> {
  return {
    _tag: "SessionResynced",
    state: {
      sessionId: "native-session-secret",
      cwd: "/native/secret/path",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      thinkingLevel: "medium",
      serviceTier: null,
      messageCount: 0,
      autoCompactionEnabled: true,
      inputQueue: {
        steeringCount: 0,
        followUpCount: 0,
        activeAction: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
      },
      goal: {
        available: true,
        active: false,
        status: "idle",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        continuationsUsed: 0,
      },
    },
    messages: [],
    children: [],
    lastEventSequence: 1,
  };
}

interface FakeCaptures {
  readonly runtimeInputs: Array<PrimeAgentDaemonSessionRuntimeInput>;
  readonly prompts: Array<{
    readonly text: string;
    readonly images: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }>;
    readonly signal: AbortSignal | undefined;
    readonly rlmQuiescenceToken: string | undefined;
  }>;
  readonly followUps: Array<{ readonly text: string; readonly imageCount: number }>;
  followUpFailure: boolean;
  inputRecoveryPending: boolean;
  inputAdmissionBusy: boolean;
  correlatedPromptLifecycleAdmissionBlocked: boolean;
  correlatedPromptLifecycleAdmissionBlockAfterReads: number | undefined;
  correlatedPromptLifecycleAdmissionReads: number;
  correlatedPromptLifecycleAvailable: boolean;
  readonly correlatedPromptSubmissions: Array<{
    readonly text: string;
    readonly correlationId: string;
    readonly queueIfBusy: true;
  }>;
  readonly correlatedPromptCancellations: Array<string>;
  correlatedPromptObserved: Queue.Queue<string> | undefined;
  correlatedPromptSubmitResult: PrimeDaemonPromptLifecycleSnapshot | undefined;
  correlatedPromptCancellationResult: PrimeDaemonPromptLifecycleCancellationResult | undefined;
  correlatedPromptCancellationObserved: Queue.Queue<void> | undefined;
  correlatedPromptCancellationRelease:
    | Deferred.Deferred<PrimeDaemonPromptLifecycleCancellationResult>
    | undefined;
  readonly steers: Array<{
    readonly text: string;
    readonly images: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }>;
  }>;
  readonly models: Array<string>;
  readonly thinkingLevels: Array<PrimeAgentDaemonThinkingLevel>;
  readonly serviceTiers: Array<PrimeAgentDaemonServiceTier>;
  readonly extensions: Array<{
    readonly id: string;
    readonly response: PrimeAgentDaemonExtensionUiResponse;
  }>;
  readonly order: Array<string>;
  disposeCount: number;
  disposeObserved: Queue.Queue<void> | undefined;
  disposeRelease: Deferred.Deferred<void> | undefined;
  extensionFailure: boolean;
  abortClearFailure: boolean;
  sessionStatsFailure: boolean;
  sessionStatsCount: number;
  reloadFailure: boolean;
  reloadCount: number;
  reloadObserved: Queue.Queue<void> | undefined;
  reloadRelease: Deferred.Deferred<void> | undefined;
  agentDepth: {
    maxDepth: number;
    source: "session";
    writable: boolean;
    settable: boolean;
    maxSettableDepth: number;
  };
  agentDepthCalls: Array<number>;
  agentDepthFailure: boolean;
  agentDepthFailureAfterMutation: boolean;
  agentDepthReadFailure: boolean;
  agentDepthObserved: Queue.Queue<void> | undefined;
  agentDepthRelease: Deferred.Deferred<void> | undefined;
  inputQueue: {
    steeringCount: number;
    followUpCount: number;
    steeringMode: "all-at-once" | "one-at-a-time";
    followUpMode: "all-at-once" | "one-at-a-time";
  };
  inputQueueModesAvailable: boolean;
  inputQueueMutationAvailable: boolean;
  inputQueueMutationCalls: Array<"steering" | "follow-up">;
  inputQueueMutationStatus: "applied" | "rejected" | "invalid" | "unsupported";
  inputQueueMutationFailure: boolean;
  inputQueueMutationDrainOtherLane: boolean;
  inputQueueModeCalls: Array<{
    readonly queue: "steering" | "follow-up";
    readonly mode: "all-at-once" | "one-at-a-time";
  }>;
  inputQueueModeFailure: boolean;
  inputQueueModeFailureAfterMutation: boolean;
  inputQueueModeTimedOut: boolean;
  inputQueueStatusFailure: boolean;
  compactionAvailable: boolean;
  refinementAvailable: boolean;
  refinementCalls: number;
  refinementFailure: boolean;
  refinementObserved: Queue.Queue<void> | undefined;
  refinementRelease: Deferred.Deferred<void> | undefined;
  autoCompactionWritable: boolean;
  compactionState: {
    isCompacting: boolean;
    autoCompactionEnabled: boolean;
    isStreaming: boolean;
    isBashRunning: boolean;
    inputQueueActive: boolean;
    steeringCount: number;
    followUpCount: number;
  };
  compactCalls: number;
  compactObserved: Queue.Queue<void> | undefined;
  compactRelease: Deferred.Deferred<void> | undefined;
  abortCompactionCalls: number;
  autoCompactionCalls: Array<boolean>;
  compactionFailure: boolean;
  compactionStateFailure: boolean;
  compactionStateFailureAfterMutation: boolean;
  agentRoster: Array<Extract<PrimeDaemonEvent, { readonly _tag: "ChildUpdated" }>["child"]>;
  agentRosterReads: number;
  cancelAgentCalls: Array<string>;
  cancelAgentResult: boolean;
  cancelAgentFailure: boolean;
  agentMessageAvailable: boolean;
  activityWatchAvailable: boolean;
  activityWatchNever: boolean;
  readonly activityWatchCalls: Array<string>;
  activityWatchObserved: Queue.Queue<void> | undefined;
  activityWatchUpdates:
    | Queue.Queue<ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>>
    | undefined;
  readonly activityWatchUpdatesByEndpoint: Map<
    string,
    Queue.Queue<ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>>
  >;
  readonly activityWatchFinalizations: Array<string>;
  activityWatchEntries: Array<ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>>;
  agentMessageCalls: Array<{ readonly activeSessionId: string; readonly message: string }>;
  agentMessageDisposition: "delivered" | "queued";
  agentMessageFailureReason:
    | "request-failed"
    | "request-timed-out"
    | "invalid-response"
    | undefined;
  agentMessageObserved: Queue.Queue<void> | undefined;
  agentMessageRelease: Deferred.Deferred<void> | undefined;
  agentMessageRosterAfterInvocation:
    | Array<Extract<PrimeDaemonEvent, { readonly _tag: "ChildUpdated" }>["child"]>
    | undefined;
  agentRosterFailure: boolean;
  sessionStats: PrimeAgentDaemonSessionStats;
  modelDiscoveryModels: Array<PrimeAgentDaemonCatalogModel>;
  modelDiscoveryFailure: boolean;
  modelDiscoveryObserved: Queue.Queue<void> | undefined;
  modelDiscoveryRelease: Deferred.Deferred<void> | undefined;
  sideQuestionsAvailable: boolean;
  sideQuestionCalls: Array<{ readonly nativeId: string; readonly question: string }>;
  sideQuestionAbortCalls: Array<string>;
  sideQuestionObserved: Queue.Queue<void> | undefined;
  sideQuestionRelease:
    | Deferred.Deferred<
        | { readonly disposition: "answered"; readonly answer: string }
        | { readonly disposition: "cancelled" }
        | { readonly disposition: "response-too-large" }
      >
    | undefined;
  sideQuestionFailure: boolean;
  promptObserved: Queue.Queue<void> | undefined;
  rlmQuiescenceAvailable: boolean;
  rlmQuiescenceRelease: Deferred.Deferred<void> | undefined;
  readonly rlmQuiescenceCalls: Array<string>;
  readonly rlmQuiescenceSignals: Array<AbortSignal>;
  rlmQuiescenceObserved: Queue.Queue<string> | undefined;
  backgroundQuiescenceCompleted: Queue.Queue<string> | undefined;
  rlmQuiescenceFailure: boolean;
  rlmConnectionGeneration: number;
  rlmContinuityValid: boolean;
  correlatedRecoveryProofCurrent: boolean;
  correlatedRecoveryProofEpoch: number;
  reconnectSnapshotResolutionAccepted: boolean;
  readonly reconnectResolutions: Array<{
    readonly generation: number;
    readonly reconciled: boolean;
    readonly terminalResponseObserved: boolean;
  }>;
  retryWorkerRecoverySnapshots: boolean;
  retryWorkerRecoverySnapshotCalls: Array<number>;
  retryWorkerRecoverySnapshotObserved: ((generation: number) => void) | undefined;
  reconnectSnapshotResolutionObserved:
    | ((resolution: {
        readonly generation: number;
        readonly reconciled: boolean;
        readonly terminalResponseObserved: boolean;
      }) => void)
    | undefined;
  workerRecoveryTerminalResponseObserved: (() => void) | undefined;
  rlmQuiescenceUsage: typeof usage | undefined;
  queue: Queue.Queue<PrimeDaemonEvent> | undefined;
  startupEvents: Array<PrimeDaemonEvent>;
}

function makeCaptures(): FakeCaptures {
  return {
    runtimeInputs: [],
    prompts: [],
    followUps: [],
    followUpFailure: false,
    inputRecoveryPending: false,
    inputAdmissionBusy: false,
    correlatedPromptLifecycleAdmissionBlocked: false,
    correlatedPromptLifecycleAdmissionBlockAfterReads: undefined,
    correlatedPromptLifecycleAdmissionReads: 0,
    correlatedPromptLifecycleAvailable: false,
    correlatedPromptSubmissions: [],
    correlatedPromptCancellations: [],
    correlatedPromptObserved: undefined,
    correlatedPromptSubmitResult: undefined,
    correlatedPromptCancellationResult: undefined,
    correlatedPromptCancellationObserved: undefined,
    correlatedPromptCancellationRelease: undefined,
    steers: [],
    models: [],
    thinkingLevels: [],
    serviceTiers: [],
    extensions: [],
    order: [],
    disposeCount: 0,
    disposeObserved: undefined,
    disposeRelease: undefined,
    extensionFailure: false,
    abortClearFailure: false,
    sessionStatsFailure: false,
    sessionStatsCount: 0,
    reloadFailure: false,
    reloadCount: 0,
    reloadObserved: undefined,
    reloadRelease: undefined,
    agentDepth: {
      maxDepth: 2,
      source: "session",
      writable: true,
      settable: true,
      maxSettableDepth: 4,
    },
    agentDepthCalls: [],
    agentDepthFailure: false,
    agentDepthFailureAfterMutation: false,
    agentDepthReadFailure: false,
    agentDepthObserved: undefined,
    agentDepthRelease: undefined,
    inputQueue: {
      steeringCount: 0,
      followUpCount: 0,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
    },
    inputQueueModesAvailable: true,
    inputQueueMutationAvailable: true,
    inputQueueMutationCalls: [],
    inputQueueMutationStatus: "applied",
    inputQueueMutationFailure: false,
    inputQueueMutationDrainOtherLane: false,
    inputQueueModeCalls: [],
    inputQueueModeFailure: false,
    inputQueueModeFailureAfterMutation: false,
    inputQueueModeTimedOut: false,
    inputQueueStatusFailure: false,
    compactionAvailable: true,
    refinementAvailable: true,
    refinementCalls: 0,
    refinementFailure: false,
    refinementObserved: undefined,
    refinementRelease: undefined,
    autoCompactionWritable: true,
    compactionState: {
      isCompacting: false,
      autoCompactionEnabled: true,
      isStreaming: false,
      isBashRunning: false,
      inputQueueActive: false,
      steeringCount: 0,
      followUpCount: 0,
    },
    compactCalls: 0,
    compactObserved: undefined,
    compactRelease: undefined,
    abortCompactionCalls: 0,
    autoCompactionCalls: [],
    compactionFailure: false,
    compactionStateFailure: false,
    compactionStateFailureAfterMutation: false,
    agentRoster: [],
    agentRosterReads: 0,
    cancelAgentCalls: [],
    cancelAgentResult: true,
    cancelAgentFailure: false,
    agentMessageAvailable: true,
    activityWatchAvailable: false,
    activityWatchNever: false,
    activityWatchCalls: [],
    activityWatchObserved: undefined,
    activityWatchUpdates: undefined,
    activityWatchUpdatesByEndpoint: new Map(),
    activityWatchFinalizations: [],
    activityWatchEntries: [],
    agentMessageCalls: [],
    agentMessageDisposition: "delivered",
    agentMessageFailureReason: undefined,
    agentMessageObserved: undefined,
    agentMessageRelease: undefined,
    agentMessageRosterAfterInvocation: undefined,
    agentRosterFailure: false,
    sessionStats: {
      contextUsage: { usedTokens: 320, maxTokens: 200_000 },
    },
    modelDiscoveryModels: [],
    modelDiscoveryFailure: false,
    modelDiscoveryObserved: undefined,
    modelDiscoveryRelease: undefined,
    sideQuestionsAvailable: true,
    sideQuestionCalls: [],
    sideQuestionAbortCalls: [],
    sideQuestionObserved: undefined,
    sideQuestionRelease: undefined,
    sideQuestionFailure: false,
    promptObserved: undefined,
    rlmQuiescenceAvailable: false,
    rlmQuiescenceRelease: undefined,
    rlmQuiescenceCalls: [],
    rlmQuiescenceSignals: [],
    rlmQuiescenceObserved: undefined,
    backgroundQuiescenceCompleted: undefined,
    rlmQuiescenceFailure: false,
    rlmConnectionGeneration: 0,
    rlmContinuityValid: true,
    correlatedRecoveryProofCurrent: true,
    correlatedRecoveryProofEpoch: 1,
    reconnectSnapshotResolutionAccepted: true,
    reconnectResolutions: [],
    retryWorkerRecoverySnapshots: false,
    retryWorkerRecoverySnapshotCalls: [],
    retryWorkerRecoverySnapshotObserved: undefined,
    reconnectSnapshotResolutionObserved: undefined,
    workerRecoveryTerminalResponseObserved: undefined,
    rlmQuiescenceUsage: undefined,
    queue: undefined,
    startupEvents: [],
  };
}

function fakeRuntimeFactory(
  captures: FakeCaptures,
): NonNullable<PrimeAgentDaemonAdapterLiveOptions["runtimeFactory"]> {
  return (input) =>
    Effect.gen(function* () {
      captures.runtimeInputs.push(input);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(`${input.sessionDir}/native-session-secret.jsonl`, ""),
      );
      const queue = yield* Queue.unbounded<PrimeDaemonEvent>();
      const promptObserved = yield* Queue.unbounded<void>();
      const runtimeSideQuestions = new Map<
        string,
        { terminalObserved: boolean; abortRequested: boolean }
      >();
      captures.queue = queue;
      captures.promptObserved = promptObserved;
      for (const event of captures.startupEvents) yield* Queue.offer(queue, event);
      const runtime: PrimeAgentDaemonSessionRuntime = {
        resumeCursor: PRIME_AGENT_DAEMON_RESUME_CURSOR,
        sessionId: "native-session-secret",
        sessionFile: `${input.sessionDir}/native-session-secret.jsonl`,
        activeSessionId: "native-active-secret",
        initialSnapshot: { ...initialSnapshot(), children: captures.agentRoster },
        initialResources: { available: true, skills: [], prompts: [], commands: [] },
        sideQuestionsAvailable: captures.sideQuestionsAvailable,
        askSideQuestion: (nativeId, question) => {
          const state = { terminalObserved: false, abortRequested: false };
          runtimeSideQuestions.set(nativeId, state);
          return Effect.gen(function* () {
            captures.sideQuestionCalls.push({ nativeId, question });
            if (captures.sideQuestionObserved !== undefined) {
              yield* Queue.offer(captures.sideQuestionObserved, undefined);
            }
            if (captures.sideQuestionFailure) {
              return yield* new PrimeAgentDaemonSessionRuntimeError({
                operation: "side-question",
                reason: "request-failed",
                detail: "private native side-question failure",
              });
            }
            const result =
              captures.sideQuestionRelease === undefined
                ? ({ disposition: "answered", answer: "side answer" } as const)
                : yield* Deferred.await(captures.sideQuestionRelease);
            state.terminalObserved = result.disposition !== "response-too-large";
            return result;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (!state.terminalObserved && !state.abortRequested) {
                  state.abortRequested = true;
                  captures.sideQuestionAbortCalls.push(nativeId);
                }
                runtimeSideQuestions.delete(nativeId);
              }),
            ),
          );
        },
        abortSideQuestion: (nativeId) =>
          Effect.sync(() => {
            const state = runtimeSideQuestions.get(nativeId);
            if (state !== undefined && !state.terminalObserved && !state.abortRequested) {
              state.abortRequested = true;
              captures.sideQuestionAbortCalls.push(nativeId);
            }
          }),
        discoverAvailableModels: Effect.gen(function* () {
          if (captures.modelDiscoveryObserved !== undefined) {
            yield* Queue.offer(captures.modelDiscoveryObserved, undefined);
          }
          if (captures.modelDiscoveryRelease !== undefined) {
            yield* Deferred.await(captures.modelDiscoveryRelease);
          }
          if (captures.modelDiscoveryFailure) {
            return yield* new PrimeAgentDaemonSessionRuntimeError({
              operation: "model-catalog",
              reason: "request-failed",
              detail: "private catalog failure",
            });
          }
          return captures.modelDiscoveryModels;
        }),
        initialInputQueue: captures.inputQueue,
        inputQueueModesAvailable: captures.inputQueueModesAvailable,
        inputQueueMutationAvailable: captures.inputQueueMutationAvailable,
        compactionAvailable: captures.compactionAvailable,
        refinementAvailable: captures.refinementAvailable && input.resumeCursor === undefined,
        refineLocalHarness: Effect.gen(function* () {
          captures.refinementCalls += 1;
          if (captures.refinementObserved !== undefined) {
            yield* Queue.offer(captures.refinementObserved, undefined);
          }
          if (captures.refinementRelease !== undefined) {
            yield* Deferred.await(captures.refinementRelease);
          }
          if (captures.refinementFailure) {
            return yield* new PrimeAgentDaemonSessionRuntimeError({
              operation: "refine-local-harness",
              reason: "request-failed",
              detail: "refinement request failed",
            });
          }
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(
                NodePath.dirname(input.sessionDir),
                "session-artifacts",
                "native-session-secret",
                "harness",
                "harness_state.json",
              ),
              "private harness",
            ),
          );
          return { appliedCount: 2, failedCount: 1, outcome: "partial" };
        }),
        autoCompactionWritable: captures.autoCompactionWritable,
        initialCompactionState: captures.compactionState,
        getCompactionState: Effect.suspend(() =>
          captures.compactionStateFailure ||
          (captures.compactionStateFailureAfterMutation && captures.autoCompactionCalls.length > 0)
            ? Effect.fail(
                new PrimeAgentDaemonSessionRuntimeError({
                  operation: "get-compaction-state",
                  reason: "request-failed",
                  detail: "state failed",
                }),
              )
            : Effect.succeed({ ...captures.compactionState }),
        ),
        compact: Effect.gen(function* () {
          captures.compactCalls += 1;
          if (captures.compactObserved !== undefined) {
            yield* Queue.offer(captures.compactObserved, undefined);
          }
          if (captures.compactRelease !== undefined) {
            yield* Deferred.await(captures.compactRelease);
          }
          if (captures.compactionFailure) {
            return yield* new PrimeAgentDaemonSessionRuntimeError({
              operation: "compact",
              reason: "request-failed",
              detail: "compaction failed",
            });
          }
        }),
        abortCompaction: Effect.sync(() => {
          captures.abortCompactionCalls += 1;
        }),
        setAutoCompactionEnabled: (enabled) =>
          Effect.sync(() => {
            captures.autoCompactionCalls.push(enabled);
            captures.compactionState = {
              ...captures.compactionState,
              autoCompactionEnabled: enabled,
            };
          }),
        initialAgentDepth:
          input.requiredExtension === undefined
            ? captures.agentDepth
            : {
                maxDepth: 0,
                source: "policy",
                writable: false,
                settable: false,
                maxSettableDepth: 4,
              },
        reloadResources: Effect.suspend(() =>
          captures.reloadFailure
            ? Effect.fail(
                new PrimeAgentDaemonSessionRuntimeError({
                  operation: "reload-resources",
                  reason: "request-failed",
                  detail: "reload failed",
                }),
              )
            : Effect.gen(function* () {
                captures.reloadCount += 1;
                captures.order.push("reload-resources");
                if (captures.reloadObserved !== undefined) {
                  yield* Queue.offer(captures.reloadObserved, undefined);
                }
                if (captures.reloadRelease !== undefined) {
                  yield* Deferred.await(captures.reloadRelease);
                }
                return {
                  resources: {
                    available: true,
                    skills: [],
                    prompts: [],
                    commands: [{ name: "skill:review", source: "skill" as const }],
                  },
                  agentDepth: captures.agentDepth,
                };
              }),
        ),
        getAgentDepth: Effect.gen(function* () {
          if (captures.agentDepthReadFailure) {
            return yield* new PrimeAgentDaemonSessionRuntimeError({
              operation: "get-agent-depth",
              reason: "request-failed",
              detail: "depth read failed",
            });
          }
          return captures.agentDepth;
        }),
        agentMessageAvailable: captures.agentMessageAvailable,
        getAgentRoster: Effect.suspend(() => {
          captures.agentRosterReads += 1;
          return captures.agentRosterFailure
            ? Effect.fail(
                new PrimeAgentDaemonSessionRuntimeError({
                  operation: "get-agent-roster",
                  reason: "request-failed",
                  detail: "roster failed",
                }),
              )
            : Effect.succeed(captures.agentRoster);
        }),
        cancelAgent: (agentId) =>
          Effect.suspend(() => {
            captures.cancelAgentCalls.push(agentId);
            return captures.cancelAgentFailure
              ? Effect.fail(
                  new PrimeAgentDaemonSessionRuntimeError({
                    operation: "cancel-agent",
                    reason: "request-failed",
                    detail: "cancel failed",
                  }),
                )
              : Effect.succeed(captures.cancelAgentResult);
          }),
        messageAgent: (activeSessionId, message) =>
          Effect.gen(function* () {
            captures.agentMessageCalls.push({ activeSessionId, message });
            if (captures.agentMessageRosterAfterInvocation !== undefined) {
              captures.agentRoster = captures.agentMessageRosterAfterInvocation;
            }
            if (captures.agentMessageObserved !== undefined) {
              yield* Queue.offer(captures.agentMessageObserved, undefined);
            }
            if (captures.agentMessageRelease !== undefined) {
              yield* Deferred.await(captures.agentMessageRelease);
            }
            captures.order.push("agent-message-completed");
            if (captures.agentMessageFailureReason !== undefined) {
              return yield* new PrimeAgentDaemonSessionRuntimeError({
                operation: "message-agent",
                reason: captures.agentMessageFailureReason,
                detail: `private native failure for ${activeSessionId}: ${message}`,
              });
            }
            return captures.agentMessageDisposition;
          }),
        watchAgentActivityAvailable: captures.activityWatchAvailable,
        watchAgentActivity: (activeSessionId) => {
          const acquired = Stream.fromEffect(
            Effect.gen(function* () {
              captures.activityWatchCalls.push(activeSessionId);
              if (captures.activityWatchObserved !== undefined) {
                yield* Queue.offer(captures.activityWatchObserved, undefined);
              }
            }),
          ).pipe(Stream.drain);
          const finalized = Effect.sync(() => {
            captures.activityWatchFinalizations.push(activeSessionId);
          });
          const updates =
            captures.activityWatchUpdatesByEndpoint.get(activeSessionId) ??
            captures.activityWatchUpdates;
          if (updates !== undefined) {
            return acquired.pipe(
              Stream.concat(Stream.fromQueue(updates)),
              Stream.ensuring(finalized),
            );
          }
          if (captures.activityWatchNever) {
            return acquired.pipe(Stream.concat(Stream.never), Stream.ensuring(finalized));
          }
          return acquired.pipe(
            Stream.concat(Stream.fromIterable(captures.activityWatchEntries)),
            Stream.ensuring(finalized),
          );
        },
        setAgentDepth: (maxDepth) =>
          Effect.gen(function* () {
            captures.agentDepthCalls.push(maxDepth);
            if (captures.agentDepthObserved !== undefined) {
              yield* Queue.offer(captures.agentDepthObserved, undefined);
            }
            if (captures.agentDepthRelease !== undefined) {
              yield* Deferred.await(captures.agentDepthRelease);
            }
            if (captures.agentDepthFailureAfterMutation) {
              captures.agentDepth = { ...captures.agentDepth, maxDepth, source: "session" };
            }
            if (captures.agentDepthFailure || captures.agentDepthFailureAfterMutation) {
              return yield* new PrimeAgentDaemonSessionRuntimeError({
                operation: "set-agent-depth",
                reason: "request-failed",
                detail: "depth update failed",
              });
            }
            captures.agentDepth = { ...captures.agentDepth, maxDepth, source: "session" };
            return captures.agentDepth;
          }),
        events: Stream.fromQueue(queue),
        rlmQuiescenceAvailable: captures.rlmQuiescenceAvailable,
        waitForRlmQuiescence: (token, signal) =>
          Effect.gen(function* () {
            captures.rlmQuiescenceCalls.push(token);
            captures.rlmQuiescenceSignals.push(signal);
            if (captures.rlmQuiescenceObserved !== undefined) {
              yield* Queue.offer(captures.rlmQuiescenceObserved, token);
            }
            if (captures.rlmQuiescenceRelease !== undefined) {
              yield* Deferred.await(captures.rlmQuiescenceRelease);
            }
            if (captures.rlmQuiescenceFailure) {
              return yield* new PrimeAgentDaemonSessionRuntimeError({
                operation: "rlm-quiescence",
                reason: "request-failed",
                detail: "quiescence failed",
              });
            }
            if (token.startsWith("background:")) {
              captures.inputAdmissionBusy = false;
              if (captures.backgroundQuiescenceCompleted !== undefined) {
                yield* Queue.offer(captures.backgroundQuiescenceCompleted, token);
              }
            }
            yield* Queue.offer(queue, {
              _tag: "RlmQuiesced",
              token,
              connectionGeneration: captures.rlmConnectionGeneration,
              ...(captures.rlmQuiescenceUsage === undefined
                ? {}
                : { usage: captures.rlmQuiescenceUsage }),
            });
          }),
        isRlmQuiescenceGenerationCurrent: (generation) =>
          captures.rlmContinuityValid && generation === captures.rlmConnectionGeneration,
        resolveReconnectSnapshot: (generation, reconciled, terminalResponseObserved = false) => {
          const resolution = { generation, reconciled, terminalResponseObserved };
          captures.reconnectResolutions.push(resolution);
          captures.reconnectSnapshotResolutionObserved?.(resolution);
          if (
            generation !== captures.rlmConnectionGeneration ||
            !captures.reconnectSnapshotResolutionAccepted ||
            (captures.correlatedPromptLifecycleAvailable &&
              !captures.correlatedRecoveryProofCurrent)
          ) {
            return false;
          }
          captures.rlmContinuityValid = reconciled;
          return true;
        },
        retryWorkerRecoverySnapshot: (generation) => {
          captures.retryWorkerRecoverySnapshotCalls.push(generation);
          captures.retryWorkerRecoverySnapshotObserved?.(generation);
          return captures.retryWorkerRecoverySnapshots;
        },
        noteWorkerRecoveryTerminalResponse: () => {
          captures.workerRecoveryTerminalResponseObserved?.();
        },
        isConnectionGenerationCurrent: (generation, proofEpoch) =>
          generation === captures.rlmConnectionGeneration &&
          (!captures.correlatedPromptLifecycleAvailable ||
            (captures.correlatedRecoveryProofCurrent &&
              (proofEpoch ?? captures.correlatedRecoveryProofEpoch) ===
                captures.correlatedRecoveryProofEpoch)),
        get correlatedPromptLifecycleAvailable() {
          return captures.correlatedPromptLifecycleAvailable;
        },
        submitCorrelatedPrompt: (prompt) =>
          Effect.gen(function* () {
            captures.correlatedPromptSubmissions.push({
              text: prompt.text,
              correlationId: prompt.correlationId,
              queueIfBusy: prompt.queueIfBusy,
            });
            if (captures.correlatedPromptObserved !== undefined) {
              yield* Queue.offer(captures.correlatedPromptObserved, prompt.correlationId);
            }
            return (
              captures.correlatedPromptSubmitResult ?? {
                correlationId: prompt.correlationId,
                phase: "owned",
                kind: prompt.text.startsWith("/") ? "session_command" : "model_prompt",
                revision: 1,
                deliveryCrossed: false,
              }
            );
          }),
        cancelPromptLifecycle: (correlationId) =>
          Effect.gen(function* () {
            captures.correlatedPromptCancellations.push(correlationId);
            if (captures.correlatedPromptCancellationObserved !== undefined) {
              yield* Queue.offer(captures.correlatedPromptCancellationObserved, undefined);
            }
            if (captures.correlatedPromptCancellationRelease !== undefined) {
              return yield* Deferred.await(captures.correlatedPromptCancellationRelease);
            }
            return (
              captures.correlatedPromptCancellationResult ?? {
                status: "cancelled",
                ownershipCrossed: true,
                deliveryCrossed: false,
                lifecycle: {
                  correlationId,
                  phase: "cancelled",
                  kind: "model_prompt",
                  revision: 2,
                  deliveryCrossed: false,
                },
              }
            );
          }),
        get correlatedPromptLifecycleAdmissionBlocked() {
          captures.correlatedPromptLifecycleAdmissionReads += 1;
          return (
            captures.correlatedPromptLifecycleAdmissionBlocked ||
            (captures.correlatedPromptLifecycleAdmissionBlockAfterReads !== undefined &&
              captures.correlatedPromptLifecycleAdmissionReads >=
                captures.correlatedPromptLifecycleAdmissionBlockAfterReads)
          );
        },
        get inputAdmissionBusy() {
          return captures.inputAdmissionBusy;
        },
        prompt: (prompt) =>
          Effect.gen(function* () {
            captures.order.push("prompt");
            captures.prompts.push({
              text: prompt.text,
              images: prompt.images ?? [],
              signal: prompt.signal,
              rlmQuiescenceToken: prompt.rlmQuiescenceToken,
            });
            yield* Queue.offer(promptObserved, undefined);
          }),
        steer: (steer) =>
          captures.inputRecoveryPending
            ? Effect.succeed("recovering" as const)
            : Effect.sync(() => {
                captures.order.push("steer");
                captures.steers.push({ text: steer.text, images: steer.images ?? [] });
                return "accepted" as const;
              }),
        followUp: (followUp) =>
          captures.inputRecoveryPending
            ? Effect.succeed("recovering" as const)
            : captures.followUpFailure
              ? Effect.fail(
                  new PrimeAgentDaemonSessionRuntimeError({
                    operation: "follow-up",
                    reason: "request-failed",
                    detail: "follow-up failed",
                  }),
                )
              : Effect.sync(() => {
                  captures.followUps.push({
                    text: followUp.text,
                    imageCount: followUp.images?.length ?? 0,
                  });
                  captures.inputQueue = {
                    ...captures.inputQueue,
                    followUpCount: captures.inputQueue.followUpCount + 1,
                  };
                  return "accepted" as const;
                }),
        getInputQueue: Effect.sync(() => captures.inputQueue),
        getInputQueueStatus: Effect.suspend(() =>
          captures.inputQueueStatusFailure
            ? Effect.fail(
                new PrimeAgentDaemonSessionRuntimeError({
                  operation: "get-input-queue",
                  reason: "request-failed",
                  detail: "queue status failed",
                }),
              )
            : Effect.succeed({
                queue: captures.inputQueue,
                activeAction: false,
                isStreaming: false,
              }),
        ),
        clearInputQueue: Effect.sync(() => {
          captures.inputQueue = {
            ...captures.inputQueue,
            steeringCount: 0,
            followUpCount: 0,
          };
          return { queue: captures.inputQueue, activeAction: false, isStreaming: false };
        }),
        removeOnlyInputQueueItem: (queueKind) =>
          Effect.suspend(() => {
            captures.inputQueueMutationCalls.push(queueKind);
            if (captures.inputQueueMutationFailure) {
              return Effect.fail(
                new PrimeAgentDaemonSessionRuntimeError({
                  operation: "remove-only-input-queue-item",
                  reason: "request-failed",
                  detail: "queue mutation failed",
                }),
              );
            }
            if (captures.inputQueueMutationStatus === "applied") {
              captures.inputQueue = captures.inputQueueMutationDrainOtherLane
                ? { ...captures.inputQueue, steeringCount: 0, followUpCount: 0 }
                : {
                    ...captures.inputQueue,
                    ...(queueKind === "steering" ? { steeringCount: 0 } : { followUpCount: 0 }),
                  };
            }
            return Effect.succeed(captures.inputQueueMutationStatus);
          }),
        setInputQueueMode: (mode) =>
          Effect.suspend(() => {
            captures.inputQueueModeCalls.push(mode);
            if (captures.inputQueueModeFailureAfterMutation) {
              captures.inputQueue = {
                ...captures.inputQueue,
                ...(mode.queue === "steering"
                  ? { steeringMode: mode.mode }
                  : { followUpMode: mode.mode }),
              };
            }
            if (
              captures.inputQueueModeFailure ||
              captures.inputQueueModeFailureAfterMutation ||
              captures.inputQueueModeTimedOut
            ) {
              return Effect.fail(
                new PrimeAgentDaemonSessionRuntimeError({
                  operation: "set-input-queue-mode",
                  reason: captures.inputQueueModeTimedOut ? "request-timed-out" : "request-failed",
                  detail: "queue mode failed",
                }),
              );
            }
            captures.inputQueue = {
              ...captures.inputQueue,
              ...(mode.queue === "steering"
                ? { steeringMode: mode.mode }
                : { followUpMode: mode.mode }),
            };
            return Effect.void;
          }),
        abort: Effect.sync(() => {
          captures.order.push("abort");
          expect(captures.prompts.at(-1)?.signal?.aborted).toBe(true);
        }),
        abortAndClearQueue: captures.abortClearFailure
          ? Effect.fail(
              new PrimeAgentDaemonSessionRuntimeError({
                operation: "abort-and-clear-queue",
                reason: "request-failed",
                detail: "abort clear failed",
              }),
            )
          : Effect.sync(() => {
              captures.order.push("abort-clear");
            }),
        setModel: (model) =>
          Effect.sync(() => {
            captures.order.push(`model:${model}`);
            captures.models.push(model);
            const separator = model.indexOf("/");
            return {
              provider: model.slice(0, separator),
              id: model.slice(separator + 1),
              name: model,
            };
          }),
        setThinkingLevel: (level) =>
          Effect.sync(() => {
            captures.order.push(`thinking:${level}`);
            captures.thinkingLevels.push(level);
          }),
        setServiceTier: (tier) =>
          Effect.sync(() => {
            captures.order.push(`service:${tier ?? "none"}`);
            captures.serviceTiers.push(tier);
          }),
        respondToExtensionUiRequest: (id, response) =>
          captures.extensionFailure
            ? Effect.fail(
                new PrimeAgentDaemonSessionRuntimeError({
                  operation: "extension-ui-response",
                  reason: "request-failed",
                  detail: "native secret failure",
                }),
              )
            : Effect.sync(() => {
                captures.order.push(`extension:${id}`);
                captures.extensions.push({ id, response });
              }),
        getSessionStats: captures.sessionStatsFailure
          ? Effect.fail(
              new PrimeAgentDaemonSessionRuntimeError({
                operation: "session-stats",
                reason: "request-failed",
                detail: "stats failed",
              }),
            )
          : Effect.sync(() => {
              captures.sessionStatsCount += 1;
              return captures.sessionStats;
            }),
        dispose: Effect.gen(function* () {
          captures.order.push("dispose");
          captures.disposeCount += 1;
          if (captures.disposeObserved !== undefined) {
            yield* Queue.offer(captures.disposeObserved, undefined);
          }
          if (captures.disposeRelease !== undefined) {
            yield* Deferred.await(captures.disposeRelease);
          }
        }),
      };
      return runtime;
    });
}

function subscribe(adapter: { readonly streamEvents: Stream.Stream<ProviderRuntimeEvent> }) {
  return Effect.gen(function* () {
    const events: Array<ProviderRuntimeEvent> = [];
    const observed = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const fiber = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(Effect.andThen(Queue.offer(observed, event)), Effect.asVoid),
      ),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    return { events, observed, fiber };
  });
}

const awaitObservedType = Effect.fn("awaitObservedType")(function* (
  observed: Queue.Queue<ProviderRuntimeEvent>,
  type: ProviderRuntimeEvent["type"],
) {
  while (true) {
    const event = yield* Queue.take(observed);
    if (event.type === type) return event;
  }
});

function offer(captures: FakeCaptures, event: PrimeDaemonEvent) {
  return Queue.offer(captures.queue!, event).pipe(Effect.asVoid);
}

describe("PrimeAgentDaemonAdapter", () => {
  it.effect("stamps every daemon event path from the captured session incarnation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        const sessionIncarnationId = RuntimeSessionId.make("prime-daemon-incarnation-a");
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          sessionIncarnationId,
        });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const turnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "stamp all daemon event paths",
            sessionIncarnationId,
          })
          .pipe(Effect.forkChild);
        const correlationId = yield* Queue.take(captures.correlatedPromptObserved);
        const message = assistantMessage("captured incarnation");
        yield* offer(captures, {
          _tag: "PromptLifecycleUpdated",
          lifecycle: lifecycleSnapshot(correlationId, "delivered", 2),
        });
        yield* offer(captures, {
          _tag: "MessageStarted",
          message,
          attribution: { scope: "prompt", correlationId },
        });
        yield* offer(captures, {
          _tag: "AssistantStream",
          phase: "delta",
          kind: "text",
          delta: message.text,
          attribution: { scope: "prompt", correlationId },
        });
        yield* offer(captures, {
          _tag: "MessageCompleted",
          message,
          attribution: { scope: "prompt", correlationId },
        });
        yield* offer(captures, {
          _tag: "RunCompleted",
          messages: [message],
          attribution: { scope: "prompt", correlationId },
        });
        yield* offer(captures, {
          _tag: "PromptLifecycleUpdated",
          lifecycle: lifecycleSnapshot(correlationId, "completed", 3, { usage }),
        });
        yield* Fiber.join(turnFiber);
        yield* awaitObservedType(subscription.observed, "turn.completed");
        yield* adapter.stopSession(threadId);
        yield* awaitObservedType(subscription.observed, "session.exited");

        const requiredTypes: ReadonlyArray<ProviderRuntimeEvent["type"]> = [
          "session.started",
          "session.resources.updated",
          "session.state.changed",
          "thread.started",
          "turn.started",
          "item.started",
          "content.delta",
          "item.completed",
          "turn.completed",
          "session.exited",
        ];
        for (const type of requiredTypes) {
          expect(subscription.events.some((event) => event.type === type)).toBe(true);
        }
        expect(
          subscription.events.every((event) => event.sessionIncarnationId === sessionIncarnationId),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rechecks correlated recovery before committing a new strict turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.correlatedPromptLifecycleAdmissionBlockAfterReads = 2;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        const error = yield* adapter
          .sendTurn({ threadId, input: "must not cross pending resync" })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          reason: "busy",
        });
        expect(captures.correlatedPromptLifecycleAdmissionReads).toBeGreaterThanOrEqual(2);
        expect(captures.correlatedPromptSubmissions).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("settles only the delivered correlated owner and uses terminal lifecycle usage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.inputAdmissionBusy = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId, model: "openai/current" },
        });
        const turnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "owned prompt",
            modelSelection: { instanceId, model: "openai/current" },
          })
          .pipe(Effect.forkChild);
        const correlationId = yield* Queue.take(captures.correlatedPromptObserved);
        expect(correlationId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(captures.prompts).toEqual([]);
        expect(captures.correlatedPromptSubmissions).toEqual([
          { text: "owned prompt", correlationId, queueIfBusy: true },
        ]);

        const preDelivery = yield* adapter
          .sendTurn({ threadId, input: "must not steer predecessor" })
          .pipe(Effect.flip);
        expect(preDelivery).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          reason: "busy",
        });
        expect(captures.steers).toEqual([]);

        yield* offer(captures, {
          _tag: "MessageCompleted",
          message: assistantMessage("background contamination"),
          attribution: { scope: "session" },
        });
        yield* offer(captures, {
          _tag: "ToolStarted",
          toolCallId: "background-tool-call",
          toolName: PRIME_AGENT_PLAN_TOOL_NAME,
          attribution: { scope: "session" },
        });
        yield* offer(captures, {
          _tag: "MessageCompleted",
          message: {
            role: "toolResult",
            timestamp: 2,
            toolCallId: "background-tool-call",
            toolName: PRIME_AGENT_PLAN_TOOL_NAME,
            text: "background plan result",
            imageMimeTypes: [],
            isError: false,
            planUpdate: {
              toolCallId: "background-tool-call",
              plan: [{ step: "background plan", status: "pending" }],
            },
          },
          attribution: { scope: "session" },
        });
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "background-interaction",
            method: "confirm",
            title: "Background interaction",
            message: "must not open",
          },
          attribution: { scope: "session" },
        });
        yield* offer(captures, {
          _tag: "PromptLifecycleUpdated",
          lifecycle: lifecycleSnapshot(correlationId, "delivered", 2),
        });
        yield* offer(captures, {
          _tag: "MessageCompleted",
          message: assistantMessage("wrong owner contamination"),
          attribution: {
            scope: "prompt",
            correlationId: "f2663409-0ea8-4168-84df-5513925968c2",
          },
        });
        yield* offer(captures, {
          _tag: "MessageCompleted",
          message: assistantMessage("owned answer"),
          attribution: { scope: "prompt", correlationId },
        });
        yield* offer(captures, {
          _tag: "RunCompleted",
          messages: [assistantMessage("owned answer")],
          attribution: { scope: "prompt", correlationId },
        });
        yield* offer(captures, {
          _tag: "PromptLifecycleUpdated",
          lifecycle: lifecycleSnapshot(correlationId, "completed", 3, { usage }),
        });
        const result = yield* Fiber.join(turnFiber);
        expect(correlationId).not.toBe(result.turnId);
        const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
        const encodedTurnEvents = encodeUnknownJson(turnEvents);
        expect(encodedTurnEvents).not.toContain(correlationId);
        expect(encodedTurnEvents).not.toContain("contamination");
        expect(encodedTurnEvents).not.toContain("background plan");
        expect(encodedTurnEvents).not.toContain("Background interaction");
        expect(encodedTurnEvents).toContain("owned answer");
        expect(captures.extensions).toContainEqual({
          id: "background-interaction",
          response: { cancelled: true },
        });
        expect(turnEvents.findLast((event) => event.type === "turn.completed")).toMatchObject({
          payload: {
            state: "completed",
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
            },
            totalCostUsd: usage.totalCostUsd,
          },
        });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("completes a correlated slash command without model output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "/status" })
          .pipe(Effect.forkChild);
        const correlationId = yield* Queue.take(captures.correlatedPromptObserved);
        yield* offer(captures, {
          _tag: "PromptLifecycleUpdated",
          lifecycle: lifecycleSnapshot(correlationId, "delivered", 2, {
            kind: "session_command",
          }),
        });
        yield* offer(captures, {
          _tag: "PromptLifecycleUpdated",
          lifecycle: lifecycleSnapshot(correlationId, "completed", 3, {
            kind: "session_command",
            usage,
          }),
        });
        const result = yield* Fiber.join(turnFiber);
        const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
        expect(turnEvents.filter((event) => event.type === "runtime.error")).toEqual([]);
        expect(turnEvents.findLast((event) => event.type === "turn.completed")).toMatchObject({
          payload: { state: "completed", totalCostUsd: usage.totalCostUsd },
        });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("reconciles queued, delivered, terminal, and expired correlated snapshots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        const completedFiber = yield* adapter
          .sendTurn({ threadId, input: "recover me" })
          .pipe(Effect.forkChild);
        const completedCorrelationId = yield* Queue.take(captures.correlatedPromptObserved);
        for (const lifecycle of [
          lifecycleSnapshot(completedCorrelationId, "queued", 2),
          lifecycleSnapshot(completedCorrelationId, "delivered", 3),
          lifecycleSnapshot(completedCorrelationId, "completed", 4, { usage }),
        ]) {
          yield* offer(captures, {
            ...initialSnapshot(),
            connectionGeneration: 0,
            replayContinuity: "complete",
            promptLifecycles: { records: [lifecycle], expired: [] },
          });
        }
        const completed = yield* Fiber.join(completedFiber);
        expect(
          subscription.events.findLast(
            (event) => event.turnId === completed.turnId && event.type === "turn.completed",
          ),
        ).toMatchObject({ payload: { state: "completed", totalCostUsd: usage.totalCostUsd } });

        const expiredFiber = yield* adapter
          .sendTurn({ threadId, input: "expired lifecycle" })
          .pipe(Effect.forkChild);
        const expiredCorrelationId = yield* Queue.take(captures.correlatedPromptObserved);
        yield* offer(captures, {
          ...initialSnapshot(),
          connectionGeneration: 0,
          replayContinuity: "complete",
          promptLifecycles: {
            records: [],
            expired: [{ correlationId: expiredCorrelationId, deliveryCrossed: false }],
          },
        });
        const expired = yield* Fiber.join(expiredFiber);
        expect(
          subscription.events.findLast(
            (event) => event.turnId === expired.turnId && event.type === "turn.completed",
          ),
        ).toMatchObject({ payload: { state: "failed" } });
        expect(captures.correlatedPromptSubmissions).toHaveLength(2);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("reconciles a non-reconnect lifecycle snapshot and preserves failed usage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "catch up without reconnect" })
          .pipe(Effect.forkChild);
        const correlationId = yield* Queue.take(captures.correlatedPromptObserved);

        yield* offer(captures, {
          ...initialSnapshot(),
          lastEventSequence: 2,
          replayContinuity: "complete",
          connectionGeneration: 0,
          correlatedProofEpoch: 1,
          promptLifecycles: {
            records: [lifecycleSnapshot(correlationId, "failed", 2, { usage })],
            expired: [],
          },
        });

        const result = yield* Fiber.join(turnFiber);
        expect(captures.correlatedPromptSubmissions).toHaveLength(1);
        expect(
          subscription.events.findLast(
            (event) => event.turnId === result.turnId && event.type === "turn.completed",
          ),
        ).toMatchObject({
          payload: {
            state: "failed",
            errorMessage: "Prime Agent prompt failed.",
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cachedInputTokens: usage.cachedInputTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              totalTokens: usage.totalTokens,
            },
            totalCostUsd: usage.totalCostUsd,
          },
        });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps background snapshot children unscoped from a queued correlation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "queued owner" })
          .pipe(Effect.forkChild);
        const correlationId = yield* Queue.take(captures.correlatedPromptObserved);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");

        yield* offer(captures, {
          ...initialSnapshot(),
          lastEventSequence: 2,
          replayContinuity: "complete",
          connectionGeneration: 0,
          correlatedProofEpoch: 1,
          children: [{ id: "background-child", label: "background", status: "running" }],
          promptLifecycles: {
            records: [lifecycleSnapshot(correlationId, "queued", 2)],
            expired: [],
          },
        });
        const childProgress = yield* awaitObservedType(subscription.observed, "task.progress");
        expect(childProgress).not.toHaveProperty("turnId");
        expect(
          subscription.events.filter(
            (event) =>
              event.turnId === started.turnId &&
              (event.type === "task.progress" || event.type === "task.completed"),
          ),
        ).toEqual([]);

        yield* offer(captures, {
          _tag: "PromptLifecycleUpdated",
          lifecycle: lifecycleSnapshot(correlationId, "failed", 3),
        });
        yield* Fiber.join(turnFiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails an active correlated turn on a private protocol violation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "fail closed" })
          .pipe(Effect.forkChild);
        const correlationId = yield* Queue.take(captures.correlatedPromptObserved);

        yield* offer(captures, { _tag: "CorrelatedProtocolViolation" });
        const result = yield* Fiber.join(turnFiber);
        const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
        expect(turnEvents.findLast((event) => event.type === "runtime.error")).toMatchObject({
          payload: {
            message: "Prime Agent returned invalid correlated prompt lifecycle data.",
            class: "provider_error",
          },
        });
        expect(turnEvents.findLast((event) => event.type === "turn.completed")).toMatchObject({
          payload: { state: "failed" },
        });
        expect(encodeUnknownJson(turnEvents)).not.toContain(correlationId);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves correlated cancellation failures and terminal failed usage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        for (const status of ["expired", "unknown"] as const) {
          captures.correlatedPromptCancellationResult =
            status === "expired"
              ? { status, ownershipCrossed: true, deliveryCrossed: false }
              : { status, ownershipCrossed: "unknown", deliveryCrossed: "unknown" };
          const turnFiber = yield* adapter
            .sendTurn({ threadId, input: `${status} cancellation` })
            .pipe(Effect.forkChild);
          yield* Queue.take(captures.correlatedPromptObserved);
          yield* adapter.interruptTurn(threadId);
          const result = yield* Fiber.join(turnFiber);
          expect(
            subscription.events.findLast(
              (event) => event.turnId === result.turnId && event.type === "turn.completed",
            ),
          ).toMatchObject({
            payload: {
              state: "failed",
              errorMessage: "Prime Agent could not reconcile the cancelled prompt lifecycle.",
            },
          });
        }

        const terminalFiber = yield* adapter
          .sendTurn({ threadId, input: "too late then failed" })
          .pipe(Effect.forkChild);
        const terminalCorrelationId = yield* Queue.take(captures.correlatedPromptObserved);
        const delivered = lifecycleSnapshot(terminalCorrelationId, "delivered", 2);
        yield* offer(captures, { _tag: "PromptLifecycleUpdated", lifecycle: delivered });
        yield* offer(captures, {
          _tag: "SessionInfoChanged",
          name: "delivered",
          attribution: { scope: "prompt", correlationId: terminalCorrelationId },
        });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        captures.correlatedPromptCancellationResult = {
          status: "too_late",
          ownershipCrossed: true,
          deliveryCrossed: true,
          lifecycle: delivered,
        };
        yield* adapter.interruptTurn(threadId);
        yield* offer(captures, {
          _tag: "PromptLifecycleUpdated",
          lifecycle: lifecycleSnapshot(terminalCorrelationId, "failed", 3, { usage }),
        });
        const terminal = yield* Fiber.join(terminalFiber);
        expect(
          subscription.events.findLast(
            (event) => event.turnId === terminal.turnId && event.type === "turn.completed",
          ),
        ).toMatchObject({
          payload: {
            state: "failed",
            errorMessage: "Prime Agent prompt failed.",
            usage: { totalTokens: usage.totalTokens },
            totalCostUsd: usage.totalCostUsd,
          },
        });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects interactions and approvals after too-late cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const interactionFiber = yield* adapter
          .sendTurn({ threadId, input: "cancel before interaction" })
          .pipe(Effect.forkChild);
        const interactionCorrelationId = yield* Queue.take(captures.correlatedPromptObserved);
        const interactionDelivered = lifecycleSnapshot(interactionCorrelationId, "delivered", 2);
        yield* offer(captures, {
          _tag: "PromptLifecycleUpdated",
          lifecycle: interactionDelivered,
        });
        yield* offer(captures, {
          _tag: "SessionInfoChanged",
          name: "interaction delivered",
          attribution: { scope: "prompt", correlationId: interactionCorrelationId },
        });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        captures.correlatedPromptCancellationResult = {
          status: "too_late",
          ownershipCrossed: true,
          deliveryCrossed: true,
          lifecycle: interactionDelivered,
        };
        yield* adapter.interruptTurn(threadId);
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: { id: "late-interaction", method: "confirm", title: "Too late" },
          attribution: { scope: "prompt", correlationId: interactionCorrelationId },
        });
        yield* offer(captures, {
          _tag: "SessionInfoChanged",
          name: "interaction rejected",
          attribution: { scope: "prompt", correlationId: interactionCorrelationId },
        });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        expect(captures.extensions).toContainEqual({
          id: "late-interaction",
          response: { cancelled: true },
        });
        expect(
          subscription.events.filter((event) => event.type === "interaction.requested"),
        ).toEqual([]);
        yield* offer(captures, {
          _tag: "PromptLifecycleUpdated",
          lifecycle: lifecycleSnapshot(interactionCorrelationId, "failed", 3),
        });
        yield* Fiber.join(interactionFiber);

        yield* adapter.stopSession(threadId);
        captures.correlatedPromptCancellationResult = undefined;
        captures.extensions.length = 0;
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const extensionPath = captures.runtimeInputs.at(-1)!.extensions![0]!;
        const extensionSource = yield* Effect.promise(() =>
          NodeFSP.readFile(extensionPath, "utf8"),
        );
        const title = extensionSource.match(/const TITLE = "([^"]+)";/)?.[1];
        if (title === undefined) throw new Error("Managed extension title was not generated.");
        const approvalFiber = yield* adapter
          .sendTurn({ threadId, input: "cancel before approval" })
          .pipe(Effect.forkChild);
        const approvalCorrelationId = yield* Queue.take(captures.correlatedPromptObserved);
        const approvalDelivered = lifecycleSnapshot(approvalCorrelationId, "delivered", 2);
        yield* offer(captures, { _tag: "PromptLifecycleUpdated", lifecycle: approvalDelivered });
        yield* offer(captures, {
          _tag: "SessionInfoChanged",
          name: "approval delivered",
          attribution: { scope: "prompt", correlationId: approvalCorrelationId },
        });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        captures.correlatedPromptCancellationResult = {
          status: "too_late",
          ownershipCrossed: true,
          deliveryCrossed: true,
          lifecycle: approvalDelivered,
        };
        yield* adapter.interruptTurn(threadId);
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "late-approval",
            method: "confirm",
            title,
            message: "pylon-permission-v1\ncommand_execution_approval\nbash\nprintf guarded",
          },
          attribution: { scope: "prompt", correlationId: approvalCorrelationId },
        });
        yield* offer(captures, {
          _tag: "SessionInfoChanged",
          name: "approval rejected",
          attribution: { scope: "prompt", correlationId: approvalCorrelationId },
        });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        expect(captures.extensions).toContainEqual({
          id: "late-approval",
          response: { cancelled: true },
        });
        expect(subscription.events.filter((event) => event.type === "request.opened")).toEqual([]);
        yield* offer(captures, {
          _tag: "PromptLifecycleUpdated",
          lifecycle: lifecycleSnapshot(approvalCorrelationId, "failed", 3),
        });
        yield* Fiber.join(approvalFiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects an extension that settles while waiting for the thread lock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        captures.correlatedPromptCancellationObserved = yield* Queue.unbounded<void>();
        captures.correlatedPromptCancellationRelease =
          yield* Deferred.make<PrimeDaemonPromptLifecycleCancellationResult>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "settle before extension lock" })
          .pipe(Effect.forkChild);
        const correlationId = yield* Queue.take(captures.correlatedPromptObserved);
        yield* offer(captures, {
          _tag: "PromptLifecycleUpdated",
          lifecycle: lifecycleSnapshot(correlationId, "delivered", 2),
        });
        yield* offer(captures, {
          _tag: "SessionInfoChanged",
          name: "race delivered",
          attribution: { scope: "prompt", correlationId },
        });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");

        const interrupt = yield* adapter.interruptTurn(threadId).pipe(Effect.forkChild);
        yield* Queue.take(captures.correlatedPromptCancellationObserved);
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: { id: "settled-race", method: "confirm", title: "Must reject" },
          attribution: { scope: "prompt", correlationId },
        });
        yield* Effect.yieldNow;
        yield* Deferred.succeed(captures.correlatedPromptCancellationRelease, {
          status: "expired",
          ownershipCrossed: true,
          deliveryCrossed: true,
        });
        yield* Fiber.join(interrupt);
        yield* offer(captures, { _tag: "ConnectionStatus", status: "connected" });
        yield* awaitObservedType(subscription.observed, "session.state.changed");
        yield* Fiber.join(turnFiber);

        expect(captures.extensions).toContainEqual({
          id: "settled-race",
          response: { cancelled: true },
        });
        expect(
          subscription.events.filter((event) => event.type === "interaction.requested"),
        ).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails closed on a capable reconnect transcript delta", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "unsafe reconnect" })
          .pipe(Effect.forkChild);
        const correlationId = yield* Queue.take(captures.correlatedPromptObserved);
        const background = assistantMessage("background snapshot output");
        const final = { ...assistantMessage("missing final answer"), timestamp: 2 };

        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, messageCount: 2 },
          messages: [background, final],
          streamingMessage: { ...assistantMessage("partial replay"), timestamp: 3 },
          replayContinuity: "unavailable",
          connectionGeneration: 1,
          promptLifecycles: {
            records: [lifecycleSnapshot(correlationId, "completed", 2, { usage })],
            expired: [],
          },
        });
        const result = yield* Fiber.join(turnFiber);
        const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
        expect(captures.reconnectResolutions).toContainEqual({
          generation: 1,
          reconciled: false,
          terminalResponseObserved: false,
        });
        expect(captures.reconnectResolutions.some((resolution) => resolution.reconciled)).toBe(
          false,
        );
        expect(turnEvents.findLast((event) => event.type === "turn.completed")).toMatchObject({
          payload: { state: "failed" },
        });
        expect(
          turnEvents.findLast((event) => event.type === "turn.completed")?.payload,
        ).not.toHaveProperty("usage");
        expect(
          turnEvents.some(
            (event) =>
              event.type === "runtime.error" &&
              typeof event.payload.detail === "object" &&
              event.payload.detail !== null &&
              "kind" in event.payload.detail &&
              event.payload.detail.kind === "missing-final-response",
          ),
        ).toBe(false);
        expect(encodeUnknownJson(turnEvents)).not.toContain("snapshot output");
        expect(encodeUnknownJson(turnEvents)).not.toContain("missing final answer");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails a worker recovery gate before applying a mixed terminal snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        captures.retryWorkerRecoverySnapshots = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "unsafe worker recovery" })
          .pipe(Effect.forkChild);
        const correlationId = yield* Queue.take(captures.correlatedPromptObserved);
        const background = assistantMessage("mixed background result");
        const final = { ...assistantMessage("unattributed worker final"), timestamp: 2 };

        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, messageCount: 2 },
          messages: [background, final],
          replayContinuity: "complete",
          connectionGeneration: 1,
          promptLifecycles: {
            records: [lifecycleSnapshot(correlationId, "completed", 2, { usage })],
            expired: [],
          },
        });
        const result = yield* Fiber.join(turnFiber);
        const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
        expect(captures.retryWorkerRecoverySnapshotCalls).toEqual([]);
        expect(captures.reconnectResolutions).toContainEqual({
          generation: 1,
          reconciled: false,
          terminalResponseObserved: false,
        });
        expect(turnEvents.findLast((event) => event.type === "turn.completed")).toMatchObject({
          payload: { state: "failed" },
        });
        expect(
          turnEvents.findLast((event) => event.type === "turn.completed")?.payload,
        ).not.toHaveProperty("totalCostUsd");
        expect(encodeUnknownJson(turnEvents)).not.toContain("mixed background result");
        expect(encodeUnknownJson(turnEvents)).not.toContain("unattributed worker final");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("accepts exact complete capable recovery with already observed output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "safe exact recovery" })
          .pipe(Effect.forkChild);
        const correlationId = yield* Queue.take(captures.correlatedPromptObserved);
        yield* offer(captures, {
          _tag: "PromptLifecycleUpdated",
          lifecycle: lifecycleSnapshot(correlationId, "delivered", 2),
        });
        const answer = assistantMessage("already observed answer");
        yield* offer(captures, {
          _tag: "MessageCompleted",
          message: answer,
          attribution: { scope: "prompt", correlationId },
        });
        yield* offer(captures, {
          _tag: "SessionInfoChanged",
          name: "answer observed",
          attribution: { scope: "prompt", correlationId },
        });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");

        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, messageCount: 1 },
          messages: [answer],
          replayContinuity: "complete",
          connectionGeneration: 1,
          promptLifecycles: {
            records: [lifecycleSnapshot(correlationId, "completed", 3, { usage })],
            expired: [],
          },
        });
        yield* offer(captures, { _tag: "ConnectionStatus", status: "connected" });
        yield* awaitObservedType(subscription.observed, "session.state.changed");
        const result = yield* Fiber.join(turnFiber);
        const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
        expect(
          captures.reconnectResolutions.some(
            (resolution) =>
              resolution.generation === 1 &&
              resolution.reconciled &&
              !resolution.terminalResponseObserved,
          ),
        ).toBe(true);
        expect(turnEvents.findLast((event) => event.type === "turn.completed")).toMatchObject({
          payload: {
            state: "completed",
            usage: { totalTokens: usage.totalTokens },
            totalCostUsd: usage.totalCostUsd,
          },
        });
        expect(encodeUnknownJson(turnEvents)).toContain("already observed answer");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not apply a terminal correlated snapshot when proof settlement is rejected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        captures.reconnectSnapshotResolutionAccepted = false;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "retired proof must not settle" })
          .pipe(Effect.forkChild);
        const correlationId = yield* Queue.take(captures.correlatedPromptObserved);
        yield* offer(captures, {
          _tag: "PromptLifecycleUpdated",
          lifecycle: lifecycleSnapshot(correlationId, "delivered", 2),
        });
        const answer = assistantMessage("stale terminal answer");
        yield* offer(captures, {
          _tag: "MessageCompleted",
          message: answer,
          attribution: { scope: "prompt", correlationId },
        });

        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, messageCount: 1 },
          messages: [answer],
          replayContinuity: "complete",
          connectionGeneration: 1,
          correlatedProofEpoch: 1,
          promptLifecycles: {
            records: [lifecycleSnapshot(correlationId, "completed", 3, { usage })],
            expired: [],
          },
        });
        yield* offer(captures, {
          _tag: "SessionClosed",
          error: "Prime Agent correlated prompt capability proof was lost during recovery.",
        });

        const result = yield* Fiber.join(turnFiber);
        expect(captures.reconnectResolutions).toContainEqual({
          generation: 1,
          reconciled: true,
          terminalResponseObserved: false,
        });
        const terminal = subscription.events.findLast(
          (event) => event.turnId === result.turnId && event.type === "turn.completed",
        );
        expect(terminal).toMatchObject({ payload: { state: "failed" } });
        expect(terminal?.payload).not.toHaveProperty("usage");
        expect(terminal?.payload).not.toHaveProperty("totalCostUsd");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps control mismatch busy and scopes pre-delivery cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.correlatedPromptLifecycleAvailable = true;
        captures.inputAdmissionBusy = true;
        captures.correlatedPromptObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId, model: "openai/current" },
        });
        const mismatch = yield* adapter
          .sendTurn({
            threadId,
            input: "wrong controls",
            modelSelection: { instanceId, model: "openai/other" },
          })
          .pipe(Effect.flip);
        expect(mismatch).toMatchObject({ reason: "busy" });
        expect(captures.correlatedPromptSubmissions).toEqual([]);
        expect(captures.models).toEqual([]);

        const turnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "queue then cancel",
            modelSelection: { instanceId, model: "openai/current" },
          })
          .pipe(Effect.forkChild);
        const correlationId = yield* Queue.take(captures.correlatedPromptObserved);
        yield* adapter.interruptTurn(threadId);
        yield* Fiber.join(turnFiber);
        expect(captures.correlatedPromptCancellations).toEqual([correlationId]);
        expect(captures.order).not.toContain("abort-clear");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects unsupported runtime modes at the adapter boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        for (const runtimeMode of ["auto", "auto-accept-edits"] as const) {
          const error = yield* adapter
            .startSession({ threadId, cwd: process.cwd(), runtimeMode })
            .pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "ProviderAdapterValidationError",
            operation: "startSession",
          });
        }
        expect(captures.runtimeInputs).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );
  it.effect("passes the thread-scoped Pylon MCP server into the daemon runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const mcpSession = {
          providerSessionId: "provider-session-prime-test",
          threadId,
          environmentId: EnvironmentId.make("environment-prime-test"),
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:4321/mcp/provider-session-prime-test",
          authorizationHeader: "Bearer scoped-secret",
          expiresAt: 4_000_000_000_000,
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => McpProviderSession.setMcpProviderSession(mcpSession)),
          () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
        );
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });

        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        expect(captures.runtimeInputs).toHaveLength(1);
        expect(captures.runtimeInputs[0]?.mcpServer).toEqual({
          ownerId: `pylon:${mcpSession.providerSessionId}`,
          server: {
            name: "t3-code",
            type: "http",
            url: mcpSession.endpoint,
            headers: { Authorization: mcpSession.authorizationHeader },
          },
        });
        yield* adapter.stopSession(threadId);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails closed when the loaded managed extension source changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const delegate = fakeRuntimeFactory(captures);
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: (input) =>
            delegate(input).pipe(
              Effect.tap(() =>
                Effect.promise(() => NodeFSP.writeFile(input.extensions![0]!, "tampered")),
              ),
            ),
        });
        const error = yield* adapter
          .startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderAdapterProcessError",
          detail:
            "Prime Agent loaded a managed provider extension whose source integrity could not be verified.",
        });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("discovers models without delaying session start and publishes the active result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.modelDiscoveryModels = [
          {
            provider: "openai-codex",
            id: "gpt-5.4",
            name: "GPT-5.4",
            api: "openai-codex-responses",
            reasoning: true,
          },
        ];
        captures.modelDiscoveryObserved = yield* Queue.unbounded<void>();
        captures.modelDiscoveryRelease = yield* Deferred.make<void>();
        const published = yield* Queue.unbounded<ReadonlyArray<PrimeAgentDaemonCatalogModel>>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
          onModelsDiscovered: (models) => Queue.offer(published, models).pipe(Effect.asVoid),
        });

        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* Queue.take(captures.modelDiscoveryObserved);
        expect(Option.isNone(yield* Queue.poll(published))).toBe(true);

        yield* Deferred.succeed(captures.modelDiscoveryRelease, undefined);
        expect(yield* Queue.take(published)).toEqual(captures.modelDiscoveryModels);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes an authoritative empty configured-model catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.modelDiscoveryModels = [];
        const published = yield* Queue.unbounded<ReadonlyArray<PrimeAgentDaemonCatalogModel>>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
          onModelsDiscovered: (models) => Queue.offer(published, models).pipe(Effect.asVoid),
        });

        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        expect(yield* Queue.take(published)).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not hold the thread mutation lock while model publication is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.modelDiscoveryModels = [
          {
            provider: "anthropic",
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            api: "anthropic-messages",
            reasoning: true,
          },
        ];
        const publicationObserved = yield* Deferred.make<void>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
          onModelsDiscovered: () =>
            Deferred.succeed(publicationObserved, undefined).pipe(Effect.andThen(Effect.never)),
        });

        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* Deferred.await(publicationObserved);

        const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
        yield* Fiber.join(stopFiber);
        expect(captures.disposeCount).toBe(1);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("serializes in-flight catalog publications by discovery generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const older = makeCaptures();
        older.modelDiscoveryModels = [
          {
            provider: "anthropic",
            id: "older",
            name: "Older",
            api: "anthropic-messages",
            reasoning: false,
          },
        ];
        older.modelDiscoveryObserved = yield* Queue.unbounded<void>();
        older.modelDiscoveryRelease = yield* Deferred.make<void>();
        const newer = makeCaptures();
        newer.modelDiscoveryModels = [
          {
            provider: "openai-codex",
            id: "newer",
            name: "Newer",
            api: "openai-codex-responses",
            reasoning: true,
          },
        ];
        newer.modelDiscoveryObserved = yield* Queue.unbounded<void>();
        newer.modelDiscoveryRelease = yield* Deferred.make<void>();
        const olderFactory = fakeRuntimeFactory(older);
        const newerFactory = fakeRuntimeFactory(newer);
        let runtimeCount = 0;
        const olderPublicationObserved = yield* Deferred.make<void>();
        const releaseOlderPublication = yield* Deferred.make<void>();
        const published = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: (input) =>
            runtimeCount++ === 0 ? olderFactory(input) : newerFactory(input),
          onModelsDiscovered: (models) =>
            Effect.gen(function* () {
              const id = models[0]!.id;
              if (id === "older") {
                yield* Deferred.succeed(olderPublicationObserved, undefined);
                yield* Deferred.await(releaseOlderPublication);
              }
              yield* Queue.offer(published, id);
            }),
        });
        const newerThreadId = ThreadId.make("prime-daemon/thread-publication-newer");

        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* Queue.take(older.modelDiscoveryObserved);
        yield* Deferred.succeed(older.modelDiscoveryRelease, undefined);
        yield* Deferred.await(olderPublicationObserved);

        yield* adapter.startSession({
          threadId: newerThreadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* Queue.take(newer.modelDiscoveryObserved);
        yield* Deferred.succeed(newer.modelDiscoveryRelease, undefined);
        yield* Effect.yieldNow;
        expect(Option.isNone(yield* Queue.poll(published))).toBe(true);

        yield* Deferred.succeed(releaseOlderPublication, undefined);
        expect(yield* Queue.take(published)).toBe("older");
        expect(yield* Queue.take(published)).toBe("newer");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not let an older live session overwrite a newer model catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const older = makeCaptures();
        older.modelDiscoveryModels = [
          {
            provider: "anthropic",
            id: "older",
            name: "Older",
            api: "anthropic-messages",
            reasoning: false,
          },
        ];
        older.modelDiscoveryObserved = yield* Queue.unbounded<void>();
        older.modelDiscoveryRelease = yield* Deferred.make<void>();
        const newer = makeCaptures();
        newer.modelDiscoveryModels = [
          {
            provider: "openai-codex",
            id: "newer",
            name: "Newer",
            api: "openai-codex-responses",
            reasoning: true,
          },
        ];
        newer.modelDiscoveryObserved = yield* Queue.unbounded<void>();
        newer.modelDiscoveryRelease = yield* Deferred.make<void>();
        const olderFactory = fakeRuntimeFactory(older);
        const newerFactory = fakeRuntimeFactory(newer);
        let runtimeCount = 0;
        const published = yield* Queue.unbounded<ReadonlyArray<PrimeAgentDaemonCatalogModel>>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: (input) =>
            runtimeCount++ === 0 ? olderFactory(input) : newerFactory(input),
          onModelsDiscovered: (models) => Queue.offer(published, models).pipe(Effect.asVoid),
        });
        const newerThreadId = ThreadId.make("prime-daemon/thread-newer");

        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* Queue.take(older.modelDiscoveryObserved);
        yield* adapter.startSession({
          threadId: newerThreadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* Queue.take(newer.modelDiscoveryObserved);

        yield* Deferred.succeed(newer.modelDiscoveryRelease, undefined);
        expect(yield* Queue.take(published)).toEqual(newer.modelDiscoveryModels);
        yield* Deferred.succeed(older.modelDiscoveryRelease, undefined);
        yield* Effect.yieldNow;
        expect(Option.isNone(yield* Queue.poll(published))).toBe(true);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("drops a model catalog that completes after its session stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.modelDiscoveryModels = [
          {
            provider: "anthropic",
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            api: "anthropic-messages",
            reasoning: true,
          },
        ];
        captures.modelDiscoveryObserved = yield* Queue.unbounded<void>();
        captures.modelDiscoveryRelease = yield* Deferred.make<void>();
        const published = yield* Queue.unbounded<ReadonlyArray<PrimeAgentDaemonCatalogModel>>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
          onModelsDiscovered: (models) => Queue.offer(published, models).pipe(Effect.asVoid),
        });

        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* Queue.take(captures.modelDiscoveryObserved);
        yield* adapter.stopSession(threadId);
        yield* Deferred.succeed(captures.modelDiscoveryRelease, undefined);
        yield* Effect.yieldNow;

        expect(Option.isNone(yield* Queue.poll(published))).toBe(true);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes the initial resource inventory once for a started daemon session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);

        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const event = yield* awaitObservedType(subscription.observed, "session.resources.updated");

        expect(event).toMatchObject({
          type: "session.resources.updated",
          provider: "primeAgent",
          providerInstanceId: instanceId,
          threadId,
          payload: { available: true, skills: [], prompts: [], commands: [] },
        });
        expect(event).not.toHaveProperty("turnId");
        expect(event).not.toHaveProperty("providerRefs");
        expect(event).not.toHaveProperty("raw");
        expect(
          subscription.events.filter((candidate) => candidate.type === "session.resources.updated"),
        ).toHaveLength(1);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes the initial goal before buffered daemon goal updates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.startupEvents.push({
          _tag: "GoalUpdated",
          goal: {
            available: true,
            active: false,
            status: "complete",
            objective: "Finish the provider integration",
            tokenBudget: 5_000,
            tokensUsed: 4_000,
            timeUsedSeconds: 120,
            continuationsUsed: 2,
          },
        });
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);

        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const initial = yield* awaitObservedType(subscription.observed, "session.goal.updated");
        const buffered = yield* awaitObservedType(subscription.observed, "session.goal.updated");

        expect(initial.payload).toEqual({
          available: true,
          active: false,
          status: "idle",
          tokensUsed: 0,
          timeUsedSeconds: 0,
          continuationsUsed: 0,
        });
        expect(buffered.payload).toMatchObject({
          available: true,
          status: "complete",
          objective: "Finish the provider integration",
          tokensUsed: 4_000,
        });
        expect(buffered).not.toHaveProperty("providerRefs");
        expect(buffered).not.toHaveProperty("raw");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps supervised goal observation unavailable and ignores native updates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.startupEvents.push(
          {
            _tag: "GoalUpdated",
            goal: {
              available: true,
              active: true,
              status: "active",
              objective: "PRIVATE SUPERVISED GOAL",
              tokensUsed: 99,
              timeUsedSeconds: 10,
              continuationsUsed: 1,
            },
          },
          { _tag: "ConnectionStatus", status: "reconnecting" },
        );
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);

        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const goalEvent = yield* awaitObservedType(subscription.observed, "session.goal.updated");
        yield* awaitObservedType(subscription.observed, "session.state.changed");
        yield* awaitObservedType(subscription.observed, "session.state.changed");

        expect(goalEvent.payload).toEqual({
          available: false,
          active: false,
          status: "idle",
          tokensUsed: 0,
          timeUsedSeconds: 0,
          continuationsUsed: 0,
        });
        const goalEvents = subscription.events.filter(
          (candidate) => candidate.type === "session.goal.updated",
        );
        expect(goalEvents).toHaveLength(1);
        expect(encodeUnknownJson(goalEvents)).not.toContain("PRIVATE SUPERVISED GOAL");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes and updates bounded session agent depth", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.resources.updated");
        const initial = yield* awaitObservedType(
          subscription.observed,
          "session.agent-depth.updated",
        );

        expect(initial).toMatchObject({
          provider: "primeAgent",
          providerInstanceId: instanceId,
          threadId,
          payload: {
            maxDepth: 2,
            source: "session",
            writable: true,
            settable: true,
            maxSettableDepth: 4,
          },
        });
        expect(yield* adapter.getSessionAgentDepth!(threadId)).toEqual(initial.payload);

        const updated = yield* adapter.setSessionAgentDepth!(threadId, 3);
        const event = yield* awaitObservedType(
          subscription.observed,
          "session.agent-depth.updated",
        );
        expect(updated).toEqual({
          maxDepth: 3,
          source: "session",
          writable: true,
          settable: true,
          maxSettableDepth: 4,
        });
        expect(event.payload).toEqual(updated);
        expect(captures.agentDepthCalls).toEqual([3]);

        const error = yield* adapter.setSessionAgentDepth!(threadId, 5).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          operation: "setSessionAgentDepth",
        });
        expect(captures.agentDepthCalls).toEqual([3]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "publishes count-only queue state and clears it without interrupting the active run",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          const initial = yield* awaitObservedType(
            subscription.observed,
            "session.input-queue.updated",
          );
          expect(initial.payload).toEqual({
            steeringCount: 0,
            followUpCount: 0,
            steeringMode: "one-at-a-time",
            followUpMode: "one-at-a-time",
          });

          const running = yield* adapter
            .sendTurn({ threadId, input: "base run" })
            .pipe(Effect.forkChild);
          yield* Queue.take(captures.promptObserved!);
          const queued = yield* adapter.followUp!({ threadId, input: "private follow-up" });
          expect(queued).toEqual({
            steeringCount: 0,
            followUpCount: 1,
            steeringMode: "one-at-a-time",
            followUpMode: "one-at-a-time",
          });
          const queuedEvent = yield* awaitObservedType(
            subscription.observed,
            "session.input-queue.updated",
          );
          expect(queuedEvent.payload).toEqual(queued);
          expect(encodeUnknownJson(queuedEvent)).not.toContain("private follow-up");
          expect(captures.followUps).toEqual([{ text: "private follow-up", imageCount: 0 }]);
          yield* offer(captures, {
            _tag: "QueueChanged",
            queuedCount: 1,
            steeringCount: 0,
            followUpCount: 1,
          });

          const cleared = yield* adapter.clearSessionInputQueue!(threadId);
          expect(cleared).toEqual({
            steeringCount: 0,
            followUpCount: 0,
            steeringMode: "one-at-a-time",
            followUpMode: "one-at-a-time",
          });
          const clearedEvent = yield* awaitObservedType(
            subscription.observed,
            "session.input-queue.updated",
          );
          expect(clearedEvent.payload).toEqual(cleared);
          expect(captures.order).not.toContain("abort-clear");
          yield* offer(captures, {
            _tag: "QueueChanged",
            queuedCount: 0,
            steeringCount: 0,
            followUpCount: 0,
          });
          yield* offer(captures, { _tag: "RunCompleted", messages: [] });
          yield* Fiber.join(running);
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes and reconciles only a sole privacy-safe queue lane item", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.inputQueue = {
          ...captures.inputQueue,
          followUpCount: 1,
        };
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.input-queue.updated");

        const removed = yield* adapter.removeOnlySessionInputQueueItem!({
          threadId,
          queue: "follow-up",
        });
        expect(removed).toMatchObject({ steeringCount: 0, followUpCount: 0 });
        expect(captures.inputQueueMutationCalls).toEqual(["follow-up"]);
        expect(
          (yield* awaitObservedType(subscription.observed, "session.input-queue.updated")).payload,
        ).toEqual(removed);

        captures.inputQueue = { ...captures.inputQueue, steeringCount: 2 };
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 2,
          steeringCount: 2,
          followUpCount: 0,
        });
        yield* awaitObservedType(subscription.observed, "session.input-queue.updated");
        expect(
          yield* adapter.removeOnlySessionInputQueueItem!({ threadId, queue: "steering" }).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "ProviderAdapterValidationError", reason: "invalid-input" });
        expect(captures.inputQueueMutationCalls).toEqual(["follow-up"]);

        captures.inputQueue = { ...captures.inputQueue, steeringCount: 1 };
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 1,
          steeringCount: 1,
          followUpCount: 0,
        });
        yield* awaitObservedType(subscription.observed, "session.input-queue.updated");
        captures.inputQueueMutationStatus = "rejected";
        expect(
          yield* adapter.removeOnlySessionInputQueueItem!({ threadId, queue: "steering" }).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "ProviderAdapterValidationError", reason: "invalid-input" });
        expect(captures.inputQueueMutationCalls).toEqual(["follow-up", "steering"]);
        expect(captures.disposeCount).toBe(0);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("settles an awaiting turn from reconciled zero counts when another lane drains", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.inputQueueMutationDrainOtherLane = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.input-queue.updated");
        const running = yield* adapter
          .sendTurn({ threadId, input: "base run" })
          .pipe(Effect.forkChild);
        yield* Queue.take(captures.promptObserved!);

        captures.inputQueue = {
          ...captures.inputQueue,
          steeringCount: 1,
          followUpCount: 1,
        };
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 2,
          steeringCount: 1,
          followUpCount: 1,
        });
        yield* awaitObservedType(subscription.observed, "session.input-queue.updated");
        yield* offer(captures, { _tag: "RunCompleted", messages: [] });

        expect(
          yield* adapter.removeOnlySessionInputQueueItem!({ threadId, queue: "steering" }),
        ).toMatchObject({ steeringCount: 0, followUpCount: 0 });
        yield* Fiber.join(running);
        expect(captures.inputQueueMutationCalls).toEqual(["steering"]);
        expect(captures.disposeCount).toBe(0);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("reconciles an ambiguous sole-item removal failure without retrying", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.inputQueue = { ...captures.inputQueue, steeringCount: 1 };
        captures.inputQueueMutationFailure = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.input-queue.updated");

        expect(
          yield* adapter.removeOnlySessionInputQueueItem!({ threadId, queue: "steering" }).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "ProviderAdapterRequestError" });
        expect(captures.inputQueueMutationCalls).toEqual(["steering"]);
        expect(captures.disposeCount).toBe(0);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("closes the session when sole-item removal cannot reconcile", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.inputQueue = { ...captures.inputQueue, followUpCount: 1 };
        captures.inputQueueStatusFailure = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.input-queue.updated");

        expect(
          yield* adapter.removeOnlySessionInputQueueItem!({ threadId, queue: "follow-up" }).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "ProviderAdapterRequestError" });
        expect(captures.inputQueueMutationCalls).toEqual(["follow-up"]);
        expect(captures.disposeCount).toBe(1);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("sets and reconciles authoritative session input delivery modes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.input-queue.updated");

        const steering = yield* adapter.setSessionInputQueueMode!({
          threadId,
          queue: "steering",
          mode: "all-at-once",
        });
        expect(steering).toMatchObject({
          steeringMode: "all-at-once",
          followUpMode: "one-at-a-time",
        });
        expect(
          (yield* awaitObservedType(subscription.observed, "session.input-queue.updated")).payload,
        ).toEqual(steering);
        expect(
          yield* adapter.setSessionInputQueueMode!({
            threadId,
            queue: "steering",
            mode: "all-at-once",
          }),
        ).toEqual(steering);
        expect(captures.inputQueueModeCalls).toEqual([{ queue: "steering", mode: "all-at-once" }]);

        captures.inputQueueModeFailureAfterMutation = true;
        const reconciled = yield* adapter.setSessionInputQueueMode!({
          threadId,
          queue: "follow-up",
          mode: "all-at-once",
        });
        expect(reconciled).toMatchObject({
          steeringMode: "all-at-once",
          followUpMode: "all-at-once",
        });
        expect(
          (yield* awaitObservedType(subscription.observed, "session.input-queue.updated")).payload,
        ).toEqual(reconciled);
        expect(captures.inputQueueModeCalls).toEqual([
          { queue: "steering", mode: "all-at-once" },
          { queue: "follow-up", mode: "all-at-once" },
        ]);
        expect(captures.disposeCount).toBe(0);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("projects and controls native context compaction without private result data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.compactObserved = yield* Queue.unbounded<void>();
        captures.compactRelease = yield* Deferred.make<void>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const initial = yield* awaitObservedType(
          subscription.observed,
          "session.compaction.updated",
        );
        expect(initial.payload).toEqual({
          available: true,
          status: "idle",
          abortable: false,
          autoCompactionEnabled: true,
          autoCompactionWritable: true,
          manualCompactionSettable: true,
          autoCompactionScope: "session-and-provider-default",
        });

        const admitted = yield* adapter.compactSession!(threadId);
        expect(admitted).toMatchObject({ status: "starting", manualCompactionSettable: false });
        yield* Queue.take(captures.compactObserved);
        expect(
          (yield* awaitObservedType(subscription.observed, "session.compaction.updated")).payload,
        ).toMatchObject({ status: "starting", manualCompactionSettable: false });
        captures.compactionState = { ...captures.compactionState, isCompacting: true };
        yield* offer(captures, { _tag: "CompactionStarted" });
        const compacting = yield* awaitObservedType(
          subscription.observed,
          "session.compaction.updated",
        );
        expect(compacting.payload).toMatchObject({ status: "compacting" });
        expect(encodeUnknownJson(compacting)).not.toContain("private summary");
        expect(encodeUnknownJson(compacting)).not.toContain("/Users/");

        const abortRequested = yield* adapter.abortSessionCompaction!(threadId);
        expect(abortRequested.status).toBe("abort-requested");
        expect(captures.abortCompactionCalls).toBe(1);
        expect(
          (yield* awaitObservedType(subscription.observed, "session.compaction.updated")).payload,
        ).toMatchObject({ status: "abort-requested" });

        captures.compactionState = { ...captures.compactionState, isCompacting: false };
        yield* offer(captures, {
          _tag: "CompactionCompleted",
          outcome: "aborted",
          willRetry: false,
        });
        expect(
          (yield* awaitObservedType(subscription.observed, "session.compaction.updated")).payload,
        ).toMatchObject({ status: "idle", manualCompactionSettable: false });
        yield* Deferred.succeed(captures.compactRelease, undefined);
        expect(
          (yield* awaitObservedType(subscription.observed, "session.compaction.updated")).payload,
        ).toMatchObject({ status: "idle", manualCompactionSettable: true });

        const configured = yield* adapter.setSessionAutoCompaction!({
          threadId,
          enabled: false,
        });
        expect(configured).toMatchObject({
          autoCompactionEnabled: false,
          autoCompactionScope: "session-and-provider-default",
        });
        expect(captures.autoCompactionCalls).toEqual([false]);
        expect(
          encodeUnknownJson(
            yield* awaitObservedType(subscription.observed, "session.compaction.updated"),
          ),
        ).not.toContain("native-session-secret");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("runs one local refinement from the sanitized method result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.refinementObserved = yield* Queue.unbounded<void>();
        captures.refinementRelease = yield* Deferred.make<void>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const nativeSessionDir = captures.runtimeInputs.at(-1)!.sessionDir;
        const harnessRoot = NodePath.join(
          NodePath.dirname(nativeSessionDir),
          "session-artifacts",
          "native-session-secret",
          "harness",
        );
        expect((yield* Effect.promise(() => NodeFSP.stat(harnessRoot))).mode & 0o777).toBe(0o700);
        const eventStart = subscription.events.length;

        const refinementFiber = yield* adapter.refineSessionHarness!(threadId).pipe(
          Effect.forkChild,
        );
        yield* Queue.take(captures.refinementObserved);
        expect(
          yield* awaitObservedType(subscription.observed, "session.harness-refinement.updated"),
        ).toMatchObject({ payload: { status: "running" } });
        expect(yield* adapter.refineSessionHarness!(threadId).pipe(Effect.flip)).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          reason: "busy",
        });
        expect(captures.refinementCalls).toBe(1);
        expect(
          subscription.events.slice(eventStart).filter((event) => event.type === "item.started"),
        ).toEqual([]);

        // An unsolicited native lifecycle event remains observational and cannot satisfy or
        // identify the pending RPC.
        yield* offer(captures, { _tag: "RefinementCompleted", appliedCount: 2, failedCount: 1 });
        const completed = yield* awaitObservedType(subscription.observed, "item.completed");
        expect(completed.itemId).toBeUndefined();
        expect(yield* adapter.refineSessionHarness!(threadId).pipe(Effect.flip)).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          reason: "busy",
        });
        expect(completed.payload).toEqual({
          itemType: "refinement",
          status: "completed",
          title: "Harness refinement",
          data: { appliedCount: 2, failedCount: 1, outcome: "partial" },
        });
        expect(encodeUnknownJson(completed)).not.toContain("native");
        expect(encodeUnknownJson(completed)).not.toContain("/Users/");

        yield* Deferred.succeed(captures.refinementRelease, undefined);
        expect(yield* Fiber.join(refinementFiber)).toEqual({
          appliedCount: 2,
          failedCount: 1,
          outcome: "partial",
        });
        expect(
          yield* awaitObservedType(subscription.observed, "session.harness-refinement.updated"),
        ).toMatchObject({ payload: { status: "available" } });
        expect(
          (yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(harnessRoot, "harness_state.json")),
          )).mode & 0o777,
        ).toBe(0o600);

        const supervisedThread = ThreadId.make("thread-supervised-refinement");
        yield* adapter.startSession({
          threadId: supervisedThread,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        expect(
          yield* adapter.refineSessionHarness!(supervisedThread).pipe(Effect.flip),
        ).toMatchObject({ _tag: "ProviderAdapterUnsupportedOperationError" });

        const missingThread = ThreadId.make("thread-missing-refinement");
        const unavailable = makeCaptures();
        unavailable.refinementAvailable = false;
        const unavailableAdapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(unavailable),
        });
        yield* unavailableAdapter.startSession({
          threadId: missingThread,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        expect(
          yield* unavailableAdapter.refineSessionHarness!(missingThread).pipe(Effect.flip),
        ).toMatchObject({ _tag: "ProviderAdapterUnsupportedOperationError" });
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("clears a pending refinement when the session stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.refinementObserved = yield* Queue.unbounded<void>();
        captures.refinementRelease = yield* Deferred.make<void>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const refinementFiber = yield* adapter.refineSessionHarness!(threadId).pipe(
          Effect.exit,
          Effect.forkChild,
        );
        yield* Queue.take(captures.refinementObserved);
        yield* adapter.stopSession(threadId);
        expect(yield* Fiber.join(refinementFiber)).toMatchObject({ _tag: "Failure" });
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(captures.disposeCount).toBe(1);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps an ambiguous failed request reserved without inventing lifecycle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.refinementFailure = true;
        captures.refinementObserved = yield* Queue.unbounded<void>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const eventStart = subscription.events.length;
        expect(yield* adapter.refineSessionHarness!(threadId).pipe(Effect.flip)).toMatchObject({
          _tag: "ProviderAdapterRequestError",
        });
        expect(
          yield* awaitObservedType(subscription.observed, "session.harness-refinement.updated"),
        ).toMatchObject({ payload: { status: "running" } });
        expect(
          yield* awaitObservedType(subscription.observed, "session.harness-refinement.updated"),
        ).toMatchObject({ payload: { status: "outcome-unknown" } });
        expect(
          subscription.events.slice(eventStart).filter((event) => event.type === "item.started"),
        ).toEqual([]);
        expect(yield* adapter.refineSessionHarness!(threadId).pipe(Effect.flip)).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          reason: "busy",
        });
        expect(captures.refinementCalls).toBe(1);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes buffered startup compaction after the initial idle snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.startupEvents.push({ _tag: "CompactionStarted" });
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const initial = yield* awaitObservedType(
          subscription.observed,
          "session.compaction.updated",
        );
        const buffered = yield* awaitObservedType(
          subscription.observed,
          "session.compaction.updated",
        );
        expect(initial.payload).toMatchObject({ status: "idle", abortable: false });
        expect(buffered.payload).toMatchObject({ status: "compacting", abortable: true });
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves abort acceptance for automatic compaction until terminal state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.compaction.updated");
        captures.compactionState = { ...captures.compactionState, isCompacting: true };
        yield* offer(captures, { _tag: "CompactionStarted" });
        expect(
          (yield* awaitObservedType(subscription.observed, "session.compaction.updated")).payload,
        ).toMatchObject({ status: "compacting", abortable: true });

        const requested = yield* adapter.abortSessionCompaction!(threadId);
        expect(requested).toMatchObject({ status: "abort-requested", abortable: true });
        expect(
          (yield* awaitObservedType(subscription.observed, "session.compaction.updated")).payload,
        ).toMatchObject({ status: "abort-requested" });
        expect(yield* adapter.getSessionCompaction!(threadId)).toMatchObject({
          status: "abort-requested",
        });

        captures.compactionState = { ...captures.compactionState, isCompacting: false };
        yield* offer(captures, {
          _tag: "CompactionCompleted",
          outcome: "aborted",
          willRetry: false,
        });
        expect(
          (yield* awaitObservedType(subscription.observed, "session.compaction.updated")).payload,
        ).toMatchObject({ status: "idle", abortable: false });
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps a starting compaction abort pending until native terminal state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.compactObserved = yield* Queue.unbounded<void>();
        captures.compactRelease = yield* Deferred.make<void>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.compaction.updated");
        yield* adapter.compactSession!(threadId);
        yield* Queue.take(captures.compactObserved);
        yield* awaitObservedType(subscription.observed, "session.compaction.updated");

        const requested = yield* adapter.abortSessionCompaction!(threadId);
        expect(requested).toMatchObject({ status: "abort-requested" });
        expect(
          (yield* awaitObservedType(subscription.observed, "session.compaction.updated")).payload,
        ).toMatchObject({ status: "abort-requested" });
        captures.compactionState = { ...captures.compactionState, isCompacting: true };
        yield* offer(captures, { _tag: "CompactionStarted" });
        yield* awaitObservedType(subscription.observed, "item.started");
        expect(yield* adapter.getSessionCompaction!(threadId)).toMatchObject({
          status: "abort-requested",
        });

        captures.compactionState = { ...captures.compactionState, isCompacting: false };
        yield* offer(captures, {
          _tag: "CompactionCompleted",
          outcome: "aborted",
          willRetry: false,
        });
        expect(
          (yield* awaitObservedType(subscription.observed, "session.compaction.updated")).payload,
        ).toMatchObject({ status: "idle", manualCompactionSettable: false });
        yield* Deferred.succeed(captures.compactRelease, undefined);
        expect(
          (yield* awaitObservedType(subscription.observed, "session.compaction.updated")).payload,
        ).toMatchObject({ status: "idle", manualCompactionSettable: true });
        const settled = yield* adapter.getSessionCompaction!(threadId);
        expect(settled).toMatchObject({ status: "idle", manualCompactionSettable: true });
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("admits manual compaction only from authoritative idle state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.compactionState = { ...captures.compactionState, isStreaming: true };
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        expect(yield* adapter.compactSession!(threadId).pipe(Effect.flip)).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          reason: "busy",
        });
        expect(captures.compactCalls).toBe(0);

        const supervisedThread = ThreadId.make("thread-supervised-compaction");
        const supervised = makeCaptures();
        const supervisedAdapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(supervised),
        });
        yield* supervisedAdapter.startSession({
          threadId: supervisedThread,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        expect(
          yield* supervisedAdapter.compactSession!(supervisedThread).pipe(Effect.flip),
        ).toMatchObject({ _tag: "ProviderAdapterUnsupportedOperationError" });
        expect(supervised.compactCalls).toBe(0);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rechecks native compaction before changing the provider default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        captures.compactionState = { ...captures.compactionState, isCompacting: true };
        expect(
          yield* adapter.setSessionAutoCompaction!({ threadId, enabled: false }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "ProviderAdapterValidationError", reason: "busy" });
        expect(captures.autoCompactionCalls).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails closed when automatic compaction cannot be reconciled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        captures.compactionStateFailureAfterMutation = true;
        expect(
          yield* adapter.setSessionAutoCompaction!({ threadId, enabled: false }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "ProviderAdapterRequestError" });
        expect(captures.autoCompactionCalls).toEqual([false]);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(captures.disposeCount).toBe(1);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rejects unavailable or reconnecting input delivery mutations before native calls",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const unavailableCaptures = makeCaptures();
          unavailableCaptures.inputQueueModesAvailable = false;
          const unavailableAdapter = yield* makePrimeAgentDaemonAdapter(
            decodeSettings({}),
            manager,
            {
              instanceId,
              runtimeFactory: fakeRuntimeFactory(unavailableCaptures),
            },
          );
          yield* unavailableAdapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          expect(
            yield* unavailableAdapter.setSessionInputQueueMode!({
              threadId,
              queue: "steering",
              mode: "all-at-once",
            }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "ProviderAdapterUnsupportedOperationError" });
          expect(unavailableCaptures.inputQueueModeCalls).toEqual([]);

          const captures = makeCaptures();
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          yield* awaitObservedType(subscription.observed, "thread.started");
          yield* offer(captures, { _tag: "ConnectionStatus", status: "reconnecting" });
          yield* awaitObservedType(subscription.observed, "session.state.changed");
          expect(
            yield* adapter.setSessionInputQueueMode!({
              threadId,
              queue: "steering",
              mode: "all-at-once",
            }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "ProviderAdapterValidationError" });
          expect(captures.inputQueueModeCalls).toEqual([]);
          expect(captures.disposeCount).toBe(0);
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps reconciled failures live but closes timed-out mode mutations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        captures.inputQueueModeFailure = true;
        expect(
          yield* adapter.setSessionInputQueueMode!({
            threadId,
            queue: "steering",
            mode: "all-at-once",
          }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "ProviderAdapterRequestError" });
        expect(captures.disposeCount).toBe(0);
        expect((yield* adapter.listSessions()).length).toBe(1);

        captures.inputQueueModeFailure = false;
        captures.inputQueueModeTimedOut = true;
        expect(
          yield* adapter.setSessionInputQueueMode!({
            threadId,
            queue: "follow-up",
            mode: "all-at-once",
          }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "ProviderAdapterRequestError" });
        expect(captures.disposeCount).toBe(1);
        expect(yield* adapter.listSessions()).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns busy without stopping when recovery blocks a concurrent follow-up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "base run" }).pipe(Effect.forkChild);
        yield* Queue.take(captures.promptObserved!);
        captures.inputRecoveryPending = true;

        const error = yield* adapter.followUp!({ threadId, input: "wait for safe recovery" }).pipe(
          Effect.flip,
        );

        expect(error).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          reason: "busy",
        });
        expect(captures.followUps).toEqual([]);
        expect(captures.disposeCount).toBe(0);
        expect(yield* adapter.listSessions()).toHaveLength(1);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns busy and rearms quiescence for newer native background activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.inputAdmissionBusy = true;
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.backgroundQuiescenceCompleted = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");
        const initialToken = yield* Queue.take(captures.rlmQuiescenceObserved);

        yield* offer(captures, {
          _tag: "ChildUpdated",
          child: { id: "heartbeat-child", label: "heartbeat child", status: "running" },
        });
        const childToken = yield* Queue.take(captures.rlmQuiescenceObserved);
        yield* offer(captures, { _tag: "BashOutput", chunk: "newer background output" });
        const bashOutputToken = yield* Queue.take(captures.rlmQuiescenceObserved);

        expect([initialToken, childToken, bashOutputToken]).toEqual([
          `background:${threadId}:1`,
          `background:${threadId}:2`,
          `background:${threadId}:3`,
        ]);
        expect(captures.rlmQuiescenceSignals.map((signal) => signal.aborted)).toEqual([
          true,
          true,
          false,
        ]);

        const error = yield* adapter
          .sendTurn({ threadId, input: "do not attach this to the heartbeat" })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          reason: "busy",
          issue: "Prime Agent background work is still running. Try again after it finishes.",
        });
        expect(captures.prompts).toEqual([]);
        expect(captures.disposeCount).toBe(0);
        expect((yield* adapter.listSessions())[0]?.activeTurnId).toBeUndefined();
        expect(subscription.events.some((event) => event.type === "turn.started")).toBe(false);

        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        const completedTokens = [
          yield* Queue.take(captures.backgroundQuiescenceCompleted),
          yield* Queue.take(captures.backgroundQuiescenceCompleted),
          yield* Queue.take(captures.backgroundQuiescenceCompleted),
        ];
        expect(new Set(completedTokens)).toEqual(
          new Set([initialToken, childToken, bashOutputToken]),
        );
        yield* adapter
          .sendTurn({ threadId, input: "now the background work is done" })
          .pipe(Effect.forkChild);
        yield* Queue.take(captures.promptObserved!);
        expect(captures.prompts.map((prompt) => prompt.text)).toEqual([
          "now the background work is done",
        ]);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rearms quiescence for active resync compaction, bash, retry, and queue states", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const idle = initialSnapshot();
        const activeSnapshots = [
          { ...idle, state: { ...idle.state, isCompacting: true }, lastEventSequence: 2 },
          { ...idle, state: { ...idle.state, isBashRunning: true }, lastEventSequence: 3 },
          { ...idle, state: { ...idle.state, retryAttempt: 1 }, lastEventSequence: 4 },
          {
            ...idle,
            state: {
              ...idle.state,
              inputQueue: { ...idle.state.inputQueue, followUpCount: 1, activeAction: true },
            },
            lastEventSequence: 5,
          },
        ];
        const observedTokens: string[] = [];
        for (const activeSnapshot of activeSnapshots) {
          yield* offer(captures, activeSnapshot);
          observedTokens.push(yield* Queue.take(captures.rlmQuiescenceObserved));
        }

        expect(observedTokens).toEqual([
          `background:${threadId}:1`,
          `background:${threadId}:2`,
          `background:${threadId}:3`,
          `background:${threadId}:4`,
        ]);
        expect(captures.rlmQuiescenceSignals.map((signal) => signal.aborted)).toEqual([
          true,
          true,
          true,
          false,
        ]);

        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails closed when a rejected follow-up cannot be attributed from queue counts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.input-queue.updated");
        const running = yield* adapter
          .sendTurn({ threadId, input: "base run" })
          .pipe(Effect.forkChild);
        yield* Queue.take(captures.promptObserved!);

        // The native count is ahead of Pylon's projection because another producer queued work.
        captures.inputQueue = { ...captures.inputQueue, steeringCount: 0, followUpCount: 1 };
        captures.followUpFailure = true;
        const error = yield* adapter.followUp!({
          threadId,
          input: "must not be falsely attributed",
        }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderAdapterRequestError",
          method: "session/follow-up",
        });
        expect(captures.disposeCount).toBe(1);
        yield* awaitObservedType(subscription.observed, "session.exited");
        expect(subscription.events).toContainEqual(
          expect.objectContaining({
            type: "session.input-queue.updated",
            payload: {
              steeringCount: 0,
              followUpCount: 0,
            },
          }),
        );
        yield* Fiber.join(running);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "settles completed when an explicit clear removes a follow-up between native runs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          yield* awaitObservedType(subscription.observed, "session.input-queue.updated");

          const running = yield* adapter
            .sendTurn({ threadId, input: "base run" })
            .pipe(Effect.forkChild);
          yield* Queue.take(captures.promptObserved!);
          yield* adapter.followUp!({ threadId, input: "queued next run" });
          yield* awaitObservedType(subscription.observed, "session.input-queue.updated");
          yield* offer(captures, {
            _tag: "QueueChanged",
            queuedCount: 1,
            steeringCount: 0,
            followUpCount: 1,
          });
          const firstRunMessage = assistantMessage("base complete");
          yield* offer(captures, { _tag: "RunCompleted", messages: [firstRunMessage] });
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: { id: "queue-clear-barrier", method: "notify", message: "   " },
          });
          yield* awaitObservedType(subscription.observed, "runtime.warning");

          yield* adapter.clearSessionInputQueue!(threadId);
          yield* awaitObservedType(subscription.observed, "session.input-queue.updated");
          const completed = yield* awaitObservedType(subscription.observed, "turn.completed");
          expect(completed.payload).toMatchObject({ state: "completed" });
          expect(completed.payload).not.toHaveProperty("errorMessage");
          yield* Fiber.join(running);
          expect(captures.order).not.toContain("abort-clear");
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails closed when resync loses an observed queued action before RunStarted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.input-queue.updated");
        const running = yield* adapter
          .sendTurn({ threadId, input: "base run" })
          .pipe(Effect.forkChild);
        yield* Queue.take(captures.promptObserved!);
        yield* adapter.followUp!({ threadId, input: "queued next run" });
        yield* awaitObservedType(subscription.observed, "session.input-queue.updated");
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 1,
          steeringCount: 0,
          followUpCount: 1,
        });
        yield* offer(captures, {
          _tag: "RunCompleted",
          messages: [assistantMessage("base complete")],
        });
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 0,
          steeringCount: 0,
          followUpCount: 0,
          active: { kind: "turn", phase: "preparing" },
        });
        const resynced = initialSnapshot();
        yield* offer(captures, {
          ...resynced,
          lastEventSequence: 2,
        });

        const completed = yield* awaitObservedType(subscription.observed, "turn.completed");
        expect(completed.payload).toMatchObject({
          state: "failed",
          errorMessage: "Prime Agent queued input ended before a native run started.",
        });
        yield* Fiber.join(running);
        yield* awaitObservedType(subscription.observed, "session.exited");
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps the authoritative agent depth unchanged when the daemon write fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.agentDepthFailure = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.resources.updated");
        yield* awaitObservedType(subscription.observed, "session.agent-depth.updated");
        const eventCount = subscription.events.length;

        const error = yield* adapter.setSessionAgentDepth!(threadId, 3).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderAdapterRequestError",
          method: "session/set-agent-depth",
        });
        expect(yield* adapter.getSessionAgentDepth!(threadId)).toMatchObject({ maxDepth: 2 });
        expect(subscription.events).toHaveLength(eventCount);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("reconciles an ambiguously committed daemon depth write", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.agentDepthFailureAfterMutation = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.resources.updated");
        yield* awaitObservedType(subscription.observed, "session.agent-depth.updated");

        const error = yield* adapter.setSessionAgentDepth!(threadId, 3).pipe(Effect.flip);
        const reconciled = yield* awaitObservedType(
          subscription.observed,
          "session.agent-depth.updated",
        );
        expect(error).toMatchObject({
          _tag: "ProviderAdapterRequestError",
          method: "session/set-agent-depth",
        });
        expect(reconciled).toMatchObject({ payload: { maxDepth: 3 } });
        expect(yield* adapter.getSessionAgentDepth!(threadId)).toMatchObject({ maxDepth: 3 });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("closes a session when an ambiguous depth write cannot be reconciled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.agentDepthFailure = true;
        captures.agentDepthReadFailure = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        const error = yield* adapter.setSessionAgentDepth!(threadId, 3).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "ProviderAdapterRequestError" });
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(captures.disposeCount).toBe(1);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("refreshes authoritative native depth on explicit reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.resources.updated");
        yield* awaitObservedType(subscription.observed, "session.agent-depth.updated");
        captures.agentDepth = { ...captures.agentDepth, maxDepth: 4 };

        const refreshed = yield* adapter.getSessionAgentDepth!(threadId);
        const event = yield* awaitObservedType(
          subscription.observed,
          "session.agent-depth.updated",
        );
        expect(refreshed.maxDepth).toBe(4);
        expect(event).toMatchObject({ payload: { maxDepth: 4 } });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("finishes an admitted depth write before honoring interruption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.agentDepthObserved = yield* Queue.unbounded<void>();
        captures.agentDepthRelease = yield* Deferred.make<void>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.resources.updated");
        yield* awaitObservedType(subscription.observed, "session.agent-depth.updated");

        const updateFiber = yield* adapter.setSessionAgentDepth!(threadId, 3).pipe(
          Effect.forkChild,
        );
        yield* Queue.take(captures.agentDepthObserved);
        const interruptFiber = yield* Fiber.interrupt(updateFiber).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(captures.agentDepth.maxDepth).toBe(2);
        yield* Deferred.succeed(captures.agentDepthRelease, undefined);
        yield* Fiber.join(interruptFiber);

        const event = yield* awaitObservedType(
          subscription.observed,
          "session.agent-depth.updated",
        );
        expect(event).toMatchObject({ payload: { maxDepth: 3 } });
        expect(yield* adapter.getSessionAgentDepth!(threadId)).toMatchObject({ maxDepth: 3 });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "cancels only a known active session agent and projects the native terminal update",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          captures.agentRoster = [
            {
              id: "child-live",
              parentId: "parent-safe",
              label: "reviewer",
              status: "running",
              activeSessionId: "native-active-secret",
            },
          ];
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          const started = yield* awaitObservedType(subscription.observed, "task.progress");
          expect(started.payload).toMatchObject({
            taskId: "child-live",
            taskType: "subagent",
            status: "running",
          });
          expect(started.payload).not.toHaveProperty("activeSessionId");

          const accepted = yield* adapter.cancelSessionAgent!(
            threadId,
            RuntimeTaskId.make("child-live"),
          );
          expect(accepted).toEqual({ agentId: "child-live", disposition: "cancel-requested" });
          expect(captures.cancelAgentCalls).toEqual(["child-live"]);

          const duplicatePending = yield* adapter.cancelSessionAgent!(
            threadId,
            RuntimeTaskId.make("child-live"),
          );
          expect(duplicatePending).toEqual({
            agentId: "child-live",
            disposition: "cancel-requested",
          });
          expect(captures.cancelAgentCalls).toEqual(["child-live"]);

          yield* Queue.offer(captures.queue!, {
            _tag: "ChildUpdated",
            child: { id: "child-live", label: "reviewer", status: "cancelled" },
          });
          const completed = yield* awaitObservedType(subscription.observed, "task.completed");
          expect(completed.payload).toMatchObject({ taskId: "child-live", status: "stopped" });

          yield* Queue.offer(captures.queue!, {
            _tag: "ChildUpdated",
            child: { id: "child-live", label: "reviewer", status: "cancelled" },
          });
          yield* Queue.offer(captures.queue!, {
            _tag: "ChildUpdated",
            child: { id: "child-live", label: "reviewer", status: "running" },
          });
          yield* Queue.offer(captures.queue!, {
            _tag: "SessionInfoChanged",
            name: "terminal-barrier",
          });
          yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
          expect(
            subscription.events.filter(
              (event) => event.type === "task.completed" && event.payload.taskId === "child-live",
            ),
          ).toHaveLength(1);

          const settled = yield* adapter.cancelSessionAgent!(
            threadId,
            RuntimeTaskId.make("child-live"),
          );
          expect(settled.disposition).toBe("already-settled");
          expect(captures.cancelAgentCalls).toEqual(["child-live"]);

          const unknown = yield* adapter.cancelSessionAgent!(
            threadId,
            RuntimeTaskId.make("other-thread-child"),
          ).pipe(Effect.flip);
          expect(unknown).toMatchObject({ _tag: "ProviderAdapterValidationError" });
          expect(captures.cancelAgentCalls).toEqual(["child-live"]);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("reconciles a false or failed agent cancellation without retrying", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.agentRoster = [{ id: "child-race", label: "worker", status: "running" }];
        captures.cancelAgentResult = false;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "task.progress");
        captures.agentRoster = [{ id: "child-race", label: "worker", status: "done" }];

        const result = yield* adapter.cancelSessionAgent!(
          threadId,
          RuntimeTaskId.make("child-race"),
        );
        expect(result).toEqual({ agentId: "child-race", disposition: "already-settled" });
        expect(captures.cancelAgentCalls).toEqual(["child-race"]);
        const completed = yield* awaitObservedType(subscription.observed, "task.completed");
        expect(completed.payload).toMatchObject({ taskId: "child-race", status: "completed" });

        captures.agentRoster = [{ id: "child-again", label: "worker", status: "running" }];
        yield* Queue.offer(captures.queue!, {
          _tag: "ChildUpdated",
          child: captures.agentRoster[0]!,
        });
        yield* awaitObservedType(subscription.observed, "task.progress");
        captures.cancelAgentFailure = true;
        const failure = yield* adapter.cancelSessionAgent!(
          threadId,
          RuntimeTaskId.make("child-again"),
        ).pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "ProviderAdapterRequestError" });
        expect(captures.cancelAgentCalls).toEqual(["child-race", "child-again"]);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("closes when an agent cancellation cannot be reconciled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.agentRoster = [{ id: "child-uncertain", label: "worker", status: "running" }];
        captures.cancelAgentResult = false;
        captures.agentRosterFailure = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "task.progress");

        const failure = yield* adapter.cancelSessionAgent!(
          threadId,
          RuntimeTaskId.make("child-uncertain"),
        ).pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "ProviderAdapterRequestError" });
        expect(captures.cancelAgentCalls).toEqual(["child-uncertain"]);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("messages a nested live descendant through the authoritative native endpoint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.agentMessageDisposition = "queued";
        captures.agentRoster = [
          {
            id: "nested-child",
            parentId: "intermediate-child",
            activeSessionId: "stale-native-endpoint",
            label: "nested worker",
            status: "queued",
          },
        ];
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        captures.agentRoster = [
          {
            id: "nested-child",
            parentId: "intermediate-child",
            activeSessionId: "authoritative-native-endpoint",
            label: "nested worker",
            status: "running",
          },
        ];

        const result = yield* adapter.messageSessionAgent!(
          threadId,
          RuntimeTaskId.make("nested-child"),
          "  review the final diff  ",
        );

        expect(result).toEqual({ agentId: "nested-child", disposition: "queued" });
        expect(captures.agentRosterReads).toBe(1);
        expect(captures.agentMessageCalls).toEqual([
          {
            activeSessionId: "authoritative-native-endpoint",
            message: "review the final diff",
          },
        ]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("resolves canonical task ids privately and isolates watcher revisions per client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.activityWatchAvailable = true;
        captures.agentRoster = [
          {
            id: "canonical-child",
            activeSessionId: "private-native-active-session",
            label: "worker",
            status: "running",
          },
        ];
        captures.activityWatchEntries = [
          [
            { speaker: "assistant", text: "safe live activity" },
            { kind: "tool", activityId: 1, label: "Code", status: "started" },
          ],
        ];
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        const first = Array.from(
          yield* Stream.runCollect(
            adapter.watchSessionAgentActivity!(threadId, RuntimeTaskId.make("canonical-child")),
          ),
        );
        const second = Array.from(
          yield* Stream.runCollect(
            adapter.watchSessionAgentActivity!(threadId, RuntimeTaskId.make("canonical-child")),
          ),
        );

        expect(first).toEqual([
          {
            agentId: "canonical-child",
            revision: 1,
            entries: [{ speaker: "assistant", text: "safe live activity" }],
            activity: [
              { speaker: "assistant", text: "safe live activity" },
              { kind: "tool", activityId: 1, label: "Code", status: "started" },
            ],
          },
        ]);
        expect(second[0]?.revision).toBe(1);
        expect(captures.activityWatchCalls).toEqual([
          "private-native-active-session",
          "private-native-active-session",
        ]);
        expect(encodeUnknownJson(first)).not.toContain("private-native-active-session");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("shares one native watcher until the last same-child subscriber exits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.activityWatchAvailable = true;
        captures.activityWatchObserved = yield* Queue.unbounded<void>();
        const updates =
          yield* Queue.unbounded<ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>>();
        captures.activityWatchUpdates = updates;
        captures.agentRoster = [
          {
            id: "canonical-child",
            activeSessionId: "private-native-active-session",
            label: "worker",
            status: "running",
          },
        ];
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        const first = yield* adapter.watchSessionAgentActivity!(
          threadId,
          RuntimeTaskId.make("canonical-child"),
        ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
        const secondObserved = yield* Queue.unbounded<void>();
        const second = yield* adapter.watchSessionAgentActivity!(
          threadId,
          RuntimeTaskId.make("canonical-child"),
        ).pipe(
          Stream.tap(() => Queue.offer(secondObserved, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Queue.take(captures.activityWatchObserved);
        yield* Effect.yieldNow;

        yield* Queue.offer(updates, [{ speaker: "assistant", text: "first replacement" }]);
        yield* Queue.take(secondObserved);
        expect(Array.from(yield* Fiber.join(first))).toEqual([
          {
            agentId: "canonical-child",
            revision: 1,
            entries: [{ speaker: "assistant", text: "first replacement" }],
          },
        ]);
        expect(captures.activityWatchCalls).toEqual(["private-native-active-session"]);
        expect(captures.activityWatchFinalizations).toEqual([]);

        yield* Queue.offer(updates, [{ speaker: "assistant", text: "later replacement" }]);
        expect(Array.from(yield* Fiber.join(second))).toEqual([
          {
            agentId: "canonical-child",
            revision: 1,
            entries: [{ speaker: "assistant", text: "first replacement" }],
          },
          {
            agentId: "canonical-child",
            revision: 2,
            entries: [{ speaker: "assistant", text: "later replacement" }],
          },
        ]);
        expect(captures.activityWatchFinalizations).toEqual(["private-native-active-session"]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps shared native activity streams isolated by canonical child and endpoint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.activityWatchAvailable = true;
        const firstUpdates =
          yield* Queue.unbounded<ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>>();
        const secondUpdates =
          yield* Queue.unbounded<ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>>();
        captures.activityWatchUpdatesByEndpoint.set("native-first", firstUpdates);
        captures.activityWatchUpdatesByEndpoint.set("native-second", secondUpdates);
        captures.agentRoster = [
          { id: "first-child", activeSessionId: "native-first", label: "first", status: "running" },
          {
            id: "second-child",
            activeSessionId: "native-second",
            label: "second",
            status: "running",
          },
        ];
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        const first = yield* adapter.watchSessionAgentActivity!(
          threadId,
          RuntimeTaskId.make("first-child"),
        ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
        const second = yield* adapter.watchSessionAgentActivity!(
          threadId,
          RuntimeTaskId.make("second-child"),
        ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* Queue.offer(firstUpdates, [{ speaker: "assistant", text: "first only" }]);
        yield* Queue.offer(secondUpdates, [{ speaker: "assistant", text: "second only" }]);

        expect(Array.from(yield* Fiber.join(first))[0]?.entries).toEqual([
          { speaker: "assistant", text: "first only" },
        ]);
        expect(Array.from(yield* Fiber.join(second))[0]?.entries).toEqual([
          { speaker: "assistant", text: "second only" },
        ]);
        expect(captures.activityWatchCalls.sort()).toEqual(["native-first", "native-second"]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails the old shared stream and replaces it when a child endpoint changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.activityWatchAvailable = true;
        captures.activityWatchObserved = yield* Queue.unbounded<void>();
        const oldUpdates =
          yield* Queue.unbounded<ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>>();
        const newUpdates =
          yield* Queue.unbounded<ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>>();
        captures.activityWatchUpdatesByEndpoint.set("native-old", oldUpdates);
        captures.activityWatchUpdatesByEndpoint.set("native-new", newUpdates);
        captures.agentRoster = [
          {
            id: "canonical-child",
            activeSessionId: "native-old",
            label: "worker",
            status: "running",
          },
        ];
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        const oldWatcher = yield* adapter.watchSessionAgentActivity!(
          threadId,
          RuntimeTaskId.make("canonical-child"),
        ).pipe(Stream.runDrain, Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Queue.take(captures.activityWatchObserved);
        captures.agentRoster = [
          {
            id: "canonical-child",
            activeSessionId: "native-new",
            label: "worker",
            status: "running",
          },
        ];
        const replacement = yield* adapter.watchSessionAgentActivity!(
          threadId,
          RuntimeTaskId.make("canonical-child"),
        ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(yield* Fiber.join(oldWatcher)).toMatchObject({
          _tag: "ProviderAdapterRequestError",
          method: "session/watch-agent-activity",
        });
        expect(captures.activityWatchFinalizations).toEqual(["native-old"]);

        yield* Queue.offer(newUpdates, [{ speaker: "assistant", text: "new endpoint" }]);
        expect(Array.from(yield* Fiber.join(replacement))[0]?.entries).toEqual([
          { speaker: "assistant", text: "new endpoint" },
        ]);
        expect(captures.activityWatchCalls).toEqual(["native-old", "native-new"]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("caps concurrent per-session watchers and releases reservations on cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.activityWatchAvailable = true;
        captures.activityWatchNever = true;
        captures.activityWatchObserved = yield* Queue.unbounded<void>();
        captures.agentRoster = [
          {
            id: "canonical-child",
            activeSessionId: "private-native-active-session",
            label: "worker",
            status: "running",
          },
        ];
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        const fibers: Array<Fiber.Fiber<void, ProviderAdapterError>> = [];
        for (let index = 0; index < 4; index += 1) {
          fibers.push(
            yield* adapter.watchSessionAgentActivity!(
              threadId,
              RuntimeTaskId.make("canonical-child"),
            ).pipe(Stream.runDrain, Effect.forkChild),
          );
        }
        yield* Queue.take(captures.activityWatchObserved);
        const excess = yield* adapter.watchSessionAgentActivity!(
          threadId,
          RuntimeTaskId.make("canonical-child"),
        ).pipe(Stream.runDrain, Effect.flip);
        expect(excess).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          reason: "busy",
        });

        yield* Fiber.interrupt(fibers.shift()!);
        const replacement = yield* adapter.watchSessionAgentActivity!(
          threadId,
          RuntimeTaskId.make("canonical-child"),
        ).pipe(Stream.runDrain, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(replacement);
        yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("terminates a watcher when its child settles and rejects supervised sessions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.activityWatchAvailable = true;
        captures.activityWatchNever = true;
        captures.activityWatchObserved = yield* Queue.unbounded<void>();
        captures.agentRoster = [
          {
            id: "canonical-child",
            activeSessionId: "private-native-active-session",
            label: "worker",
            status: "running",
          },
        ];
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const watcher = yield* adapter.watchSessionAgentActivity!(
          threadId,
          RuntimeTaskId.make("canonical-child"),
        ).pipe(Stream.runDrain, Effect.forkChild);
        yield* Queue.take(captures.activityWatchObserved);
        yield* Queue.offer(captures.queue!, {
          _tag: "ChildUpdated",
          child: { id: "canonical-child", label: "worker", status: "done" },
        });
        yield* Fiber.join(watcher);

        const supervisedThread = ThreadId.make("prime-daemon/supervised-live-activity");
        const supervised = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(makeCaptures()),
        });
        yield* supervised.startSession({
          threadId: supervisedThread,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const failure = yield* supervised.watchSessionAgentActivity!(
          supervisedThread,
          RuntimeTaskId.make("canonical-child"),
        ).pipe(Stream.runDrain, Effect.flip);
        expect(failure).toMatchObject({
          _tag: "ProviderAdapterUnsupportedOperationError",
          operation: "watchSessionAgentActivity",
        });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects unsupported and invalid agent-message preflight without sending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const supervisedCaptures = makeCaptures();
        const supervisedAdapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(supervisedCaptures),
        });
        const supervisedThread = ThreadId.make("prime-daemon/supervised-message");
        yield* supervisedAdapter.startSession({
          threadId: supervisedThread,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        expect(
          yield* supervisedAdapter.messageSessionAgent!(
            supervisedThread,
            RuntimeTaskId.make("supervised-child"),
            "hello",
          ).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "ProviderAdapterUnsupportedOperationError",
          operation: "messageSessionAgent",
        });
        expect(supervisedCaptures.agentRosterReads).toBe(0);
        expect(supervisedCaptures.agentMessageCalls).toEqual([]);

        const unsupportedCaptures = makeCaptures();
        unsupportedCaptures.agentMessageAvailable = false;
        unsupportedCaptures.agentRoster = [
          {
            id: "child-live",
            activeSessionId: "native-live",
            label: "worker",
            status: "running",
          },
        ];
        const unsupportedAdapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(unsupportedCaptures),
        });
        const unsupportedThread = ThreadId.make("prime-daemon/unsupported-message");
        yield* unsupportedAdapter.startSession({
          threadId: unsupportedThread,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        expect(
          yield* unsupportedAdapter.messageSessionAgent!(
            unsupportedThread,
            RuntimeTaskId.make("child-live"),
            "hello",
          ).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "ProviderAdapterUnsupportedOperationError",
          operation: "messageSessionAgent",
        });
        expect(unsupportedCaptures.agentRosterReads).toBe(0);
        expect(unsupportedCaptures.agentMessageCalls).toEqual([]);

        const rosterFailureCaptures = makeCaptures();
        rosterFailureCaptures.agentRoster = [
          {
            id: "child-roster-failure",
            activeSessionId: "native-roster-failure",
            label: "worker",
            status: "running",
          },
        ];
        const rosterFailureAdapter = yield* makePrimeAgentDaemonAdapter(
          decodeSettings({}),
          manager,
          {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(rosterFailureCaptures),
          },
        );
        const rosterFailureThread = ThreadId.make("prime-daemon/message-roster-failure");
        yield* rosterFailureAdapter.startSession({
          threadId: rosterFailureThread,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        rosterFailureCaptures.agentRosterFailure = true;
        expect(
          yield* rosterFailureAdapter.messageSessionAgent!(
            rosterFailureThread,
            RuntimeTaskId.make("child-roster-failure"),
            "hello",
          ).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "ProviderAdapterRequestError",
          method: "session/get-agent-roster",
        });
        expect(rosterFailureCaptures.agentRosterReads).toBe(1);
        expect(rosterFailureCaptures.agentMessageCalls).toEqual([]);

        const captures = makeCaptures();
        captures.agentRoster = [
          { id: "child-settled", label: "done", status: "done" },
          { id: "child-no-endpoint", label: "starting", status: "queued" },
          {
            id: "child-cancelling",
            activeSessionId: "native-cancelling",
            label: "stopping",
            status: "running",
          },
        ];
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const preflightThread = ThreadId.make("prime-daemon/message-preflight");
        yield* adapter.startSession({
          threadId: preflightThread,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        for (const agentId of ["unknown-child", "child-settled"] as const) {
          expect(
            yield* adapter.messageSessionAgent!(
              preflightThread,
              RuntimeTaskId.make(agentId),
              "hello",
            ).pipe(Effect.flip),
          ).toMatchObject({ _tag: "ProviderAdapterValidationError" });
        }
        for (const message of ["   ", "x".repeat(PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS + 1)]) {
          expect(
            yield* adapter.messageSessionAgent!(
              preflightThread,
              RuntimeTaskId.make("child-settled"),
              message,
            ).pipe(Effect.flip),
          ).toMatchObject({
            _tag: "ProviderAdapterRequestError",
            method: "session/message-agent-invalid-message",
          });
        }
        const notReady = yield* adapter.messageSessionAgent!(
          preflightThread,
          RuntimeTaskId.make("child-no-endpoint"),
          "hello",
        ).pipe(Effect.flip);
        expect(notReady).toMatchObject({
          _tag: "ProviderAdapterRequestError",
          method: "session/message-agent-not-ready",
        });

        yield* adapter.cancelSessionAgent!(preflightThread, RuntimeTaskId.make("child-cancelling"));
        expect(
          yield* adapter.messageSessionAgent!(
            preflightThread,
            RuntimeTaskId.make("child-cancelling"),
            "hello",
          ).pipe(Effect.flip),
        ).toMatchObject({ _tag: "ProviderAdapterValidationError" });
        expect(captures.agentMessageCalls).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("maps uncertain delivery generically, reconciles once, and keeps the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const reason of ["request-failed", "request-timed-out", "invalid-response"] as const) {
          const captures = makeCaptures();
          const agentId = `child-${reason}`;
          const privateEndpoint = `private-endpoint-${reason}`;
          const privateMessage = `private-message-${reason}`;
          captures.agentRoster = [
            {
              id: agentId,
              activeSessionId: privateEndpoint,
              label: "worker",
              status: "running",
            },
          ];
          captures.agentMessageFailureReason = reason;
          captures.agentMessageRosterAfterInvocation = [
            { id: agentId, label: "worker", status: "done" },
          ];
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const failureThread = ThreadId.make(`prime-daemon/message-${reason}`);
          yield* adapter.startSession({
            threadId: failureThread,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          const error = yield* adapter.messageSessionAgent!(
            failureThread,
            RuntimeTaskId.make(agentId),
            privateMessage,
          ).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "ProviderAdapterRequestError",
            method: "session/message-agent-delivery-unknown",
            detail: "Prime Agent message delivery could not be confirmed.",
          });
          expect(encodeUnknownJson(error)).not.toContain(privateEndpoint);
          expect(encodeUnknownJson(error)).not.toContain(privateMessage);
          expect(error.message).not.toContain(privateMessage);
          expect(captures.agentMessageCalls).toEqual([
            { activeSessionId: privateEndpoint, message: privateMessage },
          ]);
          expect(captures.agentRosterReads).toBe(2);
          expect(yield* adapter.hasSession(failureThread)).toBe(true);

          const settled = yield* adapter.messageSessionAgent!(
            failureThread,
            RuntimeTaskId.make(agentId),
            "do not retry",
          ).pipe(Effect.flip);
          expect(settled).toMatchObject({ _tag: "ProviderAdapterValidationError" });
          expect(captures.agentMessageCalls).toHaveLength(1);
        }
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("finishes an admitted agent message before honoring interruption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.agentRoster = [
          {
            id: "child-locked",
            activeSessionId: "native-locked",
            label: "worker",
            status: "running",
          },
        ];
        captures.agentMessageObserved = yield* Queue.unbounded<void>();
        captures.agentMessageRelease = yield* Deferred.make<void>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const lockedThread = ThreadId.make("prime-daemon/message-uninterruptible");
        yield* adapter.startSession({
          threadId: lockedThread,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const deliveryFiber = yield* adapter.messageSessionAgent!(
          lockedThread,
          RuntimeTaskId.make("child-locked"),
          "hello",
        ).pipe(Effect.forkChild);
        yield* Queue.take(captures.agentMessageObserved);
        const interruptFiber = yield* Fiber.interrupt(deliveryFiber).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(captures.order).not.toContain("agent-message-completed");
        yield* Deferred.succeed(captures.agentMessageRelease, undefined);
        yield* Fiber.join(interruptFiber);

        expect(captures.order).toContain("agent-message-completed");
        expect(captures.agentMessageCalls).toEqual([
          { activeSessionId: "native-locked", message: "hello" },
        ]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not persist private child prose or duplicate preview-only progress", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.resources.updated");
        yield* awaitObservedType(subscription.observed, "session.agent-depth.updated");

        yield* offer(captures, {
          _tag: "ChildUpdated",
          child: {
            id: "child-private-progress",
            parentId: "parent",
            activeSessionId: "native-initial",
            sessionName: "private-session-initial",
            model: "child-model",
            label: "private-safe-label",
            status: "running",
            durationMs: 1,
            tokenCount: 10,
            toolUseCount: 1,
            activity: { kind: "executing", toolName: "bash" },
            answerPreview: "private-answer-0",
            recap: "private-recap-0",
          },
        });
        yield* awaitObservedType(subscription.observed, "task.progress");
        yield* awaitObservedType(subscription.observed, "session.agent-depth.updated");
        const durableStart = subscription.events.length;

        for (let index = 1; index <= 100; index += 1) {
          yield* offer(captures, {
            _tag: "ChildUpdated",
            child: {
              id: "child-private-progress",
              parentId: "parent",
              activeSessionId: `native-private-${index}`,
              sessionName: `private-session-${index}`,
              model: "child-model",
              label: "private-safe-label",
              status: "running",
              durationMs: index * 10,
              tokenCount: 10,
              toolUseCount: 1,
              activity: { kind: "executing", toolName: "bash" },
              answerPreview: `private-answer-${index}`,
              recap: `private-recap-${index}`,
              error: `private-transient-error-${index}`,
            },
          });
        }
        captures.agentRoster = [
          {
            id: "child-private-progress",
            parentId: "parent",
            activeSessionId: "native-private-roster",
            sessionName: "private-session-roster",
            model: "child-model",
            label: "private-safe-label",
            status: "running",
            durationMs: 1_200,
            tokenCount: 10,
            toolUseCount: 1,
            activity: { kind: "executing", toolName: "bash" },
            answerPreview: "private-answer-roster",
            recap: "private-recap-roster",
          },
        ];
        expect(
          yield* adapter.messageSessionAgent!(
            threadId,
            RuntimeTaskId.make("child-private-progress"),
            "continue",
          ),
        ).toEqual({ agentId: "child-private-progress", disposition: "delivered" });
        expect(captures.agentMessageCalls.at(-1)?.activeSessionId).toBe("native-private-roster");

        yield* offer(captures, {
          _tag: "ChildUpdated",
          child: {
            id: "child-private-progress",
            parentId: "parent",
            model: "child-model",
            label: "private-safe-label",
            status: "error",
            durationMs: 1_500,
            tokenCount: 12,
            toolUseCount: 1,
            answerPreview: "private-terminal-answer",
            recap: "private-terminal-recap",
            error: "private-terminal-error",
          },
        });
        yield* offer(captures, {
          _tag: "GoalUpdated",
          goal: {
            available: true,
            active: false,
            status: "complete",
            objective: "durable child marker",
            tokensUsed: 1,
            timeUsedSeconds: 1,
            continuationsUsed: 0,
          },
        });
        yield* awaitObservedType(subscription.observed, "session.goal.updated");

        const durableEvents = subscription.events.slice(durableStart);
        expect(durableEvents.filter((event) => event.type === "task.progress")).toEqual([]);
        const completed = durableEvents.filter((event) => event.type === "task.completed");
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject({
          payload: {
            taskId: "child-private-progress",
            status: "failed",
            typedUsage: { totalTokens: 12, toolUses: 1, durationMs: 1_500 },
          },
        });
        expect(completed[0]?.payload).not.toHaveProperty("summary");
        const persisted = encodeUnknownJson(durableEvents);
        expect(persisted).not.toContain("private-answer");
        expect(persisted).not.toContain("private-recap");
        expect(persisted).not.toContain("private-terminal-error");
        expect(persisted).not.toContain("private-transient-error");
        expect(persisted).not.toContain("private-session");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("settles children missing from an authoritative reconnect snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.agentRoster = [{ id: "child-gap", label: "worker", status: "running" }];
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "task.progress");

        yield* Queue.offer(captures.queue!, {
          ...initialSnapshot(),
          children: [],
          lastEventSequence: 2,
        });
        const completed = yield* awaitObservedType(subscription.observed, "task.completed");
        expect(completed.payload).toMatchObject({ taskId: "child-gap", status: "stopped" });
        expect(captures.cancelAgentCalls).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes native busy state for background child-agent activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.resources.updated");
        yield* awaitObservedType(subscription.observed, "session.agent-depth.updated");

        yield* Queue.offer(captures.queue!, {
          _tag: "ChildUpdated",
          child: { id: "child-background", label: "child", status: "running" },
        });
        const busy = yield* awaitObservedType(subscription.observed, "session.agent-depth.updated");
        expect(busy).toMatchObject({ payload: { writable: true, settable: false } });
        expect(yield* adapter.getSessionAgentDepth!(threadId)).toMatchObject({
          writable: true,
          settable: false,
        });
        const error = yield* adapter.setSessionAgentDepth!(threadId, 3).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          reason: "busy",
        });

        yield* Queue.offer(captures.queue!, {
          _tag: "ChildUpdated",
          child: { id: "child-background", label: "child", status: "done" },
        });
        const idle = yield* awaitObservedType(subscription.observed, "session.agent-depth.updated");
        expect(idle).toMatchObject({ payload: { writable: true, settable: true } });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps supervised session agent depth fixed at policy zero", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });

        expect(yield* adapter.getSessionAgentDepth!(threadId)).toEqual({
          maxDepth: 0,
          source: "policy",
          writable: false,
          settable: false,
          maxSettableDepth: 4,
        });
        const error = yield* adapter.setSessionAgentDepth!(threadId, 1).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderAdapterUnsupportedOperationError",
          operation: "setSessionAgentDepth",
        });
        expect(captures.agentDepthCalls).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("reloads idle full-access resources and publishes one replacement catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.resources.updated");

        const payload = yield* adapter.reloadSessionResources!(threadId);
        const event = yield* awaitObservedType(subscription.observed, "session.resources.updated");

        expect(captures.reloadCount).toBe(1);
        expect(payload.commands).toEqual([{ name: "skill:review", source: "skill" }]);
        expect(event).toMatchObject({
          providerInstanceId: instanceId,
          threadId,
          payload,
        });
        expect(event).not.toHaveProperty("turnId");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects reload when the managed extension source changed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* Effect.promise(() =>
          NodeFSP.writeFile(captures.runtimeInputs[0]!.extensions![0]!, "tampered"),
        );

        const error = yield* adapter.reloadSessionResources!(threadId).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "ProviderAdapterProcessError",
          detail: "Prime Agent's managed provider extension source changed before reload.",
        });
        expect(captures.reloadCount).toBe(0);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("waits for resource reload completion before mutating agent depth", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.reloadObserved = yield* Queue.unbounded<void>();
        captures.reloadRelease = yield* Deferred.make<void>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        const reloadFiber = yield* adapter.reloadSessionResources!(threadId).pipe(Effect.forkChild);
        yield* Queue.take(captures.reloadObserved);
        const updateFiber = yield* adapter.setSessionAgentDepth!(threadId, 3).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        expect(captures.agentDepthCalls).toEqual([]);

        yield* Deferred.succeed(captures.reloadRelease, undefined);
        yield* Fiber.join(reloadFiber);
        expect((yield* Fiber.join(updateFiber)).maxDepth).toBe(3);
        expect(captures.agentDepthCalls).toEqual([3]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects agent depth updates while a turn is active", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "keep working" })
          .pipe(Effect.forkChild);
        yield* Queue.take(captures.promptObserved!);

        const error = yield* adapter.setSessionAgentDepth!(threadId, 3).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          operation: "setSessionAgentDepth",
        });
        expect(captures.agentDepthCalls).toEqual([]);

        yield* Queue.offer(captures.queue!, { _tag: "RunCompleted", messages: [] });
        yield* Fiber.join(turnFiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects reload while a turn is active without invoking the runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "keep working" })
          .pipe(Effect.forkChild);
        yield* Queue.take(captures.promptObserved!);

        const error = yield* adapter.reloadSessionResources!(threadId).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          operation: "reloadSessionResources",
        });
        expect(captures.reloadCount).toBe(0);

        yield* Queue.offer(captures.queue!, { _tag: "RunCompleted", messages: [] });
        yield* Fiber.join(turnFiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "allows reload lifecycle interactions to resolve without releasing mutation serialization",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          captures.reloadObserved = yield* Queue.unbounded<void>();
          captures.reloadRelease = yield* Deferred.make<void>();
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          yield* awaitObservedType(subscription.observed, "session.resources.updated");

          const reloadFiber = yield* adapter.reloadSessionResources!(threadId).pipe(
            Effect.forkChild,
          );
          yield* Queue.take(captures.reloadObserved);
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-reload-request-secret",
              method: "confirm",
              title: "Reload extension",
              message: "Continue reload",
            },
          });
          const requested = yield* awaitObservedType(
            subscription.observed,
            "interaction.requested",
          );
          yield* adapter.respondToInteraction!(threadId, requested.requestId!, {
            kind: "confirmed",
            confirmed: true,
          });
          yield* awaitObservedType(subscription.observed, "interaction.resolved");
          yield* Deferred.succeed(captures.reloadRelease, undefined);

          const result = yield* Fiber.join(reloadFiber);
          const updated = yield* awaitObservedType(
            subscription.observed,
            "session.resources.updated",
          );
          expect(result.commands).toEqual([{ name: "skill:review", source: "skill" }]);
          expect(updated.payload).toEqual(result);
          expect(captures.extensions).toEqual([
            { id: "native-reload-request-secret", response: { confirmed: true } },
          ]);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("finishes an admitted reload before honoring interruption or a queued turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.reloadObserved = yield* Queue.unbounded<void>();
        captures.reloadRelease = yield* Deferred.make<void>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.resources.updated");

        const reloadFiber = yield* adapter.reloadSessionResources!(threadId).pipe(Effect.forkChild);
        yield* Queue.take(captures.reloadObserved);
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "after reload" })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(Option.isNone(yield* Queue.poll(captures.promptObserved!))).toBe(true);
        const interruptFiber = yield* Fiber.interrupt(reloadFiber).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(Option.isNone(yield* Queue.poll(captures.promptObserved!))).toBe(true);

        yield* Deferred.succeed(captures.reloadRelease, undefined);
        const updated = yield* awaitObservedType(
          subscription.observed,
          "session.resources.updated",
        );
        expect(updated.payload).toMatchObject({
          available: true,
          commands: [{ name: "skill:review", source: "skill" }],
        });
        yield* Queue.take(captures.promptObserved!);
        yield* offer(captures, { _tag: "RunCompleted", messages: [] });
        yield* Fiber.join(turnFiber);
        yield* Fiber.join(interruptFiber);
        expect(captures.order.indexOf("reload-resources")).toBeLessThan(
          captures.order.indexOf("prompt"),
        );
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("invalidates stale resources after a failed reload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "session.resources.updated");
        captures.reloadFailure = true;

        const error = yield* adapter.reloadSessionResources!(threadId).pipe(Effect.flip);
        const event = yield* awaitObservedType(subscription.observed, "session.resources.updated");
        const exited = yield* awaitObservedType(subscription.observed, "session.exited");

        expect(error).toMatchObject({ _tag: "ProviderAdapterRequestError" });
        expect(event).toMatchObject({
          payload: { available: false, skills: [], prompts: [], commands: [] },
        });
        expect(exited).toMatchObject({
          payload: {
            exitKind: "error",
            reason:
              "Prime Agent session closed after session resources could not be reloaded safely.",
          },
        });
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(captures.disposeCount).toBe(1);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects resource reload for supervised sessions before runtime mutation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });

        const error = yield* adapter.reloadSessionResources!(threadId).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderAdapterUnsupportedOperationError",
          operation: "reloadSessionResources",
        });
        expect(captures.reloadCount).toBe(0);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes authoritative context usage and clears unknown post-compaction state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const initialUsage = yield* awaitObservedType(
          subscription.observed,
          "thread.token-usage.updated",
        );
        expect(initialUsage).toMatchObject({
          payload: {
            usage: {
              usedTokens: 320,
              maxTokens: 200_000,
              compactsAutomatically: true,
            },
          },
        });
        expect(initialUsage).not.toHaveProperty("turnId");

        captures.sessionStats = {
          contextUsage: { usedTokens: null, maxTokens: 200_000 },
        };
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "compact", interactionMode: "default" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        yield* offer(captures, { _tag: "RunStarted" });
        yield* offer(captures, {
          _tag: "RunCompleted",
          messages: [assistantMessage("done")],
        });

        const cleared = yield* awaitObservedType(
          subscription.observed,
          "thread.token-usage.cleared",
        );
        expect(cleared).toMatchObject({ payload: { reason: "unknown" } });
        expect(cleared).not.toHaveProperty("turnId");
        expect(captures.sessionStatsCount).toBe(2);
        yield* Fiber.join(turnFiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("settles an explicit compact command from its terminal lifecycle event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.token-usage.updated");

        const turnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "/compact PRIVATE INSTRUCTIONS",
            interactionMode: "default",
          })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        yield* offer(captures, { _tag: "CompactionStarted" });
        const started = yield* awaitObservedType(subscription.observed, "item.started");
        expect(started).toMatchObject({
          payload: { itemType: "context_compaction", status: "inProgress" },
        });
        const steerError = yield* adapter
          .sendTurn({ threadId, input: "queued text", interactionMode: "default" })
          .pipe(Effect.flip);
        expect(steerError).toMatchObject({
          _tag: "ProviderAdapterValidationError",
          issue: "Prime Agent cannot steer an active context compaction.",
        });

        captures.sessionStats = {
          contextUsage: { usedTokens: null, maxTokens: 200_000 },
        };
        yield* offer(captures, {
          _tag: "CompactionCompleted",
          outcome: "completed",
          willRetry: false,
        });
        const completedItem = yield* awaitObservedType(subscription.observed, "item.completed");
        expect(completedItem).toMatchObject({
          itemId: started.itemId,
          payload: { itemType: "context_compaction", status: "completed" },
        });
        expect(started.payload).not.toHaveProperty("detail");
        expect(started.payload).not.toHaveProperty("data");
        expect(completedItem.payload).not.toHaveProperty("detail");
        expect(completedItem.payload).not.toHaveProperty("data");
        const completedTurn = yield* awaitObservedType(subscription.observed, "turn.completed");
        expect(completedTurn).toMatchObject({ payload: { state: "completed" } });
        expect(completedTurn.payload).not.toHaveProperty("errorMessage");
        yield* awaitObservedType(subscription.observed, "thread.token-usage.cleared");
        yield* Fiber.join(turnFiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps compaction replacement scope after its active turn is cancelled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.token-usage.updated");

        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "ordinary turn", interactionMode: "default" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        yield* offer(captures, { _tag: "CompactionStarted" });
        const started = yield* awaitObservedType(subscription.observed, "item.started");

        yield* adapter.interruptTurn(threadId);
        const cancelled = yield* awaitObservedType(subscription.observed, "turn.completed");
        expect(cancelled).toMatchObject({ payload: { state: "cancelled" } });
        yield* Fiber.join(turnFiber);

        yield* offer(captures, {
          _tag: "CompactionCompleted",
          outcome: "completed",
          willRetry: false,
        });
        const completed = yield* awaitObservedType(subscription.observed, "item.completed");
        expect(completed.itemId).toBe(started.itemId);
        expect(completed.turnId).toBe(started.turnId);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps usage telemetry failures ancillary to completed turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.sessionStatsFailure = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "hello", interactionMode: "default" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        yield* offer(captures, { _tag: "RunStarted" });
        yield* offer(captures, {
          _tag: "RunCompleted",
          messages: [assistantMessage("done")],
        });

        const completed = yield* awaitObservedType(subscription.observed, "turn.completed");
        expect(completed).toMatchObject({ payload: { state: "completed" } });
        expect(subscription.events.some((event) => event.type === "runtime.error")).toBe(false);
        yield* Fiber.join(turnFiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("restores Prime's own default when a thread switches to Prime Agent Default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId, model: "openai/first" },
        });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const failure = yield* adapter
          .sendTurn({ threadId, input: "hello", modelSelection: { instanceId, model: "default" } })
          .pipe(Effect.flip);

        // "default" is Pylon's sentinel for letting Prime choose, not a provider/model
        // selector, so it must never reach setModel as an id.
        expect(captures.models).not.toContain("default");
        expect(failure).toMatchObject({
          operation: "sendTurn",
          issue: expect.stringContaining("cannot return to its own default model"),
        });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps running a thread that stays on Prime Agent Default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId, model: "default" },
        });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "hello", modelSelection: { instanceId, model: "default" } })
          .pipe(Effect.forkChild);
        yield* Queue.take(captures.promptObserved!);

        // Prime already owns the model here, so the same selection is a no-op, not a change.
        expect(captures.models).toEqual([]);

        yield* Fiber.interrupt(turnFiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("persists a server-private identity behind the opaque v3 cursor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(
          decodeSettings({ agentHomePath: "/prime/home" }),
          manager,
          { instanceId, runtimeFactory: fakeRuntimeFactory(captures) },
        );
        const subscription = yield* subscribe(adapter);
        const session = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("primeAgent"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId, model: "openai/first" },
        });
        yield* awaitObservedType(subscription.observed, "thread.started");

        expect(session.resumeCursor).toEqual(PRIME_AGENT_DAEMON_RESUME_CURSOR);
        expect(captures.runtimeInputs[0]).toMatchObject({
          agentDir: "/prime/home",
          model: "openai/first",
        });
        expect(captures.runtimeInputs[0]!.sessionDir).toContain("provider-sessions/prime-agent/");
        expect(subscription.events.map((event) => event.type)).toEqual([
          "session.started",
          "session.resources.updated",
          "session.agent-depth.updated",
          "session.compaction.updated",
          "session.goal.updated",
          "session.input-queue.updated",
          "session.state.changed",
          "thread.started",
        ]);
        expect(encodeUnknownJson(subscription.events)).not.toContain("native-active-secret");
        expect(encodeUnknownJson(subscription.events)).not.toContain("native-session-secret");
        expect(encodeUnknownJson(subscription.events)).not.toContain("/native/secret/path");
        expect(new Set(subscription.events.map((event) => event.eventId)).size).toBe(
          subscription.events.length,
        );
        expect(subscription.events.every((event) => event.createdAt.length > 0)).toBe(true);
        const identitySource = yield* Effect.promise(() =>
          NodeFSP.readFile(
            `${captures.runtimeInputs[0]!.sessionDir}/.pylon-prime-session.json`,
            "utf8",
          ),
        );
        expect(identitySource).toContain('"sessionId":"native-session-secret"');
        const privateDirMode =
          (yield* Effect.promise(() => NodeFSP.stat(captures.runtimeInputs[0]!.sessionDir))).mode &
          0o777;
        const identityMode =
          (yield* Effect.promise(() =>
            NodeFSP.stat(`${captures.runtimeInputs[0]!.sessionDir}/.pylon-prime-session.json`),
          )).mode & 0o777;
        expect(privateDirMode).toBe(0o700);
        expect(identityMode).toBe(0o600);

        yield* Effect.promise(() =>
          NodeFSP.unlink(`${captures.runtimeInputs[0]!.sessionDir}/.pylon-prime-session.json`),
        );
        yield* adapter.stopSession(threadId);
        const restoredWithoutIdentity = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: session.resumeCursor,
        });
        expect(session.restored).toBeUndefined();
        expect(restoredWithoutIdentity.restored).toBe(true);
        expect(captures.runtimeInputs[1]).toMatchObject({
          resumeCursor: PRIME_AGENT_DAEMON_RESUME_CURSOR,
        });
        expect(captures.runtimeInputs[1]).not.toHaveProperty("resumeSessionId");

        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: session.resumeCursor,
        });
        expect(captures.runtimeInputs[2]).toMatchObject({
          resumeCursor: PRIME_AGENT_DAEMON_RESUME_CURSOR,
          resumeSessionId: "native-session-secret",
        });
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails visibly instead of resuming a missing native transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const error = yield* adapter
          .startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: PRIME_AGENT_DAEMON_RESUME_CURSOR,
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderAdapterProcessError",
          detail: "No saved Prime Agent session is available to continue.",
        });
        expect(captures.runtimeInputs).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("gates approval-required sessions through opaque canonical approvals", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        yield* awaitObservedType(subscription.observed, "thread.started");

        expect(session.runtimeMode).toBe("approval-required");
        expect(captures.runtimeInputs[0]).toMatchObject({
          disableExtensionDiscovery: true,
          disableAutoReconnect: true,
          requiredExtension: {
            markerCommand: "pylon-managed-bridge-v1",
          },
        });
        expect(captures.runtimeInputs[0]!.extensions).toHaveLength(1);
        const slashError = yield* adapter
          .sendTurn({
            threadId,
            input: "/export /tmp/bypass.html",
            interactionMode: "default",
          })
          .pipe(Effect.flip);
        expect(slashError).toMatchObject({
          operation: "sendTurn",
          issue: expect.stringContaining("slash commands"),
        });
        expect(captures.prompts).toEqual([]);
        const extensionPath = captures.runtimeInputs[0]!.extensions![0]!;
        const extensionSource = yield* Effect.promise(() =>
          NodeFSP.readFile(extensionPath, "utf8"),
        );
        const title = extensionSource.match(/const TITLE = "([^"]+)";/)?.[1];
        expect(title).toMatch(/^Pylon execution approval:[0-9a-f-]{36}$/);
        if (title === undefined) throw new Error("Managed extension title was not generated.");

        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-approval-secret",
            method: "confirm",
            title,
            message: "pylon-permission-v1\ncommand_execution_approval\nbash\nprintf guarded",
            timeoutMs: 600_000,
          },
        });
        const requested = yield* awaitObservedType(subscription.observed, "request.opened");
        expect(requested).toMatchObject({
          payload: {
            requestType: "command_execution_approval",
            detail: "printf guarded",
            args: { toolName: "bash" },
          },
        });
        expect(encodeUnknownJson(requested)).not.toContain("native-approval-secret");
        expect(encodeUnknownJson(requested)).not.toContain(title);

        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(String(requested.requestId)),
          "acceptForSession",
        );
        const resolved = yield* awaitObservedType(subscription.observed, "request.resolved");
        expect(resolved).toMatchObject({
          requestId: requested.requestId,
          payload: { requestType: "command_execution_approval", decision: "acceptForSession" },
        });
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-session-approved",
            method: "confirm",
            title,
            message: "pylon-permission-v1\nfile_change_approval\nedit\nREADME.md",
          },
        });
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-wrong-token",
            method: "confirm",
            title: "Pylon execution approval:wrong-token",
            message: "pylon-permission-v1\ncommand_execution_approval\nbash\ntouch denied",
          },
        });
        yield* awaitObservedType(subscription.observed, "runtime.error");
        expect(captures.extensions).toEqual([
          { id: "native-approval-secret", response: { confirmed: true } },
          { id: "native-session-approved", response: { confirmed: true } },
          { id: "native-wrong-token", response: { confirmed: false } },
        ]);
        expect(subscription.events.filter((event) => event.type === "request.opened")).toHaveLength(
          1,
        );
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps failed responses pending and settles cancellation even when queue clearing fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          captures.abortClearFailure = true;
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });
          yield* awaitObservedType(subscription.observed, "thread.started");
          const extensionPath = captures.runtimeInputs[0]!.extensions![0]!;
          const source = yield* Effect.promise(() => NodeFSP.readFile(extensionPath, "utf8"));
          const title = source.match(/const TITLE = "([^"]+)";/)?.[1];
          if (title === undefined) throw new Error("Managed extension title was not generated.");
          const turnFiber = yield* adapter
            .sendTurn({ threadId, input: "run custom", interactionMode: "default" })
            .pipe(Effect.forkChild);
          yield* awaitObservedType(subscription.observed, "turn.started");
          yield* Queue.take(captures.promptObserved!);
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-retry-approval",
              method: "confirm",
              title,
              message: "pylon-permission-v1\ncommand_execution_approval\nbash\nprintf guarded",
            },
          });
          const requested = yield* awaitObservedType(subscription.observed, "request.opened");
          const requestId = ApprovalRequestId.make(String(requested.requestId));
          captures.extensionFailure = true;
          yield* adapter.respondToRequest(threadId, requestId, "accept").pipe(Effect.flip);
          expect(subscription.events.some((event) => event.type === "request.resolved")).toBe(
            false,
          );

          captures.extensionFailure = false;
          const cancelExit = yield* adapter
            .respondToRequest(threadId, requestId, "cancel")
            .pipe(Effect.exit);
          expect(Exit.isFailure(cancelExit)).toBe(true);
          const resolved = yield* awaitObservedType(subscription.observed, "request.resolved");
          expect(resolved).toMatchObject({ payload: { decision: "cancel" } });
          const result = yield* Fiber.join(turnFiber);
          expect(result.threadId).toBe(threadId);
          expect(
            subscription.events.some(
              (event) => event.type === "turn.completed" && event.payload.state === "cancelled",
            ),
          ).toBe(true);
          expect(captures.extensions).toEqual([
            { id: "native-retry-approval", response: { confirmed: false } },
          ]);
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "publishes the stamped canonical sequence, switches models, sends images, and resolves extensions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: { instanceId, model: "openai/first" },
          });
          yield* awaitObservedType(subscription.observed, "thread.started");
          const config = yield* ServerConfig;
          const attachment = {
            type: "image" as const,
            id: "prime-daemon-thread-00000000-0000-4000-8000-000000000001",
            name: "pixel.png",
            mimeType: "image/png",
            sizeBytes: 3,
          };
          // Prime ingests images only. ProviderService forwards every
          // attachment, so a generic file must be skipped here rather than
          // base64'd into an image block with a non-image mime type.
          const fileAttachment = {
            type: "file" as const,
            id: "prime-daemon-thread-00000000-0000-4000-8000-000000000002",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 3,
          };
          for (const each of [attachment, fileAttachment]) {
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                `${config.attachmentsDir}/${attachmentRelativePath(each)}`,
                Buffer.from([1, 2, 3]),
              ),
            );
          }

          const turnFiber = yield* adapter
            .sendTurn({
              threadId,
              input: "hello",
              attachments: [attachment, fileAttachment],
              modelSelection: {
                instanceId,
                model: "anthropic/second",
                options: [
                  { id: "thinkingLevel", value: "high" },
                  { id: "serviceTier", value: "priority" },
                ],
              },
              interactionMode: "default",
            })
            .pipe(Effect.forkChild);
          yield* awaitObservedType(subscription.observed, "turn.started");
          yield* Queue.take(captures.promptObserved!);
          expect(captures.prompts.at(-1)?.images.map((image) => image.mimeType)).toEqual([
            "image/png",
          ]);
          const toolTurnMessage = assistantMessage("hello back", "toolUse");
          yield* offer(captures, { _tag: "MessageStarted", message: assistantMessage("") });
          yield* offer(captures, {
            _tag: "AssistantStream",
            phase: "start",
            kind: "thinking",
          });
          yield* offer(captures, {
            _tag: "AssistantStream",
            phase: "delta",
            kind: "thinking",
            delta: "because",
          });
          yield* offer(captures, {
            _tag: "AssistantStream",
            phase: "end",
            kind: "thinking",
            content: "because",
          });
          yield* offer(captures, {
            _tag: "AssistantStream",
            phase: "delta",
            kind: "text",
            delta: "hello back",
          });
          yield* offer(captures, {
            _tag: "ToolStarted",
            toolCallId: "tool-1",
            toolName: "bash",
            input: { command: "pwd" },
          });
          yield* offer(captures, {
            _tag: "ToolProgress",
            toolCallId: "tool-1",
            toolName: "bash",
            text: "running",
          });
          yield* offer(captures, {
            _tag: "ToolCompleted",
            toolCallId: "tool-1",
            toolName: "bash",
            text: "done",
            isError: false,
          });
          yield* offer(captures, {
            _tag: "MessageCompleted",
            message: toolTurnMessage,
          });
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-request-secret",
              method: "select",
              title: " Choose a client ",
              options: ["web", "desktop"],
              timeoutMs: 10_000,
              text: "native payload secret",
            },
          });
          const requested = yield* awaitObservedType(
            subscription.observed,
            "interaction.requested",
          );
          expect(requested).toMatchObject({
            turnId: subscription.events.findLast((event) => event.type === "turn.started")!.turnId,
            payload: {
              request: {
                kind: "select",
                title: "Choose a client",
                options: ["web", "desktop"],
                timeout: 10_000,
              },
            },
          });
          expect(requested.requestId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          expect(captures.extensions).toEqual([]);
          yield* adapter.respondToInteraction!(threadId, requested.requestId!, {
            kind: "selected",
            value: "desktop",
          });
          const resolved = yield* awaitObservedType(subscription.observed, "interaction.resolved");
          expect(resolved).toMatchObject({
            requestId: requested.requestId,
            turnId: requested.turnId,
            payload: { response: { kind: "selected", value: "desktop" } },
          });
          yield* offer(captures, {
            _tag: "TurnCompleted",
            message: toolTurnMessage,
            toolResults: [],
          });
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: { id: "cycle-barrier", method: "barrier" },
          });
          yield* awaitObservedType(subscription.observed, "runtime.warning");
          expect(turnFiber.pollUnsafe()).toBeUndefined();

          const finalMessage = assistantMessage("final answer");
          yield* offer(captures, { _tag: "TurnStarted" });
          yield* offer(captures, { _tag: "MessageStarted", message: finalMessage });
          yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
          yield* offer(captures, {
            _tag: "TurnCompleted",
            message: finalMessage,
            toolResults: [],
          });
          yield* offer(captures, { _tag: "SessionInfoChanged", name: "Cycle complete" });
          yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
          expect(turnFiber.pollUnsafe()).toBeUndefined();
          yield* offer(captures, {
            _tag: "RunCompleted",
            messages: [toolTurnMessage, finalMessage],
          });
          const result = yield* Fiber.join(turnFiber);
          yield* awaitObservedType(subscription.observed, "session.state.changed");

          expect(result.resumeCursor).toEqual(PRIME_AGENT_DAEMON_RESUME_CURSOR);
          expect(captures.order.slice(0, 4)).toEqual([
            "model:anthropic/second",
            "thinking:high",
            "service:priority",
            "prompt",
          ]);
          expect(captures.thinkingLevels).toEqual(["high"]);
          expect(captures.serviceTiers).toEqual(["priority"]);
          expect(captures.prompts[0]).toMatchObject({
            text: "hello",
            images: [{ type: "image", data: "AQID", mimeType: "image/png" }],
          });
          expect(captures.extensions).toEqual([
            { id: "native-request-secret", response: { value: "desktop" } },
          ]);

          const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
          expect(turnEvents.map((event) => event.type)).toEqual([
            "turn.started",
            "item.started",
            "item.completed",
            "content.delta",
            "item.started",
            "item.updated",
            "item.completed",
            "item.completed",
            "interaction.requested",
            "interaction.resolved",
            "runtime.warning",
            "item.started",
            "content.delta",
            "item.completed",
            "thread.metadata.updated",
            "turn.completed",
            "session.state.changed",
          ]);
          expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
          const assistantStarts = turnEvents.filter(
            (event) =>
              event.type === "item.started" && event.payload.itemType === "assistant_message",
          );
          expect(assistantStarts.map((event) => event.itemId)).toEqual([
            `assistant:${result.turnId}:segment:0`,
            `assistant:${result.turnId}:segment:1`,
          ]);
          expect(turnEvents.find((event) => event.type === "turn.completed")).toMatchObject({
            payload: {
              state: "completed",
              usage: {
                inputTokens: 22,
                outputTokens: 14,
                cachedInputTokens: 6,
                cacheWriteTokens: 4,
                totalTokens: 46,
              },
              totalCostUsd: 0.024,
            },
          });
          expect(new Set(turnEvents.map((event) => event.eventId)).size).toBe(turnEvents.length);
          expect(turnEvents.every((event) => event.createdAt.length > 0)).toBe(true);
          const serialized = encodeUnknownJson(turnEvents);
          expect(serialized).not.toContain("native-request-secret");
          expect(serialized).not.toContain("native/dialog");
          expect(serialized).not.toContain("native payload secret");
          expect(serialized).not.toContain("/native/private/path");

          // A duplicate authoritative completion after settlement is ignored.
          yield* offer(captures, {
            _tag: "RunCompleted",
            messages: [assistantMessage("duplicate")],
          });
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: { id: "barrier", method: "barrier" },
          });
          yield* awaitObservedType(subscription.observed, "runtime.warning");
          expect(
            subscription.events.filter((event) => event.type === "turn.completed"),
          ).toHaveLength(1);
          yield* adapter.stopSession(threadId);
          yield* awaitObservedType(subscription.observed, "session.exited");
          expect(captures.disposeCount).toBe(1);
          expect(captures.order.at(-1)).toBe("dispose");
          expect(subscription.events.at(-1)?.type).toBe("session.exited");
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps asynchronous child continuations attached through authoritative quiescence",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          captures.rlmQuiescenceAvailable = true;
          captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
          captures.rlmQuiescenceUsage = {
            inputTokens: 101,
            outputTokens: 37,
            cachedInputTokens: 503,
            cacheWriteTokens: 11,
            totalTokens: 652,
            totalCostUsd: 0.321,
          };
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          yield* awaitObservedType(subscription.observed, "thread.started");

          const running = yield* adapter
            .sendTurn({ threadId, input: "wait for asynchronous children" })
            .pipe(Effect.forkChild);
          const started = yield* awaitObservedType(subscription.observed, "turn.started");
          yield* Queue.take(captures.promptObserved!);

          // The child roster can arrive just after the root model boundary. The
          // native barrier, rather than local timing, keeps the Pylon turn open.
          yield* offer(captures, { _tag: "RunCompleted", messages: [] });
          yield* offer(captures, {
            _tag: "ChildUpdated",
            child: { id: "child-first", label: "first", status: "running" },
          });
          yield* offer(captures, {
            _tag: "ChildUpdated",
            child: { id: "child-second", label: "second", status: "running" },
          });
          yield* offer(captures, {
            _tag: "SessionInfoChanged",
            name: "children admitted barrier",
          });
          yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
          expect(running.pollUnsafe()).toBeUndefined();
          expect(subscription.events.some((event) => event.type === "turn.completed")).toBe(false);

          yield* offer(captures, {
            _tag: "ChildUpdated",
            child: { id: "child-second", label: "second", status: "done" },
          });
          yield* offer(captures, {
            _tag: "ChildUpdated",
            child: { id: "child-first", label: "first", status: "done" },
          });
          yield* offer(captures, { _tag: "RunStarted" });
          const finalMessage = assistantMessage("the asynchronous parent final response");
          yield* offer(captures, { _tag: "MessageStarted", message: finalMessage });
          yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
          yield* offer(captures, { _tag: "RunCompleted", messages: [finalMessage] });
          yield* offer(captures, {
            _tag: "SessionInfoChanged",
            name: "parent continuation barrier",
          });
          yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
          expect(running.pollUnsafe()).toBeUndefined();
          expect(subscription.events.some((event) => event.type === "turn.completed")).toBe(false);

          yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
          const result = yield* Fiber.join(running);

          expect(result.turnId).toBe(started.turnId);
          const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
          expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
          expect(turnEvents.find((event) => event.type === "turn.completed")).toMatchObject({
            payload: {
              usage: {
                inputTokens: 101,
                outputTokens: 37,
                cachedInputTokens: 503,
                cacheWriteTokens: 11,
                totalTokens: 652,
              },
              totalCostUsd: 0.321,
            },
          });
          expect(
            turnEvents.some(
              (event) =>
                event.type === "content.delta" &&
                event.payload.streamKind === "assistant_text" &&
                event.payload.delta === finalMessage.text,
            ),
          ).toBe(true);
          expect(
            turnEvents
              .filter((event) => event.type === "task.completed")
              .map((event) => event.payload),
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ taskId: "child-first", status: "completed" }),
              expect.objectContaining({ taskId: "child-second", status: "completed" }),
            ]),
          );
          expect(
            turnEvents.some(
              (event) =>
                (event.type === "runtime.warning" || event.type === "runtime.error") &&
                typeof event.payload.detail === "object" &&
                event.payload.detail !== null &&
                "kind" in event.payload.detail &&
                event.payload.detail.kind === "missing-final-response",
            ),
          ).toBe(false);
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("settles once when asynchronous children quiesce without a parent reply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "handle a cancelled child" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        yield* offer(captures, {
          _tag: "ChildUpdated",
          child: { id: "child-cancelled", label: "cancelled", status: "running" },
        });
        yield* offer(captures, { _tag: "RunCompleted", messages: [] });
        yield* offer(captures, {
          _tag: "ChildUpdated",
          child: { id: "child-cancelled", label: "cancelled", status: "cancelled" },
        });
        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);

        const result = yield* Fiber.join(running);
        expect(result.turnId).toBe(started.turnId);
        const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(turnEvents.find((event) => event.type === "runtime.warning")).toMatchObject({
          payload: {
            detail: { kind: "missing-final-response", outcome: "completed" },
          },
        });
        expect(turnEvents.find((event) => event.type === "task.completed")).toMatchObject({
          payload: { taskId: "child-cancelled", status: "stopped" },
        });
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("ignores an old quiescence marker after a steer rearms the active turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "start child work" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        const initialToken = yield* Queue.take(captures.rlmQuiescenceObserved);
        yield* offer(captures, {
          _tag: "RunCompleted",
          messages: [assistantMessage("initial response", "toolUse")],
        });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "initial boundary" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");

        const steered = yield* adapter.sendTurn({ threadId, input: "include this follow-up" });
        expect(steered.turnId).toBe(started.turnId);
        const currentToken = yield* Queue.take(captures.rlmQuiescenceObserved);
        expect(currentToken).not.toBe(initialToken);
        expect(captures.rlmQuiescenceSignals).toHaveLength(2);
        expect(captures.rlmQuiescenceSignals[0]).toBe(captures.prompts[0]?.signal);
        expect(captures.rlmQuiescenceSignals[1]).toBe(captures.prompts[0]?.signal);

        yield* offer(captures, {
          _tag: "RlmQuiesced",
          token: initialToken,
          connectionGeneration: 0,
        });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "stale marker drained" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        expect(subscription.events.some((event) => event.type === "turn.completed")).toBe(false);

        yield* offer(captures, { _tag: "RunStarted" });
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 0,
          steeringCount: 0,
          followUpCount: 0,
        });
        const finalMessage = assistantMessage("final response after steering");
        yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
        yield* offer(captures, { _tag: "RunCompleted", messages: [finalMessage] });
        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        const result = yield* Fiber.join(running);

        expect(result.turnId).toBe(started.turnId);
        const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(
          turnEvents.some(
            (event) =>
              event.type === "content.delta" &&
              event.payload.streamKind === "assistant_text" &&
              event.payload.delta === finalMessage.text,
          ),
        ).toBe(true);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps queue-clear settlement behind its marker and ignores it in the next turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const first = yield* adapter
          .sendTurn({ threadId, input: "queue work then clear it" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.rlmQuiescenceObserved);
        yield* offer(captures, {
          _tag: "RunCompleted",
          messages: [assistantMessage("waiting for queued input", "toolUse")],
        });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "queue clear boundary" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        const steered = yield* adapter.sendTurn({ threadId, input: "remove this input" });
        const staleToken = yield* Queue.take(captures.rlmQuiescenceObserved);
        yield* adapter.clearSessionInputQueue!(threadId);
        expect(subscription.events.some((event) => event.type === "turn.completed")).toBe(false);

        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        const firstResult = yield* Fiber.join(first);
        expect(firstResult.turnId).toBe(steered.turnId);
        expect(
          subscription.events.filter(
            (event) => event.turnId === firstResult.turnId && event.type === "turn.completed",
          ),
        ).toHaveLength(1);

        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        const second = yield* adapter
          .sendTurn({ threadId, input: "a new canonical turn" })
          .pipe(Effect.forkChild);
        const secondStarted = yield* awaitObservedType(subscription.observed, "turn.started");
        const secondToken = yield* Queue.take(captures.rlmQuiescenceObserved);
        expect(secondToken).not.toBe(staleToken);
        const secondMessage = assistantMessage("second turn final");
        yield* offer(captures, { _tag: "RunCompleted", messages: [secondMessage] });
        yield* offer(captures, {
          _tag: "RlmQuiesced",
          token: staleToken,
          connectionGeneration: 0,
        });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "old turn marker drained" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        expect(
          subscription.events.filter(
            (event) => event.turnId === secondStarted.turnId && event.type === "turn.completed",
          ),
        ).toHaveLength(0);

        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        const secondResult = yield* Fiber.join(second);
        expect(secondResult.turnId).toBe(secondStarted.turnId);
        expect(
          subscription.events.filter(
            (event) => event.turnId === secondResult.turnId && event.type === "turn.completed",
          ),
        ).toHaveLength(1);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails and disposes a session whose current quiescence marker crossed reconnect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "reconnect during child work" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        const token = yield* Queue.take(captures.rlmQuiescenceObserved);
        yield* offer(captures, { _tag: "RunCompleted", messages: [] });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "pending reconnect" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");

        captures.rlmConnectionGeneration = 1;
        yield* offer(captures, {
          _tag: "RlmQuiesced",
          token,
          connectionGeneration: 0,
        });
        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        yield* Fiber.join(running);
        yield* awaitObservedType(subscription.observed, "session.exited");

        const turnEvents = subscription.events.filter((event) => event.turnId === started.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(turnEvents.find((event) => event.type === "turn.completed")).toMatchObject({
          payload: { state: "failed" },
        });
        expect(captures.disposeCount).toBe(1);
        const nextError = yield* adapter
          .sendTurn({ threadId, input: "must not reuse uncertain native state" })
          .pipe(Effect.flip);
        expect(nextError).toMatchObject({ _tag: "ProviderAdapterSessionNotFoundError" });
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails and disposes the session when its authoritative barrier rejects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "barrier failure with a running child" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.rlmQuiescenceObserved);
        yield* offer(captures, {
          _tag: "ChildUpdated",
          child: { id: "child-running", label: "running", status: "running" },
        });
        yield* offer(captures, { _tag: "RunCompleted", messages: [] });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "barrier failure pending" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");

        captures.rlmQuiescenceFailure = true;
        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        yield* Fiber.join(running);
        yield* awaitObservedType(subscription.observed, "session.exited");

        const turnEvents = subscription.events.filter((event) => event.turnId === started.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(turnEvents.find((event) => event.type === "turn.completed")).toMatchObject({
          payload: { state: "failed" },
        });
        expect(captures.disposeCount).toBe(1);
        expect(
          subscription.events.filter(
            (event) => event.turnId === started.turnId && event.type === "content.delta",
          ),
        ).toHaveLength(0);
        const nextError = yield* adapter
          .sendTurn({ threadId, input: "must start a replacement session first" })
          .pipe(Effect.flip);
        expect(nextError).toMatchObject({ _tag: "ProviderAdapterSessionNotFoundError" });
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("recovers a completed response from an exact reconnect snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "finish before the resync projection" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.rlmQuiescenceObserved);
        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, isStreaming: false, messageCount: 1 },
          messages: [assistantMessage("recovered final response")],
          lastEventSequence: 12,
          replayContinuity: "unavailable",
          connectionGeneration: 1,
        });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "snapshot applied" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        expect(captures.rlmContinuityValid).toBe(true);
        expect(captures.reconnectResolutions.at(-1)).toEqual({
          generation: 1,
          reconciled: true,
          terminalResponseObserved: true,
        });

        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        const result = yield* Fiber.join(running);
        expect(result.turnId).toBe(started.turnId);
        const turnEvents = subscription.events.filter((event) => event.turnId === started.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.started")).toHaveLength(1);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(encodeUnknownJson(turnEvents)).toContain("recovered final response");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps a current terminal response observed before reconnect reconciliation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "observe the final response before resync" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.rlmQuiescenceObserved);
        const terminal = assistantMessage("already observed final response");
        yield* offer(captures, { _tag: "MessageCompleted", message: terminal });
        yield* offer(captures, { _tag: "RunCompleted", messages: [terminal] });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "terminal observed" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");

        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, isStreaming: false, messageCount: 1 },
          messages: [terminal],
          lastEventSequence: 12,
          replayContinuity: "unavailable",
          connectionGeneration: 1,
        });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "snapshot applied" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        expect(captures.reconnectResolutions.at(-1)).toEqual({
          generation: 1,
          reconciled: true,
          terminalResponseObserved: true,
        });

        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        yield* Fiber.join(running);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("recovers only the missing suffix of partially streamed assistant text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "recover a partial assistant stream" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.rlmQuiescenceObserved);
        yield* offer(captures, {
          _tag: "MessageStarted",
          message: assistantMessage(""),
        });
        yield* offer(captures, {
          _tag: "AssistantStream",
          phase: "delta",
          kind: "text",
          delta: "partial ",
        });
        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, messageCount: 1 },
          messages: [assistantMessage("partial recovered final")],
          lastEventSequence: 18,
          replayContinuity: "unavailable",
          connectionGeneration: 1,
        });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "partial stream applied" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        yield* Fiber.join(running);

        const turnEvents = subscription.events.filter((event) => event.turnId === started.turnId);
        expect(
          turnEvents
            .filter((event) => event.type === "content.delta")
            .map((event) => event.payload.delta),
        ).toEqual(["partial ", "recovered final"]);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("settles an exact recovered final when the native barrier is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "recover without a native barrier" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, messageCount: 1 },
          messages: [assistantMessage("recovered without barrier")],
          lastEventSequence: 47,
          replayContinuity: "unavailable",
          connectionGeneration: 1,
        });
        yield* Fiber.join(running);

        const turnEvents = subscription.events.filter((event) => event.turnId === started.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.started")).toHaveLength(1);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(encodeUnknownJson(turnEvents)).toContain("recovered without barrier");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("ignores a stale resync from an older reconnect generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "ignore stale reconnect state" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.rlmQuiescenceObserved);
        captures.rlmConnectionGeneration = 2;
        captures.rlmContinuityValid = true;
        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, messageCount: 1 },
          messages: [assistantMessage("stale snapshot must not project")],
          lastEventSequence: 52,
          replayContinuity: "unavailable",
          connectionGeneration: 1,
        });
        const finalMessage = assistantMessage("current generation final");
        yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
        yield* offer(captures, { _tag: "RunCompleted", messages: [finalMessage] });
        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        yield* Fiber.join(running);

        const turnEvents = subscription.events.filter((event) => event.turnId === started.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.started")).toHaveLength(1);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(encodeUnknownJson(turnEvents)).toContain("current generation final");
        expect(encodeUnknownJson(turnEvents)).not.toContain("stale snapshot must not project");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("projects each finalized managed plan once on the exact active turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "implement task parity" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        const planMessage = {
          role: "toolResult",
          timestamp: 2,
          toolCallId: "private-plan-call",
          toolName: "pylon_update_plan",
          text: "Plan updated (2 steps).",
          imageMimeTypes: [],
          isError: false,
          planUpdate: {
            toolCallId: "private-plan-call",
            explanation: "Prime tasks",
            plan: [
              { step: "Inspect", status: "completed" as const },
              { step: "Implement", status: "inProgress" as const },
            ],
          },
        } satisfies PrimeDaemonMessage;
        const planCallMessage = {
          ...assistantMessage("", "toolUse"),
          toolCalls: [{ id: "private-plan-call", name: "pylon_update_plan" }],
        } satisfies PrimeDaemonMessage;
        const forgedPlanMessage = {
          ...planMessage,
          toolCallId: "forged-plan-call",
          planUpdate: { ...planMessage.planUpdate, toolCallId: "forged-plan-call" },
        } satisfies PrimeDaemonMessage;
        const unrelatedCallMessage = {
          ...assistantMessage("", "toolUse"),
          toolCalls: [{ id: "forged-plan-call", name: "bash", input: { command: "pwd" } }],
        } satisfies PrimeDaemonMessage;

        yield* offer(captures, { _tag: "MessageCompleted", message: unrelatedCallMessage });
        yield* offer(captures, {
          _tag: "ToolCompleted",
          toolCallId: "forged-plan-call",
          toolName: "pylon_update_plan",
          text: forgedPlanMessage.text,
          isError: false,
        });
        yield* offer(captures, { _tag: "MessageCompleted", message: forgedPlanMessage });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "forged plan dropped" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        expect(subscription.events.some((event) => event.type === "turn.plan.updated")).toBe(false);

        yield* offer(captures, { _tag: "MessageCompleted", message: planCallMessage });
        yield* offer(captures, {
          _tag: "ToolCompleted",
          toolCallId: "private-plan-call",
          toolName: "pylon_update_plan",
          text: planMessage.text,
          isError: false,
        });
        yield* offer(captures, { _tag: "MessageCompleted", message: planMessage });
        yield* offer(captures, { _tag: "MessageCompleted", message: planMessage });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "plan committed" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");

        const planEvents = subscription.events.filter(
          (event) => event.type === "turn.plan.updated",
        );
        expect(planEvents).toHaveLength(1);
        expect(planEvents[0]).toMatchObject({
          turnId: started.turnId,
          payload: {
            explanation: "Prime tasks",
            plan: [
              { step: "Inspect", status: "completed" },
              { step: "Implement", status: "inProgress" },
            ],
          },
        });
        expect(encodeUnknownJson(planEvents)).not.toContain("private-plan-call");

        const finalMessage = assistantMessage("task parity complete");
        yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
        yield* offer(captures, {
          _tag: "RunCompleted",
          messages: [planCallMessage, planMessage, finalMessage],
        });
        yield* Fiber.join(running);
        yield* offer(captures, {
          _tag: "MessageCompleted",
          message: { ...planMessage, toolCallId: "late-plan-call" },
        });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "late plan dropped" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        expect(
          subscription.events.filter((event) => event.type === "turn.plan.updated"),
        ).toHaveLength(1);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("holds managed plans across reconnect until verified snapshot recovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");
        const running = yield* adapter
          .sendTurn({ threadId, input: "recover a plan update" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        const planMessage = {
          role: "toolResult",
          timestamp: 2,
          toolCallId: "recovered-plan-call",
          toolName: "pylon_update_plan",
          text: "Plan updated (1 steps).",
          imageMimeTypes: [],
          isError: false,
          planUpdate: {
            toolCallId: "recovered-plan-call",
            plan: [{ step: "Recover safely", status: "inProgress" as const }],
          },
        } satisfies PrimeDaemonMessage;
        const clearedPlanMessage = {
          ...planMessage,
          timestamp: 3,
          toolCallId: "recovered-plan-call-2",
          text: "Plan updated (0 steps).",
          planUpdate: {
            toolCallId: "recovered-plan-call-2",
            explanation: "Work completed",
            plan: [],
          },
        } satisfies PrimeDaemonMessage;
        const planCallMessage = {
          ...assistantMessage("", "toolUse"),
          toolCalls: [
            { id: "recovered-plan-call", name: "pylon_update_plan" },
            { id: "recovered-plan-call-2", name: "pylon_update_plan" },
          ],
        } satisfies PrimeDaemonMessage;
        const finalMessage = assistantMessage("recovery complete");

        yield* offer(captures, { _tag: "MessageCompleted", message: planCallMessage });
        yield* offer(captures, { _tag: "ConnectionStatus", status: "reconnecting" });
        yield* offer(captures, { _tag: "MessageCompleted", message: planMessage });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "before plan verification" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        expect(subscription.events.some((event) => event.type === "turn.plan.updated")).toBe(false);

        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        yield* offer(captures, {
          ...initialSnapshot(),
          state: {
            ...initialSnapshot().state,
            isStreaming: true,
            messageCount: 4,
          },
          messages: [planCallMessage, planMessage, clearedPlanMessage, finalMessage],
          replayContinuity: "complete",
          connectionGeneration: 1,
        });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "plan verified" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        const plans = subscription.events.filter((event) => event.type === "turn.plan.updated");
        expect(plans).toHaveLength(2);
        expect(plans[0]).toMatchObject({
          turnId: started.turnId,
          payload: { plan: [{ step: "Recover safely", status: "inProgress" }] },
        });
        expect(plans[1]).toMatchObject({
          turnId: started.turnId,
          payload: { explanation: "Work completed", plan: [] },
        });
        const finalAssistantIndex = subscription.events.findLastIndex(
          (event) =>
            event.turnId === started.turnId &&
            event.type === "content.delta" &&
            encodeUnknownJson(event).includes("recovery complete"),
        );
        expect(finalAssistantIndex).toBeGreaterThan(
          subscription.events.findLastIndex((event) => event.type === "turn.plan.updated"),
        );
        yield* offer(captures, {
          _tag: "RunCompleted",
          messages: [planCallMessage, planMessage, clearedPlanMessage, finalMessage],
        });
        yield* Fiber.join(running);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("recovers root tool work without duplicating its lifecycle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "run one root tool across reconnect" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.rlmQuiescenceObserved);
        const toolCallMessage = {
          ...assistantMessage("", "toolUse"),
          toolCalls: [{ id: "tool-root-reconnect", name: "bash", input: { command: "pwd" } }],
        } satisfies PrimeDaemonMessage;
        // The completed assistant tool call was observed, but its separate
        // tool-start event was lost with the transport.
        yield* offer(captures, { _tag: "MessageCompleted", message: toolCallMessage });
        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        yield* offer(captures, {
          ...initialSnapshot(),
          state: {
            ...initialSnapshot().state,
            isStreaming: true,
            isBashRunning: true,
            messageCount: 1,
          },
          messages: [toolCallMessage],
          lastEventSequence: 22,
          replayContinuity: "unavailable",
          connectionGeneration: 1,
        });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "tool snapshot applied" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");

        const toolResult = {
          role: "toolResult",
          timestamp: 2,
          toolCallId: "tool-root-reconnect",
          toolName: "bash",
          text: "/work/project",
          imageMimeTypes: [],
          isError: false,
        } satisfies PrimeDaemonMessage;
        const finalMessage = assistantMessage("root tool recovery complete");
        yield* offer(captures, {
          _tag: "ToolCompleted",
          toolCallId: "tool-root-reconnect",
          toolName: "bash",
          text: "/work/project",
          isError: false,
        });
        yield* offer(captures, { _tag: "MessageCompleted", message: toolResult });
        yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
        yield* offer(captures, {
          _tag: "RunCompleted",
          messages: [toolCallMessage, toolResult, finalMessage],
        });
        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        yield* Fiber.join(running);

        const turnEvents = subscription.events.filter((event) => event.turnId === started.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.started")).toHaveLength(1);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(
          turnEvents.filter(
            (event) =>
              event.type === "item.started" && event.payload.itemType === "command_execution",
          ),
        ).toHaveLength(1);
        expect(encodeUnknownJson(turnEvents)).toContain("root tool recovery complete");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps a pending child and its parent continuation on the canonical turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "wait for a child across reconnect" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.rlmQuiescenceObserved);
        const childCallMessage = {
          ...assistantMessage("", "toolUse"),
          toolCalls: [{ id: "child-tool-reconnect", name: "rlm" }],
        } satisfies PrimeDaemonMessage;
        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, isStreaming: false, messageCount: 1 },
          messages: [childCallMessage],
          children: [
            {
              id: "child-reconnect",
              label: "child",
              status: "running",
              activeSessionId: "private-child-session",
            },
          ],
          lastEventSequence: 32,
          replayContinuity: "unavailable",
          connectionGeneration: 1,
        });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "child snapshot applied" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        yield* offer(captures, {
          _tag: "ChildUpdated",
          child: { id: "child-reconnect", label: "child", status: "done" },
        });
        yield* offer(captures, { _tag: "RunStarted" });
        const finalMessage = assistantMessage("parent resumed after child");
        yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
        yield* offer(captures, { _tag: "RunCompleted", messages: [finalMessage] });
        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        yield* Fiber.join(running);

        const turnEvents = subscription.events.filter((event) => event.turnId === started.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.started")).toHaveLength(1);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(encodeUnknownJson(turnEvents)).toContain("parent resumed after child");
        expect(captures.disposeCount).toBe(0);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("reconciles an exact rolling transcript tail at the snapshot bound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "keep only a bounded exact transcript tail" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.rlmQuiescenceObserved);
        const messages = Array.from(
          { length: PRIME_AGENT_DAEMON_TRANSCRIPT_MAX_MESSAGES + 1 },
          (_, index) =>
            ({
              role: "user",
              timestamp: index,
              text: `queued-${index}`,
              imageMimeTypes: [],
              imageDigests: [],
            }) satisfies PrimeDaemonMessage,
        );
        for (const message of messages) {
          yield* offer(captures, { _tag: "MessageCompleted", message });
        }
        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        yield* offer(captures, {
          ...initialSnapshot(),
          state: {
            ...initialSnapshot().state,
            messageCount: messages.length,
          },
          messages: messages.slice(-PRIME_AGENT_DAEMON_TRANSCRIPT_MAX_MESSAGES),
          lastEventSequence: 62,
          replayContinuity: "unavailable",
          connectionGeneration: 1,
        });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "bounded tail applied" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        expect(captures.rlmContinuityValid).toBe(true);

        const finalMessage = assistantMessage("bounded tail recovered");
        yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
        yield* offer(captures, { _tag: "RunCompleted", messages: [finalMessage] });
        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        yield* Fiber.join(running);

        const turnEvents = subscription.events.filter((event) => event.turnId === started.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(encodeUnknownJson(turnEvents)).toContain("bounded tail recovered");
        expect(encodeUnknownJson(turnEvents)).not.toContain(
          "Prime Agent could not safely recover the active turn after reconnecting.",
        );
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects an unavailable replay with no bounded transcript overlap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "reject a transcript gap at the bound" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.rlmQuiescenceObserved);
        yield* offer(captures, {
          _tag: "MessageCompleted",
          message: {
            role: "user",
            timestamp: 0,
            text: "observed anchor",
            imageMimeTypes: [],
            imageDigests: [],
          },
        });
        const disconnectedMessages = Array.from(
          { length: PRIME_AGENT_DAEMON_TRANSCRIPT_MAX_MESSAGES },
          (_, index) =>
            ({
              role: "user",
              timestamp: index + 1,
              text: `disconnected-${index}`,
              imageMimeTypes: [],
              imageDigests: [],
            }) satisfies PrimeDaemonMessage,
        );
        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, messageCount: 101 },
          messages: disconnectedMessages,
          lastEventSequence: 68,
          replayContinuity: "unavailable",
          connectionGeneration: 1,
        });
        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        yield* Fiber.join(running);
        yield* awaitObservedType(subscription.observed, "session.exited");

        expect(captures.disposeCount).toBe(1);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails closed when an idle reconnect adds unobserved native history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, messageCount: 1 },
          messages: [assistantMessage("unobserved idle history")],
          lastEventSequence: 72,
          replayContinuity: "unavailable",
          connectionGeneration: 1,
        });
        const exited = yield* awaitObservedType(subscription.observed, "session.exited");

        expect(exited).toMatchObject({
          payload: {
            reason: "Prime Agent session closed after reconnect recovery could not be confirmed.",
          },
        });
        expect(captures.disposeCount).toBe(1);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("waits for a fresh worker snapshot after a strict transcript mismatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        captures.retryWorkerRecoverySnapshots = true;
        let reportSnapshotRetry!: (generation: number) => void;
        const snapshotRetryObserved = new Promise<number>((resolve) => {
          reportSnapshotRetry = resolve;
        });
        captures.retryWorkerRecoverySnapshotObserved = reportSnapshotRetry;
        let reportSnapshotResolution!: (
          resolution: FakeCaptures["reconnectResolutions"][number],
        ) => void;
        const snapshotResolutionObserved = new Promise<
          FakeCaptures["reconnectResolutions"][number]
        >((resolve) => {
          reportSnapshotResolution = resolve;
        });
        captures.reconnectSnapshotResolutionObserved = reportSnapshotResolution;
        let reportTerminalResponse!: () => void;
        const terminalResponseObserved = new Promise<void>((resolve) => {
          reportTerminalResponse = resolve;
        });
        captures.workerRecoveryTerminalResponseObserved = reportTerminalResponse;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "retry one strict worker snapshot" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.rlmQuiescenceObserved);
        const observedBoundary = assistantMessage("observed tool boundary", "toolUse");
        yield* offer(captures, { _tag: "MessageCompleted", message: observedBoundary });
        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, messageCount: 1 },
          messages: [assistantMessage("different cached history", "toolUse")],
          lastEventSequence: 42,
          replayContinuity: "unavailable",
          connectionGeneration: 1,
        });

        expect(yield* Effect.promise(() => snapshotRetryObserved)).toBe(1);
        expect(captures.retryWorkerRecoverySnapshotCalls).toEqual([1]);
        expect(captures.reconnectResolutions).toHaveLength(0);
        expect(captures.disposeCount).toBe(0);
        expect(
          subscription.events.filter(
            (event) => event.turnId === started.turnId && event.type === "turn.completed",
          ),
        ).toHaveLength(0);

        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, messageCount: 1, isStreaming: true },
          messages: [observedBoundary],
          lastEventSequence: 43,
          replayContinuity: "unavailable",
          connectionGeneration: 1,
        });
        expect(yield* Effect.promise(() => snapshotResolutionObserved)).toEqual({
          generation: 1,
          reconciled: true,
          terminalResponseObserved: false,
        });
        expect(captures.rlmContinuityValid).toBe(true);
        const finalMessage = assistantMessage("fresh snapshot recovery completed");
        yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
        yield* Effect.promise(() => terminalResponseObserved);
        yield* offer(captures, { _tag: "RunCompleted", messages: [finalMessage] });
        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        yield* Fiber.join(running);

        const turnEvents = subscription.events.filter((event) => event.turnId === started.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(turnEvents.find((event) => event.type === "turn.completed")).toMatchObject({
          payload: { state: "completed" },
        });
        expect(encodeUnknownJson(turnEvents)).toContain("fresh snapshot recovery completed");
        expect(encodeUnknownJson(turnEvents)).not.toContain(
          "Prime Agent could not safely recover the active turn after reconnecting.",
        );
        expect(captures.disposeCount).toBe(0);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails once and disposes when a reconnect snapshot is not an exact suffix", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.rlmQuiescenceAvailable = true;
        captures.rlmQuiescenceRelease = yield* Deferred.make<void>();
        captures.rlmQuiescenceObserved = yield* Queue.unbounded<string>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "reject an ambiguous snapshot" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.rlmQuiescenceObserved);
        yield* offer(captures, {
          _tag: "MessageCompleted",
          message: assistantMessage("observed tool boundary", "toolUse"),
        });
        captures.rlmConnectionGeneration = 1;
        captures.rlmContinuityValid = false;
        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, messageCount: 1 },
          messages: [assistantMessage("different native history", "toolUse")],
          lastEventSequence: 42,
          replayContinuity: "unavailable",
          connectionGeneration: 1,
        });
        yield* Deferred.succeed(captures.rlmQuiescenceRelease, undefined);
        yield* Fiber.join(running);
        yield* awaitObservedType(subscription.observed, "session.exited");

        const turnEvents = subscription.events.filter((event) => event.turnId === started.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(turnEvents.find((event) => event.type === "turn.completed")).toMatchObject({
          payload: {
            state: "failed",
            errorMessage:
              "Prime Agent could not safely recover the active turn after reconnecting.",
          },
        });
        expect(turnEvents.find((event) => event.type === "runtime.error")).toMatchObject({
          payload: {
            message: "Prime Agent could not safely recover the active turn after reconnecting.",
          },
        });
        expect(encodeUnknownJson(turnEvents)).not.toContain(
          "Prime Agent stopped before sending a final response.",
        );
        expect(captures.disposeCount).toBe(1);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps an automatic reconnect continuation attached to the original turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "continue after reconnect" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);

        const failedMessage = {
          ...assistantMessage("", "error"),
          errorMessage: "PRIVATE reconnect teardown cause",
        } satisfies PrimeDaemonMessage;
        yield* offer(captures, { _tag: "MessageStarted", message: failedMessage });
        yield* offer(captures, { _tag: "MessageCompleted", message: failedMessage });
        yield* offer(captures, { _tag: "RunCompleted", messages: [failedMessage] });
        yield* offer(captures, {
          ...initialSnapshot(),
          state: { ...initialSnapshot().state, isStreaming: true, retryAttempt: 1 },
        });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "active resync barrier" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        yield* TestClock.adjust(PRIME_AGENT_FAILED_RUN_SETTLEMENT_GRACE_MS + 1);
        expect(running.pollUnsafe()).toBeUndefined();

        const toolOnlyMessage = assistantMessage("preparing the tool", "toolUse");
        yield* offer(captures, { _tag: "MessageStarted", message: toolOnlyMessage });
        yield* offer(captures, { _tag: "MessageCompleted", message: toolOnlyMessage });
        yield* offer(captures, { _tag: "RunCompleted", messages: [toolOnlyMessage] });
        yield* offer(captures, { _tag: "RunStarted" });

        const finalMessage = assistantMessage("the recovered final response");
        yield* offer(captures, {
          _tag: "AssistantStream",
          phase: "delta",
          kind: "text",
          delta: finalMessage.text,
        });
        yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
        yield* offer(captures, { _tag: "RunCompleted", messages: [finalMessage] });

        const result = yield* Fiber.join(running);
        expect(result.turnId).toBe(started.turnId);
        const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        const recoveredItemId = `assistant:${result.turnId}:segment:2`;
        const recoveredStartIndex = turnEvents.findIndex(
          (event) => event.type === "item.started" && event.itemId === recoveredItemId,
        );
        const recoveredDeltaIndex = turnEvents.findIndex(
          (event) =>
            event.type === "content.delta" &&
            event.itemId === recoveredItemId &&
            event.payload.streamKind === "assistant_text" &&
            event.payload.delta === finalMessage.text,
        );
        expect(recoveredStartIndex).toBeGreaterThanOrEqual(0);
        expect(recoveredDeltaIndex).toBeGreaterThan(recoveredStartIndex);
        expect(
          turnEvents.some(
            (event) =>
              (event.type === "runtime.warning" || event.type === "runtime.error") &&
              typeof event.payload.detail === "object" &&
              event.payload.detail !== null &&
              "kind" in event.payload.detail &&
              event.payload.detail.kind === "missing-final-response",
          ),
        ).toBe(false);
        expect(encodeUnknownJson(subscription.events)).not.toContain(
          "PRIVATE reconnect teardown cause",
        );
        const providerThread = yield* adapter.readThread(threadId);
        expect(providerThread.turns.every((turn) => turn.items.length === 0)).toBe(true);
        expect(encodeUnknownJson(providerThread)).not.toContain("PRIVATE reconnect teardown cause");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps a long automatic compaction and its idle reconnect gap attached to the turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          yield* awaitObservedType(subscription.observed, "thread.started");

          const running = yield* adapter
            .sendTurn({ threadId, input: "continue through compaction" })
            .pipe(Effect.forkChild);
          const started = yield* awaitObservedType(subscription.observed, "turn.started");
          yield* Queue.take(captures.promptObserved!);

          const toolOnlyMessage = assistantMessage("preparing the next step", "toolUse");
          yield* offer(captures, { _tag: "RunStarted" });
          yield* offer(captures, { _tag: "RunCompleted", messages: [toolOnlyMessage] });
          yield* offer(captures, { _tag: "CompactionStarted" });
          const compactionStarted = yield* awaitObservedType(subscription.observed, "item.started");
          expect(compactionStarted).toMatchObject({
            turnId: started.turnId,
            payload: { itemType: "context_compaction", status: "inProgress" },
          });

          yield* TestClock.adjust(PRIME_AGENT_FAILED_RUN_SETTLEMENT_GRACE_MS + 1);
          expect(running.pollUnsafe()).toBeUndefined();
          expect(subscription.events.some((event) => event.type === "turn.completed")).toBe(false);

          yield* offer(captures, {
            _tag: "CompactionCompleted",
            outcome: "completed",
            willRetry: false,
          });
          const compactionCompleted = yield* awaitObservedType(
            subscription.observed,
            "item.completed",
          );
          expect(compactionCompleted).toMatchObject({
            turnId: started.turnId,
            itemId: compactionStarted.itemId,
            payload: { itemType: "context_compaction", status: "completed" },
          });

          // Prime schedules the continuation after compaction. A reconnect can
          // observe the intentional idle gap before the next agent_start.
          yield* offer(captures, initialSnapshot());
          yield* offer(captures, { _tag: "SessionInfoChanged", name: "idle gap barrier" });
          yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
          expect(running.pollUnsafe()).toBeUndefined();
          expect(subscription.events.some((event) => event.type === "runtime.error")).toBe(false);

          yield* offer(captures, { _tag: "RunStarted" });
          const finalMessage = assistantMessage("the final response after compaction");
          yield* offer(captures, { _tag: "MessageStarted", message: finalMessage });
          yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
          yield* offer(captures, { _tag: "RunCompleted", messages: [finalMessage] });

          const result = yield* Fiber.join(running);
          expect(result.turnId).toBe(started.turnId);
          const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
          expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
          expect(
            turnEvents.some(
              (event) =>
                event.type === "runtime.error" &&
                typeof event.payload.detail === "object" &&
                event.payload.detail !== null &&
                "kind" in event.payload.detail &&
                event.payload.detail.kind === "missing-final-response",
            ),
          ).toBe(false);
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("restarts bounded handoff grace from an idle resync that replaces compaction end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "recover a missing compaction terminal" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        const toolOnlyMessage = assistantMessage("", "toolUse");
        yield* offer(captures, { _tag: "RunCompleted", messages: [toolOnlyMessage] });
        yield* offer(captures, { _tag: "CompactionStarted" });
        yield* awaitObservedType(subscription.observed, "item.started");
        yield* TestClock.adjust(PRIME_AGENT_FAILED_RUN_SETTLEMENT_GRACE_MS + 1);
        expect(running.pollUnsafe()).toBeUndefined();

        // The reconnect snapshot is authoritative even when compaction_end was
        // not replayed. It must replace the grace consumed by the long compaction.
        yield* offer(captures, initialSnapshot());
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "idle resync barrier" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        expect(running.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust(PRIME_AGENT_FAILED_RUN_SETTLEMENT_GRACE_MS);
        const result = yield* Fiber.join(running);
        expect(result.turnId).toBe(started.turnId);
        const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(turnEvents.find((event) => event.type === "turn.completed")).toMatchObject({
          payload: { state: "completed" },
        });
        expect(
          turnEvents.some(
            (event) =>
              event.type === "runtime.error" &&
              event.payload.message ===
                "Prime Agent could not reconcile the active turn after reconnecting.",
          ),
        ).toBe(false);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("completes overflow compaction before keeping its prompt retry attached", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "recover an overflowing prompt" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        const overflowMessage = {
          ...assistantMessage("", "error"),
          errorMessage: "PRIVATE context overflow detail",
        } satisfies PrimeDaemonMessage;
        yield* offer(captures, { _tag: "RunCompleted", messages: [overflowMessage] });
        yield* offer(captures, { _tag: "CompactionStarted" });
        const compactionStarted = yield* awaitObservedType(subscription.observed, "item.started");
        yield* TestClock.adjust(PRIME_AGENT_FAILED_RUN_SETTLEMENT_GRACE_MS / 2);
        yield* offer(captures, {
          _tag: "CompactionCompleted",
          outcome: "completed",
          willRetry: true,
        });
        const compactionCompleted = yield* awaitObservedType(
          subscription.observed,
          "item.completed",
        );
        expect(compactionCompleted).toMatchObject({
          turnId: started.turnId,
          itemId: compactionStarted.itemId,
          payload: { itemType: "context_compaction", status: "completed" },
        });
        expect(yield* adapter.getSessionCompaction!(threadId)).toMatchObject({
          status: "idle",
          abortable: false,
        });
        yield* TestClock.adjust(PRIME_AGENT_FAILED_RUN_SETTLEMENT_GRACE_MS / 2 + 1);
        expect(running.pollUnsafe()).toBeUndefined();
        expect(subscription.events.some((event) => event.type === "turn.completed")).toBe(false);

        yield* offer(captures, { _tag: "RunStarted" });
        const finalMessage = assistantMessage("recovered after overflow");
        yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
        yield* offer(captures, { _tag: "RunCompleted", messages: [finalMessage] });
        const result = yield* Fiber.join(running);
        expect(result.turnId).toBe(started.turnId);
        expect(
          subscription.events.filter(
            (event) => event.type === "turn.completed" && event.turnId === result.turnId,
          ),
        ).toHaveLength(1);
        expect(encodeUnknownJson(subscription.events)).not.toContain(
          "PRIVATE context overflow detail",
        );
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not duplicate compaction completion when overflow recovery is exhausted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "exhaust overflow recovery" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        const firstOverflow = {
          ...assistantMessage("", "error"),
          errorMessage: "PRIVATE first overflow",
        } satisfies PrimeDaemonMessage;
        yield* offer(captures, { _tag: "RunCompleted", messages: [firstOverflow] });
        yield* offer(captures, { _tag: "CompactionStarted" });
        yield* awaitObservedType(subscription.observed, "item.started");
        yield* offer(captures, {
          _tag: "CompactionCompleted",
          outcome: "completed",
          willRetry: true,
        });
        yield* awaitObservedType(subscription.observed, "item.completed");

        yield* offer(captures, { _tag: "RunStarted" });
        const secondOverflow = {
          ...assistantMessage("", "error"),
          errorMessage: "PRIVATE second overflow",
        } satisfies PrimeDaemonMessage;
        yield* offer(captures, { _tag: "RunCompleted", messages: [secondOverflow] });
        // Prime reports exhausted recovery with compaction_end but no matching
        // compaction_start. It is a failure notice, not a second lifecycle item.
        yield* offer(captures, {
          _tag: "CompactionCompleted",
          outcome: "failed",
          willRetry: false,
        });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "overflow barrier" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        expect(
          subscription.events.filter(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "context_compaction",
          ),
        ).toHaveLength(1);
        expect(running.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust(PRIME_AGENT_FAILED_RUN_SETTLEMENT_GRACE_MS);
        const result = yield* Fiber.join(running);
        expect(result.turnId).toBe(started.turnId);
        const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
        expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(turnEvents.find((event) => event.type === "turn.completed")).toMatchObject({
          payload: {
            state: "failed",
            errorMessage: "Prime Agent stopped before sending a final response.",
          },
        });
        expect(encodeUnknownJson(turnEvents)).not.toContain("PRIVATE first overflow");
        expect(encodeUnknownJson(turnEvents)).not.toContain("PRIVATE second overflow");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("settles a genuinely failed daemon run after the bounded retry handoff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "fail safely" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        const failedMessage = {
          ...assistantMessage("", "error"),
          errorMessage: "PRIVATE provider error",
        } satisfies PrimeDaemonMessage;
        yield* offer(captures, { _tag: "MessageCompleted", message: failedMessage });
        yield* offer(captures, { _tag: "RunCompleted", messages: [failedMessage] });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "failure barrier" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
        expect(running.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust(PRIME_AGENT_FAILED_RUN_SETTLEMENT_GRACE_MS);
        const result = yield* Fiber.join(running);
        expect(result.turnId).toBe(started.turnId);
        const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
        expect(turnEvents.find((event) => event.type === "runtime.error")).toMatchObject({
          payload: {
            message: "Prime Agent stopped before sending a final response.",
            detail: { kind: "missing-final-response", outcome: "failed" },
          },
        });
        expect(turnEvents.find((event) => event.type === "turn.completed")).toMatchObject({
          payload: {
            state: "failed",
            errorMessage: "Prime Agent stopped before sending a final response.",
          },
        });
        expect(encodeUnknownJson(turnEvents)).not.toContain("PRIVATE provider error");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps input admitted during a failed-run handoff attached to the turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "initial" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        const failedMessage = {
          ...assistantMessage("", "error"),
          errorMessage: "PRIVATE transient failure",
        } satisfies PrimeDaemonMessage;
        yield* offer(captures, { _tag: "RunCompleted", messages: [failedMessage] });
        yield* offer(captures, { _tag: "SessionInfoChanged", name: "handoff input barrier" });
        yield* awaitObservedType(subscription.observed, "thread.metadata.updated");

        const steered = yield* adapter.sendTurn({ threadId, input: "continue this turn" });
        expect(steered.turnId).toBe(started.turnId);
        yield* TestClock.adjust(PRIME_AGENT_FAILED_RUN_SETTLEMENT_GRACE_MS + 1);
        expect(running.pollUnsafe()).toBeUndefined();
        expect(subscription.events.filter((event) => event.type === "turn.completed")).toHaveLength(
          0,
        );

        yield* offer(captures, { _tag: "RunStarted" });
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 0,
          steeringCount: 0,
          followUpCount: 0,
        });
        const finalMessage = assistantMessage("continued final response");
        yield* offer(captures, { _tag: "MessageStarted", message: finalMessage });
        yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
        yield* offer(captures, { _tag: "RunCompleted", messages: [finalMessage] });
        const result = yield* Fiber.join(running);
        expect(result.turnId).toBe(started.turnId);
        expect(
          subscription.events.filter(
            (event) => event.type === "turn.completed" && event.turnId === result.turnId,
          ),
        ).toHaveLength(1);
        expect(encodeUnknownJson(subscription.events)).not.toContain("PRIVATE transient failure");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("steers an active daemon run without opening or settling another turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");
        yield* awaitObservedType(subscription.observed, "thread.token-usage.updated");
        expect(captures.sessionStatsCount).toBe(1);

        const running = yield* adapter
          .sendTurn({ threadId, input: "first" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);

        const changedControls = yield* adapter
          .sendTurn({
            threadId,
            input: "change controls",
            modelSelection: {
              instanceId,
              model: "default",
              options: [{ id: "thinkingLevel", value: "xhigh" }],
            },
          })
          .pipe(Effect.result);
        expect(changedControls._tag).toBe("Failure");

        const steered = yield* adapter.sendTurn({
          threadId,
          input: "focus on the failure",
          modelSelection: {
            instanceId,
            model: "default",
            options: [
              { id: "thinkingLevel", value: "medium" },
              { id: "serviceTier", value: "prime-default" },
            ],
          },
        });
        expect(steered.turnId).toBe(started.turnId);
        expect(captures.steers).toEqual([{ text: "focus on the failure", images: [] }]);
        expect(captures.thinkingLevels).toEqual([]);
        expect(captures.serviceTiers).toEqual([]);
        expect(captures.order).toEqual(["prompt", "steer"]);
        expect(subscription.events.filter((event) => event.type === "turn.started")).toHaveLength(
          1,
        );
        expect(running.pollUnsafe()).toBeUndefined();

        const firstRunMessage = assistantMessage("base");
        yield* offer(captures, {
          _tag: "TurnCompleted",
          message: firstRunMessage,
          toolResults: [],
        });
        yield* offer(captures, { _tag: "RunCompleted", messages: [firstRunMessage] });
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 0,
          steeringCount: 0,
          followUpCount: 0,
        });
        yield* offer(captures, {
          _tag: "RetryStarted",
          attempt: 1,
          maxAttempts: 2,
          delayMs: 0,
        });
        yield* awaitObservedType(subscription.observed, "item.started");
        expect(running.pollUnsafe()).toBeUndefined();
        expect(subscription.events.filter((event) => event.type === "turn.completed")).toHaveLength(
          0,
        );
        expect(captures.sessionStatsCount).toBe(1);

        yield* offer(captures, { _tag: "RunStarted" });
        const finalMessage = assistantMessage("done");
        yield* offer(captures, {
          _tag: "TurnCompleted",
          message: finalMessage,
          toolResults: [],
        });
        yield* offer(captures, { _tag: "RunCompleted", messages: [finalMessage] });
        yield* Fiber.join(running);
        yield* awaitObservedType(subscription.observed, "thread.token-usage.updated");
        expect(captures.sessionStatsCount).toBe(2);
        const completed = subscription.events.filter((event) => event.type === "turn.completed");
        expect(completed).toHaveLength(1);
        expect(completed[0]?.payload.usage).toEqual({
          inputTokens: 22,
          outputTokens: 14,
          cachedInputTokens: 6,
          cacheWriteTokens: 4,
          totalTokens: 46,
        });
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("settles when a queued steer fails before a native run starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "first" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        yield* adapter.sendTurn({ threadId, input: "queued one" });
        yield* adapter.sendTurn({ threadId, input: "queued two" });

        const firstRunMessage = assistantMessage("base");
        yield* offer(captures, { _tag: "RunCompleted", messages: [firstRunMessage] });
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 1,
          steeringCount: 1,
          followUpCount: 0,
          active: { kind: "turn", phase: "preparing" },
        });
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 1,
          steeringCount: 1,
          followUpCount: 0,
        });
        yield* Fiber.join(running);

        const completions = subscription.events.filter((event) => event.type === "turn.completed");
        expect(completions).toHaveLength(1);
        expect(completions[0]?.payload).toMatchObject({
          state: "failed",
          errorMessage: "Prime Agent could not start a queued input.",
        });
        const runtimeErrors = subscription.events.filter((event) => event.type === "runtime.error");
        expect(runtimeErrors).toHaveLength(1);
        expect(runtimeErrors[0]).toMatchObject({
          payload: {
            message: "Prime Agent stopped before sending a final response.",
            detail: { kind: "missing-final-response", outcome: "failed" },
          },
        });
        expect(captures.steers.map((steer) => steer.text)).toEqual(["queued one", "queued two"]);
        expect(captures.order.at(-1)).toBe("abort-clear");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps a queued continuation that started in a streaming resync through compaction",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          yield* awaitObservedType(subscription.observed, "thread.started");

          const running = yield* adapter
            .sendTurn({ threadId, input: "first" })
            .pipe(Effect.forkChild);
          const started = yield* awaitObservedType(subscription.observed, "turn.started");
          yield* Queue.take(captures.promptObserved!);
          yield* adapter.sendTurn({ threadId, input: "queued continuation" });

          const firstRunMessage = assistantMessage("base");
          yield* offer(captures, { _tag: "RunCompleted", messages: [firstRunMessage] });
          yield* offer(captures, {
            _tag: "QueueChanged",
            queuedCount: 1,
            steeringCount: 1,
            followUpCount: 0,
            active: { kind: "turn", phase: "preparing" },
          });
          yield* offer(captures, {
            ...initialSnapshot(),
            state: {
              ...initialSnapshot().state,
              isStreaming: true,
              inputQueue: {
                ...initialSnapshot().state.inputQueue,
                activeAction: true,
              },
            },
          });

          const queuedProgress = assistantMessage("queued progress", "toolUse");
          yield* offer(captures, { _tag: "MessageCompleted", message: queuedProgress });
          yield* offer(captures, { _tag: "RunCompleted", messages: [queuedProgress] });
          yield* offer(captures, { _tag: "CompactionStarted" });
          yield* offer(captures, {
            _tag: "CompactionCompleted",
            outcome: "completed",
            willRetry: false,
          });
          yield* offer(captures, {
            _tag: "QueueChanged",
            queuedCount: 0,
            steeringCount: 0,
            followUpCount: 0,
          });
          yield* offer(captures, { _tag: "RunStarted" });

          const finalMessage = assistantMessage("queued continuation complete");
          yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
          yield* offer(captures, { _tag: "RunCompleted", messages: [finalMessage] });
          yield* Fiber.join(running);

          const turnEvents = subscription.events.filter((event) => event.turnId === started.turnId);
          expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
          expect(turnEvents.find((event) => event.type === "turn.completed")).toMatchObject({
            payload: { state: "completed" },
          });
          expect(encodeUnknownJson(turnEvents)).toContain("queued continuation complete");
          expect(encodeUnknownJson(turnEvents)).not.toContain(
            "Prime Agent could not start a queued input.",
          );
          expect(encodeUnknownJson(turnEvents)).not.toContain(
            "Prime Agent stopped before sending a final response.",
          );
          expect(captures.order).not.toContain("abort-clear");
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("finishes detached cleanup when a failed queued run cannot clear the queue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.abortClearFailure = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "first" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        yield* adapter.sendTurn({ threadId, input: "queued" });
        yield* offer(captures, {
          _tag: "RunCompleted",
          messages: [assistantMessage("base")],
        });
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 0,
          steeringCount: 0,
          followUpCount: 0,
          active: { kind: "turn", phase: "preparing" },
        });
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 0,
          steeringCount: 0,
          followUpCount: 0,
        });

        yield* Fiber.join(running);
        const exited = yield* awaitObservedType(subscription.observed, "session.exited");
        expect(exited).toMatchObject({ payload: { exitKind: "graceful" } });
        expect(captures.disposeCount).toBe(1);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "validates interaction responses, retains failed native requests, and rejects stale ids",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          yield* awaitObservedType(subscription.observed, "thread.started");

          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-select-secret",
              method: "select",
              title: "Target",
              options: ["web", "desktop"],
            },
          });
          const requested = yield* awaitObservedType(
            subscription.observed,
            "interaction.requested",
          );
          const requestId = requested.requestId!;

          const wrongKind = yield* adapter.respondToInteraction!(threadId, requestId, {
            kind: "confirmed",
            confirmed: true,
          }).pipe(Effect.result);
          const wrongValue = yield* adapter.respondToInteraction!(threadId, requestId, {
            kind: "selected",
            value: "mobile",
          }).pipe(Effect.result);
          expect(wrongKind._tag).toBe("Failure");
          expect(wrongValue._tag).toBe("Failure");
          expect(captures.extensions).toEqual([]);

          captures.extensionFailure = true;
          const nativeFailure = yield* adapter.respondToInteraction!(threadId, requestId, {
            kind: "selected",
            value: "desktop",
          }).pipe(Effect.result);
          expect(nativeFailure._tag).toBe("Failure");
          captures.extensionFailure = false;
          yield* adapter.respondToInteraction!(threadId, requestId, {
            kind: "selected",
            value: "desktop",
          });
          yield* awaitObservedType(subscription.observed, "interaction.resolved");
          expect(captures.extensions).toEqual([
            { id: "native-select-secret", response: { value: "desktop" } },
          ]);

          const duplicate = yield* adapter.respondToInteraction!(threadId, requestId, {
            kind: "cancelled",
          }).pipe(Effect.result);
          const unknown = yield* adapter.respondToInteraction!(
            threadId,
            SessionInteractionRequestId.make("00000000-0000-4000-8000-000000000099"),
            { kind: "cancelled" },
          ).pipe(Effect.result);
          expect(duplicate._tag).toBe("Failure");
          expect(unknown._tag).toBe("Failure");

          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-confirm-secret",
              method: "confirm",
              title: "Continue?",
              message: "Proceed now",
            },
          });
          const confirm = yield* awaitObservedType(subscription.observed, "interaction.requested");
          yield* adapter.respondToInteraction!(threadId, confirm.requestId!, {
            kind: "confirmed",
            confirmed: false,
          });
          yield* awaitObservedType(subscription.observed, "interaction.resolved");

          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-input-secret",
              method: "input",
              title: "Branch",
              placeholder: "feature/name",
            },
          });
          const input = yield* awaitObservedType(subscription.observed, "interaction.requested");
          yield* adapter.respondToInteraction!(threadId, input.requestId!, {
            kind: "submitted",
            value: "submitted-secret-marker",
          });
          yield* awaitObservedType(subscription.observed, "interaction.resolved");
          expect(encodeUnknownJson(subscription.events)).not.toContain("submitted-secret-marker");

          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-editor-secret",
              method: "editor",
              title: "Plan",
            },
          });
          const editorWarning = yield* awaitObservedType(subscription.observed, "runtime.warning");
          expect(editorWarning).toMatchObject({
            payload: { message: expect.stringContaining("prefills cannot be stored safely") },
          });

          expect(captures.extensions.slice(1)).toEqual([
            { id: "native-confirm-secret", response: { confirmed: false } },
            { id: "native-input-secret", response: { value: "submitted-secret-marker" } },
            { id: "native-editor-secret", response: { cancelled: true } },
          ]);
          expect(
            subscription.events.filter((event) => event.type === "interaction.requested"),
          ).toHaveLength(3);
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "expires blocking interactions without replying to an already-timed-out native dialog",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          yield* awaitObservedType(subscription.observed, "thread.started");
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-timeout-secret",
              method: "input",
              title: "Short-lived input",
              timeoutMs: 1_000,
            },
          });
          const requested = yield* awaitObservedType(
            subscription.observed,
            "interaction.requested",
          );

          yield* TestClock.adjust("1 second");
          const resolved = yield* awaitObservedType(subscription.observed, "interaction.resolved");
          expect(resolved).toMatchObject({
            requestId: requested.requestId,
            payload: { response: { kind: "cancelled" } },
          });
          expect(captures.extensions).toEqual([]);
          const stale = yield* adapter.respondToInteraction!(threadId, requested.requestId!, {
            kind: "cancelled",
          }).pipe(Effect.result);
          expect(stale._tag).toBe("Failure");
          expect(
            subscription.events.filter(
              (event) =>
                event.type === "interaction.resolved" && event.requestId === requested.requestId,
            ),
          ).toHaveLength(1);
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("aborts the admission signal before runtime abort and settles cancellation once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const fiber = yield* adapter
          .sendTurn({ threadId, input: "cancel me" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        const turnId = subscription.events.findLast(
          (event) => event.type === "turn.started",
        )!.turnId!;
        yield* adapter.interruptTurn(threadId, turnId);
        yield* Fiber.join(fiber);
        yield* awaitObservedType(subscription.observed, "turn.completed");

        expect(captures.order).toEqual(["prompt", "abort-clear"]);
        const completions = subscription.events.filter(
          (event) => event.type === "turn.completed" && event.turnId === turnId,
        );
        expect(completions).toHaveLength(1);
        expect(completions[0]).toMatchObject({ payload: { state: "cancelled" } });

        const lateMessage = assistantMessage("cancelled", "aborted");
        yield* offer(captures, {
          _tag: "TurnCompleted",
          message: lateMessage,
          toolResults: [],
        });
        yield* offer(captures, { _tag: "RunCompleted", messages: [lateMessage] });
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: { id: "interrupt-barrier", method: "barrier" },
        });
        yield* awaitObservedType(subscription.observed, "runtime.warning");
        expect(
          subscription.events.filter(
            (event) => event.type === "turn.completed" && event.turnId === turnId,
          ),
        ).toHaveLength(1);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes safe nonblocking presentation updates and ignores malformed requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-notify-secret",
            method: "notify",
            message: "Saved",
            notifyType: "warning",
            text: "native notification payload",
          },
        });
        const notification = yield* awaitObservedType(
          subscription.observed,
          "session-presentation.updated",
        );
        expect(notification).toMatchObject({
          payload: {
            presentation: { kind: "notification", message: "Saved", level: "warning" },
          },
        });

        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-status-secret",
            method: "setStatus",
            statusKey: " build ",
            statusText: "Running",
            text: "native status payload",
          },
        });
        const status = yield* awaitObservedType(
          subscription.observed,
          "session-presentation.updated",
        );
        expect(status).toMatchObject({
          payload: { presentation: { kind: "status", key: "build", text: "Running" } },
        });

        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-widget-secret",
            method: "setWidget",
            widgetKey: "plan",
            widgetLines: ["1. Test", "2. Ship"],
            widgetPlacement: "belowEditor",
            text: "native widget payload",
          },
        });
        const widget = yield* awaitObservedType(
          subscription.observed,
          "session-presentation.updated",
        );
        expect(widget).toMatchObject({
          payload: {
            presentation: {
              kind: "widget",
              key: "plan",
              lines: ["1. Test", "2. Ship"],
              placement: "belowEditor",
            },
          },
        });

        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-fire-and-forget-secret",
            method: "setTitle",
            title: "New title",
          },
        });
        yield* awaitObservedType(subscription.observed, "runtime.warning");
        expect(captures.extensions).toEqual([]);
        expect(captures.order).toEqual([]);

        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: { id: "native-malformed-notify", method: "notify", message: "   " },
        });
        const presentationWarning = yield* awaitObservedType(
          subscription.observed,
          "runtime.warning",
        );
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-malformed-select",
            method: "select",
            title: "Choose",
            options: [],
          },
        });
        const blockingWarning = yield* awaitObservedType(subscription.observed, "runtime.warning");

        expect(captures.extensions).toEqual([
          { id: "native-malformed-select", response: { cancelled: true } },
        ]);
        expect(encodeUnknownJson([notification, status, widget])).not.toContain("native");
        expect(presentationWarning).toMatchObject({
          payload: {
            message: "Prime Agent sent an unsupported interaction update; it was ignored.",
          },
        });
        expect(blockingWarning).toMatchObject({
          payload: { message: "Prime Agent sent a malformed interaction request; it was ignored." },
        });
        expect(encodeUnknownJson([presentationWarning, blockingWarning])).not.toContain(
          "malformed-select",
        );
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails closed when extension cancellation cannot be delivered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.extensionFailure = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "blocked interaction" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-extension-secret",
            method: "confirm",
            title: "   ",
            text: "native secret payload",
          },
        });
        yield* awaitObservedType(subscription.observed, "runtime.error");
        const result = yield* Fiber.join(turnFiber);

        expect(captures.order).toEqual(["prompt", "abort-clear"]);
        expect(
          subscription.events.filter(
            (event) => event.type === "turn.completed" && event.turnId === result.turnId,
          ),
        ).toHaveLength(1);
        const serialized = encodeUnknownJson(subscription.events);
        expect(serialized).not.toContain("native-extension-secret");
        expect(serialized).not.toContain("native/secret-method");
        expect(serialized).not.toContain("native secret payload");
        expect(serialized).not.toContain("native secret failure");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "cancels pending interactions before stop disposal and resolves each exactly once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
          yield* awaitObservedType(subscription.observed, "thread.started");
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: { id: "native-stop-secret", method: "input", title: "Pending input" },
          });
          const requested = yield* awaitObservedType(
            subscription.observed,
            "interaction.requested",
          );

          yield* adapter.stopSession(threadId);
          const resolved = yield* awaitObservedType(subscription.observed, "interaction.resolved");
          yield* awaitObservedType(subscription.observed, "session.exited");

          expect(resolved).toMatchObject({
            requestId: requested.requestId,
            payload: { response: { kind: "cancelled" } },
          });
          expect(
            subscription.events.filter(
              (event) =>
                event.type === "interaction.resolved" && event.requestId === requested.requestId,
            ),
          ).toHaveLength(1);
          expect(captures.extensions).toEqual([
            { id: "native-stop-secret", response: { cancelled: true } },
          ]);
          expect(captures.order).toEqual(["dispose", "extension:native-stop-secret"]);
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("continues stop teardown when interaction cancellation fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.extensionFailure = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: { id: "native-stop-failure", method: "confirm", title: "Pending" },
        });
        yield* awaitObservedType(subscription.observed, "interaction.requested");

        yield* adapter.stopSession(threadId);
        yield* awaitObservedType(subscription.observed, "session.exited");

        expect(captures.disposeCount).toBe(1);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(yield* adapter.listSessions()).toEqual([]);
        expect(subscription.events.filter((event) => event.type === "session.exited")).toHaveLength(
          1,
        );
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("stops multiple sessions with bounded cleanup and one terminal event each", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstCaptures = makeCaptures();
        const secondCaptures = makeCaptures();
        let starts = 0;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: (input) =>
            fakeRuntimeFactory(starts++ === 0 ? firstCaptures : secondCaptures)(input),
        });
        const subscription = yield* subscribe(adapter);
        const secondThreadId = ThreadId.make("thread-prime-second");
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* adapter.startSession({
          threadId: secondThreadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* awaitObservedType(subscription.observed, "thread.started");

        yield* adapter.stopAll();

        expect(firstCaptures.disposeCount).toBe(1);
        expect(secondCaptures.disposeCount).toBe(1);
        expect(yield* adapter.listSessions()).toEqual([]);
        const exits = subscription.events.filter((event) => event.type === "session.exited");
        expect(exits).toHaveLength(2);
        expect(new Set(exits.map((event) => event.threadId))).toEqual(
          new Set([threadId, secondThreadId]),
        );
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps ProviderService stop bounded behind a stalled subscriber and relays one ordered exit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          const providerKind = ProviderDriverKind.make("primeAgent");
          const providerInstanceId = defaultInstanceIdForDriver(providerKind);
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId: providerInstanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const pull = yield* Stream.toPull(adapter.streamEvents);
          const initialPull = yield* pull.pipe(Effect.forkChild);
          yield* Effect.yieldNow;

          const serviceSubscribed = yield* Deferred.make<void>();
          const serviceAdapter = {
            ...adapter,
            streamEvents: adapter.streamEvents.pipe(
              Stream.onStart(Deferred.succeed(serviceSubscribed, undefined)),
            ),
          };
          const registry = makeAdapterRegistryMock({ [providerKind]: serviceAdapter });
          const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
            Layer.provide(SqlitePersistenceMemory),
          );
          const directoryLayer = ProviderSessionDirectoryLive.pipe(
            Layer.provide(runtimeRepositoryLayer),
          );
          const providerLayer = Layer.mergeAll(
            makeProviderServiceLive().pipe(
              Layer.provide(
                Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry),
              ),
              Layer.provide(directoryLayer),
              Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
              Layer.provideMerge(AnalyticsService.layerTest),
              Layer.provide(
                Layer.succeed(
                  ProviderEventLoggers.ProviderEventLoggers,
                  ProviderEventLoggers.NoOpProviderEventLoggers,
                ),
              ),
            ),
            directoryLayer,
            runtimeRepositoryLayer,
          );
          const providerScope = yield* Scope.make();
          const services = yield* Layer.build(providerLayer).pipe(Scope.provide(providerScope));
          const provider = yield* ProviderService.ProviderService.pipe(Effect.provide(services));
          const subscription = yield* subscribe(provider);
          yield* Deferred.await(serviceSubscribed);
          const session = yield* provider.startSession(threadId, {
            provider: providerKind,
            providerInstanceId,
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          const initialEvents = [...(yield* Fiber.join(initialPull))];
          yield* awaitObservedType(subscription.observed, "thread.started");
          const turnFiber = yield* provider
            .sendTurn({
              threadId,
              input: "preserve every assistant delta while delivery is stalled",
              sessionIncarnationId: session.sessionIncarnationId,
            })
            .pipe(Effect.forkChild);
          yield* Queue.take(captures.promptObserved!);

          let markAssistantProcessed!: () => void;
          const assistantProcessed = new Promise<void>((resolve) => {
            markAssistantProcessed = resolve;
          });
          captures.workerRecoveryTerminalResponseObserved = markAssistantProcessed;
          const deltaCount = PRIME_AGENT_EVENT_BUFFER_CAPACITY * 2;
          const deltas = Array.from({ length: deltaCount }, (_, index) => `delta:${index};`);
          const message = assistantMessage(deltas.join(""));
          yield* offer(captures, { _tag: "MessageStarted", message });
          for (const delta of deltas) {
            yield* offer(captures, {
              _tag: "AssistantStream",
              phase: "delta",
              kind: "text",
              delta,
            });
          }
          yield* offer(captures, { _tag: "MessageCompleted", message });

          yield* Effect.promise(() => assistantProcessed);

          yield* provider.stopSession({ threadId });
          expect(subscription.events.some((event) => event.type === "session.exited")).toBe(false);

          const directEvents = [...initialEvents];
          while (!directEvents.some((event) => event.type === "session.exited")) {
            directEvents.push(...(yield* pull));
          }
          yield* awaitObservedType(subscription.observed, "session.exited");

          expect(
            subscription.events
              .filter((event) => event.type === "content.delta")
              .map((event) => event.payload.delta),
          ).toEqual(deltas);
          expect(
            directEvents
              .filter((event) => event.type === "content.delta")
              .map((event) => event.payload.delta),
          ).toEqual(deltas);
          expect(
            subscription.events.filter((event) => event.type === "session.exited"),
          ).toHaveLength(1);
          expect(directEvents.filter((event) => event.type === "session.exited")).toHaveLength(1);
          expect(yield* adapter.hasSession(threadId)).toBe(false);
          yield* Fiber.interrupt(turnFiber);
          yield* Fiber.interrupt(subscription.fiber);
          yield* Scope.close(providerScope, Exit.void);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps the replacement gate closed while scope-owned disposal is in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const oldCaptures = makeCaptures();
        oldCaptures.disposeObserved = yield* Queue.unbounded<void>();
        oldCaptures.disposeRelease = yield* Deferred.make<void>();
        const replacementCaptures = makeCaptures();
        const oldDelegate = fakeRuntimeFactory(oldCaptures);
        const replacementFactory = fakeRuntimeFactory(replacementCaptures);
        let oldRuntimeScope: Scope.Closeable | undefined;
        const scopeOwningFactory: NonNullable<
          PrimeAgentDaemonAdapterLiveOptions["runtimeFactory"]
        > = (input) =>
          Effect.gen(function* () {
            oldRuntimeScope = (yield* Scope.Scope) as Scope.Closeable;
            const runtime = yield* oldDelegate(input);
            const disposeCompletion = yield* Deferred.make<
              void,
              PrimeAgentDaemonSessionRuntimeError
            >();
            let disposeStarted = false;
            const dispose = Effect.suspend(() => {
              if (disposeStarted) return Deferred.await(disposeCompletion);
              disposeStarted = true;
              return runtime.dispose.pipe(
                Effect.onExit((exit) => Deferred.done(disposeCompletion, exit).pipe(Effect.ignore)),
              );
            });
            yield* Effect.addFinalizer(() => dispose.pipe(Effect.ignore));
            return { ...runtime, dispose };
          });
        let runtimeStartCount = 0;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: (input) => {
            runtimeStartCount += 1;
            return runtimeStartCount === 1 ? scopeOwningFactory(input) : replacementFactory(input);
          },
        });
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          sessionIncarnationId: RuntimeSessionId.make("prime-daemon-scope-owner-old"),
        });

        const scopeClose = yield* Scope.close(oldRuntimeScope!, Exit.void).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Queue.take(oldCaptures.disposeObserved);
        const stop = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
        const replacement = yield* adapter
          .startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            sessionIncarnationId: RuntimeSessionId.make("prime-daemon-scope-owner-replacement"),
          })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        expect(oldCaptures.disposeCount).toBe(1);
        expect(stop.pollUnsafe()).toBeUndefined();
        expect(replacement.pollUnsafe()).toBeUndefined();
        expect(runtimeStartCount).toBe(1);

        yield* Deferred.succeed(oldCaptures.disposeRelease, undefined);
        yield* Fiber.join(scopeClose);
        yield* Fiber.join(stop);
        const replacementSession = yield* Fiber.join(replacement);
        expect(replacementSession.sessionIncarnationId).toBe(
          RuntimeSessionId.make("prime-daemon-scope-owner-replacement"),
        );
        expect(runtimeStartCount).toBe(2);
        expect(oldCaptures.disposeCount).toBe(1);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("bounds four hung session cleanups by one global teardown window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = [makeCaptures(), makeCaptures(), makeCaptures(), makeCaptures()];
        for (const capture of captures) {
          capture.disposeObserved = yield* Queue.unbounded<void>();
          capture.disposeRelease = yield* Deferred.make<void>();
        }
        let starts = 0;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: (input) => fakeRuntimeFactory(captures[starts++]!)(input),
        });
        const subscription = yield* subscribe(adapter);
        const threadIds = [
          ThreadId.make("thread-prime-hung-1"),
          ThreadId.make("thread-prime-hung-2"),
          ThreadId.make("thread-prime-hung-3"),
          ThreadId.make("thread-prime-hung-4"),
        ];
        for (const currentThreadId of threadIds) {
          yield* adapter.startSession({
            threadId: currentThreadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
        }

        const stopFiber = yield* adapter.stopAll().pipe(Effect.forkChild);
        yield* Effect.all(
          captures.map((capture) => Queue.take(capture.disposeObserved!)),
          { concurrency: "unbounded", discard: true },
        );
        expect(captures.map((capture) => capture.disposeCount)).toEqual([1, 1, 1, 1]);
        expect(stopFiber.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust(PRIME_AGENT_SESSION_TEARDOWN_TIMEOUT_MS);
        yield* Fiber.join(stopFiber);
        expect(captures.map((capture) => capture.disposeCount)).toEqual([1, 1, 1, 1]);
        expect(yield* adapter.listSessions()).toEqual([]);
        yield* Effect.forEach(
          captures,
          (capture) => Deferred.succeed(capture.disposeRelease!, undefined),
          { concurrency: "unbounded", discard: true },
        );
        expect(subscription.events.filter((event) => event.type === "session.exited")).toHaveLength(
          4,
        );
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("treats SessionClosed as terminal cleanup without duplicate exit or completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        yield* offer(captures, { _tag: "ConnectionStatus", status: "reconnecting" });
        yield* awaitObservedType(subscription.observed, "session.state.changed");
        expect((yield* adapter.listSessions())[0]?.status).toBe("connecting");
        yield* offer(captures, { _tag: "ConnectionStatus", status: "connected" });
        yield* awaitObservedType(subscription.observed, "session.state.changed");
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");

        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "terminal" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        const preToolMessage = assistantMessage("partial response before bash");
        yield* offer(captures, { _tag: "MessageStarted", message: preToolMessage });
        yield* offer(captures, { _tag: "MessageCompleted", message: preToolMessage });
        yield* offer(captures, {
          _tag: "BashStarted",
          command: "PRIVATE command",
          excludeFromContext: false,
          transient: false,
        });
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: { id: "native-close-secret", method: "confirm", title: "Still pending?" },
        });
        const requested = yield* awaitObservedType(subscription.observed, "interaction.requested");
        yield* offer(captures, {
          _tag: "SessionClosed",
          error: "PRIVATE daemon closed /tmp/native.sock",
        });
        const resolved = yield* awaitObservedType(subscription.observed, "interaction.resolved");
        yield* awaitObservedType(subscription.observed, "turn.completed");
        yield* awaitObservedType(subscription.observed, "session.exited");
        const result = yield* Fiber.join(turnFiber);

        expect(captures.disposeCount).toBe(1);
        expect(captures.extensions).toEqual([]);
        expect(resolved).toMatchObject({
          requestId: requested.requestId,
          payload: { response: { kind: "cancelled" } },
        });
        expect(
          subscription.events.filter(
            (event) =>
              event.type === "interaction.resolved" && event.requestId === requested.requestId,
          ),
        ).toHaveLength(1);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(yield* adapter.listSessions()).toEqual([]);
        expect(
          subscription.events.filter(
            (event) => event.type === "turn.completed" && event.turnId === result.turnId,
          ),
        ).toHaveLength(1);
        expect(subscription.events.filter((event) => event.type === "session.exited")).toHaveLength(
          1,
        );
        expect(
          subscription.events.find(
            (event) =>
              event.type === "runtime.error" &&
              event.turnId === result.turnId &&
              typeof event.payload.detail === "object" &&
              event.payload.detail !== null &&
              "kind" in event.payload.detail &&
              event.payload.detail.kind === "missing-final-response",
          ),
        ).toBeDefined();
        expect(subscription.events.find((event) => event.type === "session.exited")).toMatchObject({
          payload: {
            exitKind: "error",
            reason: "Prime Agent session closed unexpectedly.",
          },
        });
        expect(encodeUnknownJson(subscription.events)).not.toContain("PRIVATE");
        const stoppedAgain = yield* adapter.stopSession(threadId).pipe(Effect.result);
        expect(stoppedAgain._tag).toBe("Failure");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "times out hung SessionClosed cleanup before starting a replacement and ignores the late old close",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const oldCaptures = makeCaptures();
          oldCaptures.disposeObserved = yield* Queue.unbounded<void>();
          oldCaptures.disposeRelease = yield* Deferred.make<void>();
          const replacementCaptures = makeCaptures();
          const oldFactory = fakeRuntimeFactory(oldCaptures);
          const replacementFactory = fakeRuntimeFactory(replacementCaptures);
          let runtimeStartCount = 0;
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: (input) =>
              (runtimeStartCount++ === 0 ? oldFactory : replacementFactory)(input),
          });
          const subscription = yield* subscribe(adapter);
          const oldIncarnationId = RuntimeSessionId.make("prime-daemon-old-incarnation");
          const replacementIncarnationId = RuntimeSessionId.make(
            "prime-daemon-replacement-incarnation",
          );
          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            sessionIncarnationId: oldIncarnationId,
          });
          yield* awaitObservedType(subscription.observed, "thread.started");

          yield* offer(oldCaptures, { _tag: "SessionClosed", error: "private old close" });
          yield* Queue.take(oldCaptures.disposeObserved);
          expect(yield* adapter.hasSession(threadId)).toBe(false);
          expect(yield* adapter.listSessions()).toEqual([]);

          const replacementFiber = yield* adapter
            .startSession({
              threadId,
              cwd: process.cwd(),
              runtimeMode: "full-access",
              sessionIncarnationId: replacementIncarnationId,
            })
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(replacementFiber.pollUnsafe()).toBeUndefined();
          expect(runtimeStartCount).toBe(1);

          yield* offer(oldCaptures, { _tag: "SessionClosed", error: "private late old close" });
          const concurrentStopFiber = yield* adapter
            .stopSession(threadId)
            .pipe(Effect.result, Effect.forkChild);
          yield* Effect.yieldNow;
          expect(concurrentStopFiber.pollUnsafe()).toBeUndefined();

          yield* TestClock.adjust(PRIME_AGENT_SESSION_TEARDOWN_TIMEOUT_MS);
          yield* awaitObservedType(subscription.observed, "session.exited");
          const concurrentStop = yield* Fiber.join(concurrentStopFiber);
          expect(concurrentStop._tag).toBe("Failure");
          const replacement = yield* Fiber.join(replacementFiber);

          expect(replacement.threadId).toBe(threadId);
          expect(runtimeStartCount).toBe(2);
          expect(oldCaptures.disposeCount).toBe(1);
          expect(replacementCaptures.disposeCount).toBe(0);
          expect(yield* adapter.hasSession(threadId)).toBe(true);
          expect(yield* adapter.listSessions()).toEqual([replacement]);
          const exits = subscription.events.filter((event) => event.type === "session.exited");
          expect(exits).toHaveLength(1);
          expect(exits[0]?.sessionIncarnationId).toBe(oldIncarnationId);
          const replacementEvents = subscription.events.filter(
            (event) =>
              event.sessionIncarnationId === replacementIncarnationId &&
              (event.type === "session.started" || event.type === "session.resources.updated"),
          );
          expect(replacementEvents.map((event) => event.type)).toEqual([
            "session.started",
            "session.resources.updated",
          ]);
          expect(
            subscription.events.some(
              (event) =>
                event.type !== "session.exited" &&
                event.createdAt === exits[0]?.createdAt &&
                event.sessionIncarnationId === replacementIncarnationId,
            ),
          ).toBe(false);

          yield* Deferred.succeed(oldCaptures.disposeRelease, undefined).pipe(Effect.ignore);
          yield* Effect.yieldNow;
          expect(yield* adapter.hasSession(threadId)).toBe(true);
          expect(
            subscription.events.filter((event) => event.type === "session.exited"),
          ).toHaveLength(1);
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("asks only fresh approval-required sessions and keeps native ids private", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const requestId = ProviderSessionSideQuestionRequestId.make("public-side-1");

        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        expect(yield* adapter.askSessionSideQuestion(threadId, requestId, "question")).toEqual({
          requestId,
          disposition: "answered",
          answer: "side answer",
        });
        expect(captures.sideQuestionCalls).toHaveLength(1);
        expect(captures.sideQuestionCalls[0]).toMatchObject({ question: "question" });
        expect(captures.sideQuestionCalls[0]!.nativeId).not.toBe(requestId);
        expect(captures.sideQuestionCalls[0]!.nativeId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(yield* adapter.cancelSessionSideQuestion(threadId, requestId)).toEqual({
          requestId,
          disposition: "already-settled",
        });

        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        expect(
          yield* adapter.askSessionSideQuestion(threadId, requestId, "question").pipe(Effect.flip),
        ).toMatchObject({ _tag: "ProviderAdapterUnsupportedOperationError" });

        const fullSession = (yield* adapter.listSessions())[0]!;
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: fullSession.resumeCursor,
        });
        expect(
          yield* adapter.askSessionSideQuestion(threadId, requestId, "question").pipe(Effect.flip),
        ).toMatchObject({ _tag: "ProviderAdapterUnsupportedOperationError" });

        yield* adapter.stopSession(threadId);
        captures.sideQuestionsAvailable = false;
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        expect(
          yield* adapter.askSessionSideQuestion(threadId, requestId, "question").pipe(Effect.flip),
        ).toMatchObject({ _tag: "ProviderAdapterUnsupportedOperationError" });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps explicit cancellation pending for a native terminal and settles timeout/stop safely",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          captures.sideQuestionObserved = yield* Queue.unbounded<void>();
          const cancelRelease = yield* Deferred.make<PrimeAgentDaemonSideQuestionResult>();
          captures.sideQuestionRelease = cancelRelease;
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });

          const cancelId = ProviderSessionSideQuestionRequestId.make("public-cancel");
          const cancelCompleted = yield* Deferred.make<void>();
          const cancelled = yield* adapter
            .askSessionSideQuestion(threadId, cancelId, "question")
            .pipe(Effect.ensuring(Deferred.succeed(cancelCompleted, undefined)), Effect.forkChild);
          yield* Queue.take(captures.sideQuestionObserved);
          const busyId = ProviderSessionSideQuestionRequestId.make("public-busy");
          expect(
            yield* adapter.askSessionSideQuestion(threadId, busyId, "question").pipe(Effect.flip),
          ).toMatchObject({ _tag: "ProviderAdapterValidationError", reason: "busy" });
          expect(yield* adapter.cancelSessionSideQuestion(threadId, busyId)).toEqual({
            requestId: busyId,
            disposition: "already-settled",
          });
          expect(yield* adapter.cancelSessionSideQuestion(threadId, cancelId)).toEqual({
            requestId: cancelId,
            disposition: "cancel-requested",
          });
          expect(yield* Deferred.isDone(cancelCompleted)).toBe(false);
          expect(captures.sideQuestionAbortCalls).toHaveLength(1);
          expect(yield* adapter.cancelSessionSideQuestion(threadId, cancelId)).toEqual({
            requestId: cancelId,
            disposition: "cancel-requested",
          });
          expect(captures.sideQuestionAbortCalls).toHaveLength(1);
          yield* Deferred.succeed(cancelRelease, { disposition: "cancelled" });
          expect(yield* Fiber.join(cancelled)).toEqual({
            requestId: cancelId,
            disposition: "cancelled",
          });

          captures.sideQuestionRelease = yield* Deferred.make<PrimeAgentDaemonSideQuestionResult>();
          const timeoutId = ProviderSessionSideQuestionRequestId.make("public-timeout");
          const timedOut = yield* adapter
            .askSessionSideQuestion(threadId, timeoutId, "question")
            .pipe(Effect.forkChild);
          yield* Queue.take(captures.sideQuestionObserved);
          expect(yield* adapter.cancelSessionSideQuestion(threadId, timeoutId)).toEqual({
            requestId: timeoutId,
            disposition: "cancel-requested",
          });
          expect(captures.sideQuestionAbortCalls).toHaveLength(2);
          yield* TestClock.adjust(PRIME_AGENT_SIDE_QUESTION_TIMEOUT_MS);
          expect(yield* Fiber.join(timedOut)).toEqual({
            requestId: timeoutId,
            disposition: "timed-out",
          });
          expect(captures.sideQuestionAbortCalls).toHaveLength(2);

          captures.sideQuestionRelease = yield* Deferred.make<PrimeAgentDaemonSideQuestionResult>();
          const stopId = ProviderSessionSideQuestionRequestId.make("public-stop");
          const stopped = yield* adapter
            .askSessionSideQuestion(threadId, stopId, "question")
            .pipe(Effect.forkChild);
          yield* Queue.take(captures.sideQuestionObserved);
          yield* adapter.stopSession(threadId);
          expect(yield* Fiber.join(stopped)).toEqual({
            requestId: stopId,
            disposition: "outcome-unknown",
          });
          expect(captures.sideQuestionAbortCalls).toHaveLength(3);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("enforces a provider-wide cap of four active side questions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.sideQuestionObserved = yield* Queue.unbounded<void>();
        captures.sideQuestionRelease = yield* Deferred.make<PrimeAgentDaemonSideQuestionResult>();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const threads = Array.from({ length: 5 }, (_, index) =>
          ThreadId.make(`prime-daemon/side-${index}`),
        );
        for (const currentThreadId of threads) {
          yield* adapter.startSession({
            threadId: currentThreadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });
        }
        const activeFibers: Array<Fiber.Fiber<unknown, unknown>> = [];
        for (let index = 0; index < 4; index += 1) {
          const requestId = ProviderSessionSideQuestionRequestId.make(`public-cap-${index}`);
          activeFibers.push(
            yield* adapter
              .askSessionSideQuestion(threads[index]!, requestId, "question")
              .pipe(Effect.forkChild),
          );
          yield* Queue.take(captures.sideQuestionObserved);
        }
        const overflowId = ProviderSessionSideQuestionRequestId.make("public-cap-overflow");
        expect(
          yield* adapter
            .askSessionSideQuestion(threads[4]!, overflowId, "question")
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "ProviderAdapterValidationError", reason: "busy" });

        for (const fiber of activeFibers) yield* Fiber.interrupt(fiber);
        yield* Effect.yieldNow;
        expect(captures.sideQuestionAbortCalls).toHaveLength(4);
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
