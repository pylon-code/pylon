import { describe, expect, it } from "@effect/vitest";
import {
  PROVIDER_AGENT_CONTROL_ID_MAX_CHARS,
  PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS,
} from "@t3tools/contracts";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

vi.mock("effect/Queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/Queue")>();
  return { ...actual, shutdown: vi.fn(actual.shutdown) };
});

import {
  type PrimeAgentDaemonAgentConnection,
  type PrimeAgentDaemonBridge,
  type PrimeAgentDaemonClient,
  type PrimeAgentDaemonExtensionUiResponse,
  type PrimeAgentDaemonImage,
  type PrimeAgentDaemonPromptOptions,
  type PrimeAgentDaemonQueuedMessageMutation,
  type PrimeAgentDaemonSessionWatcher,
  type PrimeAgentDaemonServiceTier,
  type PrimeAgentDaemonThinkingLevel,
} from "./PrimeAgentDaemonBridge.ts";
import type { PrimeAgentDaemonManager } from "./PrimeAgentDaemonManager.ts";
import { PRIME_AGENT_PLAN_TOOL_DEFINITION } from "./PrimeAgentManagedExtension.ts";
import { PRIME_AGENT_EVENT_BUFFER_CAPACITY } from "./PrimeAgentEventBuffer.ts";
import {
  makePrimeAgentDaemonSessionRuntime,
  PRIME_AGENT_DAEMON_RESUME_CURSOR,
  PRIME_AGENT_LIVE_ACTIVITY_REFRESH_DELAY_MS,
  primeAgentLiveActivityToolLabel,
  sanitizePrimeAgentLiveActivityMessages,
  type PrimeAgentDaemonSessionRuntime,
  type PrimeAgentDaemonSessionRuntimeInput,
} from "./PrimeAgentDaemonSessionRuntime.ts";
import { PRIME_AGENT_ACP_RESUME_CURSOR } from "./PrimeAgentResumeCursor.ts";

const actions = {
  queuedCount: 0,
  steering: [],
  followUps: [],
};
const goal = {
  active: false,
  status: "idle",
  tokensUsed: 0,
  timeUsedSeconds: 0,
  continuationsUsed: 0,
};
const activeSignal = () => new AbortController().signal;

function snapshot(sequence = 4) {
  return {
    state: {
      activeSessionId: "active-secret-1",
      cwd: "/work/project",
      thinkingLevel: "medium",
      serviceTier: null,
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      sessionId: "session-1",
      sessionName: "prime-test",
      sessionDir: "/daemon/private/session",
      sessionFile: "/daemon/private/session.jsonl",
      messageCount: 0,
      autoCompactionEnabled: true,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      sessionActions: actions,
      goal,
    },
    messages: [],
    children: [
      {
        id: "child-1",
        label: "child",
        status: "running",
        sessionDir: "/daemon/private/child",
      },
    ],
    lastEventSequence: sequence,
  };
}

function promptLifecycle(
  correlationId: string,
  phase: "owned" | "queued" | "delivered" | "completed" | "cancelled" | "failed",
  revision: number,
  options: {
    readonly kind?:
      | "model_prompt"
      | "session_command"
      | "extension_command"
      | "input_handler"
      | "injected_prompt";
    readonly deliveryCrossed?: boolean;
    readonly usage?: unknown;
  } = {},
) {
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

function terminalAssistantMessage(text = "recovered final response", timestamp = 2) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function sessionAlreadyActiveCreateResponse(activeSessionId = "active-secret-existing") {
  const sessionPath = "/state/provider-sessions/thread-safe/session.jsonl";
  return {
    type: "response",
    command: "create",
    success: false,
    error: `Session is already active in ${activeSessionId}: ${sessionPath}`,
    errorInfo: {
      code: "session_already_active",
      sessionPath,
      activeSessionId,
    },
  };
}

function workerListResponse(
  workerState: "recovering" | "ready" | "failed" | "stopping",
  workerPid = 101,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    type: "response",
    command: "list",
    success: true,
    data: {
      sessions: [
        {
          activeSessionId: "active-secret-1",
          sessionId: "session-1",
          sessionFile: "/state/provider-sessions/thread-safe/session.jsonl",
          workerState,
          workerPid,
          ...overrides,
        },
      ],
    },
  };
}

interface Captures {
  readonly order: string[];
  readonly commands: Array<Readonly<Record<string, unknown>>>;
  readonly connectionCalls: Array<{
    readonly method: string;
    readonly args: ReadonlyArray<unknown>;
  }>;
  readonly attachOptions: Array<Readonly<Record<string, unknown>> | undefined>;
  readonly reconnectOptions: Array<{ readonly recoverDaemon: () => Promise<void> }>;
  openCount: number;
  recoverCount: number;
  closeCount: number;
  disposeCount: number;
  unsubscribeCount: number;
  watcherCloseCount: number;
  watcherUnsubscribeCount: number;
  readonly watchedActiveSessionIds: string[];
  readonly sideQuestionStarts: Array<{
    readonly nativeId: string;
    readonly question: string;
    readonly argumentCount: number;
  }>;
  readonly sideQuestionAborts: string[];
  rootMessageReads: number;
  watcherMessageReads: number;
}

function fixture(options?: {
  readonly rawSnapshot?: unknown;
  readonly rawSnapshotImpl?: () => unknown;
  readonly authoritativeRlmChildren?: unknown;
  readonly createResponse?: unknown;
  readonly createResponses?: ReadonlyArray<unknown>;
  readonly createRequestObserved?: (attempt: number) => void;
  readonly duringSnapshot?: ReadonlyArray<unknown>;
  readonly duringResourceSnapshot?: ReadonlyArray<unknown>;
  readonly afterSnapshotEvent?: unknown;
  readonly attachFailure?: boolean;
  readonly omitMcpSupport?: boolean;
  readonly mcpSupported?: boolean;
  readonly replaceMcpImpl?: () => Promise<unknown>;
  readonly releaseMcpImpl?: () => Promise<unknown>;
  readonly resourceSnapshot?: unknown;
  readonly getResourceSnapshotImpl?: () => Promise<unknown>;
  readonly commands?: unknown;
  readonly toolDefinition?: unknown;
  readonly modelCatalog?: unknown;
  readonly availableModels?: unknown;
  readonly getModelCatalogImpl?: () => Promise<unknown>;
  readonly getAvailableModelsImpl?: () => Promise<unknown>;
  readonly omitModelCatalog?: boolean;
  readonly omitAvailableModels?: boolean;
  readonly omitSideQuestions?: boolean;
  readonly startSideQuestionImpl?: (nativeId: string, question: string) => Promise<unknown>;
  readonly abortSideQuestionImpl?: (nativeId: string) => Promise<unknown>;
  readonly reloadImpl?: () => Promise<unknown>;
  readonly rlmDepth?: number;
  readonly rlmStatus?: unknown;
  readonly setRlmImpl?: (maxDepth: number) => Promise<unknown>;
  readonly cancelRlmImpl?: (agentId: string) => Promise<unknown>;
  readonly sendAgentMessageImpl?: (activeSessionId: string, message: string) => Promise<unknown>;
  readonly omitSendAgentMessage?: boolean;
  readonly omitWatchSession?: boolean;
  readonly watchSessionUndefined?: boolean;
  readonly watchSessionMalformed?: boolean;
  readonly getWatchMessages?: () => ReadonlyArray<unknown> | Promise<ReadonlyArray<unknown>>;
  readonly sessionStats?: unknown;
  readonly getSessionStatsImpl?: () => Promise<unknown>;
  readonly getQueueImpl?: () => Promise<unknown>;
  readonly clearQueueImpl?: () => Promise<unknown>;
  readonly mutateQueuedMessageImpl?: (
    lane: "steering" | "followUp",
    index: number,
    expectedText: string,
    mutation: PrimeAgentDaemonQueuedMessageMutation,
  ) => Promise<unknown>;
  readonly omitQueueMutation?: boolean;
  readonly queueMutationCapability?: boolean;
  readonly getStateImpl?: () => Promise<unknown>;
  readonly setSteeringModeImpl?: (mode: "all" | "one-at-a-time") => Promise<unknown>;
  readonly setFollowUpModeImpl?: (mode: "all" | "one-at-a-time") => Promise<unknown>;
  readonly compactImpl?: () => Promise<unknown>;
  readonly refineImpl?: (options: { readonly global: false }) => Promise<unknown>;
  readonly omitRefine?: boolean;
  readonly abortCompactionImpl?: () => Promise<unknown>;
  readonly setAutoCompactionImpl?: (enabled: boolean) => Promise<unknown>;
  readonly setModelImpl?: (provider: string, modelId: string) => Promise<unknown>;
  readonly promptAndWaitImpl?: (
    message: string,
    options?: PrimeAgentDaemonPromptOptions,
  ) => Promise<unknown>;
  /** Convenience default for server offer, frozen SDK feature, and post-attach proof. */
  readonly correlatedPromptLifecycleCapability?: boolean;
  readonly correlatedPromptLifecycleSdkFeature?: boolean;
  readonly correlatedPromptLifecycleProof?: boolean;
  readonly omitNegotiatedCapabilityAccessor?: boolean;
  readonly negotiatedCapabilityProofImpl?: () => boolean;
  readonly submitCorrelatedPromptImpl?: (
    message: string,
    options: {
      readonly correlationId: string;
      readonly images?: ReadonlyArray<PrimeAgentDaemonImage>;
      readonly queueIfBusy?: boolean;
      readonly signal?: AbortSignal;
    },
  ) => Promise<unknown>;
  readonly cancelPromptLifecycleImpl?: (correlationId: string) => Promise<unknown>;
  readonly getPromptLifecyclesImpl?: () => Promise<unknown>;
  readonly resumeQueueResponses?: ReadonlyArray<unknown>;
  readonly listedActiveSessionId?: string;
  readonly listResponses?: ReadonlyArray<unknown>;
  readonly listRequestObserved?: () => void;
  readonly waitForHeadlessCompletionImpl?: (options: {
    readonly waitForRlmQuiescence?: boolean;
  }) => Promise<unknown>;
  readonly omitRlmQuiescence?: boolean;
  readonly verifyManagedSourceImpl?: () => Promise<boolean>;
  readonly unsubscribeImpl?: () => void;
  readonly disposeImpl?: () => Promise<unknown>;
  readonly recoveryMode?: "create" | "adopt";
}) {
  const captures: Captures = {
    order: [],
    commands: [],
    connectionCalls: [],
    attachOptions: [],
    reconnectOptions: [],
    openCount: 0,
    recoverCount: 0,
    closeCount: 0,
    disposeCount: 0,
    unsubscribeCount: 0,
    watcherCloseCount: 0,
    watcherUnsubscribeCount: 0,
    watchedActiveSessionIds: [],
    sideQuestionStarts: [],
    sideQuestionAborts: [],
    rootMessageReads: 0,
    watcherMessageReads: 0,
  };
  let listener: ((event: unknown) => void | Promise<void>) | undefined;
  let watcherListener: ((event: unknown) => void | Promise<void>) | undefined;
  let queuedInputSuspended = false;
  let resumeQueueRequestCount = 0;
  let listRequestCount = 0;
  let createRequestCount = 0;
  let correlatedPromptLifecycleProof =
    options?.correlatedPromptLifecycleProof ??
    options?.correlatedPromptLifecycleCapability ??
    false;

  class FakeClient implements PrimeAgentDaemonClient {
    isConnected = true;
    hello = {
      type: "daemon_hello" as const,
      protocol: { name: "prime-agent.daemon" as const, version: 7 },
      socketPath: "/tmp/pylon-prime.sock",
      appVersion: "0.7.1",
      schemaRevision: 30,
      supervisorGeneration: "supervisor-1",
      serverCapabilities: [
        "daemon_recoverable_owned_session_adoption_v1",
        "caller_owned_session_environment_cleanup_v1",
        "authoritative_owned_session_cleanup_v1",
      ],
    };
    connect(): Promise<void> {
      return Promise.resolve();
    }
    waitForHello(): Promise<unknown> {
      return Promise.resolve({});
    }
    request(command: Readonly<Record<string, unknown>>): Promise<unknown> {
      captures.commands.push(command);
      if (command.type === "complete_owned_session") {
        return Promise.resolve({
          type: "response",
          command: "complete_owned_session",
          success: true,
        });
      }
      if (command.type === "mutate_queued_message") {
        const lane = command.lane as "steering" | "followUp";
        const index = command.index as number;
        const expectedText = command.expectedText as string;
        const mutation = command.mutation as PrimeAgentDaemonQueuedMessageMutation;
        captures.connectionCalls.push({
          method: "mutateQueuedMessage",
          args: [lane, index, expectedText, mutation],
        });
        return (
          options?.mutateQueuedMessageImpl?.(lane, index, expectedText, mutation) ??
          Promise.resolve("applied")
        ).then((status) => ({
          type: "response",
          command: "mutate_queued_message",
          success: true,
          data: { status },
        }));
      }
      if (command.type === "list") {
        options?.listRequestObserved?.();
        const configuredResponse = options?.listResponses?.[listRequestCount];
        listRequestCount += 1;
        return Promise.resolve(
          configuredResponse ?? {
            type: "response",
            command: "list",
            success: true,
            data: {
              sessions: [
                {
                  activeSessionId: options?.listedActiveSessionId ?? "active-secret-1",
                  sessionId: "session-1",
                  sessionFile: "/state/provider-sessions/thread-safe/session.jsonl",
                },
              ],
            },
          },
        );
      }
      if (command.type === "resume_queue") {
        captures.connectionCalls.push({ method: "resumeQueue", args: [] });
        queuedInputSuspended = false;
        const configuredResponse = options?.resumeQueueResponses?.[resumeQueueRequestCount];
        resumeQueueRequestCount += 1;
        return Promise.resolve(
          configuredResponse ?? {
            type: "response",
            command: "resume_queue",
            success: false,
            error: "No queued work to resume",
          },
        );
      }
      const configuredCreateResponse = options?.createResponses?.[createRequestCount];
      createRequestCount += 1;
      options?.createRequestObserved?.(createRequestCount);
      return Promise.resolve(
        configuredCreateResponse ??
          options?.createResponse ?? {
            type: "response",
            command: "create",
            success: true,
            data: {
              activeSessionId: "active-secret-1",
              sessionId: "session-1",
              sessionFile: "/state/provider-sessions/thread-safe/session.jsonl",
            },
          },
      );
    }
    enableRequestRecovery(): void {
      captures.order.push("request-recovery");
    }
    supportsServerCapability(
      capability: "queue_message_mutation" | "correlated_prompt_lifecycle_v1",
    ): boolean {
      return capability === "queue_message_mutation"
        ? (options?.queueMutationCapability ?? true)
        : (options?.correlatedPromptLifecycleCapability ?? false);
    }
    enableAutoReconnect(reconnectOptions: { readonly recoverDaemon: () => Promise<void> }): void {
      captures.reconnectOptions.push(reconnectOptions);
    }
    close(): void {
      this.isConnected = false;
      captures.order.push("close");
      captures.closeCount += 1;
    }
  }

  class FakeConnection implements PrimeAgentDaemonAgentConnection {
    constructor() {
      if (options?.omitSendAgentMessage === true) {
        Object.defineProperty(this, "sendAgentMessage", { value: undefined });
      }
      if (options?.omitWatchSession === true) {
        Object.defineProperty(this, "watchSession", { value: undefined });
      }
      if (options?.omitRefine === true) {
        Object.defineProperty(this, "refine", { value: undefined });
      }
      if (options?.omitModelCatalog === true) {
        Object.defineProperty(this, "getModelCatalog", { value: undefined });
      }
      if (options?.omitAvailableModels === true) {
        Object.defineProperty(this, "getAvailableModels", { value: undefined });
      }
      if (options?.omitSideQuestions === true) {
        Object.defineProperty(this, "startSideQuestion", { value: undefined });
        Object.defineProperty(this, "abortSideQuestion", { value: undefined });
      }
      if (options?.omitQueueMutation === true) {
        Object.defineProperty(this, "mutateQueuedMessage", { value: undefined });
      }
      if (options?.omitMcpSupport === true) {
        Object.defineProperties(this, {
          supportsAcpMcpServers: { value: undefined },
          replaceAcpMcpServers: { value: undefined },
          releaseAcpMcpServers: { value: undefined },
        });
      }
      if (options?.omitRlmQuiescence === true) {
        Object.defineProperty(this, "waitForHeadlessCompletion", { value: undefined });
      }
      if (options?.authoritativeRlmChildren === undefined) {
        Object.defineProperty(this, "getRlmChildSnapshots", { value: undefined });
      }
      if (options?.omitNegotiatedCapabilityAccessor === true) {
        Object.defineProperty(this, "supportsNegotiatedCapability", { value: undefined });
      }
    }
    static attach(
      _client: PrimeAgentDaemonClient,
      _activeSessionId: string,
      attachOptions?: Readonly<Record<string, unknown>>,
    ): Promise<PrimeAgentDaemonAgentConnection> {
      captures.order.push("attach");
      captures.attachOptions.push(attachOptions);
      return options?.attachFailure
        ? Promise.reject(new Error("attach failed"))
        : Promise.resolve(new FakeConnection());
    }
    subscribe(next: (event: unknown) => void | Promise<void>): () => void {
      captures.order.push("subscribe");
      listener = next;
      return () => {
        captures.order.push("unsubscribe");
        captures.unsubscribeCount += 1;
        options?.unsubscribeImpl?.();
      };
    }
    async getInitialSnapshot(): Promise<unknown> {
      captures.order.push("snapshot");
      for (const event of options?.duringSnapshot ?? []) await listener?.(event);
      if (options?.afterSnapshotEvent !== undefined) {
        queueMicrotask(() => {
          void listener?.(options.afterSnapshotEvent);
        });
      }
      return options?.rawSnapshotImpl?.() ?? options?.rawSnapshot ?? snapshot();
    }
    getRlmChildSnapshots(): Promise<unknown> {
      captures.connectionCalls.push({ method: "getRlmChildSnapshots", args: [] });
      return Promise.resolve(options?.authoritativeRlmChildren);
    }
    getState(): Promise<unknown> {
      captures.connectionCalls.push({ method: "getState", args: [] });
      if (options?.getStateImpl !== undefined) return options.getStateImpl();
      const current = options?.rawSnapshotImpl?.() ?? options?.rawSnapshot ?? snapshot();
      return Promise.resolve(
        typeof current === "object" && current !== null && "state" in current
          ? current.state
          : undefined,
      );
    }
    promptAndWait(
      message: string,
      promptOptions?: PrimeAgentDaemonPromptOptions,
    ): Promise<unknown> {
      captures.connectionCalls.push({ method: "prompt", args: [message, promptOptions] });
      if (queuedInputSuspended) {
        return Promise.reject(
          new Error("Cannot admit a session action while queued session input is suspended."),
        );
      }
      return options?.promptAndWaitImpl?.(message, promptOptions) ?? Promise.resolve(undefined);
    }
    submitCorrelatedPrompt(
      message: string,
      promptOptions: {
        readonly correlationId: string;
        readonly images?: ReadonlyArray<PrimeAgentDaemonImage>;
        readonly queueIfBusy?: boolean;
        readonly signal?: AbortSignal;
      },
    ): Promise<unknown> {
      captures.connectionCalls.push({
        method: "submitCorrelatedPrompt",
        args: [message, promptOptions],
      });
      return (
        options?.submitCorrelatedPromptImpl?.(message, promptOptions) ?? Promise.resolve(undefined)
      );
    }
    cancelPromptLifecycle(correlationId: string): Promise<unknown> {
      captures.connectionCalls.push({ method: "cancelPromptLifecycle", args: [correlationId] });
      return options?.cancelPromptLifecycleImpl?.(correlationId) ?? Promise.resolve(undefined);
    }
    getPromptLifecycles(): Promise<unknown> {
      captures.connectionCalls.push({ method: "getPromptLifecycles", args: [] });
      return options?.getPromptLifecyclesImpl?.() ?? Promise.resolve({ records: [], expired: [] });
    }
    supportsNegotiatedCapability(capability: "correlated_prompt_lifecycle_v1"): boolean {
      return (
        capability === "correlated_prompt_lifecycle_v1" &&
        (options?.negotiatedCapabilityProofImpl?.() ?? correlatedPromptLifecycleProof)
      );
    }
    waitForHeadlessCompletion(
      waitOptions: { readonly waitForRlmQuiescence?: boolean } = {},
    ): Promise<unknown> {
      captures.connectionCalls.push({
        method: "waitForHeadlessCompletion",
        args: [waitOptions],
      });
      return (
        options?.waitForHeadlessCompletionImpl?.(waitOptions) ??
        Promise.resolve({ privateAutonomousStatus: "discarded" })
      );
    }
    steer(message: string, images?: ReadonlyArray<PrimeAgentDaemonImage>): Promise<unknown> {
      captures.connectionCalls.push({ method: "steer", args: [message, images] });
      return Promise.resolve(undefined);
    }
    followUp(message: string, images?: ReadonlyArray<PrimeAgentDaemonImage>): Promise<unknown> {
      captures.connectionCalls.push({ method: "followUp", args: [message, images] });
      return Promise.resolve(undefined);
    }
    startSideQuestion(nativeId: string, question: string): Promise<unknown> {
      captures.sideQuestionStarts.push({
        nativeId,
        question,
        argumentCount: arguments.length,
      });
      return options?.startSideQuestionImpl?.(nativeId, question) ?? Promise.resolve(undefined);
    }
    abortSideQuestion(nativeId: string): Promise<unknown> {
      captures.sideQuestionAborts.push(nativeId);
      return options?.abortSideQuestionImpl?.(nativeId) ?? Promise.resolve(false);
    }
    abort(): Promise<unknown> {
      captures.connectionCalls.push({ method: "abort", args: [] });
      return Promise.resolve(undefined);
    }
    abortAndClearQueue(): Promise<unknown> {
      captures.connectionCalls.push({ method: "abortAndClearQueue", args: [] });
      queuedInputSuspended = true;
      return Promise.resolve({ steering: [], followUp: [] });
    }
    getQueue(): Promise<unknown> {
      captures.connectionCalls.push({ method: "getQueue", args: [] });
      return options?.getQueueImpl?.() ?? Promise.resolve({ steering: [], followUp: [] });
    }
    clearQueue(): Promise<unknown> {
      captures.connectionCalls.push({ method: "clearQueue", args: [] });
      return options?.clearQueueImpl?.() ?? Promise.resolve({ steering: [], followUp: [] });
    }
    mutateQueuedMessage(
      lane: "steering" | "followUp",
      index: number,
      expectedText: string,
      mutation: PrimeAgentDaemonQueuedMessageMutation,
    ): Promise<unknown> {
      captures.connectionCalls.push({
        method: "mutateQueuedMessage",
        args: [lane, index, expectedText, mutation],
      });
      return (
        options?.mutateQueuedMessageImpl?.(lane, index, expectedText, mutation) ??
        Promise.resolve("applied")
      );
    }
    setSteeringMode(mode: "all" | "one-at-a-time"): Promise<unknown> {
      captures.connectionCalls.push({ method: "setSteeringMode", args: [mode] });
      return options?.setSteeringModeImpl?.(mode) ?? Promise.resolve(undefined);
    }
    setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<unknown> {
      captures.connectionCalls.push({ method: "setFollowUpMode", args: [mode] });
      return options?.setFollowUpModeImpl?.(mode) ?? Promise.resolve(undefined);
    }
    compact(): Promise<unknown> {
      captures.connectionCalls.push({ method: "compact", args: [] });
      queuedInputSuspended = true;
      return (
        options?.compactImpl?.() ??
        Promise.resolve({
          summary: "private summary",
          details: { sessionFile: "/daemon/private/session.jsonl" },
          firstKeptId: "native-secret",
          tokensBefore: 1234,
        })
      );
    }
    refine(refineOptions: { readonly global: false }): Promise<unknown> {
      captures.connectionCalls.push({ method: "refine", args: [refineOptions] });
      return (
        options?.refineImpl?.(refineOptions) ??
        Promise.resolve({
          appliedEdits: [
            { applied: true, path: "/private/harness.md", instructions: "secret" },
            { applied: false, error: "private failure" },
          ],
          proposalId: "native-secret",
          scope: "local",
        })
      );
    }
    abortCompaction(): Promise<unknown> {
      captures.connectionCalls.push({ method: "abortCompaction", args: [] });
      return options?.abortCompactionImpl?.() ?? Promise.resolve(undefined);
    }
    setAutoCompactionEnabled(enabled: boolean): Promise<unknown> {
      captures.connectionCalls.push({ method: "setAutoCompactionEnabled", args: [enabled] });
      return options?.setAutoCompactionImpl?.(enabled) ?? Promise.resolve(undefined);
    }
    setModel(provider: string, modelId: string): Promise<unknown> {
      captures.connectionCalls.push({ method: "setModel", args: [provider, modelId] });
      if (options?.setModelImpl) return options.setModelImpl(provider, modelId);
      return Promise.resolve({
        provider,
        id: modelId,
        name: "Prime model",
        baseUrl: "https://native-secret.invalid",
        headers: { authorization: "secret" },
      });
    }
    setThinkingLevel(level: PrimeAgentDaemonThinkingLevel): Promise<unknown> {
      captures.connectionCalls.push({ method: "setThinkingLevel", args: [level] });
      return Promise.resolve(undefined);
    }
    setServiceTier(tier: PrimeAgentDaemonServiceTier): Promise<unknown> {
      captures.connectionCalls.push({ method: "setServiceTier", args: [tier] });
      return Promise.resolve(undefined);
    }
    respondToExtensionUiRequest(
      requestId: string,
      response: PrimeAgentDaemonExtensionUiResponse,
    ): Promise<unknown> {
      captures.connectionCalls.push({ method: "extension", args: [requestId, response] });
      return Promise.resolve(undefined);
    }
    getModelCatalog(): Promise<unknown> {
      captures.connectionCalls.push({ method: "getModelCatalog", args: [] });
      return (
        options?.getModelCatalogImpl?.() ??
        Promise.resolve(options?.modelCatalog ?? { models: [], configuredProviders: [] })
      );
    }
    getAvailableModels(): Promise<unknown> {
      captures.connectionCalls.push({ method: "getAvailableModels", args: [] });
      return options?.getAvailableModelsImpl?.() ?? Promise.resolve(options?.availableModels ?? []);
    }
    getCommands(): Promise<unknown> {
      captures.connectionCalls.push({ method: "getCommands", args: [] });
      return Promise.resolve(
        options?.commands ?? [
          {
            name: "pylon-permission-gate-v1",
            source: "extension",
            sourceInfo: { path: "/state/pylon/permission.mjs" },
          },
        ],
      );
    }
    getToolDefinition(name: string): Promise<unknown> {
      captures.connectionCalls.push({ method: "getToolDefinition", args: [name] });
      return Promise.resolve(options?.toolDefinition ?? PRIME_AGENT_PLAN_TOOL_DEFINITION);
    }
    async getResourceSnapshot(): Promise<unknown> {
      captures.connectionCalls.push({ method: "getResourceSnapshot", args: [] });
      for (const event of options?.duringResourceSnapshot ?? []) await listener?.(event);
      if (options?.getResourceSnapshotImpl !== undefined) {
        return options.getResourceSnapshotImpl();
      }
      return (
        options?.resourceSnapshot ?? {
          extensions: [{ path: "/state/pylon/permission.mjs" }],
          diagnostics: { extensions: [] },
        }
      );
    }
    supportsAcpMcpServers(): boolean {
      captures.connectionCalls.push({ method: "supportsAcpMcpServers", args: [] });
      return options?.mcpSupported ?? true;
    }
    replaceAcpMcpServers(servers: ReadonlyArray<unknown>, ownerId: string): Promise<unknown> {
      captures.order.push("replace-mcp");
      captures.connectionCalls.push({ method: "replaceAcpMcpServers", args: [servers, ownerId] });
      return options?.replaceMcpImpl?.() ?? Promise.resolve(undefined);
    }
    releaseAcpMcpServers(ownerId: string, serverNames: ReadonlyArray<string>): Promise<unknown> {
      captures.order.push("release-mcp");
      captures.connectionCalls.push({
        method: "releaseAcpMcpServers",
        args: [ownerId, serverNames],
      });
      return options?.releaseMcpImpl?.() ?? Promise.resolve(undefined);
    }
    reload(): Promise<unknown> {
      captures.connectionCalls.push({ method: "reload", args: [] });
      return options?.reloadImpl?.() ?? Promise.resolve(undefined);
    }
    getSessionStats(): Promise<unknown> {
      captures.connectionCalls.push({ method: "getSessionStats", args: [] });
      if (options?.getSessionStatsImpl !== undefined) return options.getSessionStatsImpl();
      return Promise.resolve(
        options?.sessionStats ?? {
          sessionFile: "/daemon/private/session.jsonl",
          sessionId: "session-1",
          tokens: {
            input: 120,
            output: 30,
            cacheRead: 850,
            cacheWrite: 10,
            total: 1_010,
          },
          cost: 0.42,
          contextUsage: { tokens: 320, contextWindow: 200_000, percent: 0.16 },
        },
      );
    }
    getRlmMaxDepthStatus(): Promise<unknown> {
      captures.connectionCalls.push({ method: "getRlmMaxDepthStatus", args: [] });
      return Promise.resolve(
        options?.rlmStatus ?? { maxDepth: options?.rlmDepth ?? 0, source: "chat" },
      );
    }
    cancelRlmChild(agentId: string): Promise<unknown> {
      captures.connectionCalls.push({ method: "cancelRlmChild", args: [agentId] });
      return options?.cancelRlmImpl?.(agentId) ?? Promise.resolve(true);
    }
    sendAgentMessage(activeSessionId: string, message: string): Promise<unknown> {
      captures.connectionCalls.push({
        method: "sendAgentMessage",
        args: [activeSessionId, message],
      });
      return (
        options?.sendAgentMessageImpl?.(activeSessionId, message) ??
        Promise.resolve({
          id: "private-receipt-id",
          message,
          target: { activeSessionId, sessionId: "private-target-session" },
          deliveryStatus: "delivered",
          deliveredAt: "2026-08-09T00:00:00.000Z",
        })
      );
    }
    getMessages(): Promise<ReadonlyArray<unknown>> {
      captures.rootMessageReads += 1;
      return Promise.resolve([
        {
          role: "assistant",
          content: [{ type: "text", text: "root transcript must stay private" }],
        },
      ]);
    }
    watchSession(activeSessionId: string): Promise<PrimeAgentDaemonSessionWatcher | undefined> {
      captures.watchedActiveSessionIds.push(activeSessionId);
      if (options?.watchSessionUndefined === true) return Promise.resolve(undefined);
      if (options?.watchSessionMalformed === true) {
        return Promise.resolve({
          getMessages: () => Promise.resolve([]),
        } as unknown as PrimeAgentDaemonSessionWatcher);
      }
      return Promise.resolve({
        getMessages: () => {
          captures.watcherMessageReads += 1;
          return Promise.resolve(options?.getWatchMessages?.() ?? []);
        },
        subscribe: (next: (event: unknown) => void | Promise<void>) => {
          watcherListener = next;
          return () => {
            captures.watcherUnsubscribeCount += 1;
          };
        },
        close: () => {
          captures.watcherCloseCount += 1;
          return Promise.resolve();
        },
      });
    }
    setRlmMaxDepth(maxDepth: number): Promise<unknown> {
      captures.connectionCalls.push({ method: "setRlmMaxDepth", args: [maxDepth] });
      return (
        options?.setRlmImpl?.(maxDepth) ??
        Promise.resolve({ maxDepth, source: "chat", globalSaved: false })
      );
    }
    disposeOwnedSession(): Promise<unknown> {
      captures.order.push("dispose-owned");
      return Promise.resolve({ status: "completed" });
    }
    dispose(): Promise<unknown> {
      captures.order.push("dispose");
      captures.disposeCount += 1;
      return options?.disposeImpl?.() ?? Promise.resolve(undefined);
    }
  }

  const bridge: PrimeAgentDaemonBridge = {
    packageRoot: "/fake/prime-agent",
    moduleEntryPath: "/fake/prime-agent/dist/index.js",
    version: "0.7.1",
    protocolName: "prime-agent.daemon",
    protocolVersion: 7,
    negotiatedDaemonSessionCapabilitiesAvailable:
      options?.correlatedPromptLifecycleSdkFeature ??
      options?.correlatedPromptLifecycleCapability ??
      false,
    sdkFeatures:
      options?.recoveryMode === undefined
        ? []
        : ["recoverable_owned_session_adoption_v1", "caller_owned_session_environment_cleanup_v1"],
    recoverableOwnedSessionAdoptionAvailable: options?.recoveryMode !== undefined,
    ...(options?.recoveryMode === undefined
      ? {}
      : {
          createRecoverableOwnedSession: async () => {
            captures.order.push("create-recoverable");
            return {
              connection: new FakeConnection(),
              recoveryHandle: "handle-1",
              supervisorGeneration: "supervisor-1",
              ownershipGeneration: 0,
              state: {
                activeSessionId: "active-secret-1",
                sessionId: "session-1",
                sessionFile: "/state/provider-sessions/thread-safe/session.jsonl",
              },
            };
          },
          adoptRecoverableOwnedSession: async () => {
            captures.order.push("adopt-recoverable");
            return {
              connection: new FakeConnection(),
              recoveryHandle: "handle-2",
              proof: {
                feature: "recoverable_owned_session_adoption_v1" as const,
                status: "adopted" as const,
                lifecycle: { phase: "owned" },
                supervisorGeneration: "supervisor-1",
                activeSessionId: "active-secret-1",
                sessionId: "session-1",
                correlationId: "correlation-1",
                mcpOwnerId: "pylon:mcp-2",
                ownershipGeneration: 1,
                cursor: { generation: "events-1", sequence: 9 },
              },
            };
          },
          confirmRecoverableOwnedSessionAdoption: async () => {
            captures.order.push("confirm-adoption");
          },
        }),
    DaemonClient: FakeClient,
    DaemonAgentConnection: FakeConnection,
    defaultDaemonSocketPath: () => "/tmp/prime-agent.sock",
  };
  const manager: PrimeAgentDaemonManager = {
    bridge,
    socket: "/tmp/pylon-prime.sock",
    sessionDir: "/state/shared-daemon-sessions",
    launchEnvironment: { HOME: "/private/home" },
    recoveryEnabled: options?.recoveryMode !== undefined,
    platform: "darwin",
    architecture: "arm64",
    retainForRecovery: () => {
      captures.order.push("retain-daemon");
      return () => captures.order.push("release-daemon");
    },
    prepare: () => Effect.void,
    openClient: () =>
      Effect.sync(() => {
        captures.openCount += 1;
        return new FakeClient();
      }),
    recover: async () => {
      captures.recoverCount += 1;
    },
  };
  const make = (
    resumeCursor?: unknown,
    extensions?: ReadonlyArray<string>,
    requiredExtension?: { readonly path: string; readonly markerCommand: string },
    resumeSessionId?: string,
    mcpServer?: PrimeAgentDaemonSessionRuntimeInput["mcpServer"],
    expectedExtension?: { readonly path: string; readonly markerCommand: string },
    recovery?: PrimeAgentDaemonSessionRuntimeInput["recovery"],
  ) =>
    makePrimeAgentDaemonSessionRuntime({
      manager,
      cwd: "/work/project",
      sessionDir: "/state/provider-sessions/thread-safe",
      agentDir: "/state/prime-agent-home",
      model: "openai/gpt-5.3-codex",
      thinkingLevel: "high",
      ...(extensions === undefined ? {} : { extensions }),
      ...(expectedExtension === undefined && requiredExtension === undefined
        ? {}
        : {
            expectedExtension: {
              ...(expectedExtension ?? requiredExtension!),
              verifySource: options?.verifyManagedSourceImpl ?? (() => Promise.resolve(true)),
            },
          }),
      ...(requiredExtension === undefined
        ? {}
        : {
            disableExtensionDiscovery: true,
            disableAutoReconnect: true,
            requiredExtension,
          }),
      ...(resumeCursor === undefined ? {} : { resumeCursor }),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      ...(mcpServer === undefined ? {} : { mcpServer }),
      ...(recovery === undefined ? {} : { recovery }),
    });
  const emit = (event: unknown) => Promise.resolve(listener?.(event));
  const emitWatch = (event: unknown) => Promise.resolve(watcherListener?.(event));
  return {
    captures,
    emit,
    emitWatch,
    make,
    setCorrelatedPromptLifecycleProof: (available: boolean) => {
      correlatedPromptLifecycleProof = available;
    },
  };
}

function collectEvents(runtime: PrimeAgentDaemonSessionRuntime, count: number) {
  return runtime.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((events) => Array.from(events)),
  );
}

function expectDefectExit(exit: Exit.Exit<unknown, unknown>, defect: unknown): void {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) return;
  const reason = exit.cause.reasons.find(Cause.isDieReason);
  expect(reason).toBeDefined();
  if (reason !== undefined && Cause.isDieReason(reason)) {
    expect(reason.defect).toBe(defect);
  }
}

function captureNextSetConstruction<A>(run: () => A): readonly [A, Set<unknown>] {
  const NativeSet = globalThis.Set;
  let captured: Set<unknown> | undefined;
  class CapturingSet<T> extends NativeSet<T> {
    constructor(values?: readonly T[] | null) {
      super(values);
      captured ??= this as Set<unknown>;
    }
  }
  globalThis.Set = CapturingSet as SetConstructor;
  try {
    const value = run();
    if (captured === undefined) throw new Error("Expected a Set to be constructed synchronously.");
    return [value, captured];
  } finally {
    globalThis.Set = NativeSet;
  }
}

describe("PrimeAgentDaemonSessionRuntime", () => {
  it.effect("keeps a server offer on the ordinary prompt path without the frozen SDK feature", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          correlatedPromptLifecycleSdkFeature: false,
          correlatedPromptLifecycleProof: true,
        });
        const runtime = yield* test.make();

        expect(runtime.correlatedPromptLifecycleAvailable).toBe(false);
        yield* runtime.prompt({ text: "ordinary fallback" });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "submitCorrelatedPrompt"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("keeps a frozen feature on the ordinary path when post-attach proof is false", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          correlatedPromptLifecycleSdkFeature: true,
          correlatedPromptLifecycleProof: false,
        });
        const runtime = yield* test.make();

        expect(runtime.correlatedPromptLifecycleAvailable).toBe(false);
        yield* runtime.prompt({ text: "proofless fallback" });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "submitCorrelatedPrompt"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("fails a malformed frozen feature contract without a proof accessor", () =>
    Effect.gen(function* () {
      const test = fixture({
        correlatedPromptLifecycleCapability: true,
        correlatedPromptLifecycleSdkFeature: true,
        omitNegotiatedCapabilityAccessor: true,
      });

      const error = yield* Effect.flip(Effect.scoped(test.make()));

      expect(error).toMatchObject({
        operation: "attach-session",
        reason: "invalid-response",
      });
      expect(test.captures.disposeCount).toBe(1);
      expect(test.captures.closeCount).toBe(1);
    }),
  );

  it.effect("rejects a reattached proof generation during asynchronous initialization", () =>
    Effect.gen(function* () {
      const test = fixture({
        correlatedPromptLifecycleCapability: true,
        rawSnapshot: {
          ...snapshot(),
          promptLifecycles: { records: [], expired: [] },
        },
        duringResourceSnapshot: [
          { type: "connection_status", status: "reconnecting" },
          { type: "session_resynced", snapshot: snapshot(9) },
        ],
      });

      const error = yield* Effect.flip(Effect.scoped(test.make()));

      expect(error).toMatchObject({
        operation: "initial-snapshot",
        reason: "invalid-response",
      });
      expect(test.captures.disposeCount).toBe(1);
      expect(test.captures.closeCount).toBe(1);
    }),
  );

  it.effect("enables correlated lifecycle only after frozen feature and post-attach proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const unsupported = fixture();
        const legacy = yield* unsupported.make();
        expect(legacy.correlatedPromptLifecycleAvailable).toBe(false);

        const correlationId = "8d86fd25-cb7d-4d5a-b07a-62aab2d16ea9";
        const capable = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
          submitCorrelatedPromptImpl: (_message, options) =>
            Promise.resolve({
              lifecycle: promptLifecycle(options.correlationId, "owned", 1),
              duplicate: false,
            }),
        });
        const runtime = yield* capable.make();
        expect(runtime.correlatedPromptLifecycleAvailable).toBe(true);
        const events = yield* collectEvents(runtime, 2).pipe(Effect.forkChild);
        const lifecycle = yield* runtime.submitCorrelatedPrompt({
          text: "queued safely",
          correlationId,
          queueIfBusy: true,
        });
        expect(lifecycle).toEqual(promptLifecycle(correlationId, "owned", 1));
        expect((yield* Fiber.join(events)).slice(1)).toEqual([
          { _tag: "PromptLifecycleUpdated", lifecycle },
        ]);
        expect(
          capable.captures.connectionCalls.find((call) => call.method === "submitCorrelatedPrompt")
            ?.args,
        ).toEqual(["queued safely", expect.objectContaining({ correlationId, queueIfBusy: true })]);
      }),
    ),
  );

  it.effect("fails a throwing proof accessor with payload-free errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let throwProofCanary = false;
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
          negotiatedCapabilityProofImpl: () => {
            if (throwProofCanary) throw new Error("native-proof-exception-canary");
            return true;
          },
        });
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        throwProofCanary = true;
        const error = yield* Effect.flip(
          runtime.submitCorrelatedPrompt({
            text: "must not reach native submission",
            correlationId: "e032ec7d-a217-4b61-905c-2fea05642f91",
            queueIfBusy: true,
          }),
        );

        expect(error).toMatchObject({
          operation: "prompt",
          reason: "request-failed",
          detail:
            "Prime Agent correlated prompt capability proof is unavailable for the current attachment.",
        });
        expect(yield* Fiber.join(events)).toEqual([
          expect.objectContaining({ _tag: "SessionResynced" }),
          {
            _tag: "SessionClosed",
            error: "Prime Agent correlated prompt capability proof was lost during recovery.",
          },
        ]);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "submitCorrelatedPrompt"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("keeps a local correlated proof failure terminal after SDK proof returns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
        });
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        test.setCorrelatedPromptLifecycleProof(false);
        const first = yield* runtime
          .submitCorrelatedPrompt({
            text: "lose proof",
            correlationId: "11b7f155-a257-4bbc-80ed-d4f5f484f557",
            queueIfBusy: true,
          })
          .pipe(Effect.result);
        test.setCorrelatedPromptLifecycleProof(true);
        const second = yield* runtime
          .submitCorrelatedPrompt({
            text: "must remain closed",
            correlationId: "5cf841ae-ac87-42e9-8454-d2e00603a12f",
            queueIfBusy: true,
          })
          .pipe(Effect.result);

        expect(first).toMatchObject({ _tag: "Failure" });
        expect(second).toMatchObject({
          _tag: "Failure",
          failure: {
            detail:
              "Prime Agent correlated prompt capability proof is unavailable for the current attachment.",
          },
        });
        expect(runtime.correlatedPromptLifecycleAdmissionBlocked).toBe(true);
        expect(runtime.inputAdmissionBusy).toBe(true);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "submitCorrelatedPrompt"),
        ).toHaveLength(0);
        expect(yield* Fiber.join(events)).toEqual([
          expect.objectContaining({ _tag: "SessionResynced" }),
          {
            _tag: "SessionClosed",
            error: "Prime Agent correlated prompt capability proof was lost during recovery.",
          },
        ]);
      }),
    ),
  );

  it.effect("blocks correlated commands until the reconnect snapshot is adapter-settled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
        });
        const runtime = yield* test.make();

        test.setCorrelatedPromptLifecycleProof(false);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        test.setCorrelatedPromptLifecycleProof(true);

        expect(runtime.correlatedPromptLifecycleAdmissionBlocked).toBe(true);
        expect(runtime.inputAdmissionBusy).toBe(true);
        const submit = yield* runtime
          .submitCorrelatedPrompt({
            text: "must await recovery",
            correlationId: "5c290a6f-2733-43de-89bf-b5a72a400e3f",
            queueIfBusy: true,
          })
          .pipe(Effect.result);
        const cancel = yield* runtime
          .cancelPromptLifecycle("5c290a6f-2733-43de-89bf-b5a72a400e3f")
          .pipe(Effect.result);

        expect(submit).toMatchObject({
          _tag: "Failure",
          failure: {
            detail: "Prime Agent correlated prompt lifecycle recovery is still pending.",
          },
        });
        expect(cancel).toMatchObject({
          _tag: "Failure",
          failure: {
            detail: "Prime Agent correlated prompt lifecycle recovery is still pending.",
          },
        });
        expect(
          test.captures.connectionCalls.filter(
            (call) =>
              call.method === "submitCorrelatedPrompt" || call.method === "cancelPromptLifecycle",
          ),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("rejects an awaited correlated submission when its proof fence changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const correlationId = "2dbf5245-935e-4fa2-b4d8-955ac3e7e42b";
        let resolveSubmission!: (value: unknown) => void;
        let reportSubmissionStarted!: () => void;
        const submissionStarted = new Promise<void>((resolve) => {
          reportSubmissionStarted = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
          submitCorrelatedPromptImpl: (_message, options) => {
            reportSubmissionStarted();
            return new Promise((resolve) => {
              resolveSubmission = () =>
                resolve({
                  lifecycle: promptLifecycle(options.correlationId, "owned", 1),
                  duplicate: false,
                });
            });
          },
        });
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const submission = yield* runtime
          .submitCorrelatedPrompt({
            text: "must not commit stale ownership",
            correlationId,
            queueIfBusy: true,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* Effect.promise(() => submissionStarted);
        test.setCorrelatedPromptLifecycleProof(false);
        resolveSubmission(undefined);

        const error = yield* Effect.flip(Fiber.join(submission));
        expect(error).toMatchObject({
          operation: "prompt",
          reason: "request-failed",
          detail:
            "Prime Agent correlated prompt capability proof is unavailable for the current attachment.",
        });
        expect((yield* Fiber.join(events)).map((event) => event._tag)).toEqual([
          "SessionResynced",
          "SessionClosed",
        ]);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "submitCorrelatedPrompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("does not reuse stale proof for a direct replacement generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
        });
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        test.setCorrelatedPromptLifecycleProof(false);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_replaced",
            activeSessionId: "native-replacement-canary",
          }),
        );

        const replacementEvents = yield* Fiber.join(events);
        expect(replacementEvents).toEqual([
          expect.objectContaining({ _tag: "SessionResynced" }),
          {
            _tag: "SessionClosed",
            error: "Prime Agent correlated prompt capability proof was lost during recovery.",
          },
        ]);
        expect(test.captures.order.filter((step) => step === "snapshot")).toHaveLength(1);
      }),
    ),
  );

  it.effect("caps unresolved physical strict replacement snapshots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let snapshotReads = 0;
        let reportHeldSnapshot!: () => void;
        const heldSnapshotStarted = new Promise<void>((resolve) => {
          reportHeldSnapshot = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) {
              return {
                ...snapshot(),
                promptLifecycles: { records: [], expired: [] },
              };
            }
            reportHeldSnapshot();
            return new Promise<unknown>(() => undefined);
          },
        });
        const runtime = yield* test.make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        const replacement = test.emit({
          type: "session_replaced",
          activeSessionId: "held-replacement-canary",
        });
        yield* Effect.promise(() => heldSnapshotStarted);

        const refusedReplacement = test.emit({
          type: "session_replaced",
          activeSessionId: "refused-replacement-canary",
        });
        yield* Effect.promise(() =>
          Promise.all([replacement, refusedReplacement]).then(() => undefined),
        );
        expect((yield* collectEvents(runtime, 1))[0]).toEqual({
          _tag: "SessionClosed",
          error: "Prime Agent correlated prompt capability proof was lost during recovery.",
        });
        expect(snapshotReads).toBe(2);
      }),
    ),
  );

  it.effect("fails an active correlated recovery when the attachment proof is lost", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const correlationId = "b4c2efc1-dd54-45a9-b5dd-244d0a3fc610";
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
          submitCorrelatedPromptImpl: (_message, options) =>
            Promise.resolve({
              lifecycle: promptLifecycle(options.correlationId, "owned", 1),
              duplicate: false,
            }),
        });
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 4).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* runtime.submitCorrelatedPrompt({
          text: "owned exactly once",
          correlationId,
          queueIfBusy: true,
        });
        test.setCorrelatedPromptLifecycleProof(false);
        yield* Effect.promise(() =>
          test.emit({
            type: "connection_status",
            status: "reconnecting",
          }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(2),
              activeSessionId: "native-session-canary",
              promptLifecycles: {
                records: [promptLifecycle(correlationId, "delivered", 2)],
                expired: [],
              },
            },
          }),
        );

        const recoveredEvents = yield* Fiber.join(events);
        yield* Effect.promise(() => test.emit({ type: "closed", error: "native-close-canary" }));
        const extraEvent = yield* runtime.events.pipe(
          Stream.runHead,
          Effect.timeoutOption(1),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(1);
        expect((yield* Fiber.join(extraEvent))._tag).toBe("None");
        expect(recoveredEvents.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "PromptLifecycleUpdated",
          "ConnectionStatus",
          "SessionClosed",
        ]);
        expect(recoveredEvents[3]).toEqual({
          _tag: "SessionClosed",
          error: "Prime Agent correlated prompt capability proof was lost during recovery.",
        });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "submitCorrelatedPrompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("accepts proved held lifecycle frames released before reconnect resync", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const correlationId = "72c54219-5831-4254-93a3-fbf370921e24";
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
        });
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 5).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        test.setCorrelatedPromptLifecycleProof(false);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        test.setCorrelatedPromptLifecycleProof(true);
        yield* Effect.promise(() =>
          test.emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(correlationId, "owned", 1),
          }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(2),
              promptLifecycles: {
                records: [promptLifecycle(correlationId, "delivered", 2)],
                expired: [],
              },
            },
          }),
        );
        yield* Effect.promise(() => test.emit({ type: "connection_status", status: "connected" }));

        expect((yield* Fiber.join(events)).map((event) => event._tag)).toEqual([
          "SessionResynced",
          "ConnectionStatus",
          "PromptLifecycleUpdated",
          "SessionResynced",
          "ConnectionStatus",
        ]);
      }),
    ),
  );

  it.effect("rejects an awaited lifecycle reconciliation when its proof fence changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const correlationId = "6a02296b-5ec6-42c9-ad78-758fc6aac770";
        let resolveReconciliation!: (value: unknown) => void;
        let reportReconciliationStarted!: () => void;
        const reconciliationStarted = new Promise<void>((resolve) => {
          reportReconciliationStarted = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
          submitCorrelatedPromptImpl: () => Promise.reject(new Error("native-private-canary")),
          getPromptLifecyclesImpl: () => {
            reportReconciliationStarted();
            return new Promise((resolve) => {
              resolveReconciliation = resolve;
            });
          },
        });
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const submission = yield* runtime
          .submitCorrelatedPrompt({
            text: "must not reconcile through proof loss",
            correlationId,
            queueIfBusy: true,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* Effect.promise(() => reconciliationStarted);
        test.setCorrelatedPromptLifecycleProof(false);
        resolveReconciliation({
          records: [promptLifecycle(correlationId, "owned", 1)],
          expired: [],
        });

        const error = yield* Effect.flip(Fiber.join(submission));
        expect(error).toMatchObject({
          operation: "prompt",
          reason: "request-failed",
          detail:
            "Prime Agent correlated prompt capability proof is unavailable for the current attachment.",
        });
        expect((yield* Fiber.join(events)).map((event) => event._tag)).toEqual([
          "SessionResynced",
          "SessionClosed",
        ]);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "submitCorrelatedPrompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "getPromptLifecycles"),
        ).toHaveLength(1);
        expect(test.captures.connectionCalls.filter((call) => call.method === "prompt")).toEqual(
          [],
        );
      }),
    ),
  );

  it.effect("rejects an awaited correlated cancellation when its proof fence changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const correlationId = "87979d31-e8ec-4c24-a2fd-30b6b32f70d9";
        let resolveCancellation!: (value: unknown) => void;
        let reportCancellationStarted!: () => void;
        const cancellationStarted = new Promise<void>((resolve) => {
          reportCancellationStarted = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: {
              records: [promptLifecycle(correlationId, "owned", 1)],
              expired: [],
            },
          },
          cancelPromptLifecycleImpl: () => {
            reportCancellationStarted();
            return new Promise((resolve) => {
              resolveCancellation = resolve;
            });
          },
        });
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const cancellation = yield* runtime
          .cancelPromptLifecycle(correlationId)
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* Effect.promise(() => cancellationStarted);
        test.setCorrelatedPromptLifecycleProof(false);
        resolveCancellation({
          status: "cancelled",
          ownershipCrossed: true,
          deliveryCrossed: false,
          lifecycle: promptLifecycle(correlationId, "cancelled", 2),
        });

        const error = yield* Effect.flip(Fiber.join(cancellation));
        expect(error).toMatchObject({
          operation: "abort",
          reason: "request-failed",
          detail:
            "Prime Agent correlated prompt capability proof is unavailable for the current attachment.",
        });
        expect((yield* Fiber.join(events)).map((event) => event._tag)).toEqual([
          "SessionResynced",
          "SessionClosed",
        ]);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "cancelPromptLifecycle"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("discards an old proved resync when a newer recovery retires its consumer epoch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const managed = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        const staleCorrelationId = "9e66f14b-5ea3-498b-b523-4d4549d69f62";
        let verificationCallCount = 0;
        let mcpReplacements = 0;
        let resolveBlockedVerification!: (verified: boolean) => void;
        let reportBlockedVerification!: () => void;
        const blockedVerificationStarted = new Promise<void>((resolve) => {
          reportBlockedVerification = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
          verifyManagedSourceImpl: () => {
            verificationCallCount += 1;
            if (verificationCallCount !== 2) return Promise.resolve(true);
            reportBlockedVerification();
            return new Promise((resolve) => {
              resolveBlockedVerification = resolve;
            });
          },
          replaceMcpImpl: () => {
            mcpReplacements += 1;
            return Promise.resolve(undefined);
          },
        });
        const runtime = yield* test.make(
          undefined,
          [managed.path],
          undefined,
          undefined,
          {
            ownerId: "pylon:proof-epoch-race",
            server: {
              name: "t3-code",
              type: "http",
              url: "http://127.0.0.1:4321/mcp/proof-epoch-race",
              headers: { Authorization: "Bearer scoped-secret" },
            },
          },
          managed,
        );
        const events = yield* collectEvents(runtime, 5).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        test.setCorrelatedPromptLifecycleProof(false);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        test.setCorrelatedPromptLifecycleProof(true);
        const staleResync = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(2),
            promptLifecycles: {
              records: [promptLifecycle(staleCorrelationId, "owned", 1)],
              expired: [],
            },
          },
        });
        yield* Effect.promise(() => blockedVerificationStarted);

        test.setCorrelatedPromptLifecycleProof(false);
        const nextReconnect = test.emit({
          type: "connection_status",
          status: "reconnecting",
        });
        test.setCorrelatedPromptLifecycleProof(true);
        const currentResync = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(3),
            promptLifecycles: { records: [], expired: [] },
          },
        });
        resolveBlockedVerification(false);
        yield* Effect.promise(() => Promise.all([staleResync, nextReconnect, currentResync]));
        yield* Effect.promise(() => test.emit({ type: "connection_status", status: "connected" }));

        const recovered = yield* Fiber.join(events);
        expect(recovered.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "ConnectionStatus",
          "ConnectionStatus",
          "SessionResynced",
          "ConnectionStatus",
        ]);
        expect(
          recovered.some(
            (event) =>
              event._tag === "PromptLifecycleUpdated" &&
              event.lifecycle.correlationId === staleCorrelationId,
          ),
        ).toBe(false);
        expect(mcpReplacements).toBe(2);
      }),
    ),
  );

  it.effect("fails closed when a proof-bound event cannot commit to the full queue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
        });
        const runtime = yield* test.make();
        const correlationId = (index: number) =>
          `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
        for (let index = 0; index < PRIME_AGENT_EVENT_BUFFER_CAPACITY - 1; index += 1) {
          yield* Effect.promise(() =>
            test.emit({
              type: "prompt_lifecycle",
              lifecycle: promptLifecycle(correlationId(index), "owned", 1),
            }),
          );
        }

        const overflowId = correlationId(PRIME_AGENT_EVENT_BUFFER_CAPACITY);
        const overflow = test.emit({
          type: "prompt_lifecycle",
          lifecycle: promptLifecycle(overflowId, "owned", 1),
        });
        yield* Effect.yieldNow;
        const events = yield* collectEvents(runtime, PRIME_AGENT_EVENT_BUFFER_CAPACITY + 1).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => overflow);

        const published = yield* Fiber.join(events);
        expect(published.filter((event) => event._tag === "PromptLifecycleUpdated")).toHaveLength(
          PRIME_AGENT_EVENT_BUFFER_CAPACITY - 1,
        );
        expect(
          published.some(
            (event) =>
              event._tag === "PromptLifecycleUpdated" &&
              event.lifecycle.correlationId === overflowId,
          ),
        ).toBe(false);
        expect(published.at(-1)).toEqual({
          _tag: "SessionClosed",
          error: "Prime Agent correlated prompt capability proof was lost during recovery.",
        });
        expect(published.filter((event) => event._tag === "SessionClosed")).toHaveLength(1);
        const afterTerminal = yield* runtime
          .submitCorrelatedPrompt({
            text: "must stay terminal",
            correlationId: "fbd10a32-8719-427a-8cd4-f6510661fe88",
            queueIfBusy: true,
          })
          .pipe(Effect.result);
        expect(afterTerminal).toMatchObject({
          _tag: "Failure",
          failure: {
            detail:
              "Prime Agent correlated prompt capability proof is unavailable for the current attachment.",
          },
        });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "submitCorrelatedPrompt"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("atomically fences submit, reconcile, and cancel lifecycle publication", () =>
    Effect.gen(function* () {
      for (const operation of ["submit", "reconcile", "cancel"] as const) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const correlationId =
              operation === "submit"
                ? "30000000-0000-4000-8000-000000000000"
                : operation === "reconcile"
                  ? "40000000-0000-4000-8000-000000000000"
                  : "50000000-0000-4000-8000-000000000000";
            const initialLifecycle = promptLifecycle(correlationId, "owned", 1);
            const test = fixture({
              correlatedPromptLifecycleCapability: true,
              rawSnapshot: {
                ...snapshot(),
                promptLifecycles: {
                  records: operation === "cancel" ? [initialLifecycle] : [],
                  expired: [],
                },
              },
              submitCorrelatedPromptImpl:
                operation === "reconcile"
                  ? () => Promise.reject(new Error("private submit failure"))
                  : (_message, options) =>
                      Promise.resolve({
                        lifecycle: promptLifecycle(options.correlationId, "owned", 1),
                        duplicate: false,
                      }),
              getPromptLifecyclesImpl: () =>
                Promise.resolve({ records: [initialLifecycle], expired: [] }),
              cancelPromptLifecycleImpl: () =>
                Promise.resolve({
                  status: "cancelled",
                  ownershipCrossed: true,
                  deliveryCrossed: false,
                  lifecycle: promptLifecycle(correlationId, "cancelled", 2),
                }),
            });
            const runtime = yield* test.make();
            for (let index = 0; index < PRIME_AGENT_EVENT_BUFFER_CAPACITY - 1; index += 1) {
              yield* Effect.promise(() => test.emit({ type: "heartbeats_changed" }));
            }

            const commandEffect =
              operation === "cancel"
                ? runtime
                    .cancelPromptLifecycle(correlationId)
                    .pipe(Effect.map((value): unknown => value))
                : runtime
                    .submitCorrelatedPrompt({
                      text: `queue-bound ${operation}`,
                      correlationId,
                      queueIfBusy: true,
                    })
                    .pipe(Effect.map((value): unknown => value));
            const commandFiber = yield* commandEffect.pipe(
              Effect.result,
              Effect.forkChild({ startImmediately: true }),
            );
            yield* Effect.yieldNow;
            const events = yield* collectEvents(
              runtime,
              PRIME_AGENT_EVENT_BUFFER_CAPACITY + 1,
            ).pipe(Effect.forkChild({ startImmediately: true }));

            const result = yield* Fiber.join(commandFiber);
            const published = yield* Fiber.join(events);
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: {
                reason: "request-failed",
                detail:
                  "Prime Agent correlated prompt capability proof is unavailable for the current attachment.",
              },
            });
            expect(
              published.some(
                (event) =>
                  event._tag === "PromptLifecycleUpdated" &&
                  event.lifecycle.correlationId === correlationId,
              ),
            ).toBe(false);
            expect(published.at(-1)).toEqual({
              _tag: "SessionClosed",
              error: "Prime Agent correlated prompt capability proof was lost during recovery.",
            });
          }),
        );
      }
    }),
  );

  it.effect("bounds proof-route retention while managed verification is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const managed = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let verificationCalls = 0;
        let reportBlockedVerification!: () => void;
        const blockedVerificationStarted = new Promise<void>((resolve) => {
          reportBlockedVerification = resolve;
        });
        let releaseBlockedVerification!: (verified: boolean) => void;
        const blockedVerification = new Promise<boolean>((resolve) => {
          releaseBlockedVerification = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
          verifyManagedSourceImpl: () => {
            verificationCalls += 1;
            if (verificationCalls !== 2) return Promise.resolve(true);
            reportBlockedVerification();
            return blockedVerification;
          },
        });
        const runtime = yield* test.make(
          undefined,
          [managed.path],
          undefined,
          undefined,
          undefined,
          managed,
        );
        const events = yield* collectEvents(runtime, 3).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        test.setCorrelatedPromptLifecycleProof(false);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        test.setCorrelatedPromptLifecycleProof(true);
        const blockedResync = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(5),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
        });
        yield* Effect.promise(() => blockedVerificationStarted);

        const queued: Array<Promise<void>> = [];
        for (let index = 0; index < PRIME_AGENT_EVENT_BUFFER_CAPACITY - 1; index += 1) {
          queued.push(
            test.emit({
              type: "prompt_lifecycle",
              lifecycle: promptLifecycle(
                `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
                "owned",
                1,
              ),
            }),
          );
        }
        const overflow = test.emit({
          type: "prompt_lifecycle",
          lifecycle: promptLifecycle("20000000-0000-4000-8000-000000000000", "owned", 1),
        });
        yield* Effect.yieldNow;
        releaseBlockedVerification(true);
        yield* Effect.promise(() =>
          Promise.all([blockedResync, ...queued, overflow]).then(() => undefined),
        );

        expect(yield* Fiber.join(events)).toEqual([
          expect.objectContaining({ _tag: "SessionResynced" }),
          { _tag: "ConnectionStatus", status: "reconnecting" },
          {
            _tag: "SessionClosed",
            error: "Prime Agent correlated prompt capability proof was lost during recovery.",
          },
        ]);
      }),
    ),
  );

  it.effect("fails strict ingress overflow past a never-resolving managed route", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const managed = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let verificationCalls = 0;
        let reportHungVerification!: () => void;
        const hungVerificationStarted = new Promise<void>((resolve) => {
          reportHungVerification = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
          verifyManagedSourceImpl: () => {
            verificationCalls += 1;
            if (verificationCalls === 1) return Promise.resolve(true);
            reportHungVerification();
            return new Promise<boolean>(() => undefined);
          },
        });
        const runtime = yield* test.make(
          undefined,
          [managed.path],
          undefined,
          undefined,
          undefined,
          managed,
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("ConnectionStatus");

        const hungSnapshot = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(51),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
        });
        yield* Effect.promise(() => hungVerificationStarted);
        const staged = Array.from({ length: PRIME_AGENT_EVENT_BUFFER_CAPACITY - 1 }, (_, index) =>
          test.emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(
              `51000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
              "owned",
              1,
            ),
          }),
        );
        const overflow = test.emit({
          type: "prompt_lifecycle",
          lifecycle: promptLifecycle("52000000-0000-4000-8000-000000000000", "owned", 1),
        });
        const callbacks = yield* Effect.promise(() =>
          Promise.all([hungSnapshot, ...staged, overflow]).then(() => undefined),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        expect((yield* collectEvents(runtime, 1))[0]).toEqual({
          _tag: "SessionClosed",
          error: "Prime Agent correlated prompt capability proof was lost during recovery.",
        });
        yield* Fiber.join(callbacks);
        expect(verificationCalls).toBe(2);
      }),
    ),
  );

  it.effect("caps unresolved physical provider recovery operations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const managed = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let verificationCalls = 0;
        let resourceCalls = 0;
        let reportHungResource!: () => void;
        const hungResourceStarted = new Promise<void>((resolve) => {
          reportHungResource = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
          getResourceSnapshotImpl: () => {
            resourceCalls += 1;
            if (resourceCalls === 1) {
              return Promise.resolve({
                extensions: [{ path: managed.path }],
                diagnostics: { extensions: [] },
              });
            }
            reportHungResource();
            return new Promise<unknown>(() => undefined);
          },
          verifyManagedSourceImpl: () => {
            verificationCalls += 1;
            return verificationCalls === 1
              ? Promise.resolve(true)
              : Promise.reject(new Error("rejected verification sibling"));
          },
        });
        const runtime = yield* test.make(
          undefined,
          [managed.path],
          undefined,
          undefined,
          undefined,
          managed,
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("ConnectionStatus");
        const firstSnapshot = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(61),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
        });
        yield* Effect.promise(() => hungResourceStarted);

        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("ConnectionStatus");
        const refusedSnapshot = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(62),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
        });
        yield* Effect.promise(() =>
          Promise.all([firstSnapshot, refusedSnapshot]).then(() => undefined),
        );
        expect((yield* collectEvents(runtime, 1))[0]).toEqual({
          _tag: "SessionClosed",
          error: "Prime Agent correlated prompt capability proof was lost during recovery.",
        });
        expect(verificationCalls).toBe(2);
        expect(resourceCalls).toBe(2);
      }),
    ),
  );

  it.effect("settles a strict managed callback that resumes after disposal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const managed = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let verificationCalls = 0;
        let reportHeldVerification!: () => void;
        const heldVerificationStarted = new Promise<void>((resolve) => {
          reportHeldVerification = resolve;
        });
        let releaseHeldVerification!: () => void;
        const heldVerification = new Promise<boolean>((resolve) => {
          releaseHeldVerification = () => resolve(false);
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
          verifyManagedSourceImpl: () => {
            verificationCalls += 1;
            if (verificationCalls === 1) return Promise.resolve(true);
            reportHeldVerification();
            return heldVerification;
          },
        });
        const runtime = yield* test.make(
          undefined,
          [managed.path],
          undefined,
          undefined,
          undefined,
          managed,
        );
        yield* collectEvents(runtime, 1);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        yield* collectEvents(runtime, 1);
        const callback = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(81),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
        });
        yield* Effect.promise(() => heldVerificationStarted);

        yield* runtime.dispose;
        yield* Effect.promise(() => callback);
        releaseHeldVerification();
        yield* Effect.yieldNow;
        expect(verificationCalls).toBe(2);
      }),
    ),
  );

  it.effect("retires a never-resolving strict MCP replacement on disposal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let replacementCalls = 0;
        let reportHeldReplacement!: () => void;
        const heldReplacementStarted = new Promise<void>((resolve) => {
          reportHeldReplacement = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
          replaceMcpImpl: () => {
            replacementCalls += 1;
            if (replacementCalls === 1) return Promise.resolve(undefined);
            reportHeldReplacement();
            return new Promise<unknown>(() => undefined);
          },
        });
        const runtime = yield* test.make(undefined, undefined, undefined, undefined, {
          ownerId: "pylon:strict-retirement",
          server: {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4321/mcp/strict-retirement",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        });
        yield* collectEvents(runtime, 1);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        yield* collectEvents(runtime, 1);
        const callback = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(91),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
        });
        yield* Effect.promise(() => heldReplacementStarted);

        yield* runtime.dispose;
        yield* Effect.promise(() => callback);
        expect(replacementCalls).toBe(2);
      }),
    ),
  );

  it.effect("caps unresolved physical strict MCP replacements", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let replacementCalls = 0;
        let reportHeldReplacement!: () => void;
        const heldReplacementStarted = new Promise<void>((resolve) => {
          reportHeldReplacement = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
          replaceMcpImpl: () => {
            replacementCalls += 1;
            if (replacementCalls === 1) return Promise.resolve(undefined);
            reportHeldReplacement();
            return new Promise<unknown>(() => undefined);
          },
        });
        const runtime = yield* test.make(undefined, undefined, undefined, undefined, {
          ownerId: "pylon:strict-cap",
          server: {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4321/mcp/strict-cap",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        });
        yield* collectEvents(runtime, 1);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        yield* collectEvents(runtime, 1);
        const heldSnapshot = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(92),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
        });
        yield* Effect.promise(() => heldReplacementStarted);

        const newerReconnect = test.emit({ type: "connection_status", status: "reconnecting" });
        yield* Effect.promise(() =>
          Promise.all([heldSnapshot, newerReconnect]).then(() => undefined),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("ConnectionStatus");
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(93),
              children: [],
              promptLifecycles: { records: [], expired: [] },
            },
          }),
        );
        expect((yield* collectEvents(runtime, 1))[0]).toEqual({
          _tag: "SessionClosed",
          error: "Prime Agent correlated prompt capability proof was lost during recovery.",
        });
        expect(replacementCalls).toBe(2);
      }),
    ),
  );

  it.effect("bounds cumulative decoded event queue weight after proof routes complete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const largeMessages = Array.from({ length: 100 }, (_, index) => ({
          role: "user" as const,
          content: `${index.toString().padStart(3, "0")}${"x".repeat(99_990)}`,
          timestamp: index + 1,
        }));
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
        });
        const runtime = yield* test.make();

        for (let sequence = 5; sequence <= 8; sequence += 1) {
          yield* Effect.promise(() =>
            test.emit({
              type: "session_resynced",
              snapshot: {
                ...snapshot(sequence),
                state: { ...snapshot(sequence).state, messageCount: largeMessages.length },
                children: [],
                messages: largeMessages,
                promptLifecycles: { records: [], expired: [] },
              },
            }),
          );
        }

        const published = yield* collectEvents(runtime, 5);
        expect(published.filter((event) => event._tag === "SessionResynced")).toHaveLength(4);
        expect(published.at(-1)).toEqual({
          _tag: "SessionClosed",
          error: "Prime Agent correlated prompt capability proof was lost during recovery.",
        });
        expect(published.filter((event) => event._tag === "SessionClosed")).toHaveLength(1);
      }),
    ),
  );

  it.effect("discards a stale connected frame before it can poison the next recovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const managed = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let sourceVerifications = 0;
        let mcpReplacements = 0;
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
          verifyManagedSourceImpl: () => {
            sourceVerifications += 1;
            return Promise.resolve(true);
          },
          replaceMcpImpl: () => {
            mcpReplacements += 1;
            return Promise.resolve(undefined);
          },
        });
        const runtime = yield* test.make(
          undefined,
          [managed.path],
          undefined,
          undefined,
          {
            ownerId: "pylon:stale-connected",
            server: {
              name: "t3-code",
              type: "http",
              url: "http://127.0.0.1:4321/mcp/stale-connected",
              headers: { Authorization: "Bearer scoped-secret" },
            },
          },
          managed,
        );
        const events = yield* collectEvents(runtime, 6).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        test.setCorrelatedPromptLifecycleProof(false);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        test.setCorrelatedPromptLifecycleProof(true);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(5),
              children: [],
              promptLifecycles: { records: [], expired: [] },
            },
          }),
        );

        const staleConnected = test.emit({ type: "connection_status", status: "connected" });
        test.setCorrelatedPromptLifecycleProof(false);
        const nextReconnect = test.emit({
          type: "connection_status",
          status: "reconnecting",
        });
        test.setCorrelatedPromptLifecycleProof(true);
        const currentResync = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(6),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
        });
        yield* Effect.promise(() =>
          Promise.all([staleConnected, nextReconnect, currentResync]).then(() => undefined),
        );
        yield* Effect.promise(() => test.emit({ type: "connection_status", status: "connected" }));

        const recovered = yield* Fiber.join(events);
        expect(recovered.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "ConnectionStatus",
          "SessionResynced",
          "ConnectionStatus",
          "SessionResynced",
          "ConnectionStatus",
        ]);
        expect(recovered).not.toContainEqual(expect.objectContaining({ _tag: "SessionClosed" }));
        expect(sourceVerifications).toBe(3);
        expect(mcpReplacements).toBe(3);
      }),
    ),
  );

  it.effect("discards a stale MCP recovery failure after its proof epoch retires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const staleCorrelationId = "b43640ac-2447-436d-bfbb-ffbcbb3496ec";
        let replacements = 0;
        let reportBlockedReplacement!: () => void;
        const blockedReplacementStarted = new Promise<void>((resolve) => {
          reportBlockedReplacement = resolve;
        });
        let rejectBlockedReplacement!: (reason?: unknown) => void;
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
          replaceMcpImpl: () => {
            replacements += 1;
            if (replacements !== 2) return Promise.resolve(undefined);
            reportBlockedReplacement();
            return new Promise((_, reject) => {
              rejectBlockedReplacement = reject;
            });
          },
        });
        const runtime = yield* test.make(undefined, undefined, undefined, undefined, {
          ownerId: "pylon:mcp-proof-epoch-race",
          server: {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4321/mcp/proof-epoch-race",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        });
        const events = yield* collectEvents(runtime, 5).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        test.setCorrelatedPromptLifecycleProof(false);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        test.setCorrelatedPromptLifecycleProof(true);
        const staleResync = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(2),
            promptLifecycles: {
              records: [promptLifecycle(staleCorrelationId, "owned", 1)],
              expired: [],
            },
          },
        });
        yield* Effect.promise(() => blockedReplacementStarted);

        test.setCorrelatedPromptLifecycleProof(false);
        const nextReconnect = test.emit({
          type: "connection_status",
          status: "reconnecting",
        });
        test.setCorrelatedPromptLifecycleProof(true);
        const currentResync = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(3),
            promptLifecycles: { records: [], expired: [] },
          },
        });
        rejectBlockedReplacement(new Error("stale MCP failure canary"));
        yield* Effect.promise(() => Promise.all([staleResync, nextReconnect, currentResync]));
        yield* Effect.promise(() => test.emit({ type: "connection_status", status: "connected" }));

        const recovered = yield* Fiber.join(events);
        expect(recovered.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "ConnectionStatus",
          "ConnectionStatus",
          "SessionResynced",
          "ConnectionStatus",
        ]);
        expect(
          recovered.some(
            (event) =>
              event._tag === "PromptLifecycleUpdated" &&
              event.lifecycle.correlationId === staleCorrelationId,
          ),
        ).toBe(false);
        expect(recovered).not.toContainEqual(expect.objectContaining({ _tag: "SessionClosed" }));
        expect(replacements).toBe(3);
      }),
    ),
  );

  it.effect("rejects a malformed scoped correlated cancellation result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const correlationId = "5070d085-2f9b-4f04-9e55-2d699e804cbb";
        const { make } = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: {
              records: [promptLifecycle(correlationId, "owned", 1)],
              expired: [],
            },
          },
          cancelPromptLifecycleImpl: () =>
            Promise.resolve({
              status: "cancelled",
              ownershipCrossed: true,
              deliveryCrossed: false,
              lifecycle: promptLifecycle("wrong-correlation", "cancelled", 2),
            }),
        });
        const runtime = yield* make();
        const error = yield* runtime.cancelPromptLifecycle(correlationId).pipe(Effect.flip);
        expect(error).toMatchObject({ operation: "abort", reason: "invalid-response" });
      }),
    ),
  );

  it.effect("rejects stale correlated lifecycle progression after a valid successor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const correlationId = "b11dddee-9a03-473b-8c79-6268d21d737d";
        const { emit, make } = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: {
              records: [promptLifecycle(correlationId, "owned", 1)],
              expired: [],
            },
          },
        });
        const runtime = yield* make();
        const events = yield* collectEvents(runtime, 3).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(correlationId, "queued", 2),
          }),
        );
        yield* Effect.promise(() =>
          emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(correlationId, "owned", 1),
          }),
        );
        expect((yield* Fiber.join(events)).slice(1)).toEqual([
          {
            _tag: "PromptLifecycleUpdated",
            lifecycle: promptLifecycle(correlationId, "queued", 2),
          },
          { _tag: "CorrelatedProtocolViolation" },
        ]);
      }),
    ),
  );

  it.effect("routes the private protocol marker only for capable sessions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const unsupportedFixture = fixture();
        const unsupported = yield* unsupportedFixture.make();
        const unsupportedEvents = yield* collectEvents(unsupported, 2).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          unsupportedFixture.emit({ type: "correlated_prompt_protocol_violation" }),
        );
        expect((yield* Fiber.join(unsupportedEvents)).slice(1)).toEqual([
          {
            _tag: "Ignored",
            reason: "unknown-event",
            sourceType: "correlated_prompt_protocol_violation",
          },
        ]);

        const capableFixture = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
        });
        const capable = yield* capableFixture.make();
        const capableEvents = yield* collectEvents(capable, 2).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          capableFixture.emit({ type: "correlated_prompt_protocol_violation" }),
        );
        expect((yield* Fiber.join(capableEvents)).slice(1)).toEqual([
          { _tag: "CorrelatedProtocolViolation" },
        ]);
      }),
    ),
  );

  it.effect("publishes a proved direct resync through the production provider shape", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const managed = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let sourceVerifications = 0;
        let mcpReplacements = 0;
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(4),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
          verifyManagedSourceImpl: () => {
            sourceVerifications += 1;
            return Promise.resolve(true);
          },
          replaceMcpImpl: () => {
            mcpReplacements += 1;
            return Promise.resolve(undefined);
          },
        });
        const runtime = yield* test.make(
          undefined,
          [managed.path],
          undefined,
          undefined,
          {
            ownerId: "pylon:direct-proof",
            server: {
              name: "t3-code",
              type: "http",
              url: "http://127.0.0.1:4321/mcp/direct-proof",
              headers: { Authorization: "Bearer scoped-secret" },
            },
          },
          managed,
        );
        const events = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(5),
              children: [],
              promptLifecycles: { records: [], expired: [] },
            },
          }),
        );

        const published = yield* Fiber.join(events);
        expect(published[1]).toMatchObject({
          _tag: "SessionResynced",
          connectionGeneration: 0,
          correlatedProofEpoch: expect.any(Number),
        });
        const direct = published[1];
        const proofEpoch =
          direct?._tag === "SessionResynced" ? direct.correlatedProofEpoch : undefined;
        expect(runtime.isConnectionGenerationCurrent(0, proofEpoch)).toBe(true);
        expect(runtime.resolveReconnectSnapshot(0, true)).toBe(true);
        expect(sourceVerifications).toBe(1);
        expect(mcpReplacements).toBe(1);
      }),
    ),
  );

  it.effect("fails closed without merging lifecycle state from a stale direct resync", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const correlationId = "47eace3d-ddc2-4d20-b46c-d3ef0b87eef8";
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(4),
            promptLifecycles: {
              records: [promptLifecycle(correlationId, "owned", 1)],
              expired: [],
            },
          },
        });
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 3).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(correlationId, "queued", 2),
          }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(4),
              promptLifecycles: {
                records: [promptLifecycle(correlationId, "delivered", 3)],
                expired: [],
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(correlationId, "delivered", 3),
          }),
        );

        expect(yield* Fiber.join(events)).toEqual([
          expect.objectContaining({ _tag: "SessionResynced" }),
          {
            _tag: "PromptLifecycleUpdated",
            lifecycle: expect.objectContaining({ correlationId, phase: "queued", revision: 2 }),
          },
          {
            _tag: "SessionClosed",
            error: "Prime Agent correlated prompt capability proof was lost during recovery.",
          },
        ]);
        const afterTerminal = yield* runtime
          .submitCorrelatedPrompt({
            text: "must not reopen after malformed resync",
            correlationId: "9aa3c8bd-94ae-40bd-8917-33fa745496ed",
            queueIfBusy: true,
          })
          .pipe(Effect.result);
        expect(afterTerminal).toMatchObject({ _tag: "Failure" });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "submitCorrelatedPrompt"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("fails closed on a direct lifecycle snapshot tombstone conflict", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const correlationId = "69e20929-0152-41ac-a6e4-5432098831f1";
        const deliveredId = "6bd6843d-403e-4432-ad4b-6971b1875dd9";
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(4),
            promptLifecycles: {
              records: [
                promptLifecycle(correlationId, "owned", 1),
                promptLifecycle(deliveredId, "failed", 2),
              ],
              expired: [],
            },
          },
        });
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(5),
              promptLifecycles: {
                records: [promptLifecycle(correlationId, "queued", 2)],
                expired: [{ correlationId: deliveredId, deliveryCrossed: false }],
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(correlationId, "queued", 2),
          }),
        );

        expect(yield* Fiber.join(events)).toEqual([
          expect.objectContaining({ _tag: "SessionResynced" }),
          {
            _tag: "SessionClosed",
            error: "Prime Agent correlated prompt capability proof was lost during recovery.",
          },
        ]);
      }),
    ),
  );

  it.effect("bounds live lifecycle retention without evicting an active prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lifecycleId = (index: number) =>
          `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
        const activeId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(4),
            promptLifecycles: {
              records: [promptLifecycle(activeId, "owned", 1)],
              expired: [],
            },
          },
        });
        const runtime = yield* test.make();
        expect(yield* collectEvents(runtime, 1)).toHaveLength(1);
        for (let index = 0; index < 520; index += 1) {
          const next = yield* collectEvents(runtime, 1).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Effect.promise(() =>
            test.emit({
              type: "prompt_lifecycle",
              lifecycle: promptLifecycle(lifecycleId(index), "failed", index + 2),
            }),
          );
          expect(yield* Fiber.join(next)).toHaveLength(1);
        }

        const boundedEvents = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event._tag === "HeartbeatsChanged"),
          Stream.runCollect,
          Effect.forkChild,
        );
        // An exact duplicate must not refresh the oldest retained terminal.
        yield* Effect.promise(() =>
          test.emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(lifecycleId(264), "failed", 266),
          }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(lifecycleId(520), "failed", 522),
          }),
        );
        // The duplicate stayed oldest and became a tombstone after the next terminal.
        yield* Effect.promise(() =>
          test.emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(lifecycleId(264), "failed", 266),
          }),
        );
        // The oldest terminal and tombstone have both aged out and are accepted as unknown.
        yield* Effect.promise(() =>
          test.emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(lifecycleId(0), "failed", 2),
          }),
        );
        // All nonterminal records survive terminal/tombstone pruning.
        yield* Effect.promise(() =>
          test.emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(activeId, "queued", 523),
          }),
        );
        yield* Effect.promise(() => test.emit({ type: "heartbeats_changed" }));

        expect(Array.from(yield* Fiber.join(boundedEvents))).toEqual([
          {
            _tag: "PromptLifecycleUpdated",
            lifecycle: expect.objectContaining({ correlationId: lifecycleId(520) }),
          },
          { _tag: "CorrelatedProtocolViolation" },
          {
            _tag: "PromptLifecycleUpdated",
            lifecycle: expect.objectContaining({ correlationId: lifecycleId(0) }),
          },
          {
            _tag: "PromptLifecycleUpdated",
            lifecycle: expect.objectContaining({ correlationId: activeId, phase: "queued" }),
          },
          { _tag: "HeartbeatsChanged" },
        ]);
      }),
    ),
  );

  it.effect("replaces bounded lifecycle state from a proved authoritative snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const activeId = "004370d8-540f-4592-aa54-b98388577f6a";
        const agedTerminalId = "5d2948af-229b-4873-bb39-92d36bcf07c3";
        const agedTombstoneId = "b77ea8bd-14f7-4a33-80cc-9dd4e05d340d";
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(4),
            promptLifecycles: {
              records: [
                promptLifecycle(activeId, "owned", 1),
                promptLifecycle(agedTerminalId, "failed", 2),
              ],
              expired: [{ correlationId: agedTombstoneId, deliveryCrossed: false }],
            },
          },
        });
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 5).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(6),
              promptLifecycles: {
                records: [promptLifecycle(activeId, "queued", 3)],
                expired: [],
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(agedTerminalId, "failed", 2),
          }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(agedTombstoneId, "failed", 4, {
              deliveryCrossed: false,
            }),
          }),
        );
        yield* Effect.promise(() => test.emit({ type: "heartbeats_changed" }));

        expect(yield* Fiber.join(events)).toEqual([
          expect.objectContaining({ _tag: "SessionResynced" }),
          expect.objectContaining({ _tag: "SessionResynced" }),
          {
            _tag: "PromptLifecycleUpdated",
            lifecycle: expect.objectContaining({ correlationId: agedTerminalId }),
          },
          {
            _tag: "PromptLifecycleUpdated",
            lifecycle: expect.objectContaining({ correlationId: agedTombstoneId }),
          },
          { _tag: "HeartbeatsChanged" },
        ]);
      }),
    ),
  );

  it.effect("rejects capable snapshots from a mismatched owned generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const invalidInitial = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            state: { ...snapshot().state, activeSessionId: "other-active-generation" },
            promptLifecycles: { records: [], expired: [] },
          },
        });
        const initialError = yield* invalidInitial.make().pipe(Effect.flip);
        expect(initialError).toMatchObject({
          operation: "initial-snapshot",
          reason: "invalid-response",
        });

        const correlationId = "70c5df6a-a680-4ad6-a5ca-aa581cf81f81";
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(4),
            promptLifecycles: {
              records: [promptLifecycle(correlationId, "owned", 1)],
              expired: [],
            },
          },
        });
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(5),
              state: { ...snapshot(5).state, activeSessionId: "other-active-generation" },
              promptLifecycles: {
                records: [promptLifecycle(correlationId, "queued", 2)],
                expired: [],
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "prompt_lifecycle",
            lifecycle: promptLifecycle(correlationId, "queued", 2),
          }),
        );

        expect(yield* Fiber.join(events)).toEqual([
          expect.objectContaining({ _tag: "SessionResynced" }),
          {
            _tag: "SessionClosed",
            error: "Prime Agent correlated prompt capability proof was lost during recovery.",
          },
        ]);
      }),
    ),
  );

  it.effect(
    "fails closed on malformed capable provenance and accepts an exact delivered owner",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const correlationId = "a72dc9f8-8ada-43fa-a556-039e16b7cb50";
          const { emit, make } = fixture({
            correlatedPromptLifecycleCapability: true,
            rawSnapshot: {
              ...snapshot(),
              promptLifecycles: {
                records: [promptLifecycle(correlationId, "delivered", 2)],
                expired: [],
              },
            },
          });
          const runtime = yield* make();
          const events = yield* collectEvents(runtime, 3).pipe(Effect.forkChild);
          yield* Effect.promise(() =>
            emit({
              type: "session_event",
              event: { type: "agent_start", promptCorrelationId: correlationId },
            }),
          );
          yield* Effect.promise(() =>
            emit({
              type: "session_event",
              attribution: { scope: "prompt", correlationId },
              event: { type: "agent_start", promptCorrelationId: correlationId },
            }),
          );
          expect((yield* Fiber.join(events)).slice(1)).toEqual([
            { _tag: "CorrelatedProtocolViolation" },
            {
              _tag: "RunStarted",
              attribution: { scope: "prompt", correlationId },
            },
          ]);
        }),
      ),
  );

  it.effect(
    "creates one client-owned session, subscribes before snapshot, and exposes only an opaque cursor",
    () =>
      Effect.gen(function* () {
        const { captures, make } = fixture();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* make();
            expect(captures.openCount).toBe(1);
            expect(captures.order).toEqual(["request-recovery", "attach", "subscribe", "snapshot"]);
            expect(captures.commands).toEqual([
              {
                type: "create",
                lifecycle: "client_owned",
                continueRecent: false,
                config: {
                  cwd: "/work/project",
                  sessionDir: "/state/provider-sessions/thread-safe",
                  agentDir: "/state/prime-agent-home",
                  noBuiltinTools: false,
                  noExtensions: false,
                  noSkills: false,
                  noContextFiles: false,
                  model: "openai/gpt-5.3-codex",
                  thinking: "high",
                },
              },
            ]);
            expect(runtime.resumeCursor).toEqual(PRIME_AGENT_DAEMON_RESUME_CURSOR);
            expect(runtime.sessionId).toBe("session-1");
            expect(runtime.sessionFile).toBe("/state/provider-sessions/thread-safe/session.jsonl");
            expect(runtime.resumeCursor).not.toHaveProperty("activeSessionId");
            expect(runtime.resumeCursor).not.toHaveProperty("sessionPath");
            expect(runtime.initialSnapshot.state).not.toHaveProperty("sessionDir");
            expect(runtime.initialSnapshot.children[0]).not.toHaveProperty("sessionDir");
            expect(captures.attachOptions[0]).toMatchObject({
              closeClientOnDispose: false,
              supportsExtensionUi: true,
              ownedSession: true,
              ownedSessionRecoveryConfig: {
                cwd: "/work/project",
                sessionDir: "/state/provider-sessions/thread-safe",
                agentDir: "/state/prime-agent-home",
                noBuiltinTools: false,
                noExtensions: false,
                noSkills: false,
                noContextFiles: false,
                model: "openai/gpt-5.3-codex",
                thinking: "high",
              },
            });
            yield* Effect.promise(() => captures.reconnectOptions[0]!.recoverDaemon());
            expect(captures.recoverCount).toBe(1);
          }),
        );
        expect(captures.disposeCount).toBe(1);
        expect(captures.closeCount).toBe(1);
        expect(captures.unsubscribeCount).toBe(1);
      }),
  );

  it.effect("attaches Pylon's scoped MCP server before the initial snapshot and releases it", () =>
    Effect.gen(function* () {
      const { captures, make } = fixture();
      const mcpServer = {
        ownerId: "pylon:provider-session-1",
        server: {
          name: "t3-code",
          type: "http" as const,
          url: "http://127.0.0.1:4321/mcp/provider-session-1",
          headers: { Authorization: "Bearer scoped-secret" },
        },
      };

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* make(undefined, undefined, undefined, undefined, mcpServer);
          expect(captures.order).toEqual([
            "request-recovery",
            "attach",
            "replace-mcp",
            "subscribe",
            "snapshot",
          ]);
          expect(
            captures.connectionCalls.find((call) => call.method === "replaceAcpMcpServers"),
          ).toEqual({
            method: "replaceAcpMcpServers",
            args: [[mcpServer.server], mcpServer.ownerId],
          });
        }),
      );

      expect(
        captures.connectionCalls.find((call) => call.method === "releaseAcpMcpServers"),
      ).toEqual({
        method: "releaseAcpMcpServers",
        args: [mcpServer.ownerId, [mcpServer.server.name]],
      });
      expect(captures.order.indexOf("release-mcp")).toBeLessThan(captures.order.indexOf("dispose"));
      expect(captures.disposeCount).toBe(1);
      expect(captures.closeCount).toBe(1);
    }),
  );

  it.effect("does not replace live MCP ownership for an ordinary resync snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, emit, make } = fixture();
        const runtime = yield* make(undefined, undefined, undefined, undefined, {
          ownerId: "pylon:provider-session-1",
          server: {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4321/mcp/provider-session-1",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        });
        const eventsFiber = yield* collectEvents(runtime, 2).pipe(Effect.forkChild);

        yield* Effect.promise(() => emit({ type: "session_resynced", snapshot: snapshot(5) }));

        expect((yield* Fiber.join(eventsFiber)).map((event) => event._tag)).toEqual([
          "SessionResynced",
          "SessionResynced",
        ]);
        expect(
          captures.connectionCalls.filter((call) => call.method === "replaceAcpMcpServers"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("reattaches Pylon's scoped MCP server before publishing a daemon resync", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, emit, make } = fixture();
        const runtime = yield* make(undefined, undefined, undefined, undefined, {
          ownerId: "pylon:provider-session-1",
          server: {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4321/mcp/provider-session-1",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        });
        const eventsFiber = yield* collectEvents(runtime, 4).pipe(Effect.forkChild);

        yield* Effect.promise(() =>
          emit({ type: "connection_status", status: "reconnecting", error: "private" }),
        );
        yield* Effect.promise(() => emit({ type: "session_resynced", snapshot: snapshot(5) }));
        yield* Effect.promise(() => emit({ type: "connection_status", status: "connected" }));

        const events = yield* Fiber.join(eventsFiber);
        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "ConnectionStatus",
          "SessionResynced",
          "ConnectionStatus",
        ]);
        expect(
          captures.connectionCalls.filter((call) => call.method === "replaceAcpMcpServers"),
        ).toHaveLength(2);
      }),
    ),
  );

  it.effect("blocks a waiting prompt when scoped MCP recovery fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let replacements = 0;
        let signalReplacementStarted: () => void = () => undefined;
        const replacementStarted = new Promise<void>((resolve) => {
          signalReplacementStarted = resolve;
        });
        let rejectRecovery: (reason?: unknown) => void = () => undefined;
        const { captures, emit, make } = fixture({
          replaceMcpImpl: () => {
            replacements += 1;
            if (replacements === 1) return Promise.resolve(undefined);
            signalReplacementStarted();
            return new Promise((_, reject) => {
              rejectRecovery = reject;
            });
          },
        });
        const runtime = yield* make(undefined, undefined, undefined, undefined, {
          ownerId: "pylon:provider-session-1",
          server: {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4321/mcp/provider-session-1",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        });
        const eventsFiber = yield* collectEvents(runtime, 3).pipe(Effect.forkChild);

        yield* Effect.promise(() =>
          emit({ type: "connection_status", status: "reconnecting", error: "private" }),
        );
        const resyncFiber = yield* Effect.promise(() =>
          emit({ type: "session_resynced", snapshot: snapshot(5) }),
        ).pipe(Effect.forkChild);
        yield* Effect.promise(() => replacementStarted);
        const promptFiber = yield* runtime
          .prompt({ text: "must not run without browser tools" })
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.yieldNow;
        rejectRecovery(new Error("still streaming"));
        yield* Fiber.join(resyncFiber);
        yield* Effect.promise(() => emit({ type: "connection_status", status: "connected" }));

        const events = yield* Fiber.join(eventsFiber);
        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "ConnectionStatus",
          "SessionClosed",
        ]);
        const prompt = yield* Fiber.join(promptFiber);
        expect(prompt).toMatchObject({
          _tag: "Failure",
          failure: { operation: "configure-mcp", reason: "request-failed" },
        });
        expect(captures.connectionCalls.filter((call) => call.method === "prompt")).toEqual([]);
      }),
    ),
  );

  it.effect("fails closed before snapshot when the daemon cannot own scoped MCP servers", () =>
    Effect.gen(function* () {
      const { captures, make } = fixture({ omitMcpSupport: true });
      const result = yield* Effect.scoped(
        make(undefined, undefined, undefined, undefined, {
          ownerId: "pylon:provider-session-1",
          server: {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4321/mcp/provider-session-1",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        }).pipe(Effect.result),
      );

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "PrimeAgentDaemonSessionRuntimeError",
          operation: "configure-mcp",
          reason: "incompatible-api",
        },
      });
      expect(captures.order).not.toContain("snapshot");
      expect(captures.disposeCount).toBe(1);
      expect(captures.closeCount).toBe(1);
    }),
  );

  it.effect("projects a bounded path-free session resource catalog", () =>
    Effect.gen(function* () {
      const { make } = fixture({
        resourceSnapshot: {
          skills: [
            {
              name: " review ",
              description: "Review the change",
              filePath: "/private/project/.agents/skills/review/SKILL.md",
              sourceInfo: {
                path: "/private/project/.agents/skills/review/SKILL.md",
                source: "local-secret",
                scope: "project",
                origin: "directory",
                baseDir: "/private/project",
              },
            },
          ],
          prompts: [
            {
              name: "release",
              description: "Prepare a release",
              argumentHint: "<version>",
              filePath: "/private/prompts/release.md",
              sourceInfo: {
                path: "/private/prompts/release.md",
                source: "git+token-secret",
                scope: "user",
                origin: "package",
              },
            },
          ],
          extensions: [{ path: "/private/extensions/secret.mjs" }],
          diagnostics: {
            extensions: [
              { type: "error", message: "credential-secret", path: "/private/secret.mjs" },
            ],
          },
        },
        commands: [
          {
            name: "skill:review",
            registeredName: "private-registration",
            description: "Review the change",
            argumentHint: "[target]",
            source: "skill",
            sourceInfo: {
              path: "/private/project/.agents/skills/review/SKILL.md",
              scope: "project",
            },
          },
          {
            name: "release",
            source: "prompt",
            sourceInfo: { path: "/private/prompts/release.md", scope: "user" },
          },
        ],
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* make();
          expect(runtime.initialResources).toEqual({
            available: true,
            skills: [{ name: "review", description: "Review the change", scope: "project" }],
            prompts: [
              {
                name: "release",
                description: "Prepare a release",
                argumentHint: "<version>",
                scope: "user",
              },
            ],
            commands: [
              {
                name: "skill:review",
                description: "Review the change",
                argumentHint: "[target]",
                source: "skill",
              },
              { name: "release", source: "prompt" },
            ],
          });
          expect(runtime.initialResources.skills[0]).not.toHaveProperty("filePath");
          expect(runtime.initialResources.skills[0]).not.toHaveProperty("sourceInfo");
          expect(runtime.initialResources.prompts[0]).not.toHaveProperty("filePath");
          expect(runtime.initialResources.commands[0]).not.toHaveProperty("registeredName");
          expect(runtime.initialResources.commands[0]).not.toHaveProperty("sourceInfo");
        }),
      );
    }),
  );

  it.effect("marks malformed native resource catalogs unavailable without failing chat", () =>
    Effect.gen(function* () {
      const { make } = fixture({
        resourceSnapshot: {
          skills: [{ name: 123, filePath: "/private/skill" }],
          prompts: [],
          extensions: [],
          diagnostics: { extensions: [] },
        },
        commands: [],
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* make();
          expect(runtime.initialResources).toEqual({
            available: false,
            skills: [],
            prompts: [],
            commands: [],
          });
        }),
      );
    }),
  );

  it.effect("awaits reload before reading and sanitizing the replacement catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let releaseReload: (() => void) | undefined;
        const reloadGate = new Promise<void>((resolve) => {
          releaseReload = resolve;
        });
        const { captures, make } = fixture({
          reloadImpl: async () => {
            await reloadGate;
            return undefined;
          },
          resourceSnapshot: {
            skills: [],
            prompts: [],
            extensions: [{ path: "/private/extension.mjs" }],
            diagnostics: { extensions: [] },
          },
          commands: [
            {
              name: "skill:review",
              registeredName: "private-name",
              source: "skill",
              sourceInfo: { path: "/private/review/SKILL.md", scope: "project" },
            },
          ],
        });
        const runtime = yield* make();
        captures.connectionCalls.splice(0);
        const fiber = yield* runtime.reloadResources.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(captures.connectionCalls).toEqual([{ method: "reload", args: [] }]);
        releaseReload?.();
        const resources = yield* Fiber.join(fiber);
        expect(captures.connectionCalls.map((call) => call.method)).toEqual([
          "reload",
          "getResourceSnapshot",
          "getCommands",
          "getRlmMaxDepthStatus",
        ]);
        expect(resources.resources.commands).toEqual([{ name: "skill:review", source: "skill" }]);
        expect(resources.resources.commands[0]).not.toHaveProperty("registeredName");
        expect(resources.resources.commands[0]).not.toHaveProperty("sourceInfo");
        expect(resources.agentDepth).toEqual({
          maxDepth: 0,
          source: "session",
          writable: true,
          settable: true,
          maxSettableDepth: 4,
        });
      }),
    ),
  );

  it.effect("rejects reload when the generated managed source changes afterward", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expected = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let verificationCalls = 0;
        const { captures, make } = fixture({
          rawSnapshot: { ...snapshot(), children: [] },
          verifyManagedSourceImpl: () => {
            verificationCalls += 1;
            return Promise.resolve(verificationCalls === 1);
          },
        });
        const runtime = yield* make(
          undefined,
          [expected.path],
          undefined,
          undefined,
          undefined,
          expected,
        );
        captures.connectionCalls.splice(0);

        const error = yield* runtime.reloadResources.pipe(Effect.flip);

        expect(error).toMatchObject({
          operation: "reload-resources",
          reason: "invalid-response",
        });
        expect(verificationCalls).toBe(2);
        expect(captures.connectionCalls.map((call) => call.method)).toContain("reload");
      }),
    ),
  );

  it.effect("rejects invalid explicit reload results without reading a replacement catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({
          reloadImpl: () => Promise.resolve({ raw: "secret" }),
        });
        const runtime = yield* make();
        captures.connectionCalls.splice(0);
        const error = yield* runtime.reloadResources.pipe(Effect.flip);
        expect(error).toMatchObject({
          operation: "reload-resources",
          reason: "invalid-response",
        });
        expect(captures.connectionCalls).toEqual([{ method: "reload", args: [] }]);
        expect(error.detail).not.toContain("secret");
      }),
    ),
  );

  it.effect("reads and updates bounded per-session agent depth without global persistence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({ rlmDepth: 2 });
        const runtime = yield* make();
        expect(runtime.initialAgentDepth).toEqual({
          maxDepth: 2,
          source: "session",
          writable: true,
          settable: true,
          maxSettableDepth: 4,
        });
        captures.connectionCalls.splice(0);

        const current = yield* runtime.getAgentDepth;
        const updated = yield* runtime.setAgentDepth(4);
        const invalid = yield* runtime.setAgentDepth(5).pipe(Effect.flip);

        expect(current.maxDepth).toBe(2);
        expect(updated).toEqual({
          maxDepth: 4,
          source: "session",
          writable: true,
          settable: true,
          maxSettableDepth: 4,
        });
        expect(invalid).toMatchObject({
          operation: "set-agent-depth",
          reason: "invalid-input",
        });
        expect(captures.connectionCalls).toEqual([
          { method: "getRlmMaxDepthStatus", args: [] },
          { method: "setRlmMaxDepth", args: [4] },
        ]);
      }),
    ),
  );

  it.effect("rejects invalid native agent depth responses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({
          setRlmImpl: () => Promise.resolve({ maxDepth: 2, source: "chat", globalSaved: false }),
        });
        const runtime = yield* make();
        captures.connectionCalls.splice(0);

        const error = yield* runtime.setAgentDepth(3).pipe(Effect.flip);
        expect(error).toMatchObject({
          operation: "set-agent-depth",
          reason: "invalid-response",
        });
        expect(captures.connectionCalls).toEqual([{ method: "setRlmMaxDepth", args: [3] }]);
      }),
    ),
  );

  it.effect("reads the safe agent roster and routes bounded native cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({
          cancelRlmImpl: (agentId) => Promise.resolve(agentId === "child-1"),
        });
        const runtime = yield* make();
        captures.connectionCalls.splice(0);

        const roster = yield* runtime.getAgentRoster;
        const cancelled = yield* runtime.cancelAgent("child-1");

        expect(roster).toEqual([
          expect.objectContaining({ id: "child-1", label: "child", status: "running" }),
        ]);
        expect(roster[0]).not.toHaveProperty("sessionDir");
        expect(cancelled).toBe(true);
        expect(captures.connectionCalls).toEqual([{ method: "cancelRlmChild", args: ["child-1"] }]);
      }),
    ),
  );

  it.effect("prefers the authoritative 0.8 agent roster and rejects malformed refreshes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const authoritative = fixture({
          authoritativeRlmChildren: [
            {
              id: "child-2",
              activeSessionId: "active-child-2",
              label: "new child",
              status: "running",
              sessionDir: "/private/child-2",
            },
          ],
        });
        const runtime = yield* authoritative.make();
        authoritative.captures.connectionCalls.splice(0);

        expect(yield* runtime.getAgentRoster).toEqual([
          expect.objectContaining({ id: "child-2", status: "running" }),
        ]);
        expect(authoritative.captures.connectionCalls).toEqual([
          { method: "getRlmChildSnapshots", args: [] },
        ]);

        const malformed = fixture({ authoritativeRlmChildren: { children: [] } });
        const malformedRuntime = yield* malformed.make();
        const error = yield* malformedRuntime.getAgentRoster.pipe(Effect.flip);
        expect(error).toMatchObject({
          operation: "get-agent-roster",
          reason: "invalid-response",
        });

        const oversized = fixture({
          authoritativeRlmChildren: Array.from({ length: 101 }, (_, index) => ({
            id: `child-${index}`,
            label: "child",
            status: "running",
            sessionDir: `/private/child-${index}`,
          })),
        });
        const oversizedRuntime = yield* oversized.make();
        expect(yield* oversizedRuntime.getAgentRoster.pipe(Effect.flip)).toMatchObject({
          operation: "get-agent-roster",
          reason: "invalid-response",
        });
      }),
    ),
  );

  it.effect("rejects invalid cancellation ids and native responses without retrying", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({ cancelRlmImpl: () => Promise.resolve("yes") });
        const runtime = yield* make();
        captures.connectionCalls.splice(0);

        const invalidId = yield* runtime.cancelAgent(" ").pipe(Effect.flip);
        const oversizedId = yield* runtime
          .cancelAgent("x".repeat(PROVIDER_AGENT_CONTROL_ID_MAX_CHARS + 1))
          .pipe(Effect.flip);
        const invalidResponse = yield* runtime.cancelAgent("child-1").pipe(Effect.flip);

        expect(invalidId).toMatchObject({ operation: "cancel-agent", reason: "invalid-input" });
        expect(oversizedId).toMatchObject({
          operation: "cancel-agent",
          reason: "invalid-input",
        });
        expect(invalidResponse).toMatchObject({
          operation: "cancel-agent",
          reason: "invalid-response",
        });
        expect(captures.connectionCalls).toEqual([{ method: "cancelRlmChild", args: ["child-1"] }]);
      }),
    ),
  );

  it.effect("bounds native agent cancellation while roster reads stay event-driven", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const never = () => new Promise<unknown>(() => undefined);
        const { make } = fixture({ cancelRlmImpl: never });
        const runtime = yield* make();

        const cancellationFiber = yield* runtime.cancelAgent("child-1").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("30 seconds");
        const cancellationError = yield* Fiber.join(cancellationFiber).pipe(Effect.flip);
        expect(cancellationError).toMatchObject({
          operation: "cancel-agent",
          reason: "request-failed",
          detail: expect.stringContaining("Timed out"),
        });
        expect(yield* runtime.getAgentRoster).toEqual([
          expect.objectContaining({ id: "child-1", status: "running" }),
        ]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("blocks admission from initial compaction, bash, retry, and queue snapshots", () =>
    Effect.gen(function* () {
      const idle = snapshot();
      const activeSnapshots = [
        { ...idle, state: { ...idle.state, isCompacting: true }, children: [] },
        { ...idle, state: { ...idle.state, isBashRunning: true }, children: [] },
        { ...idle, state: { ...idle.state, retryAttempt: 1 }, children: [] },
        {
          ...idle,
          state: {
            ...idle.state,
            sessionActions: {
              ...idle.state.sessionActions,
              queuedCount: 1,
              followUps: [{ text: "queued input" }],
            },
          },
          children: [],
        },
      ];
      const admissionStates: boolean[] = [];
      for (const rawSnapshot of activeSnapshots) {
        admissionStates.push(
          yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* fixture({ rawSnapshot }).make();
              return runtime.inputAdmissionBusy;
            }),
          ),
        );
      }

      expect(admissionStates).toEqual([true, true, true, true]);
    }),
  );

  it.effect("blocks admission from resynced compaction, bash, retry, and queue snapshots", () =>
    Effect.gen(function* () {
      const idle = snapshot(5);
      const activeSnapshots = [
        { ...idle, state: { ...idle.state, isCompacting: true }, children: [] },
        { ...idle, state: { ...idle.state, isBashRunning: true }, children: [] },
        { ...idle, state: { ...idle.state, retryAttempt: 1 }, children: [] },
        {
          ...idle,
          state: {
            ...idle.state,
            sessionActions: {
              ...idle.state.sessionActions,
              queuedCount: 1,
              steering: [{ text: "queued input" }],
            },
          },
          children: [],
        },
      ];
      const admissionStates: boolean[] = [];
      for (const activeSnapshot of activeSnapshots) {
        admissionStates.push(
          yield* Effect.scoped(
            Effect.gen(function* () {
              const initial = snapshot();
              const { emit, make } = fixture({
                rawSnapshot: { ...initial, children: [] },
              });
              const runtime = yield* make();
              expect(runtime.inputAdmissionBusy).toBe(false);
              yield* Effect.promise(() =>
                emit({ type: "session_resynced", snapshot: activeSnapshot }),
              );
              return runtime.inputAdmissionBusy;
            }),
          ),
        );
      }

      expect(admissionStates).toEqual([true, true, true, true]);
    }),
  );

  it.effect(
    "tracks live compaction, bash, BashOutput, retry, and queue activity until quiescence",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const initial = snapshot();
          const { emit, make } = fixture({ rawSnapshot: { ...initial, children: [] } });
          const runtime = yield* make();
          const activityCases: ReadonlyArray<{
            readonly start: unknown;
            readonly complete: unknown;
          }> = [
            {
              start: {
                type: "session_event",
                event: { type: "compaction_start", reason: "manual" },
              },
              complete: {
                type: "session_event",
                event: {
                  type: "compaction_end",
                  reason: "manual",
                  aborted: false,
                  willRetry: false,
                },
              },
            },
            {
              start: {
                type: "session_event",
                event: {
                  type: "bash_start",
                  command: "printf activity",
                  excludeFromContext: false,
                },
              },
              complete: {
                type: "session_event",
                event: {
                  type: "bash_end",
                  exitCode: 0,
                  cancelled: false,
                  truncated: false,
                },
              },
            },
            {
              start: {
                type: "session_event",
                event: { type: "bash_output", chunk: "late output without a start callback" },
              },
              complete: {
                type: "session_event",
                event: {
                  type: "bash_end",
                  exitCode: 0,
                  cancelled: false,
                  truncated: false,
                },
              },
            },
            {
              start: {
                type: "session_event",
                event: {
                  type: "auto_retry_start",
                  attempt: 1,
                  maxAttempts: 3,
                  delayMs: 100,
                  errorMessage: "retrying",
                },
              },
              complete: {
                type: "session_event",
                event: { type: "auto_retry_end", success: true, attempt: 1 },
              },
            },
            {
              start: {
                type: "session_event",
                event: {
                  type: "session_action_update",
                  actions: {
                    queuedCount: 1,
                    steering: [{ text: "queued input" }],
                    followUps: [],
                    active: { kind: "turn", phase: "running" },
                  },
                },
              },
              complete: {
                type: "session_event",
                event: { type: "session_action_update", actions },
              },
            },
          ];

          for (const [index, activity] of activityCases.entries()) {
            yield* Effect.promise(() => emit(activity.start));
            expect(runtime.inputAdmissionBusy).toBe(true);
            yield* Effect.promise(() => emit(activity.complete));
            expect(runtime.inputAdmissionBusy).toBe(true);
            yield* runtime.waitForRlmQuiescence(`background:live:${index}`, activeSignal());
            expect(runtime.inputAdmissionBusy).toBe(false);
          }
        }),
      ),
  );

  it.effect("does not let an older background barrier clear newer bash output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let releaseBarrier!: () => void;
        let reportBarrierStarted!: () => void;
        const barrierStarted = new Promise<void>((resolve) => {
          reportBarrierStarted = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          releaseBarrier = resolve;
        });
        let releaseStats!: () => void;
        let reportStatsStarted!: () => void;
        const statsStarted = new Promise<void>((resolve) => {
          reportStatsStarted = resolve;
        });
        const stats = new Promise<unknown>((resolve) => {
          releaseStats = () =>
            resolve({
              sessionFile: "/daemon/private/session.jsonl",
              sessionId: "session-1",
              tokens: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                total: 2,
              },
              cost: 0,
              contextUsage: { tokens: 2, contextWindow: 200_000, percent: 0.001 },
            });
        });
        const initial = snapshot();
        const { emit, make } = fixture({
          rawSnapshot: { ...initial, children: [] },
          waitForHeadlessCompletionImpl: () => {
            reportBarrierStarted();
            return barrier;
          },
          getSessionStatsImpl: () => {
            reportStatsStarted();
            return stats;
          },
        });
        const runtime = yield* make();
        yield* Effect.promise(() =>
          emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        yield* Effect.promise(() =>
          emit({ type: "session_event", event: { type: "agent_end", messages: [] } }),
        );
        const waiting = yield* runtime
          .waitForRlmQuiescence("background:stale", activeSignal())
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => barrierStarted);
        releaseBarrier();
        yield* Effect.promise(() => statsStarted);

        yield* Effect.promise(() =>
          emit({
            type: "session_event",
            event: { type: "bash_output", chunk: "newer native activity" },
          }),
        );
        releaseStats();
        yield* Fiber.join(waiting);
        expect(runtime.inputAdmissionBusy).toBe(true);

        yield* Effect.promise(() =>
          emit({
            type: "session_event",
            event: {
              type: "bash_end",
              exitCode: 0,
              cancelled: false,
              truncated: false,
            },
          }),
        );
        yield* runtime.waitForRlmQuiescence("background:fresh", activeSignal());
        expect(runtime.inputAdmissionBusy).toBe(false);
      }),
    ),
  );

  it.effect(
    "keeps an active recovery snapshot conservative across a newer live terminal event",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let snapshotReads = 0;
          const idle = snapshot(5);
          const test = fixture({
            rawSnapshotImpl: () => {
              snapshotReads += 1;
              return snapshotReads === 1
                ? { ...idle, children: [] }
                : {
                    ...snapshot(6),
                    state: {
                      ...snapshot(6).state,
                      activeSessionId: "active-secret-1",
                      isCompacting: true,
                    },
                    children: [],
                  };
            },
            omitRlmQuiescence: true,
            listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
          });
          const runtime = yield* test.make();
          const recoveryEvents = yield* collectEvents(runtime, 3).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Effect.promise(() =>
            test.emit({ type: "session_event", event: { type: "agent_start" } }),
          );
          const closing = yield* Effect.promise(() =>
            test.emit({ type: "closed", error: "Daemon worker client closed" }),
          ).pipe(Effect.forkChild({ startImmediately: true }));

          yield* TestClock.adjust(250);
          expect((yield* Fiber.join(recoveryEvents)).map((event) => event._tag)).toEqual([
            "SessionResynced",
            "RunStarted",
            "SessionResynced",
          ]);
          yield* Effect.promise(() =>
            test.emit({ type: "session_event", event: { type: "agent_end", messages: [] } }),
          );
          expect(runtime.inputAdmissionBusy).toBe(true);

          expect(runtime.resolveReconnectSnapshot(0, true, true)).toBe(true);
          expect(runtime.inputAdmissionBusy).toBe(true);
          yield* Fiber.join(closing);
        }).pipe(Effect.provide(TestClock.layer())),
      ),
  );

  it.effect("tracks native background activity through authoritative quiescence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initial = snapshot();
        const { emit, make } = fixture({ rawSnapshot: { ...initial, children: [] } });
        const runtime = yield* make();
        expect(runtime.inputAdmissionBusy).toBe(false);

        yield* Effect.promise(() =>
          emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        yield* Effect.promise(() =>
          emit({ type: "session_event", event: { type: "agent_end", messages: [] } }),
        );
        expect(runtime.inputAdmissionBusy).toBe(true);
        yield* runtime.waitForRlmQuiescence("background:root", activeSignal());
        expect(runtime.inputAdmissionBusy).toBe(false);

        yield* Effect.promise(() =>
          emit({
            type: "session_event",
            event: {
              type: "rlm_child_update",
              child: {
                id: "child-only-background",
                label: "child-only heartbeat",
                status: "running",
                sessionDir: "/daemon/private/child-only",
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          emit({
            type: "session_event",
            event: {
              type: "rlm_child_update",
              child: {
                id: "child-only-background",
                label: "child-only heartbeat",
                status: "done",
                sessionDir: "/daemon/private/child-only",
              },
            },
          }),
        );
        expect(runtime.inputAdmissionBusy).toBe(true);
        yield* runtime.waitForRlmQuiescence("background:child", activeSignal());
        expect(runtime.inputAdmissionBusy).toBe(false);
      }),
    ),
  );

  it.effect("fails closed after descendant work when no quiescence capability exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initial = snapshot();
        const { emit, make } = fixture({
          rawSnapshot: { ...initial, children: [] },
          omitRlmQuiescence: true,
        });
        const runtime = yield* make();
        yield* Effect.promise(() =>
          emit({
            type: "session_event",
            event: {
              type: "rlm_child_update",
              child: {
                id: "unverifiable-child",
                label: "unverifiable child",
                status: "running",
                sessionDir: "/daemon/private/unverifiable-child",
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          emit({
            type: "session_event",
            event: {
              type: "rlm_child_update",
              child: {
                id: "unverifiable-child",
                label: "unverifiable child",
                status: "done",
                sessionDir: "/daemon/private/unverifiable-child",
              },
            },
          }),
        );

        expect(runtime.inputAdmissionBusy).toBe(true);
      }),
    ),
  );

  it.effect("keeps prompt admission busy when the authoritative idle barrier fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initial = snapshot();
        const { emit, make } = fixture({
          rawSnapshot: { ...initial, children: [] },
          waitForHeadlessCompletionImpl: () => Promise.reject(new Error("private barrier failure")),
        });
        const runtime = yield* make();
        yield* Effect.promise(() =>
          emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        yield* Effect.promise(() =>
          emit({ type: "session_event", event: { type: "agent_end", messages: [] } }),
        );

        expect(
          yield* runtime
            .waitForRlmQuiescence("background:failed", activeSignal())
            .pipe(Effect.flip),
        ).toMatchObject({ operation: "rlm-quiescence", reason: "request-failed" });
        expect(runtime.inputAdmissionBusy).toBe(true);
      }),
    ),
  );

  it.effect("tracks live child updates for mutation preflight without stale snapshot reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, emit, make } = fixture();
        const runtime = yield* make();
        captures.order.splice(0);
        yield* Effect.promise(() =>
          emit({
            type: "session_event",
            event: {
              type: "rlm_child_update",
              child: {
                id: "child-2",
                parentId: "child-1",
                activeSessionId: "active-child-2",
                label: "nested child",
                status: "running",
                sessionDir: "/private/child-2",
              },
            },
          }),
        );

        expect(yield* runtime.getAgentRoster).toEqual([
          expect.objectContaining({ id: "child-1", status: "running" }),
          expect.objectContaining({ id: "child-2", status: "running" }),
        ]);
        expect(captures.order).not.toContain("snapshot");
      }),
    ),
  );

  it.effect("returns only the bounded delivery disposition and discards private receipts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const privateMessage = "private message";
        let nativeReceipt: unknown = {
          id: "private-receipt-id",
          source: "agent_message",
          target: { activeSessionId: "private-target-id", sessionId: "private-session-id" },
          from: { activeSessionId: "private-sender-id" },
          message: privateMessage,
          deliveryStatus: "queued",
          queuedAt: "2026-08-09T00:00:00.000Z",
          error: "private-native-error",
        };
        const { captures, make } = fixture({
          sendAgentMessageImpl: () => Promise.resolve(nativeReceipt),
        });
        const runtime = yield* make();
        captures.connectionCalls.splice(0);

        const disposition = yield* runtime.messageAgent(" active-child ", ` ${privateMessage} `);
        expect(disposition).toBe("queued");
        expect(captures.connectionCalls).toEqual([
          { method: "sendAgentMessage", args: ["active-child", privateMessage] },
        ]);

        nativeReceipt = {
          deliveryStatus: "not-delivered",
          message: privateMessage,
          error: "private-native-error",
        };
        const malformed = yield* runtime
          .messageAgent("active-child", privateMessage)
          .pipe(Effect.flip);
        expect(malformed).toMatchObject({
          operation: "message-agent",
          reason: "invalid-response",
          detail: "Prime Agent message delivery could not be confirmed.",
        });
        expect(malformed.detail).not.toContain(privateMessage);
        expect(malformed.detail).not.toContain("private-native-error");
        expect(malformed.message).not.toContain(privateMessage);

        const blank = yield* runtime.messageAgent("active-child", "  ").pipe(Effect.flip);
        const oversized = yield* runtime
          .messageAgent("active-child", "x".repeat(PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS + 1))
          .pipe(Effect.flip);
        expect(blank).toMatchObject({ operation: "message-agent", reason: "invalid-input" });
        expect(oversized).toMatchObject({ operation: "message-agent", reason: "invalid-input" });
        expect(captures.connectionCalls).toHaveLength(2);
      }),
    ),
  );

  it.effect("times out agent messaging once without retaining native errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const { make } = fixture({
          sendAgentMessageImpl: () => {
            calls += 1;
            return new Promise<unknown>(() => undefined);
          },
        });
        const runtime = yield* make();
        const privateMessage = "do not retain this message";
        const deliveryFiber = yield* runtime
          .messageAgent("private-active-child", privateMessage)
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("30 seconds");

        const error = yield* Fiber.join(deliveryFiber).pipe(Effect.flip);
        expect(error).toMatchObject({
          operation: "message-agent",
          reason: "request-timed-out",
          detail: "Prime Agent message delivery could not be confirmed.",
        });
        expect(error.detail).not.toContain(privateMessage);
        expect(error.detail).not.toContain("private-active-child");
        expect(error.message).not.toContain(privateMessage);
        expect(calls).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("reports native agent messaging unavailable before invoking an older client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({ omitSendAgentMessage: true });
        const runtime = yield* make();
        captures.connectionCalls.splice(0);

        expect(runtime.agentMessageAvailable).toBe(false);
        const error = yield* runtime.messageAgent("active-child", "hello").pipe(Effect.flip);
        expect(error).toMatchObject({ operation: "message-agent", reason: "incompatible-api" });
        expect(captures.connectionCalls).toEqual([]);
      }),
    ),
  );

  it.effect("disables native agent messaging in supervised sessions before invocation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const base = snapshot();
        const { captures, make } = fixture({
          rawSnapshot: { ...base, children: [] },
          resourceSnapshot: {
            extensions: [{ path: "/state/pylon/permission.mjs" }],
            diagnostics: { extensions: [] },
          },
          commands: [
            {
              name: "pylon-permission-gate-v1",
              source: "extension",
              sourceInfo: { path: "/state/pylon/permission.mjs" },
            },
          ],
        });
        const runtime = yield* make(undefined, ["/state/pylon/permission.mjs"], {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        });
        captures.connectionCalls.splice(0);

        expect(runtime.agentMessageAvailable).toBe(false);
        const error = yield* runtime.messageAgent("active-child", "hello").pipe(Effect.flip);
        expect(error).toMatchObject({ operation: "message-agent", reason: "invalid-input" });
        expect(captures.connectionCalls).toEqual([]);
      }),
    ),
  );

  it.effect("rejects resource reload before mutating a supervised session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({
          rawSnapshot: { ...snapshot(), children: [] },
          resourceSnapshot: {
            skills: [],
            prompts: [],
            extensions: [{ path: "/state/pylon/permission.mjs" }],
            diagnostics: { extensions: [] },
          },
          commands: [
            {
              name: "pylon-permission-gate-v1",
              source: "extension",
              sourceInfo: { path: "/state/pylon/permission.mjs" },
            },
          ],
        });
        const runtime = yield* make(undefined, ["/state/pylon/permission.mjs"], {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        });
        captures.connectionCalls.splice(0);
        expect(runtime.compactionAvailable).toBe(false);
        expect(runtime.autoCompactionWritable).toBe(false);
        expect(yield* runtime.compact.pipe(Effect.flip)).toMatchObject({
          operation: "compact",
          reason: "incompatible-api",
        });
        expect(yield* runtime.setAutoCompactionEnabled(false).pipe(Effect.flip)).toMatchObject({
          operation: "set-auto-compaction",
          reason: "incompatible-api",
        });
        const error = yield* runtime.reloadResources.pipe(Effect.flip);
        expect(error).toMatchObject({ operation: "reload-resources", reason: "invalid-input" });
        expect(captures.connectionCalls).toEqual([]);
      }),
    ),
  );

  it.effect("passes only explicitly configured extension paths to session creation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({
          rawSnapshot: { ...snapshot(), children: [] },
          resourceSnapshot: {
            skills: [
              {
                name: "review",
                description: "Review changes",
                filePath: "/private/review/SKILL.md",
                sourceInfo: { scope: "project" },
              },
            ],
            prompts: [],
            extensions: [{ path: "/state/pylon/permission.mjs" }],
            diagnostics: { extensions: [] },
          },
          commands: [
            {
              name: "pylon-permission-gate-v1",
              source: "extension",
              sourceInfo: { path: "/state/pylon/permission.mjs" },
            },
            {
              name: "skill:review",
              source: "skill",
              sourceInfo: { path: "/private/review/SKILL.md", scope: "project" },
            },
          ],
        });
        const runtime = yield* make(undefined, [" /state/pylon/permission.mjs ", ""], {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        });
        expect(runtime.initialResources).toEqual({
          available: true,
          skills: [{ name: "review", description: "Review changes", scope: "project" }],
          prompts: [],
          commands: [],
        });
        expect(runtime.initialAgentDepth).toEqual({
          maxDepth: 0,
          source: "policy",
          writable: false,
          settable: false,
          maxSettableDepth: 4,
        });
        expect(captures.commands[0]).toMatchObject({
          config: {
            extensions: ["/state/pylon/permission.mjs"],
            noExtensions: true,
          },
        });
        expect(captures.reconnectOptions).toEqual([]);
        expect(captures.order).not.toContain("request-recovery");
        expect(captures.attachOptions[0]).not.toHaveProperty("recoverDaemon");
        expect(captures.attachOptions[0]).toMatchObject({
          ownedSessionRecoveryConfig: {
            extensions: ["/state/pylon/permission.mjs"],
            noExtensions: true,
          },
        });
        expect(captures.connectionCalls).toEqual([
          { method: "setRlmMaxDepth", args: [0] },
          { method: "getResourceSnapshot", args: [] },
          { method: "getCommands", args: [] },
          { method: "getToolDefinition", args: ["pylon_update_plan"] },
          { method: "getRlmMaxDepthStatus", args: [] },
        ]);
      }),
    ),
  );

  it.effect("keeps discovery in full access while verifying the exact managed plan tool", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expected = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        const { captures, make } = fixture({
          rawSnapshot: { ...snapshot(), children: [] },
          resourceSnapshot: {
            extensions: [{ path: expected.path }, { path: "/state/user/unrelated.mjs" }],
            diagnostics: {
              extensions: [{ type: "error", path: "/state/user/unrelated.mjs" }],
            },
          },
        });
        const runtime = yield* make(
          undefined,
          [expected.path],
          undefined,
          undefined,
          undefined,
          expected,
        );
        expect(captures.commands[0]).toMatchObject({
          config: { extensions: [expected.path], noExtensions: false },
        });
        expect(runtime.initialResources.available).toBe(true);
        expect(captures.connectionCalls).toContainEqual({
          method: "getToolDefinition",
          args: ["pylon_update_plan"],
        });
      }),
    ),
  );

  it.effect("fails closed on a managed plan tool definition mismatch in full access", () =>
    Effect.gen(function* () {
      const expected = {
        path: "/state/pylon/permission.mjs",
        markerCommand: "pylon-permission-gate-v1",
      };
      for (const toolDefinition of [
        {
          ...PRIME_AGENT_PLAN_TOOL_DEFINITION,
          description: "A colliding tool definition",
        },
        {
          ...PRIME_AGENT_PLAN_TOOL_DEFINITION,
          promptSnippet: "unexpected extra definition field",
        },
      ]) {
        const { captures, make } = fixture({
          rawSnapshot: { ...snapshot(), children: [] },
          toolDefinition,
        });
        const error = yield* Effect.scoped(
          make(undefined, [expected.path], undefined, undefined, undefined, expected).pipe(
            Effect.flip,
          ),
        );
        expect(error).toMatchObject({
          operation: "verify-extension",
          reason: "invalid-response",
        });
        expect(captures.disposeCount).toBe(1);
        expect(captures.closeCount).toBe(1);
      }
    }),
  );

  it.effect("preserves reconnect ordering around a managed plan result and verified resync", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expected = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let verificationCalls = 0;
        let reportReconnectVerification!: () => void;
        const reconnectVerificationStarted = new Promise<void>((resolve) => {
          reportReconnectVerification = resolve;
        });
        let releaseReconnectVerification!: (verified: boolean) => void;
        const reconnectVerification = new Promise<boolean>((resolve) => {
          releaseReconnectVerification = resolve;
        });
        const test = fixture({
          rawSnapshot: { ...snapshot(), children: [] },
          verifyManagedSourceImpl: () => {
            verificationCalls += 1;
            if (verificationCalls === 1) return Promise.resolve(true);
            reportReconnectVerification();
            return reconnectVerification;
          },
        });
        const runtime = yield* test.make(
          undefined,
          [expected.path],
          undefined,
          undefined,
          undefined,
          expected,
        );
        const eventsFiber = yield* collectEvents(runtime, 5).pipe(Effect.forkChild);
        const planMessage = {
          role: "toolResult",
          toolCallId: "managed-plan-call",
          toolName: "pylon_update_plan",
          content: [{ type: "text", text: "Plan updated (1 steps)." }],
          details: {
            protocol: "pylon-plan-v1",
            plan: [{ step: "Verify reconnect", status: "inProgress" }],
          },
          isError: false,
          timestamp: 2,
        };

        const reconnecting = test.emit({ type: "connection_status", status: "reconnecting" });
        const plan = test.emit({
          type: "session_event",
          event: { type: "message_end", message: planMessage },
        });
        const resync = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(9),
            state: { ...snapshot(9).state, messageCount: 1 },
            messages: [planMessage],
          },
        });
        yield* Effect.promise(() => reconnectVerificationStarted);
        const afterResync = test.emit({
          type: "session_event",
          event: { type: "message_end", message: terminalAssistantMessage() },
        });
        const steering = yield* runtime.steer({ text: "wait for managed verification" });
        expect(steering).toBe("recovering");
        expect(eventsFiber.pollUnsafe()).toBeUndefined();
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "steer"),
        ).toHaveLength(0);

        releaseReconnectVerification(true);
        yield* Effect.promise(() =>
          Promise.all([reconnecting, plan, resync, afterResync]).then(() => undefined),
        );
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "steer"),
        ).toHaveLength(0);

        const events = yield* Fiber.join(eventsFiber);
        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "ConnectionStatus",
          "MessageCompleted",
          "SessionResynced",
          "MessageCompleted",
        ]);
        expect(events[2]).toMatchObject({
          _tag: "MessageCompleted",
          message: {
            role: "toolResult",
            planUpdate: {
              plan: [{ step: "Verify reconnect", status: "inProgress" }],
            },
          },
        });
      }),
    ),
  );

  it.effect(
    "rejects a reconnect snapshot before publishing it when managed verification fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const expected = {
            path: "/state/pylon/permission.mjs",
            markerCommand: "pylon-permission-gate-v1",
          };
          const resources = {
            extensions: [{ path: expected.path }],
            diagnostics: { extensions: [] },
          };
          const test = fixture({
            rawSnapshot: { ...snapshot(), children: [] },
            resourceSnapshot: resources,
          });
          const runtime = yield* test.make(
            undefined,
            [expected.path],
            undefined,
            undefined,
            undefined,
            expected,
          );
          const eventsFiber = yield* collectEvents(runtime, 3).pipe(Effect.forkChild);

          yield* Effect.promise(() =>
            test.emit({ type: "connection_status", status: "reconnecting" }),
          );
          resources.extensions = [];
          yield* Effect.promise(() =>
            test.emit({ type: "session_resynced", snapshot: snapshot(9) }),
          );

          const events = yield* Fiber.join(eventsFiber);
          expect(events.map((event) => event._tag)).toEqual([
            "SessionResynced",
            "ConnectionStatus",
            "SessionClosed",
          ]);
          expect(events[2]).toMatchObject({
            _tag: "SessionClosed",
            error:
              "Pylon's managed provider extension could not be verified after Prime Agent reconnected.",
          });
          expect(
            test.captures.connectionCalls.filter((call) => call.method === "getToolDefinition"),
          ).toHaveLength(2);
        }),
      ),
  );

  it.effect("emits one fixed terminal when strict managed recovery verification fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expected = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        const resources = {
          extensions: [{ path: expected.path }],
          diagnostics: { extensions: [] },
        };
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
          resourceSnapshot: resources,
        });
        const runtime = yield* test.make(
          undefined,
          [expected.path],
          undefined,
          undefined,
          undefined,
          expected,
        );
        const events = yield* collectEvents(runtime, 3).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        test.setCorrelatedPromptLifecycleProof(false);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        test.setCorrelatedPromptLifecycleProof(true);
        resources.extensions = [];
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(9),
              children: [],
              promptLifecycles: { records: [], expired: [] },
            },
          }),
        );

        expect(yield* Fiber.join(events)).toEqual([
          expect.objectContaining({ _tag: "SessionResynced" }),
          { _tag: "ConnectionStatus", status: "reconnecting" },
          {
            _tag: "SessionClosed",
            error: "Prime Agent correlated prompt capability proof was lost during recovery.",
          },
        ]);
        const extra = yield* runtime.events.pipe(
          Stream.runHead,
          Effect.timeoutOption(1),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(1);
        expect((yield* Fiber.join(extra))._tag).toBe("None");
      }),
    ),
  );

  it.effect("emits one fixed terminal when strict MCP recovery fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let replacements = 0;
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
          replaceMcpImpl: () => {
            replacements += 1;
            return replacements === 1
              ? Promise.resolve(undefined)
              : Promise.reject(new Error("private MCP rejection"));
          },
        });
        const runtime = yield* test.make(undefined, undefined, undefined, undefined, {
          ownerId: "pylon:strict-mcp-failure",
          server: {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4321/mcp/strict-mcp-failure",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        });
        const events = yield* collectEvents(runtime, 3).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        test.setCorrelatedPromptLifecycleProof(false);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        test.setCorrelatedPromptLifecycleProof(true);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(9),
              promptLifecycles: { records: [], expired: [] },
            },
          }),
        );

        expect(yield* Fiber.join(events)).toEqual([
          expect.objectContaining({ _tag: "SessionResynced" }),
          { _tag: "ConnectionStatus", status: "reconnecting" },
          {
            _tag: "SessionClosed",
            error: "Prime Agent correlated prompt capability proof was lost during recovery.",
          },
        ]);
        const extra = yield* runtime.events.pipe(
          Stream.runHead,
          Effect.timeoutOption(1),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(1);
        expect((yield* Fiber.join(extra))._tag).toBe("None");
      }),
    ),
  );

  it.effect("fails closed when the managed extension inventory or RLM depth is not verified", () =>
    Effect.gen(function* () {
      for (const fixtureOptions of [
        { commands: [] },
        {
          commands: [
            {
              name: "pylon-permission-gate-v1",
              source: "prompt",
              sourceInfo: { path: "/state/pylon/permission.mjs" },
            },
          ],
        },
        {
          commands: [
            {
              name: "pylon-permission-gate-v1",
              source: "extension",
              sourceInfo: { path: "/state/pylon/different.mjs" },
            },
          ],
        },
        {
          resourceSnapshot: {
            extensions: [{ path: "/state/pylon/permission.mjs" }],
            diagnostics: {
              extensions: [
                {
                  type: "error",
                  path: "/state/pylon/permission.mjs",
                  message: "load failed",
                },
              ],
            },
          },
        },
        {
          resourceSnapshot: {
            extensions: [{ path: "/state/pylon/permission.mjs" }],
            diagnostics: {
              extensions: [
                {
                  type: "error",
                  path: "/state/user/unrelated.mjs",
                  message: "unexpected discovered extension failure",
                },
              ],
            },
          },
        },
        { rlmDepth: 1 },
      ]) {
        const { captures, make } = fixture({
          ...fixtureOptions,
          rawSnapshot: { ...snapshot(), children: [] },
        });
        const error = yield* Effect.scoped(
          make(undefined, ["/state/pylon/permission.mjs"], {
            path: "/state/pylon/permission.mjs",
            markerCommand: "pylon-permission-gate-v1",
          }).pipe(Effect.flip),
        );
        expect(error).toMatchObject({
          operation: "verify-extension",
          reason: "invalid-response",
        });
        expect(captures.disposeCount).toBe(1);
        expect(captures.closeCount).toBe(1);
      }

      const { captures, make } = fixture({ rawSnapshot: snapshot() });
      const childError = yield* Effect.scoped(
        make(undefined, ["/state/pylon/permission.mjs"], {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        }).pipe(Effect.flip),
      );
      expect(childError).toMatchObject({
        operation: "verify-extension",
        reason: "invalid-response",
      });
      expect(captures.disposeCount).toBe(1);
      expect(captures.closeCount).toBe(1);
    }),
  );

  it.effect("rejects a restored active scheduler action in supervised mode", () =>
    Effect.gen(function* () {
      const base = snapshot();
      const { captures, make } = fixture({
        rawSnapshot: {
          ...base,
          state: {
            ...base.state,
            sessionActions: {
              ...actions,
              active: { kind: "session_command", phase: "preparing", label: "/compact" },
            },
          },
          children: [],
        },
      });
      const error = yield* Effect.scoped(
        make(undefined, ["/state/pylon/permission.mjs"], {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        }).pipe(Effect.flip),
      );
      expect(error).toMatchObject({
        operation: "verify-extension",
        reason: "invalid-response",
      });
      expect(captures.disposeCount).toBe(1);
      expect(captures.closeCount).toBe(1);
      expect(captures.connectionCalls.map((call) => call.method)).not.toContain("clearQueue");
    }),
  );

  it.effect("resumes the exact private session identity when one is available", () =>
    Effect.gen(function* () {
      const { captures, make } = fixture();
      yield* Effect.scoped(
        make(PRIME_AGENT_DAEMON_RESUME_CURSOR, undefined, undefined, "session-1"),
      );
      expect(captures.commands[0]).toMatchObject({
        type: "create",
        lifecycle: "client_owned",
        sessionPath: "session-1",
        continueRecent: false,
      });

      const invalid = fixture();
      const error = yield* Effect.scoped(
        invalid
          .make(PRIME_AGENT_DAEMON_RESUME_CURSOR, undefined, undefined, "../invalid")
          .pipe(Effect.flip),
      );
      expect(error).toMatchObject({ operation: "create-session", reason: "invalid-input" });
      expect(invalid.captures.openCount).toBe(0);

      const mismatch = fixture({
        createResponse: {
          type: "response",
          command: "create",
          success: true,
          data: {
            activeSessionId: "active-secret-1",
            sessionId: "another-session",
            sessionFile: "/state/provider-sessions/thread-safe/another-session.jsonl",
          },
        },
      });
      const mismatchError = yield* Effect.scoped(
        mismatch
          .make(PRIME_AGENT_DAEMON_RESUME_CURSOR, undefined, undefined, "session-1")
          .pipe(Effect.flip),
      );
      expect(mismatchError).toMatchObject({
        operation: "create-session",
        reason: "invalid-response",
      });
      expect(mismatch.captures.commands[1]).toEqual({
        type: "complete_owned_session",
        activeSessionId: "active-secret-1",
      });
      expect(mismatch.captures.attachOptions).toEqual([]);
    }),
  );

  it.effect("waits for a disconnected client-owned session to be released after restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({
          createResponses: [
            ...Array.from({ length: 12 }, () => sessionAlreadyActiveCreateResponse()),
            {
              type: "response",
              command: "create",
              success: true,
              data: {
                activeSessionId: "active-secret-1",
                sessionId: "session-1",
                sessionFile: "/state/provider-sessions/thread-safe/session.jsonl",
              },
            },
          ],
        });
        const runtimeFiber = yield* make(
          PRIME_AGENT_DAEMON_RESUME_CURSOR,
          undefined,
          undefined,
          "session-1",
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        for (const delay of [
          "250 millis",
          "500 millis",
          "1 second",
          "2 seconds",
          "4 seconds",
          "5 seconds",
          "5 seconds",
          "5 seconds",
          "5 seconds",
          "5 seconds",
          "5 seconds",
          "5 seconds",
        ] as const) {
          yield* TestClock.adjust(delay);
          yield* Effect.yieldNow;
        }
        const runtime = yield* Fiber.join(runtimeFiber);

        expect(runtime.sessionId).toBe("session-1");
        const createCommands = captures.commands.filter((command) => command.type === "create");
        expect(createCommands).toHaveLength(13);
        expect(createCommands).toEqual(Array.from({ length: 13 }, () => captures.commands[0]));
        expect(captures.closeCount).toBe(0);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("does not wait or steal ownership for a fresh conflicting session", () =>
    Effect.gen(function* () {
      const { captures, make } = fixture({
        createResponse: sessionAlreadyActiveCreateResponse(),
      });
      const error = yield* Effect.scoped(make().pipe(Effect.flip));

      expect(error).toMatchObject({
        operation: "create-session",
        reason: "session-already-active",
        detail:
          "SessionAlreadyActiveError: Prime Agent session is already active in another client.",
      });
      expect(captures.commands.filter((command) => command.type === "create")).toHaveLength(1);
      expect(captures.closeCount).toBe(1);
    }),
  );

  it.effect("preserves SessionAlreadyActiveError after bounded restart recovery", () =>
    Effect.gen(function* () {
      const { captures, make } = fixture({
        createResponse: sessionAlreadyActiveCreateResponse(),
      });
      const runtimeFiber = yield* Effect.scoped(
        make(PRIME_AGENT_DAEMON_RESUME_CURSOR, undefined, undefined, "session-1"),
      ).pipe(Effect.flip, Effect.forkChild);
      yield* Effect.yieldNow;
      for (const delay of [
        "250 millis",
        "500 millis",
        "1 second",
        "2 seconds",
        "4 seconds",
        "5 seconds",
        "5 seconds",
        "5 seconds",
        "5 seconds",
        "5 seconds",
        "5 seconds",
        "5 seconds",
      ] as const) {
        yield* TestClock.adjust(delay);
        yield* Effect.yieldNow;
      }
      const error = yield* Fiber.join(runtimeFiber);

      expect(error).toMatchObject({
        operation: "create-session",
        reason: "session-already-active",
        detail:
          "SessionAlreadyActiveError: Prime Agent session is already active in another client.",
      });
      expect(error.detail).not.toContain("active-secret-existing");
      expect(error.detail).not.toContain("/state/");
      expect(captures.commands.filter((command) => command.type === "create")).toHaveLength(13);
      expect(captures.closeCount).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("closes the daemon client when restart ownership recovery is interrupted", () =>
    Effect.gen(function* () {
      let reportCreate!: () => void;
      const createObserved = new Promise<void>((resolve) => {
        reportCreate = resolve;
      });
      const { captures, make } = fixture({
        createResponse: sessionAlreadyActiveCreateResponse(),
        createRequestObserved: () => reportCreate(),
      });
      const runtimeFiber = yield* Effect.scoped(
        make(PRIME_AGENT_DAEMON_RESUME_CURSOR, undefined, undefined, "session-1"),
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => createObserved);
      yield* Fiber.interrupt(runtimeFiber);

      expect(captures.commands.filter((command) => command.type === "create")).toHaveLength(1);
      expect(captures.closeCount).toBe(1);
    }),
  );

  it.effect("completes an unattached client-owned worker when attach fails", () =>
    Effect.gen(function* () {
      const { captures, make } = fixture({ attachFailure: true });
      const error = yield* Effect.scoped(make().pipe(Effect.flip));

      expect(error).toMatchObject({
        operation: "attach-session",
        reason: "request-failed",
      });
      expect(captures.commands[1]).toEqual({
        type: "complete_owned_session",
        activeSessionId: "active-secret-1",
      });
      expect(captures.commands.some((command) => command.type === "kill")).toBe(false);
      expect(captures.closeCount).toBe(1);
    }),
  );

  it.effect("cold-resumes either Prime backend cursor in the same isolated directory", () =>
    Effect.gen(function* () {
      for (const resumeCursor of [
        PRIME_AGENT_DAEMON_RESUME_CURSOR,
        PRIME_AGENT_ACP_RESUME_CURSOR,
      ]) {
        const { captures, make } = fixture();
        yield* Effect.scoped(make(resumeCursor));
        expect(captures.commands[0]).toMatchObject({
          type: "create",
          lifecycle: "client_owned",
          continueRecent: true,
          config: { sessionDir: "/state/provider-sessions/thread-safe" },
        });
        expect(captures.commands[0]).not.toHaveProperty("sessionPath");
        expect(captures.commands[0]).not.toHaveProperty("activeSessionId");
      }
    }),
  );

  it.effect(
    "orders buffered events after the snapshot and deduplicates stale resync snapshots",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { make } = fixture({
            duringSnapshot: [
              { type: "session_resynced", snapshot: snapshot(4) },
              { type: "session_event", event: { type: "turn_start" } },
              { type: "session_resynced", snapshot: snapshot(5) },
            ],
          });
          const runtime = yield* make();
          const events = yield* collectEvents(runtime, 3);
          expect(events.map((event) => event._tag)).toEqual([
            "SessionResynced",
            "TurnStarted",
            "SessionResynced",
          ]);
          expect(events[0]).toMatchObject({ lastEventSequence: 4 });
          expect(events[2]).toMatchObject({ lastEventSequence: 5 });
        }),
      ),
  );

  it.effect("does not lose an event delivered across the asynchronous snapshot handoff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({
          duringSnapshot: [{ type: "session_event", event: { type: "turn_start" } }],
          afterSnapshotEvent: {
            type: "session_event",
            event: { type: "agent_end", messages: [] },
          },
        });
        const runtime = yield* make();
        const events = yield* collectEvents(runtime, 3);
        expect(captures.order.indexOf("subscribe")).toBeLessThan(
          captures.order.indexOf("snapshot"),
        );
        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "TurnStarted",
          "RunCompleted",
        ]);
      }),
    ),
  );

  it.effect("backpressures ordinary ingress and preserves terminal event order exactly once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { emit, make } = fixture();
        const runtime = yield* make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");

        for (let index = 0; index < PRIME_AGENT_EVENT_BUFFER_CAPACITY; index += 1) {
          yield* Effect.promise(() =>
            emit({ type: "session_event", event: { type: "turn_start" } }),
          );
        }

        const terminalEvents = [
          {
            type: "session_event",
            event: {
              type: "rlm_child_update",
              child: {
                id: "child-1",
                label: "child",
                status: "done",
                sessionDir: "/daemon/private/child",
              },
            },
          },
          {
            type: "extension_ui_request",
            request: {
              id: "approval-1",
              method: "confirm",
              payload: { title: "Approve command?" },
            },
          },
          {
            type: "session_event",
            event: {
              type: "turn_end",
              message: {
                role: "assistant",
                content: [],
                api: "openai-responses",
                provider: "openai",
                model: "gpt-test",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: 1,
              },
              toolResults: [],
            },
          },
          { type: "session_event", event: { type: "agent_end", messages: [] } },
          { type: "closed" },
        ] as const;
        const terminalOfferFiber = yield* Effect.promise(() =>
          Promise.all(terminalEvents.map((event) => emit(event))).then(() => undefined),
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(terminalOfferFiber.pollUnsafe()).toBeUndefined();

        const events = yield* collectEvents(
          runtime,
          PRIME_AGENT_EVENT_BUFFER_CAPACITY + terminalEvents.length,
        );
        yield* Fiber.join(terminalOfferFiber);

        expect(
          events.slice(0, PRIME_AGENT_EVENT_BUFFER_CAPACITY).map((event) => event._tag),
        ).toEqual(Array(PRIME_AGENT_EVENT_BUFFER_CAPACITY).fill("TurnStarted"));
        const terminalTags = events
          .slice(PRIME_AGENT_EVENT_BUFFER_CAPACITY)
          .map((event) => event._tag);
        expect(terminalTags).toEqual([
          "ChildUpdated",
          "ExtensionRequest",
          "TurnCompleted",
          "RunCompleted",
          "SessionClosed",
        ]);
        for (const tag of terminalTags) {
          expect(events.filter((event) => event._tag === tag)).toHaveLength(1);
        }
      }),
    ),
  );

  it.effect("bounds ordinary backpressure staging and fails only when that bound overflows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture();
        const runtime = yield* test.make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");

        for (let index = 0; index < PRIME_AGENT_EVENT_BUFFER_CAPACITY; index += 1) {
          yield* Effect.promise(() =>
            test.emit({ type: "session_event", event: { type: "turn_start" } }),
          );
        }
        const overflowFiber = yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: PRIME_AGENT_EVENT_BUFFER_CAPACITY + 1 }, () =>
              test.emit({ type: "session_event", event: { type: "turn_start" } }),
            ),
          ).then(() => undefined),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(overflowFiber.pollUnsafe()).toBeUndefined();

        const published = yield* collectEvents(runtime, PRIME_AGENT_EVENT_BUFFER_CAPACITY + 1);
        yield* Fiber.join(overflowFiber);
        expect(published.filter((event) => event._tag === "TurnStarted")).toHaveLength(
          PRIME_AGENT_EVENT_BUFFER_CAPACITY,
        );
        expect(published.at(-1)).toEqual({
          _tag: "SessionClosed",
          error: "Prime Agent event ingress exceeded its bounded capacity.",
        });
        expect(published.filter((event) => event._tag === "SessionClosed")).toHaveLength(1);
        const promptError = yield* runtime.prompt({ text: "must remain failed" }).pipe(Effect.flip);
        expect(promptError).toMatchObject({
          operation: "prompt",
          reason: "request-failed",
          detail: "Prime Agent event ingress exceeded its bounded capacity.",
        });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("fails a private side question when ordinary ingress fails terminally", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeId = "d494f29a-3ef6-4b4d-a18d-983512d9cf8d";
        const test = fixture();
        const runtime = yield* test.make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        const asking = yield* runtime
          .askSideQuestion(nativeId, "must fail with ingress")
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(test.captures.sideQuestionStarts).toHaveLength(1);

        for (let index = 0; index < PRIME_AGENT_EVENT_BUFFER_CAPACITY; index += 1) {
          yield* Effect.promise(() =>
            test.emit({ type: "session_event", event: { type: "turn_start" } }),
          );
        }
        const overflow = yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: PRIME_AGENT_EVENT_BUFFER_CAPACITY + 1 }, () =>
              test.emit({ type: "session_event", event: { type: "turn_start" } }),
            ),
          ).then(() => undefined),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;

        const published = yield* collectEvents(runtime, PRIME_AGENT_EVENT_BUFFER_CAPACITY + 1);
        yield* Fiber.join(overflow);
        expect(published.at(-1)).toEqual({
          _tag: "SessionClosed",
          error: "Prime Agent event ingress exceeded its bounded capacity.",
        });
        const answer = yield* Fiber.join(asking);
        expect(answer).toMatchObject({
          _tag: "Failure",
          failure: { operation: "side-question", reason: "request-failed" },
        });
        expect(test.captures.sideQuestionAborts).toEqual([nativeId]);

        yield* Effect.promise(() =>
          test.emit({
            type: "side_question_event",
            event: {
              id: nativeId,
              question: "private late prompt",
              answer: "must stay private",
              status: "complete",
            },
          }),
        );
      }),
    ),
  );

  it.effect("fences ordinary input as soon as a staged reconnect callback is admitted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture();
        const runtime = yield* test.make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");

        for (let index = 0; index < PRIME_AGENT_EVENT_BUFFER_CAPACITY; index += 1) {
          yield* Effect.promise(() => test.emit({ type: "heartbeats_changed" }));
        }
        const blockedHeartbeat = yield* Effect.promise(() =>
          test.emit({ type: "heartbeats_changed" }),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(blockedHeartbeat.pollUnsafe()).toBeUndefined();

        const reconnecting = yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(reconnecting.pollUnsafe()).toBeUndefined();
        expect(runtime.inputAdmissionBusy).toBe(true);

        const prompt = yield* runtime
          .prompt({ text: "must wait for reconnect proof" })
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(prompt.pollUnsafe()).toBeUndefined();
        expect(yield* runtime.steer({ text: "must remain fenced" })).toBe("recovering");
        expect(
          test.captures.connectionCalls.filter(
            (call) => call.method === "prompt" || call.method === "steer",
          ),
        ).toHaveLength(0);

        yield* collectEvents(runtime, PRIME_AGENT_EVENT_BUFFER_CAPACITY + 2);
        yield* Fiber.join(blockedHeartbeat);
        yield* Fiber.join(reconnecting);
        yield* Fiber.interrupt(prompt);
      }),
    ),
  );

  it.effect("rejects stale ordinary snapshots across staged reconnect generations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture();
        const runtime = yield* test.make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");

        for (let index = 0; index < PRIME_AGENT_EVENT_BUFFER_CAPACITY; index += 1) {
          yield* Effect.promise(() => test.emit({ type: "heartbeats_changed" }));
        }
        const blockedHeartbeat = yield* Effect.promise(() =>
          test.emit({ type: "heartbeats_changed" }),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(blockedHeartbeat.pollUnsafe()).toBeUndefined();

        const staged = yield* Effect.sync(() => [
          test.emit({ type: "session_resynced", snapshot: snapshot(10) }),
          test.emit({ type: "connection_status", status: "reconnecting" }),
          test.emit({ type: "session_resynced", snapshot: snapshot(11) }),
          test.emit({ type: "connection_status", status: "reconnecting" }),
        ]);
        const stagedFiber = yield* Effect.promise(() =>
          Promise.all(staged).then(() => undefined),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        expect(runtime.inputAdmissionBusy).toBe(true);
        const prompt = yield* runtime
          .prompt({ text: "wait for generation two" })
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(prompt.pollUnsafe()).toBeUndefined();

        const beforeCurrentSnapshot = yield* collectEvents(
          runtime,
          PRIME_AGENT_EVENT_BUFFER_CAPACITY + 2,
        );
        yield* Fiber.join(blockedHeartbeat);
        yield* Fiber.join(stagedFiber);
        expect(
          beforeCurrentSnapshot.filter((event) => event._tag === "SessionResynced"),
        ).toHaveLength(0);
        expect(
          beforeCurrentSnapshot.filter((event) => event._tag === "ConnectionStatus"),
        ).toHaveLength(1);
        expect(runtime.inputAdmissionBusy).toBe(true);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(0);

        yield* Effect.promise(() =>
          test.emit({ type: "session_resynced", snapshot: snapshot(12) }),
        );
        const currentSnapshot = (yield* collectEvents(runtime, 1))[0];
        expect(currentSnapshot).toMatchObject({
          _tag: "SessionResynced",
          connectionGeneration: 2,
        });
        expect(runtime.resolveReconnectSnapshot(2, true)).toBe(true);
        yield* Fiber.join(prompt);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("discards an ordinary managed snapshot retired during verification", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const managed = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let verificationCalls = 0;
        let reportStaleVerification!: () => void;
        const staleVerificationStarted = new Promise<void>((resolve) => {
          reportStaleVerification = resolve;
        });
        let releaseStaleVerification!: () => void;
        const staleVerification = new Promise<boolean>((resolve) => {
          releaseStaleVerification = () => resolve(true);
        });
        const test = fixture({
          rawSnapshot: { ...snapshot(), children: [] },
          verifyManagedSourceImpl: () => {
            verificationCalls += 1;
            if (verificationCalls !== 2) return Promise.resolve(true);
            reportStaleVerification();
            return staleVerification;
          },
        });
        const runtime = yield* test.make(
          undefined,
          [managed.path],
          undefined,
          undefined,
          undefined,
          managed,
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");

        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("ConnectionStatus");
        const staleSnapshot = test.emit({
          type: "session_resynced",
          snapshot: { ...snapshot(11), children: [] },
        });
        yield* Effect.promise(() => staleVerificationStarted);
        const retiredClose = test.emit({ type: "closed", error: "retired close" });
        const retiredTerminal = test.emit({
          type: "session_event",
          event: { type: "message_end", message: terminalAssistantMessage() },
        });
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("ConnectionStatus");
        expect(runtime.inputAdmissionBusy).toBe(true);
        const prompt = yield* runtime
          .prompt({ text: "wait for managed generation two" })
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(prompt.pollUnsafe()).toBeUndefined();

        releaseStaleVerification();
        yield* Effect.promise(() =>
          Promise.all([staleSnapshot, retiredClose, retiredTerminal]).then(() => undefined),
        );
        yield* Effect.yieldNow;
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: { ...snapshot(12), children: [] },
          }),
        );
        const currentSnapshot = (yield* collectEvents(runtime, 1))[0];
        expect(currentSnapshot).toMatchObject({
          _tag: "SessionResynced",
          connectionGeneration: 2,
          lastEventSequence: 12,
        });
        expect(runtime.resolveReconnectSnapshot(2, true)).toBe(true);
        expect((yield* Fiber.join(prompt))._tag).toBe("Success");
        expect(verificationCalls).toBe(3);
      }),
    ),
  );

  it.effect("discards an ordinary MCP snapshot retired during replacement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let replacementCalls = 0;
        let reportStaleReplacement!: () => void;
        const staleReplacementStarted = new Promise<void>((resolve) => {
          reportStaleReplacement = resolve;
        });
        let releaseStaleReplacement!: () => void;
        const staleReplacement = new Promise<unknown>((resolve) => {
          releaseStaleReplacement = () => resolve(undefined);
        });
        const test = fixture({
          rawSnapshot: { ...snapshot(), children: [] },
          replaceMcpImpl: () => {
            replacementCalls += 1;
            if (replacementCalls !== 2) return Promise.resolve(undefined);
            reportStaleReplacement();
            return staleReplacement;
          },
        });
        const runtime = yield* test.make(undefined, undefined, undefined, undefined, {
          ownerId: "pylon:ordinary-generation",
          server: {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4321/mcp/ordinary-generation",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        });
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");

        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("ConnectionStatus");
        const staleSnapshot = test.emit({
          type: "session_resynced",
          snapshot: { ...snapshot(21), children: [] },
        });
        yield* Effect.promise(() => staleReplacementStarted);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("ConnectionStatus");
        expect(runtime.inputAdmissionBusy).toBe(true);
        const prompt = yield* runtime
          .prompt({ text: "wait for MCP generation two" })
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(prompt.pollUnsafe()).toBeUndefined();

        releaseStaleReplacement();
        yield* Effect.promise(() => staleSnapshot);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: { ...snapshot(22), children: [] },
          }),
        );
        const currentSnapshot = (yield* collectEvents(runtime, 1))[0];
        expect(currentSnapshot).toMatchObject({
          _tag: "SessionResynced",
          connectionGeneration: 2,
          lastEventSequence: 22,
        });
        expect(runtime.resolveReconnectSnapshot(2, true)).toBe(true);
        expect((yield* Fiber.join(prompt))._tag).toBe("Success");
        expect(replacementCalls).toBe(3);
      }),
    ),
  );

  it.effect("drops staged provider recovery before work after ordinary ingress fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expected = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let verificationCalls = 0;
        const test = fixture({
          rawSnapshot: { ...snapshot(), children: [] },
          verifyManagedSourceImpl: () => {
            verificationCalls += 1;
            return verificationCalls === 1
              ? Promise.resolve(true)
              : new Promise<boolean>(() => undefined);
          },
        });
        const runtime = yield* test.make(
          undefined,
          [expected.path],
          undefined,
          undefined,
          undefined,
          expected,
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("ConnectionStatus");

        for (let index = 0; index < PRIME_AGENT_EVENT_BUFFER_CAPACITY; index += 1) {
          yield* Effect.promise(() =>
            test.emit({ type: "session_event", event: { type: "turn_start" } }),
          );
        }
        const promptFiber = yield* runtime
          .prompt({ text: "must fail with ingress" })
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(promptFiber.pollUnsafe()).toBeUndefined();
        const overflowFiber = yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: PRIME_AGENT_EVENT_BUFFER_CAPACITY + 1 }, (_, index) =>
              test.emit({ type: "session_resynced", snapshot: snapshot(index + 1) }),
            ),
          ).then(() => undefined),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(overflowFiber.pollUnsafe()).toBeUndefined();

        const published = yield* collectEvents(runtime, PRIME_AGENT_EVENT_BUFFER_CAPACITY + 1);
        yield* Fiber.join(overflowFiber);
        expect(published.filter((event) => event._tag === "TurnStarted")).toHaveLength(
          PRIME_AGENT_EVENT_BUFFER_CAPACITY,
        );
        expect(published.at(-1)).toEqual({
          _tag: "SessionClosed",
          error: "Prime Agent event ingress exceeded its bounded capacity.",
        });
        expect(verificationCalls).toBe(1);
        const prompt = yield* Fiber.join(promptFiber);
        expect(prompt).toMatchObject({
          _tag: "Failure",
          failure: { reason: "request-failed" },
        });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("retires an in-flight managed route when ordinary ingress overflows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const managed = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let verificationCalls = 0;
        let reportHungVerification!: () => void;
        const hungVerificationStarted = new Promise<void>((resolve) => {
          reportHungVerification = resolve;
        });
        const test = fixture({
          rawSnapshot: { ...snapshot(), children: [] },
          verifyManagedSourceImpl: () => {
            verificationCalls += 1;
            if (verificationCalls === 1) return Promise.resolve(true);
            reportHungVerification();
            return new Promise<boolean>(() => undefined);
          },
        });
        const runtime = yield* test.make(
          undefined,
          [managed.path],
          undefined,
          undefined,
          undefined,
          managed,
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("ConnectionStatus");
        const prompt = yield* runtime
          .prompt({ text: "must retire with the provider route" })
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(prompt.pollUnsafe()).toBeUndefined();

        const hungSnapshot = test.emit({
          type: "session_resynced",
          snapshot: { ...snapshot(31), children: [] },
        });
        yield* Effect.promise(() => hungVerificationStarted);
        const staged = Array.from({ length: PRIME_AGENT_EVENT_BUFFER_CAPACITY - 1 }, () =>
          test.emit({ type: "heartbeats_changed" }),
        );
        const overflow = test.emit({ type: "heartbeats_changed" });
        const callbacks = yield* Effect.promise(() =>
          Promise.all([hungSnapshot, ...staged, overflow]).then(() => undefined),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        expect((yield* collectEvents(runtime, 1))[0]).toEqual({
          _tag: "SessionClosed",
          error: "Prime Agent event ingress exceeded its bounded capacity.",
        });
        yield* Fiber.join(callbacks);
        expect(yield* Fiber.join(prompt)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "request-failed" },
        });
        expect(verificationCalls).toBe(2);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("retires in-flight provider recovery and waiting input during disposal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const managed = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let verificationCalls = 0;
        let reportHungVerification!: () => void;
        const hungVerificationStarted = new Promise<void>((resolve) => {
          reportHungVerification = resolve;
        });
        const test = fixture({
          rawSnapshot: { ...snapshot(), children: [] },
          verifyManagedSourceImpl: () => {
            verificationCalls += 1;
            if (verificationCalls === 1) return Promise.resolve(true);
            reportHungVerification();
            return new Promise<boolean>(() => undefined);
          },
        });
        const runtime = yield* test.make(
          undefined,
          [managed.path],
          undefined,
          undefined,
          undefined,
          managed,
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("ConnectionStatus");
        const prompt = yield* runtime
          .prompt({ text: "must retire during disposal" })
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        const hungSnapshot = test.emit({
          type: "session_resynced",
          snapshot: { ...snapshot(41), children: [] },
        });
        yield* Effect.promise(() => hungVerificationStarted);

        yield* runtime.dispose;
        yield* Effect.promise(() => hungSnapshot);
        expect(yield* Fiber.join(prompt)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "request-failed" },
        });
        expect(verificationCalls).toBe(2);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("cumulatively bounds and preserves events across initialization phases", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const event = { type: "session_event", event: { type: "turn_start" } };
        const noisy = fixture({
          duringSnapshot: Array.from({ length: 200 }, () => event),
          duringResourceSnapshot: Array.from(
            { length: PRIME_AGENT_EVENT_BUFFER_CAPACITY - 1 - 200 },
            () => event,
          ),
        });

        const runtime = yield* noisy.make();
        const events = yield* collectEvents(runtime, PRIME_AGENT_EVENT_BUFFER_CAPACITY);
        expect(events[0]?._tag).toBe("SessionResynced");
        expect(events.slice(1).map((item) => item._tag)).toEqual(
          Array(PRIME_AGENT_EVENT_BUFFER_CAPACITY - 1).fill("TurnStarted"),
        );
      }),
    ),
  );

  it.effect("bounds cumulative initialization event weight before decoding", () =>
    Effect.gen(function* () {
      const noisy = fixture({
        duringSnapshot: Array.from({ length: 4 }, (_, index) => ({
          type: "session_event",
          event: { type: "turn_start" },
          privatePadding: `${index}${"x".repeat(17 * 1024 * 1024)}`,
        })),
      });

      const error = yield* Effect.scoped(noisy.make().pipe(Effect.flip));
      expect(error).toMatchObject({
        operation: "initial-snapshot",
        reason: "request-failed",
        detail: "The daemon emitted too many events while initializing the session.",
      });
      expect(noisy.captures.unsubscribeCount).toBe(1);
      expect(noisy.captures.disposeCount).toBe(1);
      expect(noisy.captures.closeCount).toBe(1);
    }),
  );

  it.effect("fails startup when raw initialization fits but decoded queue weight does not", () =>
    Effect.gen(function* () {
      const messages = Array.from({ length: 100 }, (_, index) => ({
        role: "user" as const,
        content: `${index.toString().padStart(3, "0")}${"x".repeat(83_769)}`,
        timestamp: index + 1,
      }));
      const weightedSnapshot = (sequence: number) => ({
        ...snapshot(sequence),
        state: { ...snapshot(sequence).state, messageCount: messages.length },
        messages,
        children: [],
      });
      const noisy = fixture({
        rawSnapshot: weightedSnapshot(4),
        duringSnapshot: [5, 6, 7].map((sequence) => ({
          type: "session_resynced",
          snapshot: weightedSnapshot(sequence),
        })),
      });

      const error = yield* Effect.scoped(noisy.make().pipe(Effect.flip));
      expect(error).toMatchObject({
        operation: "initial-snapshot",
        reason: "request-failed",
        detail: "The daemon emitted too many events while initializing the session.",
      });
      expect(noisy.captures.unsubscribeCount).toBe(1);
      expect(noisy.captures.disposeCount).toBe(1);
      expect(noisy.captures.closeCount).toBe(1);
    }),
  );

  it.effect("fails strict startup when decoded proof events exceed pre-consumer weight", () =>
    Effect.gen(function* () {
      const messages = Array.from({ length: 100 }, (_, index) => ({
        role: "user" as const,
        content: `${index.toString().padStart(3, "0")}${"x".repeat(83_768)}`,
        timestamp: index + 1,
      }));
      const weightedSnapshot = (sequence: number) => ({
        ...snapshot(sequence),
        state: { ...snapshot(sequence).state, messageCount: messages.length },
        messages,
        children: [],
        promptLifecycles: { records: [], expired: [] },
      });
      const noisy = fixture({
        correlatedPromptLifecycleCapability: true,
        rawSnapshot: weightedSnapshot(4),
        duringSnapshot: [
          ...[5, 6, 7].map((sequence) => ({
            type: "session_resynced",
            snapshot: weightedSnapshot(sequence),
          })),
          ...Array.from({ length: 200 }, () => ({
            type: "connection_status",
            status: "connected",
          })),
        ],
      });

      const error = yield* Effect.scoped(noisy.make().pipe(Effect.flip));
      expect(error).toMatchObject({
        operation: "initial-snapshot",
        reason: "request-failed",
        detail: "The daemon emitted too many events while initializing the session.",
      });
      expect(noisy.captures.unsubscribeCount).toBe(1);
      expect(noisy.captures.disposeCount).toBe(1);
      expect(noisy.captures.closeCount).toBe(1);
    }),
  );

  it.effect("fails closed and cleans up when pre-snapshot event buffering overflows", () =>
    Effect.gen(function* () {
      const event = { type: "session_event", event: { type: "turn_start" } };
      const noisy = fixture({
        duringSnapshot: Array.from({ length: 200 }, () => event),
        duringResourceSnapshot: Array.from(
          { length: PRIME_AGENT_EVENT_BUFFER_CAPACITY - 200 },
          () => event,
        ),
      });

      const error = yield* Effect.scoped(noisy.make().pipe(Effect.flip));
      expect(error).toMatchObject({
        operation: "initial-snapshot",
        reason: "request-failed",
        detail: "The daemon emitted too many events while initializing the session.",
      });
      expect(noisy.captures.unsubscribeCount).toBe(1);
      expect(noisy.captures.disposeCount).toBe(1);
      expect(noisy.captures.closeCount).toBe(1);
    }),
  );

  it.effect("orders the authoritative RLM quiescence marker after native run events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let emitNative: ((event: unknown) => Promise<unknown>) | undefined;
        const test = fixture({
          waitForHeadlessCompletionImpl: async (waitOptions) => {
            expect(waitOptions).toEqual({ waitForRlmQuiescence: true });
            await emitNative?.({
              type: "session_event",
              event: { type: "agent_end", messages: [] },
            });
            return { privateAutonomousStatus: "discarded" };
          },
        });
        emitNative = test.emit;
        const runtime = yield* test.make();
        const collecting = yield* collectEvents(runtime, 3).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        const token = "turn-1:1";
        yield* runtime.prompt({ text: "wait for descendants", rlmQuiescenceToken: token });
        yield* runtime.waitForRlmQuiescence(token, activeSignal());
        const events = yield* Fiber.join(collecting);

        expect(runtime.rlmQuiescenceAvailable).toBe(true);
        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "RunCompleted",
          "RlmQuiesced",
        ]);
        expect(events.every((event) => !("privateAutonomousStatus" in event))).toBe(true);
        expect(events.at(-1)).toMatchObject({
          _tag: "RlmQuiesced",
          token,
          connectionGeneration: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            totalCostUsd: 0,
          },
        });
      }),
    ),
  );

  it.effect("serializes rearmed quiescence barriers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let activeBarriers = 0;
        let maxActiveBarriers = 0;
        let barrierStarts = 0;
        const releases: Array<() => void> = [];
        let resolveFirstStart: (() => void) | undefined;
        let resolveSecondStart: (() => void) | undefined;
        const firstStarted = new Promise<void>((resolve) => {
          resolveFirstStart = resolve;
        });
        const secondStarted = new Promise<void>((resolve) => {
          resolveSecondStart = resolve;
        });
        const test = fixture({
          waitForHeadlessCompletionImpl: () =>
            new Promise((resolve) => {
              activeBarriers += 1;
              maxActiveBarriers = Math.max(maxActiveBarriers, activeBarriers);
              barrierStarts += 1;
              (barrierStarts === 1 ? resolveFirstStart : resolveSecondStart)?.();
              releases.push(() => {
                activeBarriers -= 1;
                resolve({ result: "completed" });
              });
            }),
        });
        const runtime = yield* test.make();
        yield* runtime.prompt({ text: "start descendants", rlmQuiescenceToken: "turn-1:1" });
        const first = yield* runtime
          .waitForRlmQuiescence("turn-1:1", activeSignal())
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstStarted);
        const second = yield* runtime
          .waitForRlmQuiescence("turn-1:2", activeSignal())
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;

        expect(barrierStarts).toBe(1);
        expect(maxActiveBarriers).toBe(1);
        releases.shift()?.();
        yield* Fiber.join(first);
        yield* Effect.promise(() => secondStarted);
        expect(barrierStarts).toBe(2);
        expect(maxActiveBarriers).toBe(1);
        releases.shift()?.();
        yield* Fiber.join(second);
      }),
    ),
  );

  it.effect("rejects a quiescence barrier that overlaps daemon reconnect recovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let releaseBarrier: (() => void) | undefined;
        let reportBarrierStarted: (() => void) | undefined;
        const barrierStarted = new Promise<void>((resolve) => {
          reportBarrierStarted = resolve;
        });
        const barrierRelease = new Promise<void>((resolve) => {
          releaseBarrier = resolve;
        });
        let releaseMcpRecovery: (() => void) | undefined;
        let reportMcpRecoveryStarted: (() => void) | undefined;
        const mcpRecoveryStarted = new Promise<void>((resolve) => {
          reportMcpRecoveryStarted = resolve;
        });
        const mcpRecoveryRelease = new Promise<void>((resolve) => {
          releaseMcpRecovery = resolve;
        });
        let replaceMcpCalls = 0;
        const test = fixture({
          waitForHeadlessCompletionImpl: () => {
            reportBarrierStarted?.();
            return barrierRelease;
          },
          replaceMcpImpl: () => {
            replaceMcpCalls += 1;
            if (replaceMcpCalls === 1) return Promise.resolve(undefined);
            reportMcpRecoveryStarted?.();
            return mcpRecoveryRelease;
          },
        });
        const runtime = yield* test.make(undefined, undefined, undefined, undefined, {
          ownerId: "pylon:provider-session-reconnect",
          server: {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4321/mcp/provider-session-reconnect",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        });
        const token = "turn-reconnect:1";
        yield* runtime.prompt({ text: "wait through reconnect", rlmQuiescenceToken: token });
        const waiting = yield* runtime
          .waitForRlmQuiescence(token, activeSignal())
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => barrierStarted);

        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        const resyncDelivery = test.emit({
          type: "session_resynced",
          snapshot: snapshot(99),
        });
        yield* Effect.promise(() => mcpRecoveryStarted);
        expect(runtime.isRlmQuiescenceGenerationCurrent(0)).toBe(false);
        releaseBarrier?.();
        releaseMcpRecovery?.();
        yield* Effect.promise(() => resyncDelivery);
        expect(runtime.resolveReconnectSnapshot(1, false)).toBe(true);

        const error = yield* Fiber.join(waiting);
        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
          detail: "Prime Agent reconnected before descendant quiescence could be confirmed.",
        });
      }),
    ),
  );

  it.effect("accepts a same-cursor reconnect generation with complete replay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture();
        const runtime = yield* test.make();
        const collecting = yield* collectEvents(runtime, 4).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const token = "turn-reconnect-complete:1";
        yield* runtime.prompt({ text: "recover after reconnect", rlmQuiescenceToken: token });

        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(1),
              replay: {
                status: "complete",
                fromSequence: 1,
                toSequence: 1,
                fromCursor: { generation: "daemon-1", sequence: 1 },
                toCursor: { generation: "daemon-1", sequence: 1 },
              },
            },
          }),
        );
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(true);
        yield* runtime.waitForRlmQuiescence(token, activeSignal());
        const events = yield* Fiber.join(collecting);

        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "ConnectionStatus",
          "SessionResynced",
          "RlmQuiesced",
        ]);
        expect(events[2]).toMatchObject({
          _tag: "SessionResynced",
          replayContinuity: "complete",
          connectionGeneration: 1,
          lastEventSequence: 1,
        });
        expect(events[3]).toMatchObject({
          _tag: "RlmQuiesced",
          token,
          connectionGeneration: 1,
        });
        expect(runtime.isRlmQuiescenceGenerationCurrent(1)).toBe(true);
      }),
    ),
  );

  it.effect("adopts an admitted prompt when its recovered request never returns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let reportPromptStarted: (() => void) | undefined;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        const test = fixture({
          promptAndWaitImpl: () => {
            reportPromptStarted?.();
            return new Promise(() => {});
          },
        });
        const runtime = yield* test.make();
        for (let index = 0; index < 101; index += 1) {
          yield* Effect.promise(() =>
            test.emit({
              type: "session_event",
              event: {
                type: "message_end",
                message: {
                  role: "user",
                  content: `historical-${index}`,
                  timestamp: index,
                },
              },
            }),
          );
        }
        const prompting = yield* runtime
          .prompt({ text: "recover this admitted prompt" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(5),
              state: { ...snapshot(5).state, messageCount: 102 },
              messages: [
                ...Array.from({ length: 99 }, (_, index) => ({
                  role: "user" as const,
                  content: `historical-${index + 2}`,
                  timestamp: index + 2,
                })),
                {
                  role: "user",
                  content: "recover this admitted prompt",
                  timestamp: 101,
                },
              ],
              replay: {
                status: "unavailable",
                fromSequence: 5,
                toSequence: 5,
                fromCursor: { generation: "daemon-1", sequence: 5 },
                toCursor: { generation: "daemon-1", sequence: 5 },
                reason: "test fallback",
              },
            },
          }),
        );
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(true);
        yield* Fiber.join(prompting);

        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(runtime.isConnectionGenerationCurrent(1)).toBe(true);
      }),
    ),
  );

  it.effect("awaits reconnect proof when a recovered prompt request rejects first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rejectPrompt!: (error: Error) => void;
        let reportPromptStarted: (() => void) | undefined;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        const test = fixture({
          promptAndWaitImpl: () =>
            new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
              reportPromptStarted?.();
            }),
        });
        const runtime = yield* test.make();
        const prompting = yield* runtime
          .prompt({ text: "recover this rejected request" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        rejectPrompt(new Error("recovered command result was rejected"));
        yield* Effect.yieldNow;
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(5),
              state: { ...snapshot(5).state, messageCount: 1 },
              messages: [
                {
                  role: "user",
                  content: "recover this rejected request",
                  timestamp: 1,
                },
              ],
              replay: {
                status: "complete",
                toSequence: 5,
                toCursor: { generation: "daemon-1", sequence: 5 },
              },
            },
          }),
        );
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(true);
        yield* Fiber.join(prompting);

        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(runtime.isConnectionGenerationCurrent(1)).toBe(true);
      }),
    ),
  );

  it.effect("adopts a pending recovered prompt from post-resync admission evidence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let reportPromptStarted: (() => void) | undefined;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        const test = fixture({
          promptAndWaitImpl: () => {
            reportPromptStarted?.();
            return new Promise(() => {});
          },
        });
        const runtime = yield* test.make();
        const prompting = yield* runtime
          .prompt({ text: "late recovered admission" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(5),
              state: { ...snapshot(5).state, messageCount: 0 },
              messages: [],
              replay: {
                status: "complete",
                toSequence: 5,
                toCursor: { generation: "daemon-1", sequence: 5 },
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: {
              type: "message_end",
              message: { role: "user", content: "late recovered admission", timestamp: 1 },
            },
          }),
        );
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(true);
        yield* Fiber.join(prompting);

        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("adopts a rejected recovered prompt from post-resync admission evidence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rejectPrompt!: (error: Error) => void;
        let reportPromptStarted: (() => void) | undefined;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        const test = fixture({
          promptAndWaitImpl: () =>
            new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
              reportPromptStarted?.();
            }),
        });
        const runtime = yield* test.make();
        const prompting = yield* runtime
          .prompt({ text: "late rejected admission" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        rejectPrompt(new Error("recovered request rejected"));
        yield* Effect.yieldNow;
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(5),
              state: { ...snapshot(5).state, messageCount: 0 },
              messages: [],
              replay: {
                status: "complete",
                toSequence: 5,
                toCursor: { generation: "daemon-1", sequence: 5 },
              },
            },
          }),
        );
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(true);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: {
              type: "message_end",
              message: { role: "user", content: "late rejected admission", timestamp: 1 },
            },
          }),
        );
        yield* Fiber.join(prompting);

        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("rejects a reconnect snapshot mismatch despite a later matching user message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rejectPrompt!: (error: Error) => void;
        let reportPromptStarted: (() => void) | undefined;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        const test = fixture({
          promptAndWaitImpl: () =>
            new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
              reportPromptStarted?.();
            }),
        });
        const runtime = yield* test.make();
        const prompting = yield* runtime
          .prompt({ text: "original reconnect input" })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        rejectPrompt(new Error("recovered request rejected"));
        yield* Effect.yieldNow;
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(5),
              state: { ...snapshot(5).state, messageCount: 1 },
              messages: [{ role: "user", content: "another input", timestamp: 1 }],
              replay: {
                status: "complete",
                toSequence: 5,
                toCursor: { generation: "daemon-1", sequence: 5 },
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: {
              type: "message_end",
              message: { role: "user", content: "original reconnect input", timestamp: 2 },
            },
          }),
        );
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(true);
        const error = yield* Fiber.join(prompting);

        expect(error).toMatchObject({ operation: "prompt", reason: "request-failed" });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter(
            (call) => call.method === "waitForHeadlessCompletion",
          ),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("rejects reconnect adoption when cancellation follows snapshot proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rejectPrompt!: (error: Error) => void;
        let reportPromptStarted: (() => void) | undefined;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        const test = fixture({
          promptAndWaitImpl: () =>
            new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
              reportPromptStarted?.();
            }),
        });
        const runtime = yield* test.make();
        const controller = new AbortController();
        const prompting = yield* runtime
          .prompt({ text: "cancel recovered input", signal: controller.signal })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        rejectPrompt(new Error("recovered request rejected"));
        yield* Effect.yieldNow;
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(5),
              state: { ...snapshot(5).state, messageCount: 1 },
              messages: [{ role: "user", content: "cancel recovered input", timestamp: 1 }],
              replay: {
                status: "complete",
                toSequence: 5,
                toCursor: { generation: "daemon-1", sequence: 5 },
              },
            },
          }),
        );
        controller.abort();
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(true);
        const error = yield* Fiber.join(prompting);

        expect(error).toMatchObject({ operation: "prompt", reason: "request-failed" });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter(
            (call) => call.method === "waitForHeadlessCompletion",
          ),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("does not deduplicate a successor-generation close against a retired route", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let listRequests = 0;
        let reportFirstList!: () => void;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        let releaseFirstList!: () => void;
        const heldFirstList = new Promise<unknown>((resolve) => {
          releaseFirstList = () => resolve(workerListResponse("recovering"));
        });
        const test = fixture({
          rawSnapshot: { ...snapshot(), children: [] },
          listResponses: [heldFirstList],
          listRequestObserved: () => {
            listRequests += 1;
            reportFirstList();
          },
        });
        const runtime = yield* test.make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        yield* runtime.prompt({ text: "keep the native run active" });
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("RunStarted");

        const firstClose = test.emit({
          type: "closed",
          error: "Daemon worker client closed in generation zero",
        });
        yield* Effect.promise(() => firstList);
        const reconnectEvents = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        const activeSnapshot = snapshot(12);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...activeSnapshot,
              state: {
                ...activeSnapshot.state,
                activeSessionId: "active-secret-1",
                isStreaming: true,
              },
            },
          }),
        );
        expect((yield* Fiber.join(reconnectEvents)).map((event) => event._tag)).toEqual([
          "ConnectionStatus",
          "SessionResynced",
        ]);
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(true);
        yield* Effect.promise(() => test.emit({ type: "connection_status", status: "connected" }));
        expect((yield* collectEvents(runtime, 1))[0]).toMatchObject({
          _tag: "ConnectionStatus",
          status: "connected",
        });
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: { type: "message_end", message: terminalAssistantMessage() },
          }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("MessageCompleted");

        const successorClose = test.emit({
          type: "closed",
          error: "Daemon worker client closed in generation one",
        });
        expect(successorClose).not.toBe(firstClose);
        yield* Effect.yieldNow;
        expect(listRequests).toBe(1);

        releaseFirstList();
        yield* Effect.promise(() => Promise.all([firstClose, successorClose]));
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(false);
      }),
    ),
  );

  it.effect("retires a post-close frame already waiting behind a provider tail", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let snapshotReads = 0;
        let reportRecoverySnapshot!: () => void;
        const recoverySnapshotRead = new Promise<void>((resolve) => {
          reportRecoverySnapshot = resolve;
        });
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return { ...snapshot(), children: [] };
            reportRecoverySnapshot();
            const activeSnapshot = snapshot(40);
            return {
              ...activeSnapshot,
              state: {
                ...activeSnapshot.state,
                activeSessionId: "active-secret-1",
                isStreaming: true,
              },
              children: [],
            };
          },
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
        });
        const runtime = yield* test.make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        yield* runtime.prompt({ text: "keep the provider tail active" });
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("RunStarted");

        for (let index = 0; index < PRIME_AGENT_EVENT_BUFFER_CAPACITY; index += 1) {
          yield* Effect.promise(() =>
            test.emit({ type: "session_event", event: { type: "turn_start" } }),
          );
        }
        const closing = test.emit({
          type: "closed",
          error: "Daemon worker client closed before provider retirement",
        });
        yield* TestClock.adjust(250);
        yield* Effect.promise(() => recoverySnapshotRead);

        const staleTerminal = test.emit({
          type: "session_event",
          event: {
            type: "message_end",
            message: terminalAssistantMessage("stale provider-tail response", 5),
          },
        });
        yield* Effect.yieldNow;
        const reconnecting = test.emit({ type: "connection_status", status: "reconnecting" });
        yield* Effect.promise(() => staleTerminal);
        const drained = yield* collectEvents(runtime, PRIME_AGENT_EVENT_BUFFER_CAPACITY + 1);
        yield* Effect.promise(() => reconnecting);
        expect(drained.map((event) => event._tag)).toEqual([
          ...Array(PRIME_AGENT_EVENT_BUFFER_CAPACITY).fill("TurnStarted"),
          "ConnectionStatus",
        ]);

        const currentSnapshot = snapshot(41);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...currentSnapshot,
              state: {
                ...currentSnapshot.state,
                activeSessionId: "active-secret-1",
                isStreaming: true,
              },
            },
          }),
        );
        expect((yield* collectEvents(runtime, 1))[0]).toMatchObject({
          _tag: "SessionResynced",
          connectionGeneration: 1,
          lastEventSequence: 41,
        });
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(true);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: {
              type: "message_end",
              message: terminalAssistantMessage("current provider-tail response", 6),
            },
          }),
        );
        expect((yield* collectEvents(runtime, 1))[0]).toMatchObject({
          _tag: "MessageCompleted",
          message: { text: "current provider-tail response" },
        });
        yield* Effect.promise(() => closing);
      }),
    ),
  );

  it.effect("retires a post-close frame across its provider tail and decoded capacity wait", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let snapshotReads = 0;
        let reportRecoverySnapshot!: () => void;
        const recoverySnapshotRead = new Promise<void>((resolve) => {
          reportRecoverySnapshot = resolve;
        });
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return { ...snapshot(), children: [] };
            reportRecoverySnapshot();
            const activeSnapshot = snapshot(30);
            return {
              ...activeSnapshot,
              state: {
                ...activeSnapshot.state,
                activeSessionId: "active-secret-1",
                isStreaming: true,
              },
              children: [],
            };
          },
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
        });
        const runtime = yield* test.make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        yield* runtime.prompt({ text: "keep the native run active" });
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("RunStarted");

        for (let index = 0; index < PRIME_AGENT_EVENT_BUFFER_CAPACITY; index += 1) {
          yield* Effect.promise(() =>
            test.emit({ type: "session_event", event: { type: "turn_start" } }),
          );
        }

        const closing = test.emit({
          type: "closed",
          error: "Daemon worker client closed before reconnect",
        });
        yield* TestClock.adjust(250);
        yield* Effect.promise(() => recoverySnapshotRead);
        const recoveryEvents = yield* collectEvents(runtime, PRIME_AGENT_EVENT_BUFFER_CAPACITY + 1);
        expect(recoveryEvents.filter((event) => event._tag === "TurnStarted")).toHaveLength(
          PRIME_AGENT_EVENT_BUFFER_CAPACITY,
        );
        expect(recoveryEvents.at(-1)?._tag).toBe("SessionResynced");

        for (let index = 0; index < PRIME_AGENT_EVENT_BUFFER_CAPACITY; index += 1) {
          yield* Effect.promise(() =>
            test.emit({ type: "session_event", event: { type: "turn_start" } }),
          );
        }

        const staleTerminal = test.emit({
          type: "session_event",
          event: {
            type: "message_end",
            message: terminalAssistantMessage("stale pre-reconnect response", 3),
          },
        });
        yield* Effect.yieldNow;

        const reconnecting = test.emit({ type: "connection_status", status: "reconnecting" });
        yield* Effect.promise(() => staleTerminal);
        const drained = yield* collectEvents(runtime, PRIME_AGENT_EVENT_BUFFER_CAPACITY + 1);
        yield* Effect.promise(() => reconnecting);
        const drainedTags = drained.map((event) => event._tag);
        expect(drainedTags).toEqual([
          ...Array(PRIME_AGENT_EVENT_BUFFER_CAPACITY).fill("TurnStarted"),
          "ConnectionStatus",
        ]);

        const currentSnapshot = snapshot(31);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...currentSnapshot,
              state: {
                ...currentSnapshot.state,
                activeSessionId: "active-secret-1",
                isStreaming: true,
              },
            },
          }),
        );
        expect((yield* collectEvents(runtime, 1))[0]).toMatchObject({
          _tag: "SessionResynced",
          connectionGeneration: 1,
          lastEventSequence: 31,
        });
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(true);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: {
              type: "message_end",
              message: terminalAssistantMessage("current post-reconnect response", 4),
            },
          }),
        );
        expect((yield* collectEvents(runtime, 1))[0]).toMatchObject({
          _tag: "MessageCompleted",
          message: { text: "current post-reconnect response" },
        });

        yield* Effect.promise(() => closing);
      }),
    ),
  );

  it.effect("keeps an admitted run through worker recovery after its client closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rejectPrompt!: (error: Error) => void;
        let reportPromptStarted: (() => void) | undefined;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        let waitAttempts = 0;
        let reportFirstWait: (() => void) | undefined;
        const firstWait = new Promise<void>((resolve) => {
          reportFirstWait = resolve;
        });
        let reportFirstList: (() => void) | undefined;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        let reportRecoverySnapshot: (() => void) | undefined;
        const recoverySnapshotRead = new Promise<void>((resolve) => {
          reportRecoverySnapshot = resolve;
        });
        let snapshotReads = 0;
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return snapshot(5);
            reportRecoverySnapshot?.();
            return {
              ...snapshot(5),
              state: {
                ...snapshot(5).state,
                activeSessionId: "active-secret-1",
                messageCount: 2,
              },
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "keep the admitted native run" },
                    { type: "image", data: "encoded-image", mimeType: "image/jpeg" },
                  ],
                  timestamp: 1,
                },
                terminalAssistantMessage(),
              ],
            };
          },
          promptAndWaitImpl: () =>
            new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
              reportPromptStarted?.();
            }),
          waitForHeadlessCompletionImpl: () => {
            waitAttempts += 1;
            reportFirstWait?.();
            return waitAttempts === 1
              ? Promise.reject(new Error("Session worker is recovering"))
              : Promise.resolve({ result: "completed" });
          },
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
          listRequestObserved: () => reportFirstList?.(),
        });
        const expected = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        const runtime = yield* test.make(
          undefined,
          [expected.path],
          undefined,
          undefined,
          undefined,
          expected,
        );
        const collecting = yield* collectEvents(runtime, 5).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const token = "turn-worker-client-close:1";
        const prompting = yield* runtime
          .prompt({
            text: "keep the admitted native run",
            images: [{ type: "image", data: "encoded-image", mimeType: "image/jpeg" }],
            rlmQuiescenceToken: token,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: {
              type: "message_end",
              message: {
                role: "user",
                content: [
                  { type: "text", text: "keep the admitted native run" },
                  { type: "image", data: "encoded-image", mimeType: "image/jpeg" },
                ],
                timestamp: 1,
              },
            },
          }),
        );

        rejectPrompt(new Error("Daemon worker client closed"));
        yield* Fiber.join(prompting);
        const waiting = yield* runtime
          .waitForRlmQuiescence(token, activeSignal())
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstWait);
        yield* Effect.promise(() => firstList);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(5),
              state: {
                ...snapshot(5).state,
                sessionId: "different-session",
                activeSessionId: "different-active-session",
              },
            },
          }),
        );
        expect(runtime.resolveReconnectSnapshot(0, true, true)).toBe(false);
        runtime.noteWorkerRecoveryTerminalResponse();
        yield* TestClock.adjust(250);
        yield* Effect.promise(() => recoverySnapshotRead);
        let snapshotResolved = false;
        for (let attempt = 0; attempt < 10 && !snapshotResolved; attempt += 1) {
          yield* Effect.yieldNow;
          snapshotResolved = runtime.resolveReconnectSnapshot(0, true, true);
        }
        expect(snapshotResolved).toBe(true);
        yield* Fiber.join(waiting);
        const events = yield* Fiber.join(collecting);

        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "MessageCompleted",
          "ConnectionStatus",
          "SessionResynced",
          "RlmQuiesced",
        ]);
        expect(test.captures.order.filter((entry) => entry === "snapshot")).toHaveLength(2);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "getToolDefinition"),
        ).toHaveLength(2);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter(
            (call) => call.method === "waitForHeadlessCompletion",
          ),
        ).toHaveLength(2);
      }),
    ),
  );

  it.effect("recovers a raw worker close and retries one rejected explicit snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let snapshotReads = 0;
        const acceptedTerminalMessage = terminalAssistantMessage("accepted worker response", 2);
        let reportPromptStarted!: () => void;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        let reportFirstRecoverySnapshot!: () => void;
        const firstRecoverySnapshot = new Promise<void>((resolve) => {
          reportFirstRecoverySnapshot = resolve;
        });
        let reportSecondRecoverySnapshot!: () => void;
        const secondRecoverySnapshot = new Promise<void>((resolve) => {
          reportSecondRecoverySnapshot = resolve;
        });
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return snapshot(5);
            if (snapshotReads === 2) reportFirstRecoverySnapshot();
            if (snapshotReads === 3) reportSecondRecoverySnapshot();
            const sequence = snapshotReads === 2 ? 10 : 6;
            const accepted = snapshotReads === 3;
            return {
              ...snapshot(sequence),
              state: {
                ...snapshot(sequence).state,
                activeSessionId: "active-secret-1",
                isStreaming: !accepted,
                messageCount: accepted ? 1 : 0,
              },
              messages: accepted ? [acceptedTerminalMessage] : [],
            };
          },
          promptAndWaitImpl: () =>
            new Promise<void>(() => {
              reportPromptStarted();
            }),
          listResponses: [
            workerListResponse("recovering"),
            workerListResponse("ready"),
            workerListResponse("ready"),
          ],
        });
        const mcpServer = {
          ownerId: "pylon:provider-session-worker-recovery",
          server: {
            name: "t3-code",
            type: "http" as const,
            url: "http://127.0.0.1:4321/mcp/provider-session-worker-recovery",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        };
        const runtime = yield* test.make(undefined, undefined, undefined, undefined, mcpServer);
        const collecting = yield* collectEvents(runtime, 4).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        const closing = yield* Effect.promise(() =>
          test.emit({ type: "closed", error: "Daemon worker client closed" }),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust(250);
        yield* Effect.promise(() => firstRecoverySnapshot);
        let retryRequested = false;
        for (let attempt = 0; attempt < 10 && !retryRequested; attempt += 1) {
          yield* Effect.yieldNow;
          retryRequested = runtime.retryWorkerRecoverySnapshot(0);
        }
        expect(retryRequested).toBe(true);

        yield* TestClock.adjust(100);
        yield* Effect.promise(() => secondRecoverySnapshot);
        const events = yield* Fiber.join(collecting);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: { type: "message_end", message: acceptedTerminalMessage },
          }),
        );
        let snapshotResolved = false;
        for (let attempt = 0; attempt < 10 && !snapshotResolved; attempt += 1) {
          yield* Effect.yieldNow;
          snapshotResolved = runtime.resolveReconnectSnapshot(0, true, true);
        }
        expect(snapshotResolved).toBe(true);
        yield* Fiber.join(closing);

        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "RunStarted",
          "SessionResynced",
          "SessionResynced",
        ]);
        expect(events.some((event) => event._tag === "SessionClosed")).toBe(false);
        expect(test.captures.order.filter((entry) => entry === "snapshot")).toHaveLength(3);
        expect(test.captures.commands.filter((command) => command.type === "list")).toHaveLength(3);

        yield* runtime.waitForRlmQuiescence("turn-worker-overlap:1", activeSignal());
        const prompting = yield* runtime
          .prompt({ text: "prompt after overlapping callback" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(7),
              state: { ...snapshot(7).state, messageCount: 2 },
              messages: [
                acceptedTerminalMessage,
                { role: "user", content: "prompt after overlapping callback", timestamp: 3 },
              ],
              replay: {
                status: "complete",
                toSequence: 7,
                toCursor: { generation: "daemon-1", sequence: 7 },
              },
            },
          }),
        );
        let reconnectResolved = false;
        for (let attempt = 0; attempt < 10 && !reconnectResolved; attempt += 1) {
          yield* Effect.yieldNow;
          reconnectResolved = runtime.resolveReconnectSnapshot(1, true);
        }
        expect(reconnectResolved).toBe(true);
        yield* Fiber.join(prompting);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "replaceAcpMcpServers"),
        ).toHaveLength(3);
      }),
    ),
  );

  it.effect("reclaims scoped MCP ownership after same-worker quiescence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expected = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        const resources = {
          extensions: [{ path: expected.path }],
          diagnostics: { extensions: [] },
        };
        let attempts = 0;
        let snapshotReads = 0;
        let mcpReplacements = 0;
        let authoritativeIdle = false;
        let reportFirstList: (() => void) | undefined;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return { ...snapshot(5), children: [] };
            return {
              ...snapshot(6),
              state: {
                ...snapshot(6).state,
                activeSessionId: "active-secret-1",
                isStreaming: true,
                messageCount: 1,
              },
              messages: [terminalAssistantMessage()],
            };
          },
          waitForHeadlessCompletionImpl: () => {
            attempts += 1;
            if (attempts === 1) {
              return Promise.reject(new Error("Session worker is recovering"));
            }
            authoritativeIdle = true;
            return Promise.resolve({ result: "completed" });
          },
          resourceSnapshot: resources,
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
          listRequestObserved: () => reportFirstList?.(),
          replaceMcpImpl: () => {
            mcpReplacements += 1;
            return mcpReplacements === 1 || authoritativeIdle
              ? Promise.resolve(undefined)
              : Promise.reject(
                  new Error("Cannot replace ACP MCP servers while the agent is running"),
                );
          },
        });
        const mcpServer = {
          ownerId: "pylon:provider-session-worker-recovery",
          server: {
            name: "t3-code",
            type: "http" as const,
            url: "http://127.0.0.1:4321/mcp/provider-session-worker-recovery",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        };
        const runtime = yield* test.make(
          undefined,
          [expected.path],
          expected,
          undefined,
          mcpServer,
        );
        const recoveryEvents = yield* collectEvents(runtime, 4).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const token = "turn-worker-mcp:1";
        yield* runtime.prompt({
          text: "preserve recovered browser tools",
          rlmQuiescenceToken: token,
        });
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        const waiting = yield* runtime
          .waitForRlmQuiescence(token, activeSignal())
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstList);
        const concurrentInput = yield* runtime.followUp({ text: "do not admit before recovery" });
        expect(concurrentInput).toBe("recovering");
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "followUp"),
        ).toHaveLength(0);

        yield* TestClock.adjust(250);
        const events = yield* Fiber.join(recoveryEvents);
        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "RunStarted",
          "ConnectionStatus",
          "SessionResynced",
        ]);
        expect(runtime.resolveReconnectSnapshot(0, true, true)).toBe(true);
        yield* Fiber.join(waiting);
        const [quiesced] = yield* collectEvents(runtime, 1);

        expect(attempts).toBe(2);
        expect(authoritativeIdle).toBe(true);
        expect(mcpReplacements).toBe(2);
        expect(quiesced).toMatchObject({
          _tag: "RlmQuiesced",
          token,
          connectionGeneration: 0,
        });

        const sameGenerationToken = "turn-worker-mcp:same-generation";
        const sameGenerationEvents = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* runtime.prompt({
          text: "continue without reconnect",
          rlmQuiescenceToken: sameGenerationToken,
        });
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        yield* runtime.waitForRlmQuiescence(sameGenerationToken, activeSignal());
        expect((yield* Fiber.join(sameGenerationEvents)).map((event) => event._tag)).toEqual([
          "RunStarted",
          "RlmQuiesced",
        ]);
        expect(attempts).toBe(3);
        expect(mcpReplacements).toBe(2);

        const reconnectEvents = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: { ...snapshot(7), children: [] },
          }),
        );
        expect((yield* Fiber.join(reconnectEvents)).map((event) => event._tag)).toEqual([
          "ConnectionStatus",
          "SessionResynced",
        ]);
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(true);

        const secondToken = "turn-worker-mcp:2";
        const secondEvents = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* runtime.prompt({
          text: "continue after reconnect",
          rlmQuiescenceToken: secondToken,
        });
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        yield* runtime.waitForRlmQuiescence(secondToken, activeSignal());
        expect((yield* Fiber.join(secondEvents)).map((event) => event._tag)).toEqual([
          "RunStarted",
          "RlmQuiesced",
        ]);
        expect(attempts).toBe(4);
        expect(mcpReplacements).toBe(3);
      }),
    ),
  );

  it.effect("does not let retired MCP reclamation poison a newer generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expected = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        const resources = {
          extensions: [{ path: expected.path }],
          diagnostics: { extensions: [] },
        };
        let attempts = 0;
        let snapshotReads = 0;
        let replacements = 0;
        let reportFirstList: (() => void) | undefined;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        let reportHeldReplacement!: () => void;
        const heldReplacementStarted = new Promise<void>((resolve) => {
          reportHeldReplacement = resolve;
        });
        let completeHeldReplacement!: () => void;
        const heldReplacement = new Promise<unknown>((resolve) => {
          completeHeldReplacement = () => resolve(undefined);
        });
        const test = fixture({
          resourceSnapshot: resources,
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return { ...snapshot(5), children: [] };
            return {
              ...snapshot(6),
              state: {
                ...snapshot(6).state,
                activeSessionId: "active-secret-1",
                isStreaming: true,
                messageCount: 1,
              },
              messages: [terminalAssistantMessage()],
            };
          },
          waitForHeadlessCompletionImpl: () => {
            attempts += 1;
            return attempts === 1
              ? Promise.reject(new Error("Session worker is recovering"))
              : Promise.resolve({ result: "completed" });
          },
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
          listRequestObserved: () => reportFirstList?.(),
          replaceMcpImpl: () => {
            replacements += 1;
            if (replacements === 1 || replacements === 3) return Promise.resolve(undefined);
            reportHeldReplacement();
            return heldReplacement;
          },
        });
        const runtime = yield* test.make(undefined, [expected.path], expected, undefined, {
          ownerId: "pylon:provider-session-worker-new-generation",
          server: {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4321/mcp/provider-session-worker-new-generation",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        });
        const recoveryEvents = yield* collectEvents(runtime, 4).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const token = "turn-worker-mcp-new-generation:1";
        yield* runtime.prompt({ text: "retire stale scoped recovery", rlmQuiescenceToken: token });
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        const waiting = yield* runtime
          .waitForRlmQuiescence(token, activeSignal())
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstList);

        yield* TestClock.adjust(250);
        yield* Fiber.join(recoveryEvents);
        expect(runtime.resolveReconnectSnapshot(0, true, true)).toBe(true);
        yield* Effect.promise(() => heldReplacementStarted);

        const currentEvents = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        completeHeldReplacement();
        yield* Effect.yieldNow;
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: { ...snapshot(7), children: [] },
          }),
        );
        expect((yield* Fiber.join(currentEvents)).map((event) => event._tag)).toEqual([
          "ConnectionStatus",
          "SessionResynced",
        ]);
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(true);
        expect(replacements).toBe(3);
        expect((yield* Fiber.join(waiting))._tag).toBe("Failure");
        const quiesced = yield* collectEvents(runtime, 1).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* runtime.waitForRlmQuiescence(token, activeSignal());
        expect((yield* Fiber.join(quiesced))[0]?._tag).toBe("RlmQuiesced");
        expect(runtime.inputAdmissionBusy).toBe(false);
      }),
    ),
  );

  it.effect("does not let a stale barrier reclaim successor MCP ownership", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let waitCalls = 0;
        let snapshotReads = 0;
        let replacements = 0;
        let listCalls = 0;
        let reportFirstList!: () => void;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        let reportSuccessorList!: () => void;
        const successorList = new Promise<void>((resolve) => {
          reportSuccessorList = resolve;
        });
        let reportOldBarrier!: () => void;
        const oldBarrierStarted = new Promise<void>((resolve) => {
          reportOldBarrier = resolve;
        });
        let completeOldBarrier!: () => void;
        const oldBarrier = new Promise<{ result: "completed" }>((resolve) => {
          completeOldBarrier = () => resolve({ result: "completed" });
        });
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return { ...snapshot(5), children: [] };
            return {
              ...snapshot(5 + snapshotReads),
              state: {
                ...snapshot(5 + snapshotReads).state,
                activeSessionId: "active-secret-1",
                isStreaming: true,
                messageCount: 1,
              },
              messages: [terminalAssistantMessage()],
            };
          },
          waitForHeadlessCompletionImpl: () => {
            waitCalls += 1;
            if (waitCalls === 1) {
              return Promise.reject(new Error("Session worker is recovering"));
            }
            if (waitCalls === 2) {
              reportOldBarrier();
              return oldBarrier;
            }
            return Promise.resolve({ result: "completed" });
          },
          listResponses: [
            workerListResponse("recovering"),
            workerListResponse("ready"),
            workerListResponse("recovering"),
            workerListResponse("ready"),
          ],
          listRequestObserved: () => {
            listCalls += 1;
            if (listCalls === 1) reportFirstList();
            if (listCalls === 3) reportSuccessorList();
          },
          replaceMcpImpl: () => {
            replacements += 1;
            return Promise.resolve(undefined);
          },
        });
        const runtime = yield* test.make(undefined, undefined, undefined, undefined, {
          ownerId: "pylon:provider-session-stale-barrier",
          server: {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4321/mcp/provider-session-stale-barrier",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        });
        const firstEvents = yield* collectEvents(runtime, 3).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const token = "turn-worker-stale-barrier:1";
        yield* runtime.prompt({ text: "hold stale barrier", rlmQuiescenceToken: token });
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        const oldWait = yield* runtime
          .waitForRlmQuiescence(token, activeSignal())
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstList);
        yield* TestClock.adjust(250);
        let firstResolved = false;
        for (let attempt = 0; attempt < 10 && !firstResolved; attempt += 1) {
          yield* Effect.yieldNow;
          firstResolved = runtime.resolveReconnectSnapshot(0, true, true);
        }
        expect(firstResolved).toBe(true);
        yield* Fiber.join(firstEvents);
        yield* Effect.promise(() => oldBarrierStarted);

        const successorEvents = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        const successorClose = yield* Effect.promise(() =>
          test.emit({ type: "closed", error: "Daemon worker client closed" }),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => successorList);
        yield* TestClock.adjust(250);
        expect((yield* Fiber.join(successorEvents)).map((event) => event._tag)).toEqual([
          "ConnectionStatus",
          "SessionResynced",
        ]);
        expect(runtime.resolveReconnectSnapshot(1, true, true)).toBe(true);
        yield* Fiber.join(successorClose);

        completeOldBarrier();
        expect((yield* Fiber.join(oldWait))._tag).toBe("Failure");
        expect(replacements).toBe(1);
        expect(runtime.inputAdmissionBusy).toBe(true);

        const quiesced = yield* collectEvents(runtime, 1).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* runtime.waitForRlmQuiescence(token, activeSignal());
        expect((yield* Fiber.join(quiesced))[0]?._tag).toBe("RlmQuiesced");
        expect(replacements).toBe(2);
      }),
    ),
  );

  it.effect("retires scoped MCP reclamation when disposal starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        let snapshotReads = 0;
        let replacements = 0;
        const cleanupOrder: Array<string> = [];
        let reportFirstList: (() => void) | undefined;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        let reportHeldReplacement!: () => void;
        const heldReplacementStarted = new Promise<void>((resolve) => {
          reportHeldReplacement = resolve;
        });
        let completeHeldReplacement!: () => void;
        const heldReplacement = new Promise<unknown>((resolve) => {
          completeHeldReplacement = () => resolve(undefined);
        });
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return snapshot(5);
            return {
              ...snapshot(6),
              state: {
                ...snapshot(6).state,
                activeSessionId: "active-secret-1",
                isStreaming: true,
                messageCount: 1,
              },
              messages: [terminalAssistantMessage()],
            };
          },
          waitForHeadlessCompletionImpl: () => {
            attempts += 1;
            return attempts === 1
              ? Promise.reject(new Error("Session worker is recovering"))
              : Promise.resolve({ result: "completed" });
          },
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
          listRequestObserved: () => reportFirstList?.(),
          replaceMcpImpl: () => {
            replacements += 1;
            if (replacements === 1) return Promise.resolve(undefined);
            reportHeldReplacement();
            return heldReplacement.then((value) => {
              cleanupOrder.push("replacement-settled");
              return value;
            });
          },
          releaseMcpImpl: () => {
            cleanupOrder.push("release");
            return Promise.resolve(undefined);
          },
          disposeImpl: () => {
            cleanupOrder.push("dispose");
            return Promise.resolve(undefined);
          },
        });
        const runtime = yield* test.make(undefined, undefined, undefined, undefined, {
          ownerId: "pylon:provider-session-worker-disposal",
          server: {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4321/mcp/provider-session-worker-disposal",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        });
        const recoveryEvents = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const token = "turn-worker-mcp-disposal:1";
        yield* runtime.prompt({
          text: "dispose during scoped tool recovery",
          rlmQuiescenceToken: token,
        });
        const waiting = yield* runtime
          .waitForRlmQuiescence(token, activeSignal())
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstList);

        yield* TestClock.adjust(250);
        yield* Fiber.join(recoveryEvents);
        expect(runtime.resolveReconnectSnapshot(0, true, true)).toBe(true);
        yield* Effect.promise(() => heldReplacementStarted);
        const disposing = yield* runtime.dispose.pipe(
          Effect.result,
          Effect.forkChild({ startImmediately: true }),
        );
        completeHeldReplacement();
        expect((yield* Fiber.join(disposing))._tag).toBe("Success");
        const result = yield* Fiber.join(waiting);

        expect(replacements).toBe(2);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "releaseAcpMcpServers"),
        ).toHaveLength(1);
        expect(cleanupOrder).toEqual(["replacement-settled", "release", "dispose"]);
        expect(result._tag).toBe("Failure");
      }),
    ),
  );

  it.effect("fails closed when scoped MCP ownership cannot be reclaimed after quiescence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        let snapshotReads = 0;
        let replacements = 0;
        let reportFirstList: (() => void) | undefined;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return snapshot(5);
            return {
              ...snapshot(6),
              state: {
                ...snapshot(6).state,
                activeSessionId: "active-secret-1",
                isStreaming: true,
                messageCount: 1,
              },
              messages: [terminalAssistantMessage()],
            };
          },
          waitForHeadlessCompletionImpl: () => {
            attempts += 1;
            return attempts === 1
              ? Promise.reject(new Error("Session worker is recovering"))
              : Promise.resolve({ result: "completed" });
          },
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
          listRequestObserved: () => reportFirstList?.(),
          replaceMcpImpl: () => {
            replacements += 1;
            return replacements === 1
              ? Promise.resolve(undefined)
              : Promise.reject(new Error("replacement ownership rejected"));
          },
        });
        const runtime = yield* test.make(undefined, undefined, undefined, undefined, {
          ownerId: "pylon:provider-session-worker-reclaim-failure",
          server: {
            name: "t3-code",
            type: "http",
            url: "http://127.0.0.1:4321/mcp/provider-session-worker-reclaim-failure",
            headers: { Authorization: "Bearer scoped-secret" },
          },
        });
        const recoveryEvents = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const token = "turn-worker-mcp-rejected:1";
        yield* runtime.prompt({ text: "fail without scoped tools", rlmQuiescenceToken: token });
        const waiting = yield* runtime
          .waitForRlmQuiescence(token, activeSignal())
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstList);

        yield* TestClock.adjust(250);
        yield* Fiber.join(recoveryEvents);
        expect(runtime.resolveReconnectSnapshot(0, true, true)).toBe(true);
        const error = yield* Fiber.join(waiting);

        expect(attempts).toBe(2);
        expect(replacements).toBe(2);
        expect(error).toMatchObject({
          operation: "configure-mcp",
          reason: "request-failed",
          detail: "Pylon browser tools could not be reclaimed after worker recovery.",
        });
      }),
    ),
  );

  it.effect("emits one terminal close when raw worker managed recovery fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expected = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        const resources = {
          extensions: [{ path: expected.path }],
          diagnostics: { extensions: [] },
        };
        let snapshotReads = 0;
        let reportFirstList!: () => void;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            return snapshotReads === 1
              ? { ...snapshot(5), children: [] }
              : { ...snapshot(6), children: [] };
          },
          resourceSnapshot: resources,
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
          listRequestObserved: () => reportFirstList(),
        });
        const runtime = yield* test.make(undefined, [expected.path], expected);
        const collecting = yield* collectEvents(runtime, 4).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        const closing = yield* Effect.promise(() =>
          test.emit({ type: "closed", error: "Daemon worker client closed" }),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Effect.promise(() => firstList);
        resources.extensions = [];
        yield* TestClock.adjust(250);
        yield* Fiber.join(closing);
        const events = yield* Fiber.join(collecting);

        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "RunStarted",
          "ConnectionStatus",
          "SessionClosed",
        ]);
        expect(events.filter((event) => event._tag === "SessionClosed")).toHaveLength(1);
        expect(events[3]).toMatchObject({
          _tag: "SessionClosed",
          error:
            "Pylon's managed provider extension could not be verified after Prime Agent reconnected.",
        });
      }),
    ),
  );

  it.effect("commits prompt admission only from the accepted worker snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let reportPromptStarted!: () => void;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        let snapshotReads = 0;
        let reportFirstRecoverySnapshot!: () => void;
        const firstRecoverySnapshot = new Promise<void>((resolve) => {
          reportFirstRecoverySnapshot = resolve;
        });
        let reportSecondRecoverySnapshot!: () => void;
        const secondRecoverySnapshot = new Promise<void>((resolve) => {
          reportSecondRecoverySnapshot = resolve;
        });
        const recoveredPromptSnapshot = (sequence: number, text: string) => ({
          ...snapshot(sequence),
          state: {
            ...snapshot(sequence).state,
            activeSessionId: "active-secret-1",
            isStreaming: true,
            messageCount: 1,
          },
          messages: [{ role: "user", content: text, timestamp: 1 }],
        });
        const test = fixture({
          promptAndWaitImpl: () =>
            new Promise<void>(() => {
              reportPromptStarted();
            }),
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return snapshot(5);
            if (snapshotReads === 2) {
              reportFirstRecoverySnapshot();
              return recoveredPromptSnapshot(10, "different rejected prompt");
            }
            reportSecondRecoverySnapshot();
            return recoveredPromptSnapshot(6, "accepted recovered prompt");
          },
          listResponses: [
            workerListResponse("recovering"),
            workerListResponse("ready"),
            workerListResponse("ready"),
          ],
        });
        const runtime = yield* test.make();
        const prompting = yield* runtime
          .prompt({ text: "accepted recovered prompt" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        const closing = yield* Effect.promise(() =>
          test.emit({ type: "closed", error: "Daemon worker client closed" }),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust(250);
        yield* Effect.promise(() => firstRecoverySnapshot);
        let retryRequested = false;
        for (let attempt = 0; attempt < 10 && !retryRequested; attempt += 1) {
          yield* Effect.yieldNow;
          retryRequested = runtime.retryWorkerRecoverySnapshot(0);
        }
        expect(retryRequested).toBe(true);

        yield* TestClock.adjust(100);
        yield* Effect.promise(() => secondRecoverySnapshot);
        let snapshotResolved = false;
        for (let attempt = 0; attempt < 10 && !snapshotResolved; attempt += 1) {
          yield* Effect.yieldNow;
          snapshotResolved = runtime.resolveReconnectSnapshot(0, true);
        }
        expect(snapshotResolved).toBe(true);
        yield* Fiber.join(closing);
        yield* Fiber.join(prompting);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("fences strict barrier-originated worker recovery with the current proof epoch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let waitAttempts = 0;
        let snapshotReads = 0;
        let loseProof = () => {};
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads > 1) loseProof();
            return {
              ...snapshot(snapshotReads + 4),
              promptLifecycles: { records: [], expired: [] },
            };
          },
          waitForHeadlessCompletionImpl: () => {
            waitAttempts += 1;
            return waitAttempts === 1
              ? Promise.reject(new Error("Session worker is recovering"))
              : Promise.resolve({ result: "completed" });
          },
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
        });
        loseProof = () => test.setCorrelatedPromptLifecycleProof(false);
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const waiting = yield* runtime
          .waitForRlmQuiescence("strict-worker-recovery", activeSignal())
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust(250);

        const error = yield* Effect.flip(Fiber.join(waiting));
        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
        });
        expect(yield* Fiber.join(events)).toEqual([
          expect.objectContaining({ _tag: "SessionResynced" }),
          {
            _tag: "SessionClosed",
            error: "Prime Agent correlated prompt capability proof was lost during recovery.",
          },
        ]);
        expect(snapshotReads).toBe(2);
        expect(waitAttempts).toBe(1);
      }),
    ),
  );

  it.effect("rejects a worker recovery snapshot that loses its correlated proof fence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const correlationId = "62a90050-e183-48a8-a9a4-d597beac6b5f";
        let snapshotReads = 0;
        let loseProof = () => {};
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads > 1) loseProof();
            return {
              ...snapshot(snapshotReads + 4),
              state: { ...snapshot(snapshotReads + 4).state, isStreaming: true },
              promptLifecycles: {
                records: [promptLifecycle(correlationId, "owned", 1)],
                expired: [],
              },
            };
          },
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
        });
        loseProof = () => test.setCorrelatedPromptLifecycleProof(false);
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const closing = yield* Effect.promise(() =>
          test.emit({ type: "closed", error: "native-worker-close-canary" }),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust(250);

        expect(yield* Fiber.join(events)).toEqual([
          expect.objectContaining({ _tag: "SessionResynced" }),
          {
            _tag: "SessionClosed",
            error: "Prime Agent correlated prompt capability proof was lost during recovery.",
          },
        ]);
        yield* Fiber.join(closing);
        expect(snapshotReads).toBe(2);
      }),
    ),
  );

  it.effect("fails when strict proof retires after worker snapshot settlement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let snapshotReads = 0;
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            return {
              ...snapshot(snapshotReads + 20),
              state: { ...snapshot(snapshotReads + 20).state, isStreaming: true },
              children: [],
              promptLifecycles: { records: [], expired: [] },
            };
          },
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
        });
        const runtime = yield* test.make();
        const snapshotEvents = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const closing = yield* Effect.promise(() =>
          test.emit({ type: "closed", error: "settled-worker-close-canary" }),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust(250);
        const admitted = yield* Fiber.join(snapshotEvents);
        expect(admitted.map((event) => event._tag)).toEqual(["SessionResynced", "SessionResynced"]);
        expect(runtime.resolveReconnectSnapshot(0, true, true)).toBe(true);
        yield* Fiber.join(closing);

        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        expect((yield* collectEvents(runtime, 1))[0]).toEqual({
          _tag: "SessionClosed",
          error: "Prime Agent correlated prompt capability proof was lost during recovery.",
        });
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(23),
              children: [],
              promptLifecycles: { records: [], expired: [] },
            },
          }),
        );
        const submit = yield* runtime
          .submitCorrelatedPrompt({
            text: "must remain terminal",
            correlationId: "fa185724-1651-4e21-8d88-fc202ffbe15d",
            queueIfBusy: true,
          })
          .pipe(Effect.result);
        expect(submit._tag).toBe("Failure");
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "submitCorrelatedPrompt"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("rejects adapter settlement after a worker snapshot proof epoch retires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const correlationId = "70e15b0e-b74c-440b-b2b9-b67135f30474";
        let snapshotReads = 0;
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            return {
              ...snapshot(snapshotReads + 4),
              state: { ...snapshot(snapshotReads + 4).state, isStreaming: true },
              promptLifecycles: {
                records: [promptLifecycle(correlationId, "owned", 1)],
                expired: [],
              },
            };
          },
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
        });
        const runtime = yield* test.make();
        const snapshotEvents = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const closing = yield* Effect.promise(() =>
          test.emit({ type: "closed", error: "native-worker-close-canary" }),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust(250);
        const admittedSnapshots = yield* Fiber.join(snapshotEvents);
        expect(admittedSnapshots.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "SessionResynced",
        ]);
        const recoverySnapshot = admittedSnapshots[1];
        expect(recoverySnapshot).toMatchObject({
          _tag: "SessionResynced",
          connectionGeneration: 0,
          correlatedProofEpoch: expect.any(Number),
        });
        const admittedProofEpoch =
          recoverySnapshot?._tag === "SessionResynced"
            ? recoverySnapshot.correlatedProofEpoch
            : undefined;
        expect(runtime.isConnectionGenerationCurrent(0, admittedProofEpoch)).toBe(true);
        const terminalEvents = yield* collectEvents(runtime, 1).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        test.setCorrelatedPromptLifecycleProof(false);
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );

        expect(runtime.isConnectionGenerationCurrent(0, admittedProofEpoch)).toBe(false);
        expect(runtime.resolveReconnectSnapshot(0, true, true)).toBe(false);
        runtime.noteWorkerRecoveryTerminalResponse();
        expect(runtime.retryWorkerRecoverySnapshot(0)).toBe(false);
        expect(yield* Fiber.join(terminalEvents)).toEqual([
          {
            _tag: "SessionClosed",
            error: "Prime Agent correlated prompt capability proof was lost during recovery.",
          },
        ]);
        yield* Fiber.join(closing);
      }),
    ),
  );

  it.effect("does not consume worker proof for an invalid lifecycle snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const correlationId = "b11506fb-c718-4880-892d-08f2a26cff85";
        let snapshotReads = 0;
        let reportRecoverySnapshot!: () => void;
        const recoverySnapshot = new Promise<void>((resolve) => {
          reportRecoverySnapshot = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) {
              return {
                ...snapshot(5),
                state: { ...snapshot(5).state, isStreaming: true },
                promptLifecycles: {
                  records: [promptLifecycle(correlationId, "owned", 1)],
                  expired: [],
                },
              };
            }
            reportRecoverySnapshot();
            return {
              ...snapshot(6),
              state: { ...snapshot(6).state, isStreaming: true },
              promptLifecycles: {
                records: [],
                expired: [{ correlationId, deliveryCrossed: false }],
              },
            };
          },
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
        });
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 3).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const closing = yield* Effect.promise(() =>
          test.emit({ type: "closed", error: "Daemon worker client closed" }),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust(250);
        yield* Effect.promise(() => recoverySnapshot);
        const recoveredEvents = yield* Fiber.join(events);
        expect(recoveredEvents[1]).toEqual({ _tag: "CorrelatedProtocolViolation" });
        expect(recoveredEvents[2]).toMatchObject({ _tag: "SessionClosed" });
        expect(runtime.resolveReconnectSnapshot(0, true)).toBe(false);
        expect(runtime.retryWorkerRecoverySnapshot(0)).toBe(false);
        yield* Fiber.join(closing);
      }),
    ),
  );

  it.effect("requires recovered terminal proof when an in-flight barrier completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let reportWaitStarted!: () => void;
        const waitStarted = new Promise<void>((resolve) => {
          reportWaitStarted = resolve;
        });
        let releaseWait!: () => void;
        const heldWait = new Promise<unknown>((resolve) => {
          releaseWait = () => resolve({ result: "completed" });
        });
        let snapshotReads = 0;
        let reportRecoverySnapshot!: () => void;
        const recoverySnapshot = new Promise<void>((resolve) => {
          reportRecoverySnapshot = resolve;
        });
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return snapshot(5);
            reportRecoverySnapshot();
            return {
              ...snapshot(6),
              state: {
                ...snapshot(6).state,
                activeSessionId: "active-secret-1",
              },
            };
          },
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
          waitForHeadlessCompletionImpl: () => {
            reportWaitStarted();
            return heldWait;
          },
        });
        const runtime = yield* test.make();
        const collecting = yield* collectEvents(runtime, 5).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_end", messages: [] } }),
        );
        const waiting = yield* runtime
          .waitForRlmQuiescence("turn-worker-close-completed-race:1", activeSignal())
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => waitStarted);
        const closing = yield* Effect.promise(() =>
          test.emit({ type: "closed", error: "Daemon worker client closed" }),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust(250);
        yield* Effect.promise(() => recoverySnapshot);
        let snapshotResolved = false;
        for (let attempt = 0; attempt < 10 && !snapshotResolved; attempt += 1) {
          yield* Effect.yieldNow;
          snapshotResolved = runtime.resolveReconnectSnapshot(0, true, false);
        }
        expect(snapshotResolved).toBe(true);
        releaseWait();
        yield* Fiber.join(closing);
        const error = yield* Fiber.join(waiting);
        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
          detail: "Prime Agent could not confirm descendant quiescence.",
        });

        yield* Effect.promise(() =>
          test.emit({ type: "closed", error: "later genuine terminal close" }),
        );
        const events = yield* Fiber.join(collecting);
        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "RunStarted",
          "RunCompleted",
          "SessionResynced",
          "SessionClosed",
        ]);
      }),
    ),
  );

  it.effect("drops same-tick traffic after a close with no active worker run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture();
        const runtime = yield* test.make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");

        yield* Effect.promise(() =>
          Promise.all([
            test.emit({ type: "closed" }),
            test.emit({
              type: "session_event",
              event: { type: "message_end", message: terminalAssistantMessage() },
            }),
          ]).then(() => undefined),
        );
        expect(yield* collectEvents(runtime, 1)).toEqual([
          { _tag: "SessionClosed", error: undefined },
        ]);
        const callsBefore = [...test.captures.connectionCalls];
        expect(yield* runtime.getInputQueueStatus.pipe(Effect.flip)).toMatchObject({
          reason: "request-failed",
        });
        expect(test.captures.connectionCalls).toEqual(callsBefore);
      }),
    ),
  );

  it.effect("quarantines same-tick terminal traffic immediately after close admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let releaseSummary!: () => void;
        const heldSummary = new Promise<unknown>((resolve) => {
          releaseSummary = () => resolve(workerListResponse("recovering"));
        });
        let reportSummaryRead!: () => void;
        const summaryRead = new Promise<void>((resolve) => {
          reportSummaryRead = resolve;
        });
        let snapshotReads = 0;
        let reportRecoverySnapshot!: () => void;
        const recoverySnapshot = new Promise<void>((resolve) => {
          reportRecoverySnapshot = resolve;
        });
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return { ...snapshot(5), children: [] };
            reportRecoverySnapshot();
            return {
              ...snapshot(6),
              state: { ...snapshot(6).state, messageCount: 1 },
              messages: [terminalAssistantMessage()],
              children: [],
            };
          },
          listResponses: [heldSummary, workerListResponse("ready")],
          listRequestObserved: () => reportSummaryRead(),
        });
        const runtime = yield* test.make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("RunStarted");

        const closeAndTerminal = yield* Effect.promise(() =>
          Promise.all([
            test.emit({ type: "closed" }),
            test.emit({
              type: "session_event",
              event: { type: "message_end", message: terminalAssistantMessage() },
            }),
          ]).then(() => undefined),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => summaryRead);
        const authoritative = yield* collectEvents(runtime, 1).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        expect(authoritative.pollUnsafe()).toBeUndefined();

        releaseSummary();
        yield* TestClock.adjust(250);
        yield* Effect.promise(() => recoverySnapshot);
        expect(yield* Fiber.join(authoritative)).toEqual([
          expect.objectContaining({ _tag: "SessionResynced", lastEventSequence: 6 }),
        ]);
        expect(runtime.resolveReconnectSnapshot(0, true)).toBe(true);
        yield* Fiber.join(closeAndTerminal);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("blocks ordinary commands and retains terminal evidence during close preflight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let releaseSummary!: () => void;
        const heldSummary = new Promise<unknown>((resolve) => {
          releaseSummary = () => resolve(workerListResponse("recovering"));
        });
        let reportSummaryRead!: () => void;
        const summaryRead = new Promise<void>((resolve) => {
          reportSummaryRead = resolve;
        });
        let snapshotReads = 0;
        let reportRecoverySnapshot!: () => void;
        const recoverySnapshot = new Promise<void>((resolve) => {
          reportRecoverySnapshot = resolve;
        });
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return { ...snapshot(5), children: [] };
            reportRecoverySnapshot();
            return {
              ...snapshot(6),
              state: { ...snapshot(6).state, messageCount: 1 },
              messages: [terminalAssistantMessage()],
              children: [],
            };
          },
          listResponses: [heldSummary, workerListResponse("ready")],
          listRequestObserved: () => reportSummaryRead(),
        });
        const runtime = yield* test.make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        const closing = yield* Effect.promise(() => test.emit({ type: "closed" })).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => summaryRead);
        expect(runtime.inputAdmissionBusy).toBe(true);
        const callsBefore = [...test.captures.connectionCalls];

        for (const operation of [
          runtime.prompt({ text: "blocked prompt" }),
          runtime.steer({ text: "blocked steer" }),
          runtime.getInputQueueStatus,
          runtime.abort,
        ]) {
          const error = yield* operation.pipe(Effect.flip);
          expect(error).toMatchObject({
            reason: "request-failed",
            detail: "Prime Agent worker recovery is pending.",
          });
        }
        expect(test.captures.connectionCalls).toEqual(callsBefore);

        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: { type: "message_end", message: terminalAssistantMessage() },
          }),
        );
        releaseSummary();
        yield* TestClock.adjust(250);
        yield* Effect.promise(() => recoverySnapshot);
        expect((yield* collectEvents(runtime, 2)).map((event) => event._tag)).toEqual([
          "RunStarted",
          "SessionResynced",
        ]);
        expect(runtime.resolveReconnectSnapshot(0, true)).toBe(true);
        yield* Fiber.join(closing);
        expect(runtime.inputAdmissionBusy).toBe(true);
        yield* runtime.waitForRlmQuiescence("close-preflight-terminal:1", activeSignal());
        expect(runtime.inputAdmissionBusy).toBe(false);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("rejects a delayed strict close after its ingress proof retires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const managed = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let verificationCalls = 0;
        let reportHeldVerification!: () => void;
        const heldVerificationStarted = new Promise<void>((resolve) => {
          reportHeldVerification = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            state: { ...snapshot().state, isStreaming: true },
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
          verifyManagedSourceImpl: () => {
            verificationCalls += 1;
            if (verificationCalls === 1) return Promise.resolve(true);
            reportHeldVerification();
            return new Promise<boolean>(() => undefined);
          },
        });
        const runtime = yield* test.make(
          undefined,
          [managed.path],
          undefined,
          undefined,
          undefined,
          managed,
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("ConnectionStatus");
        const heldSnapshot = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(101),
            state: { ...snapshot(101).state, isStreaming: true },
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
        });
        yield* Effect.promise(() => heldVerificationStarted);

        const close = test.emit({ type: "closed" });
        const newerReconnect = test.emit({ type: "connection_status", status: "reconnecting" });
        yield* Effect.promise(() =>
          Promise.all([heldSnapshot, close, newerReconnect]).then(() => undefined),
        );
        expect((yield* collectEvents(runtime, 1))[0]).toEqual({
          _tag: "SessionClosed",
          error: "Prime Agent correlated prompt capability proof was lost during recovery.",
        });
        expect(test.captures.commands.filter((command) => command.type === "list")).toHaveLength(0);
        const callsBefore = [...test.captures.connectionCalls];
        expect(yield* runtime.getInputQueueStatus.pipe(Effect.flip)).toMatchObject({
          reason: "request-failed",
        });
        expect(test.captures.connectionCalls).toEqual(callsBefore);
      }),
    ),
  );

  it.effect("retires a delayed strict close when disposal starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const managed = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let verificationCalls = 0;
        let reportHeldVerification!: () => void;
        const heldVerificationStarted = new Promise<void>((resolve) => {
          reportHeldVerification = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            state: { ...snapshot().state, isStreaming: true },
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
          verifyManagedSourceImpl: () => {
            verificationCalls += 1;
            if (verificationCalls === 1) return Promise.resolve(true);
            reportHeldVerification();
            return new Promise<boolean>(() => undefined);
          },
        });
        const runtime = yield* test.make(
          undefined,
          [managed.path],
          undefined,
          undefined,
          undefined,
          managed,
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("ConnectionStatus");
        const heldSnapshot = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(102),
            state: { ...snapshot(102).state, isStreaming: true },
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
        });
        yield* Effect.promise(() => heldVerificationStarted);

        const close = test.emit({ type: "closed" });
        yield* runtime.dispose;
        yield* Effect.promise(() => Promise.all([heldSnapshot, close]).then(() => undefined));
        expect(test.captures.commands.filter((command) => command.type === "list")).toHaveLength(0);
        expect(test.captures.order.filter((step) => step === "snapshot")).toHaveLength(1);
      }),
    ),
  );

  it.effect("fails strict close recovery when its proof retires during worker listing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let releaseList!: () => void;
        const heldList = new Promise<unknown>((resolve) => {
          releaseList = () => resolve(workerListResponse("recovering"));
        });
        let reportListRead!: () => void;
        const listRead = new Promise<void>((resolve) => {
          reportListRead = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            state: { ...snapshot().state, isStreaming: true },
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
          listResponses: [heldList],
          listRequestObserved: reportListRead,
        });
        const runtime = yield* test.make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        const close = test.emit({ type: "closed" });
        yield* Effect.promise(() => listRead);

        yield* Effect.promise(() =>
          test.emit({
            type: "session_replaced",
            activeSessionId: "replacement-after-close-canary",
          }),
        );
        expect((yield* collectEvents(runtime, 1))[0]).toEqual({
          _tag: "SessionClosed",
          error: "Prime Agent correlated prompt capability proof was lost during recovery.",
        });
        test.setCorrelatedPromptLifecycleProof(true);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(103),
              children: [],
              promptLifecycles: { records: [], expired: [] },
            },
          }),
        );
        releaseList();
        yield* Effect.promise(() => close);
        expect(test.captures.order.filter((step) => step === "snapshot")).toHaveLength(1);

        const submit = yield* runtime
          .submitCorrelatedPrompt({
            text: "must remain terminal",
            correlationId: "cd00ba2b-4e4f-41bc-b98c-5c8328784aec",
            queueIfBusy: true,
          })
          .pipe(Effect.result);
        expect(submit._tag).toBe("Failure");
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "submitCorrelatedPrompt"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("orders strict pre-close proof work before close classification", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const managed = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let verificationCalls = 0;
        let reportPreCloseVerification!: () => void;
        const preCloseVerificationStarted = new Promise<void>((resolve) => {
          reportPreCloseVerification = resolve;
        });
        let releasePreCloseVerification!: () => void;
        const preCloseVerification = new Promise<boolean>((resolve) => {
          releasePreCloseVerification = () => resolve(true);
        });
        let releaseSummary!: () => void;
        const heldSummary = new Promise<unknown>((resolve) => {
          releaseSummary = () => resolve(workerListResponse("recovering"));
        });
        let reportSummaryRead!: () => void;
        const summaryRead = new Promise<void>((resolve) => {
          reportSummaryRead = resolve;
        });
        let snapshotReads = 0;
        let reportRecoverySnapshot!: () => void;
        const recoverySnapshot = new Promise<void>((resolve) => {
          reportRecoverySnapshot = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) {
              return {
                ...snapshot(5),
                state: { ...snapshot(5).state, isStreaming: true },
                children: [],
                promptLifecycles: { records: [], expired: [] },
              };
            }
            reportRecoverySnapshot();
            return {
              ...snapshot(12),
              state: { ...snapshot(12).state, messageCount: 1 },
              messages: [terminalAssistantMessage()],
              children: [],
              promptLifecycles: { records: [], expired: [] },
            };
          },
          verifyManagedSourceImpl: () => {
            verificationCalls += 1;
            if (verificationCalls !== 2) return Promise.resolve(true);
            reportPreCloseVerification();
            return preCloseVerification;
          },
          listResponses: [heldSummary, workerListResponse("ready")],
          listRequestObserved: () => reportSummaryRead(),
        });
        const runtime = yield* test.make(
          undefined,
          [managed.path],
          undefined,
          undefined,
          undefined,
          managed,
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("ConnectionStatus");
        const preClose = test.emit({
          type: "session_resynced",
          snapshot: {
            ...snapshot(11),
            state: { ...snapshot(11).state, isStreaming: true },
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
        });
        yield* Effect.promise(() => preCloseVerificationStarted);
        const closeAndTerminal = yield* Effect.promise(() =>
          Promise.all([
            test.emit({ type: "closed" }),
            test.emit({
              type: "session_event",
              event: { type: "message_end", message: terminalAssistantMessage() },
            }),
          ]).then(() => undefined),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(runtime.inputAdmissionBusy).toBe(true);

        releasePreCloseVerification();
        yield* Effect.promise(() => preClose);
        yield* Effect.promise(() => summaryRead);
        expect((yield* collectEvents(runtime, 1))[0]).toMatchObject({
          _tag: "SessionResynced",
          lastEventSequence: 11,
        });
        const authoritative = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        expect(authoritative.pollUnsafe()).toBeUndefined();

        releaseSummary();
        yield* TestClock.adjust(250);
        yield* Effect.promise(() => recoverySnapshot);
        expect(yield* Fiber.join(authoritative)).toEqual([
          { _tag: "ConnectionStatus", status: "reconnecting", error: undefined },
          expect.objectContaining({ _tag: "SessionResynced", lastEventSequence: 12 }),
        ]);
        expect(runtime.resolveReconnectSnapshot(1, true, true)).toBe(true);
        yield* Fiber.join(closeAndTerminal);
        expect(verificationCalls).toBe(3);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("blocks strict close commands and quarantines private side-question completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let releaseSummary!: () => void;
        const heldSummary = new Promise<unknown>((resolve) => {
          releaseSummary = () => resolve(workerListResponse("ready"));
        });
        let reportSummaryRead!: () => void;
        const summaryRead = new Promise<void>((resolve) => {
          reportSummaryRead = resolve;
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            state: { ...snapshot().state, isStreaming: true },
            children: [],
            promptLifecycles: { records: [], expired: [] },
          },
          listResponses: [heldSummary],
          listRequestObserved: () => reportSummaryRead(),
        });
        const runtime = yield* test.make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        const nativeId = "77777777-7777-4777-8777-777777777777";
        const sideQuestion = yield* runtime
          .askSideQuestion(nativeId, "must fail during close")
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        const closing = yield* Effect.promise(() => test.emit({ type: "closed" })).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => summaryRead);
        expect(runtime.inputAdmissionBusy).toBe(true);
        const callsBefore = [...test.captures.connectionCalls];

        for (const operation of [runtime.getInputQueueStatus, runtime.abort]) {
          const error = yield* operation.pipe(Effect.flip);
          expect(error).toMatchObject({
            reason: "request-failed",
            detail: "Prime Agent worker recovery is pending.",
          });
        }
        expect(test.captures.connectionCalls).toEqual(callsBefore);
        yield* Effect.promise(() =>
          test.emit({
            type: "side_question_event",
            event: { id: nativeId, answer: "must stay private", status: "complete" },
          }),
        );
        expect(yield* Fiber.join(sideQuestion)).toMatchObject({
          operation: "side-question",
          reason: "request-failed",
          detail: "The Prime Agent side question did not complete safely.",
        });
        expect(test.captures.sideQuestionAborts).toEqual([nativeId]);

        releaseSummary();
        yield* Fiber.join(closing);
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionClosed");
      }),
    ),
  );

  it.effect("fails a second close after recovery before final quiescence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let snapshotReads = 0;
        let reportRecoverySnapshot!: () => void;
        const recoverySnapshot = new Promise<void>((resolve) => {
          reportRecoverySnapshot = resolve;
        });
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return { ...snapshot(5), children: [] };
            reportRecoverySnapshot();
            return {
              ...snapshot(6),
              state: { ...snapshot(6).state, messageCount: 1 },
              messages: [terminalAssistantMessage()],
              children: [],
            };
          },
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
        });
        const runtime = yield* test.make();
        expect((yield* collectEvents(runtime, 1))[0]?._tag).toBe("SessionResynced");
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        const firstClose = yield* Effect.promise(() => test.emit({ type: "closed" })).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(250);
        yield* Effect.promise(() => recoverySnapshot);
        expect((yield* collectEvents(runtime, 2)).map((event) => event._tag)).toEqual([
          "RunStarted",
          "SessionResynced",
        ]);
        expect(runtime.resolveReconnectSnapshot(0, true, true)).toBe(true);
        yield* Fiber.join(firstClose);
        expect(runtime.inputAdmissionBusy).toBe(true);

        yield* Effect.promise(() => test.emit({ type: "closed" }));
        expect((yield* collectEvents(runtime, 1))[0]).toMatchObject({
          _tag: "SessionClosed",
        });
        expect(test.captures.commands.filter((command) => command.type === "list")).toHaveLength(2);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("singleflights a raw close with concurrent barrier recovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let releaseFirstList!: () => void;
        const heldFirstList = new Promise<unknown>((resolve) => {
          releaseFirstList = () => resolve(workerListResponse("recovering"));
        });
        let listReads = 0;
        let reportFirstList!: () => void;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        let reportSecondList!: () => void;
        const secondList = new Promise<void>((resolve) => {
          reportSecondList = resolve;
        });
        let waitAttempts = 0;
        let reportFirstWait!: () => void;
        const firstWait = new Promise<void>((resolve) => {
          reportFirstWait = resolve;
        });
        let snapshotReads = 0;
        let reportRecoverySnapshot!: () => void;
        const recoverySnapshot = new Promise<void>((resolve) => {
          reportRecoverySnapshot = resolve;
        });
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return snapshot(5);
            reportRecoverySnapshot();
            return {
              ...snapshot(6),
              state: {
                ...snapshot(6).state,
                activeSessionId: "active-secret-1",
                messageCount: 1,
              },
              messages: [terminalAssistantMessage()],
            };
          },
          listResponses: [
            heldFirstList,
            workerListResponse("recovering"),
            workerListResponse("ready"),
          ],
          listRequestObserved: () => {
            listReads += 1;
            if (listReads === 1) reportFirstList();
            if (listReads === 2) reportSecondList();
          },
          waitForHeadlessCompletionImpl: () => {
            waitAttempts += 1;
            reportFirstWait();
            return waitAttempts === 1
              ? Promise.reject(new Error("Session worker is recovering"))
              : Promise.resolve({ result: "completed" });
          },
        });
        const runtime = yield* test.make();
        const collecting = yield* collectEvents(runtime, 6).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_end", messages: [] } }),
        );
        const closing = yield* Effect.promise(() =>
          test.emit({ type: "closed", error: "Daemon worker client closed" }),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstList);
        const duplicateClosing = yield* Effect.promise(() =>
          test.emit({ type: "closed", error: "duplicate worker close" }),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        const waiting = yield* runtime
          .waitForRlmQuiescence("turn-worker-close-singleflight:1", activeSignal())
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstWait);
        releaseFirstList();

        yield* TestClock.adjust(250);
        yield* Effect.promise(() => secondList);
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => recoverySnapshot);
        let snapshotResolved = false;
        for (let attempt = 0; attempt < 10 && !snapshotResolved; attempt += 1) {
          yield* Effect.yieldNow;
          snapshotResolved = runtime.resolveReconnectSnapshot(0, true, true);
        }
        expect(snapshotResolved).toBe(true);
        yield* Fiber.join(closing);
        yield* Fiber.join(duplicateClosing);
        yield* Fiber.join(waiting);
        yield* Effect.promise(() =>
          test.emit({ type: "closed", error: "later genuine terminal close" }),
        );
        const events = yield* Fiber.join(collecting);

        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "RunStarted",
          "RunCompleted",
          "SessionResynced",
          "RlmQuiesced",
          "SessionClosed",
        ]);
        expect(test.captures.commands.filter((command) => command.type === "list")).toHaveLength(3);
        expect(
          test.captures.connectionCalls.filter(
            (call) => call.method === "waitForHeadlessCompletion",
          ),
        ).toHaveLength(2);
      }),
    ),
  );

  it.effect("preserves a terminal close when the supervisor does not report recovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture({ listResponses: [workerListResponse("ready")] });
        const runtime = yield* test.make();
        const collecting = yield* collectEvents(runtime, 3).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        yield* Effect.promise(() => test.emit({ type: "closed", error: "genuine terminal close" }));
        const events = yield* Fiber.join(collecting);

        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "RunStarted",
          "SessionClosed",
        ]);
        expect(test.captures.commands.filter((command) => command.type === "list")).toHaveLength(1);
      }),
    ),
  );

  it.effect("does not adopt a different session's recovering worker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture({
          listResponses: [
            workerListResponse("recovering", 101, {
              activeSessionId: "different-active-session",
            }),
          ],
        });
        const runtime = yield* test.make();
        const collecting = yield* collectEvents(runtime, 3).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        yield* Effect.promise(() =>
          test.emit({ type: "closed", error: "different session worker closed" }),
        );
        const events = yield* Fiber.join(collecting);

        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "RunStarted",
          "SessionClosed",
        ]);
        expect(test.captures.order.filter((entry) => entry === "snapshot")).toHaveLength(1);
      }),
    ),
  );

  it.effect("fails closed when a recovered worker loses the supervised managed extension", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expected = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        const resources = {
          extensions: [{ path: expected.path }],
          diagnostics: { extensions: [] },
        };
        let reportFirstList!: () => void;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        let reportRecoverySnapshot!: () => void;
        const recoverySnapshotRead = new Promise<void>((resolve) => {
          reportRecoverySnapshot = resolve;
        });
        let snapshotReads = 0;
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads === 1) return { ...snapshot(5), children: [] };
            reportRecoverySnapshot();
            return { ...snapshot(6), children: [] };
          },
          resourceSnapshot: resources,
          waitForHeadlessCompletionImpl: () =>
            Promise.reject(new Error("Session worker is recovering")),
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
          listRequestObserved: () => reportFirstList(),
        });
        const runtime = yield* test.make(undefined, [expected.path], expected);
        const collecting = yield* collectEvents(runtime, 3).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const waiting = yield* runtime
          .waitForRlmQuiescence("turn-worker-managed-failure:1", activeSignal())
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));

        yield* Effect.promise(() => firstList);
        resources.extensions = [];
        yield* TestClock.adjust(250);
        yield* Effect.promise(() => recoverySnapshotRead);
        const error = yield* Fiber.join(waiting);
        const events = yield* Fiber.join(collecting);

        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
        });
        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "ConnectionStatus",
          "SessionClosed",
        ]);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "getToolDefinition"),
        ).toHaveLength(2);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "getRlmMaxDepthStatus"),
        ).toHaveLength(2);
      }),
    ),
  );

  it.effect("closes the managed session when worker recovery is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expected = {
          path: "/state/pylon/permission.mjs",
          markerCommand: "pylon-permission-gate-v1",
        };
        let reportFirstList!: () => void;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        const test = fixture({
          rawSnapshot: { ...snapshot(5), children: [] },
          waitForHeadlessCompletionImpl: () =>
            Promise.reject(new Error("Session worker is recovering")),
          listResponses: [workerListResponse("recovering")],
          listRequestObserved: () => reportFirstList(),
        });
        const runtime = yield* test.make(
          undefined,
          [expected.path],
          undefined,
          undefined,
          undefined,
          expected,
        );
        const collecting = yield* collectEvents(runtime, 3).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const controller = new AbortController();
        const waiting = yield* runtime
          .waitForRlmQuiescence("turn-worker-managed-abort:1", controller.signal)
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));

        yield* Effect.promise(() => firstList);
        controller.abort();
        const error = yield* Fiber.join(waiting);
        const nextPromptError = yield* runtime
          .prompt({ text: "must not enter a replacement worker" })
          .pipe(Effect.flip);
        const events = yield* Fiber.join(collecting);

        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
        });
        expect(nextPromptError).toMatchObject({
          operation: "prompt",
          reason: "request-failed",
          detail: "The Prime Agent daemon session is closed.",
        });
        expect(events.map((event) => event._tag)).toEqual([
          "SessionResynced",
          "ConnectionStatus",
          "SessionClosed",
        ]);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("waits for same-generation admission evidence after the close rejects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rejectPrompt!: (error: Error) => void;
        let reportPromptStarted: (() => void) | undefined;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        const test = fixture({
          promptAndWaitImpl: () =>
            new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
              reportPromptStarted?.();
            }),
        });
        const runtime = yield* test.make();
        const token = "turn-late-worker-proof:1";
        const prompting = yield* runtime
          .prompt({ text: "proof arrives after close", rlmQuiescenceToken: token })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);

        rejectPrompt(new Error("Daemon worker client closed"));
        yield* Effect.yieldNow;
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: {
              type: "message_end",
              message: {
                role: "user",
                content: "proof arrives after close",
                timestamp: 1,
              },
            },
          }),
        );
        yield* Fiber.join(prompting);
        yield* runtime.waitForRlmQuiescence(token, activeSignal());

        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter(
            (call) => call.method === "waitForHeadlessCompletion",
          ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("fails an unproven worker close after its bounded evidence grace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rejectPrompt!: (error: Error) => void;
        let reportPromptStarted: (() => void) | undefined;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        const test = fixture({
          promptAndWaitImpl: () =>
            new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
              reportPromptStarted?.();
            }),
        });
        const runtime = yield* test.make();
        const prompting = yield* runtime
          .prompt({ text: "never admitted" })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);

        rejectPrompt(new Error("Daemon worker client closed"));
        const error = yield* Fiber.join(prompting);

        expect(error).toMatchObject({ operation: "prompt", reason: "request-failed" });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter(
            (call) => call.method === "waitForHeadlessCompletion",
          ),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("rejects later matching input after a different first user message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rejectPrompt!: (error: Error) => void;
        let reportPromptStarted: (() => void) | undefined;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        const test = fixture({
          promptAndWaitImpl: () =>
            new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
              reportPromptStarted?.();
            }),
        });
        const runtime = yield* test.make();
        const prompting = yield* runtime
          .prompt({ text: "do not guess", rlmQuiescenceToken: "turn-unproved:1" })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);
        yield* Effect.promise(() =>
          test.emit({ type: "session_event", event: { type: "agent_start" } }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: {
              type: "message_end",
              message: { role: "user", content: "another input", timestamp: 1 },
            },
          }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: {
              type: "message_end",
              message: { role: "user", content: "do not guess", timestamp: 2 },
            },
          }),
        );

        rejectPrompt(new Error("Daemon worker client closed"));
        const error = yield* Fiber.join(prompting);

        expect(error).toMatchObject({
          operation: "prompt",
          reason: "request-failed",
          detail: "The daemon operation failed.",
        });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter(
            (call) => call.method === "waitForHeadlessCompletion",
          ),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("rejects a whitespace-plus-image proof even when image bytes match", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rejectPrompt!: (error: Error) => void;
        let reportPromptStarted: (() => void) | undefined;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        const test = fixture({
          promptAndWaitImpl: () =>
            new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
              reportPromptStarted?.();
            }),
        });
        const runtime = yield* test.make();
        const prompting = yield* runtime
          .prompt({
            text: "  \n\t",
            images: [{ type: "image", data: "encoded-image", mimeType: "image/png" }],
            rlmQuiescenceToken: "turn-image-only:1",
          })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: {
              type: "message_end",
              message: {
                role: "user",
                content: [
                  { type: "text", text: "  \n\t" },
                  { type: "image", data: "encoded-image", mimeType: "image/png" },
                ],
                timestamp: 1,
              },
            },
          }),
        );

        rejectPrompt(new Error("Daemon worker client closed"));
        const error = yield* Fiber.join(prompting);

        expect(error).toMatchObject({ operation: "prompt", reason: "request-failed" });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter(
            (call) => call.method === "waitForHeadlessCompletion",
          ),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("rejects matching text and MIME proof with different image bytes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rejectPrompt!: (error: Error) => void;
        let reportPromptStarted: (() => void) | undefined;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        const test = fixture({
          promptAndWaitImpl: () =>
            new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
              reportPromptStarted?.();
            }),
        });
        const runtime = yield* test.make();
        const prompting = yield* runtime
          .prompt({
            text: "inspect this image",
            images: [{ type: "image", data: "encoded-image", mimeType: "image/png" }],
            rlmQuiescenceToken: "turn-image-mismatch:1",
          })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: {
              type: "message_end",
              message: {
                role: "user",
                content: [
                  { type: "text", text: "inspect this image" },
                  { type: "image", data: "different-image", mimeType: "image/png" },
                ],
                timestamp: 1,
              },
            },
          }),
        );

        rejectPrompt(new Error("Daemon worker client closed"));
        const error = yield* Fiber.join(prompting);

        expect(error).toMatchObject({ operation: "prompt", reason: "request-failed" });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter(
            (call) => call.method === "waitForHeadlessCompletion",
          ),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("rejects worker-close adoption after prompt cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rejectPrompt!: (error: Error) => void;
        let reportPromptStarted: (() => void) | undefined;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        const test = fixture({
          promptAndWaitImpl: () =>
            new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
              reportPromptStarted?.();
            }),
        });
        const runtime = yield* test.make();
        const controller = new AbortController();
        const prompting = yield* runtime
          .prompt({
            text: "cancel this admission",
            rlmQuiescenceToken: "turn-cancelled-close:1",
            signal: controller.signal,
          })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: {
              type: "message_end",
              message: {
                role: "user",
                content: "cancel this admission",
                timestamp: 1,
              },
            },
          }),
        );

        controller.abort();
        rejectPrompt(new Error("Daemon worker client closed"));
        const error = yield* Fiber.join(prompting);

        expect(error).toMatchObject({ operation: "prompt", reason: "request-failed" });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter(
            (call) => call.method === "waitForHeadlessCompletion",
          ),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("rejects a genuine prompt error after native admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rejectPrompt!: (error: Error) => void;
        let reportPromptStarted: (() => void) | undefined;
        const promptStarted = new Promise<void>((resolve) => {
          reportPromptStarted = resolve;
        });
        const test = fixture({
          promptAndWaitImpl: () =>
            new Promise<void>((_resolve, reject) => {
              rejectPrompt = reject;
              reportPromptStarted?.();
            }),
        });
        const runtime = yield* test.make();
        const prompting = yield* runtime
          .prompt({ text: "admitted but failed", rlmQuiescenceToken: "turn-failed:1" })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => promptStarted);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_event",
            event: {
              type: "message_end",
              message: {
                role: "user",
                content: "admitted but failed",
                timestamp: 1,
              },
            },
          }),
        );

        rejectPrompt(new Error("provider rejected the prompt"));
        const error = yield* Fiber.join(prompting);

        expect(error).toMatchObject({
          operation: "prompt",
          reason: "request-failed",
          detail: "The daemon operation failed.",
        });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter(
            (call) => call.method === "waitForHeadlessCompletion",
          ),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("retries a quiescence wait cancelled by final-child deletion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        const test = fixture({
          waitForHeadlessCompletionImpl: () => {
            attempts += 1;
            return attempts === 1
              ? Promise.reject(new Error("RLM quiescence wait cancelled"))
              : Promise.resolve({ result: "completed" });
          },
        });
        const runtime = yield* test.make();
        const collecting = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const token = "turn-child-delete:1";

        yield* runtime.prompt({ text: "finish after child deletion", rlmQuiescenceToken: token });
        yield* runtime.waitForRlmQuiescence(token, activeSignal());
        const events = yield* Fiber.join(collecting);

        expect(attempts).toBe(2);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter(
            (call) => call.method === "waitForHeadlessCompletion",
          ),
        ).toHaveLength(2);
        expect(events.at(-1)).toMatchObject({
          _tag: "RlmQuiesced",
          token,
          connectionGeneration: 0,
        });
      }),
    ),
  );

  it.effect("fails closed when worker recovery changes process incarnation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        let reportFirstAttempt: (() => void) | undefined;
        const firstAttempt = new Promise<void>((resolve) => {
          reportFirstAttempt = resolve;
        });
        let reportFirstList: (() => void) | undefined;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        const test = fixture({
          waitForHeadlessCompletionImpl: () => {
            attempts += 1;
            reportFirstAttempt?.();
            return attempts === 1
              ? Promise.reject(new Error("Session worker is recovering"))
              : Promise.resolve({ result: "completed" });
          },
          listResponses: [workerListResponse("recovering", 101), workerListResponse("ready", 202)],
          listRequestObserved: () => reportFirstList?.(),
        });
        const runtime = yield* test.make();
        const token = "turn-worker-replacement:1";
        yield* runtime.prompt({ text: "do not adopt replacement", rlmQuiescenceToken: token });
        const waiting = yield* runtime
          .waitForRlmQuiescence(token, activeSignal())
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstAttempt);
        yield* Effect.promise(() => firstList);
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(5),
              state: {
                ...snapshot(5).state,
                activeSessionId: "active-secret-1",
                messageCount: 1,
              },
              messages: [terminalAssistantMessage()],
            },
          }),
        );
        expect(runtime.resolveReconnectSnapshot(0, true, true)).toBe(false);

        yield* TestClock.adjust(250);
        const error = yield* Fiber.join(waiting);

        expect(attempts).toBe(1);
        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
          detail: "Prime Agent could not confirm descendant quiescence.",
        });
      }),
    ),
  );

  it.effect("rejects a worker recovery interruption marker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        let reportFirstAttempt: (() => void) | undefined;
        const firstAttempt = new Promise<void>((resolve) => {
          reportFirstAttempt = resolve;
        });
        let reportFirstList: (() => void) | undefined;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        let snapshotReads = 0;
        const workerRecoveryMarkerSnapshot = {
          ...snapshot(5),
          state: {
            ...snapshot(5).state,
            activeSessionId: "active-secret-1",
            messageCount: 1,
          },
          messages: [
            {
              role: "custom",
              customType: "prime-agent.worker_recovery",
              content: [{ type: "text", text: "private recovery marker" }],
              display: false,
              timestamp: 2,
            },
          ],
        };
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            return snapshotReads === 1 ? snapshot(5) : workerRecoveryMarkerSnapshot;
          },
          waitForHeadlessCompletionImpl: () => {
            attempts += 1;
            reportFirstAttempt?.();
            return Promise.reject(new Error("Session worker is recovering"));
          },
          listResponses: [
            workerListResponse("recovering"),
            workerListResponse("ready"),
            workerListResponse("ready"),
            workerListResponse("ready"),
          ],
          listRequestObserved: () => reportFirstList?.(),
        });
        const runtime = yield* test.make();
        yield* runtime.prompt({
          text: "reject interrupted work",
          rlmQuiescenceToken: "turn-marker:1",
        });
        const waiting = yield* runtime
          .waitForRlmQuiescence("turn-marker:1", activeSignal())
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstAttempt);
        yield* Effect.promise(() => firstList);
        yield* TestClock.adjust(250);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(100);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(250);
        const error = yield* Fiber.join(waiting);

        expect(attempts).toBe(1);
        expect(runtime.resolveReconnectSnapshot(0, true, true)).toBe(false);
        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
          detail: "Prime Agent could not confirm descendant quiescence.",
        });
      }),
    ),
  );

  it.effect("requires a recovered terminal response before publishing quiescence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        let reportFirstAttempt: (() => void) | undefined;
        const firstAttempt = new Promise<void>((resolve) => {
          reportFirstAttempt = resolve;
        });
        let reportFirstList: (() => void) | undefined;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        let reportRecoverySnapshot: (() => void) | undefined;
        const recoverySnapshotRead = new Promise<void>((resolve) => {
          reportRecoverySnapshot = resolve;
        });
        let snapshotReads = 0;
        const test = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            if (snapshotReads > 1) reportRecoverySnapshot?.();
            return {
              ...snapshot(5),
              state: { ...snapshot(5).state, activeSessionId: "active-secret-1" },
            };
          },
          waitForHeadlessCompletionImpl: () => {
            attempts += 1;
            reportFirstAttempt?.();
            return attempts === 1
              ? Promise.reject(new Error("Session worker is recovering"))
              : Promise.resolve({ result: "completed" });
          },
          listResponses: [workerListResponse("recovering"), workerListResponse("ready")],
          listRequestObserved: () => reportFirstList?.(),
        });
        const runtime = yield* test.make();
        yield* runtime.prompt({
          text: "require final output",
          rlmQuiescenceToken: "turn-output:1",
        });
        const waiting = yield* runtime
          .waitForRlmQuiescence("turn-output:1", activeSignal())
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstAttempt);
        yield* Effect.promise(() => firstList);
        runtime.noteWorkerRecoveryTerminalResponse();
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(5),
              state: { ...snapshot(5).state, activeSessionId: "active-secret-1" },
            },
          }),
        );
        expect(runtime.resolveReconnectSnapshot(0, true, false)).toBe(false);
        yield* TestClock.adjust(250);
        yield* Effect.promise(() => recoverySnapshotRead);
        yield* Effect.yieldNow;
        expect(runtime.resolveReconnectSnapshot(0, true, false)).toBe(true);
        const error = yield* Fiber.join(waiting);

        expect(attempts).toBe(2);
        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
          detail: "Prime Agent could not confirm descendant quiescence.",
        });
      }),
    ),
  );

  it.effect("bounds worker recovery without resubmitting the barrier", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        let reportFirstAttempt: (() => void) | undefined;
        const firstAttempt = new Promise<void>((resolve) => {
          reportFirstAttempt = resolve;
        });
        let reportFirstList: (() => void) | undefined;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        const test = fixture({
          waitForHeadlessCompletionImpl: () => {
            attempts += 1;
            reportFirstAttempt?.();
            return Promise.reject(new Error("Session worker is recovering"));
          },
          listResponses: Array.from({ length: 16 }, () => workerListResponse("recovering")),
          listRequestObserved: () => reportFirstList?.(),
        });
        const runtime = yield* test.make();
        yield* runtime.prompt({ text: "bound recovery", rlmQuiescenceToken: "turn-recovery:1" });
        const waiting = yield* runtime
          .waitForRlmQuiescence("turn-recovery:1", activeSignal())
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstAttempt);
        yield* Effect.promise(() => firstList);

        yield* TestClock.adjust("1 minute");
        const error = yield* Fiber.join(waiting);

        expect(attempts).toBe(1);
        expect(test.captures.commands.filter((command) => command.type === "list")).toHaveLength(
          16,
        );
        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
          detail: "Prime Agent could not confirm descendant quiescence.",
        });
      }),
    ),
  );

  it.effect("does not retry worker recovery after the turn signal aborts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        let reportFirstAttempt: (() => void) | undefined;
        const firstAttempt = new Promise<void>((resolve) => {
          reportFirstAttempt = resolve;
        });
        let reportFirstList: (() => void) | undefined;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        const test = fixture({
          waitForHeadlessCompletionImpl: () => {
            attempts += 1;
            reportFirstAttempt?.();
            return Promise.reject(new Error("Session worker is recovering"));
          },
          listResponses: [workerListResponse("recovering")],
          listRequestObserved: () => reportFirstList?.(),
        });
        const runtime = yield* test.make();
        const controller = new AbortController();
        const token = "turn-recovery-abort:1";
        yield* runtime.prompt({ text: "cancel recovery", rlmQuiescenceToken: token });
        const waiting = yield* runtime
          .waitForRlmQuiescence(token, controller.signal)
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstAttempt);
        yield* Effect.promise(() => firstList);

        controller.abort();
        const error = yield* Fiber.join(waiting);

        expect(attempts).toBe(1);
        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
          detail: "Prime Agent descendant quiescence wait was cancelled.",
        });
      }),
    ),
  );

  it.effect("does not retry worker recovery across a connection generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        let reportFirstAttempt: (() => void) | undefined;
        const firstAttempt = new Promise<void>((resolve) => {
          reportFirstAttempt = resolve;
        });
        let reportFirstList: (() => void) | undefined;
        const firstList = new Promise<void>((resolve) => {
          reportFirstList = resolve;
        });
        const test = fixture({
          waitForHeadlessCompletionImpl: () => {
            attempts += 1;
            reportFirstAttempt?.();
            return Promise.reject(new Error("Session worker is recovering"));
          },
          listResponses: [workerListResponse("recovering")],
          listRequestObserved: () => reportFirstList?.(),
        });
        const runtime = yield* test.make();
        const token = "turn-recovery-generation:1";
        yield* runtime.prompt({ text: "keep recovery ownership", rlmQuiescenceToken: token });
        const waiting = yield* runtime
          .waitForRlmQuiescence(token, activeSignal())
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstAttempt);
        yield* Effect.promise(() => firstList);

        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        yield* TestClock.adjust(250);
        const error = yield* Fiber.join(waiting);

        expect(attempts).toBe(1);
        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
          detail: "Prime Agent reconnected before descendant quiescence could be confirmed.",
        });
      }),
    ),
  );

  it.effect("does not retry quiescence cancellation after the turn signal aborts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        let rejectWait!: (error: Error) => void;
        let reportWaitStarted: (() => void) | undefined;
        const waitStarted = new Promise<void>((resolve) => {
          reportWaitStarted = resolve;
        });
        const test = fixture({
          waitForHeadlessCompletionImpl: () => {
            attempts += 1;
            if (attempts > 1) return Promise.resolve({ result: "completed" });
            return new Promise((_resolve, reject) => {
              rejectWait = reject;
              reportWaitStarted?.();
            });
          },
        });
        const runtime = yield* test.make();
        const controller = new AbortController();
        const token = "turn-user-abort:1";
        yield* runtime.prompt({ text: "cancel this turn", rlmQuiescenceToken: token });
        const waiting = yield* runtime
          .waitForRlmQuiescence(token, controller.signal)
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => waitStarted);

        controller.abort();
        rejectWait(new Error("RLM quiescence wait cancelled"));
        const error = yield* Fiber.join(waiting);

        expect(attempts).toBe(1);
        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
          detail: "Prime Agent descendant quiescence wait was cancelled.",
        });
      }),
    ),
  );

  it.effect("bounds repeated quiescence cancellation retries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        const test = fixture({
          waitForHeadlessCompletionImpl: () => {
            attempts += 1;
            return Promise.reject(new Error("RLM quiescence wait cancelled"));
          },
        });
        const runtime = yield* test.make();

        yield* runtime.prompt({ text: "do not wait forever", rlmQuiescenceToken: "turn-loop:1" });
        const error = yield* runtime
          .waitForRlmQuiescence("turn-loop:1", activeSignal())
          .pipe(Effect.flip);

        expect(attempts).toBe(4);
        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
          detail: "Prime Agent could not confirm descendant quiescence.",
        });
      }),
    ),
  );

  it.effect("does not retry quiescence cancellation across a connection generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rejectWait!: (error: Error) => void;
        let reportWaitStarted: (() => void) | undefined;
        const waitStarted = new Promise<void>((resolve) => {
          reportWaitStarted = resolve;
        });
        const test = fixture({
          waitForHeadlessCompletionImpl: () =>
            new Promise((_resolve, reject) => {
              rejectWait = reject;
              reportWaitStarted?.();
            }),
        });
        const runtime = yield* test.make();
        yield* runtime.prompt({ text: "keep the generation", rlmQuiescenceToken: "turn-gen:1" });
        const waiting = yield* runtime
          .waitForRlmQuiescence("turn-gen:1", activeSignal())
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => waitStarted);

        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(1),
              replay: {
                status: "complete",
                fromSequence: 1,
                toSequence: 1,
                fromCursor: { generation: "daemon-1", sequence: 1 },
                toCursor: { generation: "daemon-1", sequence: 1 },
              },
            },
          }),
        );
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(true);
        rejectWait(new Error("RLM quiescence wait cancelled"));
        const error = yield* Fiber.join(waiting);

        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
          detail: "Prime Agent reconnected before descendant quiescence could be confirmed.",
        });
        expect(
          test.captures.connectionCalls.filter(
            (call) => call.method === "waitForHeadlessCompletion",
          ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("rejects a successful retry that crosses a connection generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        let resolveRetry!: (value: unknown) => void;
        let reportRetryStarted: (() => void) | undefined;
        const retryStarted = new Promise<void>((resolve) => {
          reportRetryStarted = resolve;
        });
        const test = fixture({
          waitForHeadlessCompletionImpl: () => {
            attempts += 1;
            if (attempts === 1) {
              return Promise.reject(new Error("RLM quiescence wait cancelled"));
            }
            return new Promise((resolve) => {
              resolveRetry = resolve;
              reportRetryStarted?.();
            });
          },
        });
        const runtime = yield* test.make();
        yield* runtime.prompt({ text: "keep retry ownership", rlmQuiescenceToken: "turn-retry:1" });
        const waiting = yield* runtime
          .waitForRlmQuiescence("turn-retry:1", activeSignal())
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => retryStarted);

        yield* Effect.promise(() =>
          test.emit({ type: "connection_status", status: "reconnecting" }),
        );
        yield* Effect.promise(() =>
          test.emit({
            type: "session_resynced",
            snapshot: {
              ...snapshot(1),
              replay: {
                status: "complete",
                fromSequence: 1,
                toSequence: 1,
                fromCursor: { generation: "daemon-1", sequence: 1 },
                toCursor: { generation: "daemon-1", sequence: 1 },
              },
            },
          }),
        );
        expect(runtime.resolveReconnectSnapshot(1, true)).toBe(true);
        resolveRetry({ result: "completed" });
        const error = yield* Fiber.join(waiting);

        expect(attempts).toBe(2);
        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
          detail: "Prime Agent reconnected before descendant quiescence could be confirmed.",
        });
      }),
    ),
  );

  it.effect("rejects final quiescence publication after its proof epoch retires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let statsCalls = 0;
        let reportFinalStats!: () => void;
        const finalStatsStarted = new Promise<void>((resolve) => {
          reportFinalStats = resolve;
        });
        let releaseFinalStats!: () => void;
        const finalStats = new Promise<unknown>((resolve) => {
          releaseFinalStats = () =>
            resolve({
              sessionId: "session-1",
              tokens: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, total: 4 },
              cost: 0,
            });
        });
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
          getSessionStatsImpl: () => {
            statsCalls += 1;
            if (statsCalls === 1) {
              return Promise.resolve({
                sessionId: "session-1",
                tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
                cost: 0,
              });
            }
            reportFinalStats();
            return finalStats;
          },
        });
        const runtime = yield* test.make();
        const events = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const token = "turn-proof-final:1";
        yield* runtime.prompt({ text: "fence final quiescence", rlmQuiescenceToken: token });
        const waiting = yield* runtime
          .waitForRlmQuiescence(token, activeSignal())
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => finalStatsStarted);

        test.setCorrelatedPromptLifecycleProof(false);
        releaseFinalStats();

        expect(yield* Fiber.join(waiting)).toMatchObject({
          _tag: "Failure",
          failure: { operation: "rlm-quiescence", reason: "request-failed" },
        });
        expect(yield* Fiber.join(events)).toEqual([
          expect.objectContaining({ _tag: "SessionResynced" }),
          {
            _tag: "SessionClosed",
            error: "Prime Agent correlated prompt capability proof was lost during recovery.",
          },
        ]);
      }),
    ),
  );

  it.effect("reports the full cumulative usage delta at authoritative quiescence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stats = [
          {
            sessionId: "session-1",
            tokens: { input: 100, output: 20, cacheRead: 300, cacheWrite: 5, total: 425 },
            cost: 0.25,
          },
          {
            sessionId: "session-1",
            tokens: { input: 160, output: 35, cacheRead: 500, cacheWrite: 8, total: 703 },
            cost: 0.5,
          },
        ];
        const test = fixture({ getSessionStatsImpl: () => Promise.resolve(stats.shift()) });
        const runtime = yield* test.make();
        const collecting = yield* collectEvents(runtime, 2).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const token = "turn-usage:1";

        yield* runtime.prompt({ text: "include child usage", rlmQuiescenceToken: token });
        yield* runtime.waitForRlmQuiescence(token, activeSignal());

        expect((yield* Fiber.join(collecting)).at(-1)).toMatchObject({
          _tag: "RlmQuiesced",
          token,
          usage: {
            inputTokens: 60,
            outputTokens: 15,
            cachedInputTokens: 200,
            cacheWriteTokens: 3,
            totalTokens: 278,
            totalCostUsd: 0.25,
          },
        });
      }),
    ),
  );

  it.effect("fails a prompt safely when the advertised RLM barrier cannot complete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({
          waitForHeadlessCompletionImpl: () =>
            Promise.reject(new Error("private daemon failure at /secret/path")),
        });
        const runtime = yield* make();

        yield* runtime.prompt({ text: "wait safely", rlmQuiescenceToken: "turn-1:1" });
        const error = yield* runtime
          .waitForRlmQuiescence("turn-1:1", activeSignal())
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
          detail: "Prime Agent could not confirm descendant quiescence.",
        });
        expect(error.detail).not.toContain("/secret/path");
        expect(
          captures.connectionCalls.filter((call) => call.method === "waitForHeadlessCompletion"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("retains prompt settlement for older connections without an RLM barrier", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({ omitRlmQuiescence: true });
        const runtime = yield* make();

        yield* runtime.prompt({ text: "legacy prompt" });

        expect(runtime.rlmQuiescenceAvailable).toBe(false);
        expect(
          captures.connectionCalls.some((call) => call.method === "waitForHeadlessCompletion"),
        ).toBe(false);
      }),
    ),
  );

  it.effect("resumes prompt admission after aborting and clearing queued input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture();
        const runtime = yield* make();

        yield* runtime.abortAndClearQueue;
        yield* runtime.prompt({ text: "continue after interrupt" });

        expect(captures.commands).toContainEqual({
          type: "list",
          includeClientOwned: true,
        });
        expect(captures.commands).toContainEqual({
          type: "resume_queue",
          activeSessionId: "active-secret-1",
        });
        expect(captures.connectionCalls.slice(-3)).toEqual([
          { method: "abortAndClearQueue", args: [] },
          { method: "resumeQueue", args: [] },
          {
            method: "prompt",
            args: [
              "continue after interrupt",
              { queueIfBusy: true, streamingBehavior: "followUp" },
            ],
          },
        ]);
      }),
    ),
  );

  it.effect("resumes the replacement active session after reconnecting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, emit, make } = fixture({
          listedActiveSessionId: "active-secret-recovered",
        });
        const runtime = yield* make();

        yield* Effect.promise(() => emit({ type: "session_resynced", snapshot: snapshot(5) }));
        yield* runtime.abortAndClearQueue;
        yield* runtime.prompt({ text: "continue after reconnect and interrupt" });

        expect(captures.commands).toContainEqual({
          type: "resume_queue",
          activeSessionId: "active-secret-recovered",
        });
        expect(captures.commands).not.toContainEqual({
          type: "resume_queue",
          activeSessionId: "active-secret-1",
        });
      }),
    ),
  );

  it.effect("fails closed when Prime does not confirm input resume after abort", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({
          resumeQueueResponses: [
            {
              type: "response",
              command: "resume_queue",
              success: false,
              error: "private daemon rejection at /secret/path",
            },
            {
              type: "response",
              command: "resume_queue",
              success: false,
              error: "No queued work to resume",
            },
          ],
        });
        const runtime = yield* make();

        yield* runtime.abortAndClearQueue;
        const error = yield* runtime.prompt({ text: "retry after interrupt" }).pipe(Effect.flip);

        expect(error).toMatchObject({
          operation: "resume-after-abort",
          reason: "invalid-response",
          detail: "The daemon returned an invalid session input resume response.",
        });
        expect(error.detail).not.toContain("/secret/path");
        expect(captures.connectionCalls.filter((call) => call.method === "prompt")).toHaveLength(0);

        yield* runtime.prompt({ text: "retry after failed resume" });
        expect(captures.commands.filter((command) => command.type === "resume_queue")).toHaveLength(
          2,
        );
        expect(captures.connectionCalls.at(-1)).toEqual({
          method: "prompt",
          args: ["retry after failed resume", { queueIfBusy: true, streamingBehavior: "followUp" }],
        });
      }),
    ),
  );

  it.effect("exposes typed operations and strips native model payloads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture();
        const runtime = yield* make();
        const images = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] as const;
        const signal = new AbortController().signal;
        yield* runtime.prompt({
          text: "prompt",
          images,
          signal,
          rlmQuiescenceToken: "turn-typed:1",
        });
        yield* runtime.waitForRlmQuiescence("turn-typed:1", activeSignal());
        yield* runtime.steer({ text: "steer", images });
        yield* runtime.followUp({ text: "follow", images });
        yield* runtime.abort;
        yield* runtime.abortAndClearQueue;
        const selected = yield* runtime.setModel("prime/model/with/slashes");
        yield* runtime.setThinkingLevel("xhigh");
        yield* runtime.setServiceTier("priority");
        yield* runtime.respondToExtensionUiRequest("dialog-1", { confirmed: true });
        const stats = yield* runtime.getSessionStats;

        expect(selected).toEqual({
          provider: "prime",
          id: "model/with/slashes",
          name: "Prime model",
        });
        expect(selected).not.toHaveProperty("baseUrl");
        expect(selected).not.toHaveProperty("headers");
        expect(stats).toEqual({
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            cachedInputTokens: 850,
            cacheWriteTokens: 10,
            totalTokens: 1_010,
            totalCostUsd: 0.42,
          },
          contextUsage: { usedTokens: 320, maxTokens: 200_000 },
        });
        expect(stats).not.toHaveProperty("sessionFile");
        expect(stats).not.toHaveProperty("sessionId");
        expect(stats).not.toHaveProperty("cost");
        expect(captures.attachOptions[0]).toMatchObject({
          ownedSessionRecoveryConfig: {
            model: "prime/model/with/slashes",
            thinking: "xhigh",
          },
        });
        expect(captures.connectionCalls).toEqual(
          [
            ["getResourceSnapshot", []],
            ["getCommands", []],
            ["getRlmMaxDepthStatus", []],
            ["getSessionStats", []],
            ["prompt", ["prompt", { queueIfBusy: false, images, signal }]],
            ["waitForHeadlessCompletion", [{ waitForRlmQuiescence: true }]],
            ["getSessionStats", []],
            ["steer", ["steer", images]],
            ["followUp", ["follow", images]],
            ["abort", []],
            ["abortAndClearQueue", []],
            ["setModel", ["prime", "model/with/slashes"]],
            ["setThinkingLevel", ["xhigh"]],
            ["setServiceTier", ["priority"]],
            ["extension", ["dialog-1", { confirmed: true }]],
            ["getSessionStats", []],
          ].map(([method, args]) => ({ method, args })),
        );
      }),
    ),
  );

  it.effect("reports a rejected model selection without leaking Prime's native error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A Prime release can drop a model id the thread still selects durably.
        const { make } = fixture({
          setModelImpl: () =>
            Promise.reject(new Error("unknown model cerebras/zai-glm-4.7 at /native/secret/path")),
        });
        const runtime = yield* make();

        const error = yield* runtime.setModel("cerebras/zai-glm-4.7").pipe(Effect.flip);

        expect(error).toMatchObject({ operation: "set-model", reason: "request-failed" });
        expect(error.detail).toContain("no longer exist in Prime Agent's catalog");
        expect(error.detail).not.toContain("/native/secret/path");
      }),
    ),
  );

  it.effect("discovers only configured catalog models and strips native fields", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({
          modelCatalog: {
            configuredProviders: [" openai ", "prime"],
            models: [
              {
                provider: " openai ",
                id: " gpt-5 ",
                name: " GPT 5 ",
                api: " responses ",
                reasoning: true,
                thinkingLevelMap: {
                  off: null,
                  minimal: " minimal ",
                  low: "low",
                  medium: "medium",
                  high: "high",
                  xhigh: "xhigh",
                  max: " max ",
                },
                baseUrl: "https://native-secret.invalid",
                headers: { authorization: "secret" },
              },
              {
                provider: "prime",
                id: "model-1",
                name: "   ",
                api: "anthropic-messages",
                reasoning: false,
              },
              {
                provider: "unconfigured",
                id: "hidden",
                name: "Hidden",
                api: "unconfigured-api",
                reasoning: false,
              },
            ],
          },
        });
        const runtime = yield* make();

        const models = yield* runtime.discoverAvailableModels;

        expect(models).toEqual([
          {
            provider: "openai",
            id: "gpt-5",
            name: "GPT 5",
            api: "responses",
            reasoning: true,
            thinkingLevelMap: {
              off: null,
              minimal: "minimal",
              low: "low",
              medium: "medium",
              high: "high",
              xhigh: "xhigh",
              max: "max",
            },
          },
          {
            provider: "prime",
            id: "model-1",
            name: "",
            api: "anthropic-messages",
            reasoning: false,
          },
        ]);
        expect(models[0]).not.toHaveProperty("baseUrl");
        expect(models[0]).not.toHaveProperty("headers");
        expect(
          captures.connectionCalls.filter((call) =>
            ["getModelCatalog", "getAvailableModels"].includes(call.method),
          ),
        ).toEqual([{ method: "getModelCatalog", args: [] }]);
      }),
    ),
  );

  it.effect("bounds the configured result after filtering a larger complete catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const unconfigured = Array.from({ length: 600 }, (_, index) => ({
          provider: "unconfigured",
          id: `model-${index}`,
          name: `Model ${index}`,
          api: "openai-completions",
          reasoning: false,
        }));
        const { make } = fixture({
          modelCatalog: {
            configuredProviders: ["configured"],
            models: [
              ...unconfigured,
              {
                provider: "configured",
                id: "usable",
                name: "Usable",
                api: "anthropic-messages",
                reasoning: true,
              },
            ],
          },
        });
        const runtime = yield* make();

        expect(yield* runtime.discoverAvailableModels).toEqual([
          {
            provider: "configured",
            id: "usable",
            name: "Usable",
            api: "anthropic-messages",
            reasoning: true,
          },
        ]);
      }),
    ),
  );

  it.effect("falls back to the legacy available-models method when catalog discovery rejects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture({
          getModelCatalogImpl: () => Promise.reject(new Error("private daemon failure")),
          availableModels: [
            {
              provider: " legacy ",
              id: " model ",
              name: " Legacy Model ",
              api: " legacy-api ",
              reasoning: true,
            },
          ],
        });
        const runtime = yield* make();

        expect(yield* runtime.discoverAvailableModels).toEqual([
          {
            provider: "legacy",
            id: "model",
            name: "Legacy Model",
            api: "legacy-api",
            reasoning: true,
          },
        ]);
        expect(
          captures.connectionCalls.filter((call) =>
            ["getModelCatalog", "getAvailableModels"].includes(call.method),
          ),
        ).toEqual([
          { method: "getModelCatalog", args: [] },
          { method: "getAvailableModels", args: [] },
        ]);
      }),
    ),
  );

  it.effect("rejects malformed or unbounded model catalogs without exposing native values", () =>
    Effect.gen(function* () {
      const model = (overrides: Readonly<Record<string, unknown>> = {}) => ({
        provider: "provider",
        id: "model",
        name: "Model",
        api: "test-api",
        reasoning: false,
        ...overrides,
      });
      const invalidCatalogs: ReadonlyArray<unknown> = [
        { models: [model({ provider: " " })], configuredProviders: [] },
        { models: [model({ id: " " })], configuredProviders: [] },
        {
          models: [model(), model({ provider: " provider ", id: " model " })],
          configuredProviders: [],
        },
        { models: [model()], configuredProviders: ["provider", " provider "] },
        { models: [model()], configuredProviders: ["missing-provider"] },
        { models: [model({ provider: `provider\u0000secret` })], configuredProviders: [] },
        { models: [model({ provider: "p".repeat(129) })], configuredProviders: [] },
        { models: [model({ id: "i".repeat(513) })], configuredProviders: [] },
        { models: [model({ name: "n".repeat(513) })], configuredProviders: [] },
        { models: [model({ api: "a".repeat(129) })], configuredProviders: [] },
        { models: [model({ api: " " })], configuredProviders: [] },
        { models: [model({ thinkingLevelMap: { high: " " } })], configuredProviders: [] },
        {
          models: [{ provider: "provider", id: "model", name: "Model", reasoning: false }],
          configuredProviders: [],
        },
        {
          models: [{ provider: "provider", id: "model", name: "Model", api: "test-api" }],
          configuredProviders: [],
        },
        {
          models: [model({ thinkingLevelMap: { high: "h".repeat(129) } })],
          configuredProviders: [],
        },
        { models: [model({ thinkingLevelMap: { ultra: "secret" } })], configuredProviders: [] },
        {
          models: Array.from({ length: 2_049 }, (_, index) => model({ id: `model-${index}` })),
          configuredProviders: [],
        },
        {
          models: Array.from({ length: 513 }, (_, index) => model({ id: `model-${index}` })),
          configuredProviders: ["provider"],
        },
        {
          models: [model()],
          configuredProviders: Array.from({ length: 129 }, (_, index) => `provider-${index}`),
        },
      ];

      for (const modelCatalog of invalidCatalogs) {
        const error = yield* Effect.scoped(
          Effect.gen(function* () {
            const { make } = fixture({ modelCatalog });
            const runtime = yield* make();
            return yield* Effect.flip(runtime.discoverAvailableModels);
          }),
        );
        expect(error.operation).toBe("model-catalog");
        expect(error.reason).toBe("invalid-response");
        expect(error.detail).toBe("Prime Agent returned an invalid model catalog.");
        expect(error.detail).not.toContain("secret");
      }
    }),
  );

  it.effect("reports model discovery as incompatible only when neither method exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { make } = fixture({ omitModelCatalog: true, omitAvailableModels: true });
        const runtime = yield* make();

        const error = yield* Effect.flip(runtime.discoverAvailableModels);

        expect(error.operation).toBe("model-catalog");
        expect(error.reason).toBe("incompatible-api");
      }),
    ),
  );

  it.effect(
    "projects queue counts without retaining prompt previews and clears without aborting",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let queue = { steering: ["private steer"], followUp: ["private one", "private two"] };
          const queuedSnapshot = snapshot();
          const test = fixture({
            rawSnapshotImpl: () => ({
              ...queuedSnapshot,
              state: {
                ...queuedSnapshot.state,
                sessionActions: {
                  ...actions,
                  steering: queue.steering,
                  followUps: queue.followUp,
                  queuedCount: queue.steering.length + queue.followUp.length,
                },
              },
            }),
            getQueueImpl: () => Promise.resolve(queue),
            clearQueueImpl: () => {
              const removed = queue;
              queue = { steering: [], followUp: [] };
              return Promise.resolve(removed);
            },
          });
          const runtime = yield* test.make();

          expect(runtime.initialInputQueue).toEqual({
            steeringCount: 1,
            followUpCount: 2,
            steeringMode: "one-at-a-time",
            followUpMode: "one-at-a-time",
          });
          expect(yield* runtime.getInputQueue).toEqual({ steeringCount: 1, followUpCount: 2 });
          expect(yield* runtime.clearInputQueue).toEqual({
            queue: {
              steeringCount: 0,
              followUpCount: 0,
              steeringMode: "one-at-a-time",
              followUpMode: "one-at-a-time",
            },
            activeAction: false,
            isStreaming: false,
          });
          expect(test.captures.connectionCalls.map((call) => call.method)).toContain("clearQueue");
          expect(test.captures.connectionCalls.map((call) => call.method)).not.toContain("abort");
        }),
      ),
  );

  it.effect("removes only a sole lane item with one native compare-and-delete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let queue = { steering: [] as string[], followUp: ["private follow-up"] };
        const test = fixture({
          getQueueImpl: () => Promise.resolve(queue),
          mutateQueuedMessageImpl: () => {
            queue = { steering: [], followUp: [] };
            return Promise.resolve("applied");
          },
        });
        const runtime = yield* test.make();
        expect(runtime.inputQueueMutationAvailable).toBe(true);
        expect(yield* runtime.removeOnlyInputQueueItem("follow-up")).toBe("applied");
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "mutateQueuedMessage"),
        ).toEqual([
          {
            method: "mutateQueuedMessage",
            args: ["followUp", 0, "private follow-up", { type: "delete" }],
          },
        ]);
        expect(test.captures.openCount).toBe(2);
        expect(test.captures.order.filter((entry) => entry === "request-recovery")).toHaveLength(1);
        expect(test.captures.closeCount).toBe(1);
      }),
    ),
  );

  it.effect("rejects a non-sole lane before mutation and gates an omitted native API", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const multiple = fixture({
          getQueueImpl: () =>
            Promise.resolve({ steering: ["private one", "private two"], followUp: [] }),
        });
        const multipleRuntime = yield* multiple.make();
        expect(yield* multipleRuntime.removeOnlyInputQueueItem("steering")).toBe("rejected");
        expect(
          multiple.captures.connectionCalls.some((call) => call.method === "mutateQueuedMessage"),
        ).toBe(false);

        const omitted = fixture({ omitQueueMutation: true });
        const omittedRuntime = yield* omitted.make();
        expect(omittedRuntime.inputQueueMutationAvailable).toBe(false);
        expect(
          yield* omittedRuntime.removeOnlyInputQueueItem("steering").pipe(Effect.flip),
        ).toMatchObject({ operation: "remove-only-input-queue-item", reason: "incompatible-api" });

        const incompatibleDaemon = fixture({ queueMutationCapability: false });
        const incompatibleRuntime = yield* incompatibleDaemon.make();
        expect(incompatibleRuntime.inputQueueMutationAvailable).toBe(false);
      }),
    ),
  );

  it.effect("decodes queued mutation statuses and never retries a timed-out mutation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const malformed = fixture({
          getQueueImpl: () => Promise.resolve({ steering: ["private"], followUp: [] }),
          mutateQueuedMessageImpl: () => Promise.resolve({ native: "secret" }),
        });
        const malformedRuntime = yield* malformed.make();
        expect(
          yield* malformedRuntime.removeOnlyInputQueueItem("steering").pipe(Effect.flip),
        ).toMatchObject({ operation: "remove-only-input-queue-item", reason: "invalid-response" });

        const timedOut = fixture({
          getQueueImpl: () => Promise.resolve({ steering: ["private"], followUp: [] }),
          mutateQueuedMessageImpl: () => new Promise<unknown>(() => undefined),
        });
        const timedOutRuntime = yield* timedOut.make();
        const fiber = yield* timedOutRuntime
          .removeOnlyInputQueueItem("steering")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("30 seconds");
        expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({
          operation: "remove-only-input-queue-item",
          reason: "request-timed-out",
        });
        expect(
          timedOut.captures.connectionCalls.filter((call) => call.method === "mutateQueuedMessage"),
        ).toHaveLength(1);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("maps and bounds authoritative session input delivery modes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let steeringMode: "all" | "one-at-a-time" = "one-at-a-time";
        let followUpMode: "all" | "one-at-a-time" = "one-at-a-time";
        const { captures, make } = fixture({
          rawSnapshotImpl: () => {
            const current = snapshot();
            return {
              ...current,
              state: { ...current.state, steeringMode, followUpMode },
            };
          },
          setSteeringModeImpl: (mode) => {
            steeringMode = mode;
            return Promise.resolve(undefined);
          },
          setFollowUpModeImpl: (mode) => {
            followUpMode = mode;
            return Promise.resolve(undefined);
          },
        });
        const runtime = yield* make();
        expect(runtime.initialInputQueue).toMatchObject({
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
        });
        expect(runtime.inputQueueModesAvailable).toBe(true);

        yield* runtime.setInputQueueMode({ queue: "steering", mode: "all-at-once" });
        yield* runtime.setInputQueueMode({ queue: "follow-up", mode: "all-at-once" });
        expect((yield* runtime.getInputQueueStatus).queue).toMatchObject({
          steeringMode: "all-at-once",
          followUpMode: "all-at-once",
        });
        expect(captures.connectionCalls).toContainEqual({
          method: "setSteeringMode",
          args: ["all"],
        });
        expect(captures.connectionCalls).toContainEqual({
          method: "setFollowUpMode",
          args: ["all"],
        });
        expect(captures.connectionCalls).toContainEqual({ method: "getState", args: [] });
        expect(captures.order.filter((entry) => entry === "snapshot")).toHaveLength(1);
      }),
    ),
  );

  it.effect("probes and invokes only local argument-free harness refinement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture();
        const runtime = yield* make();
        expect(runtime.refinementAvailable).toBe(true);
        expect(yield* runtime.refineLocalHarness).toEqual({
          appliedCount: 1,
          failedCount: 1,
          outcome: "partial",
        });
        expect(captures.connectionCalls.filter((call) => call.method === "refine")).toEqual([
          { method: "refine", args: [{ global: false }] },
        ]);

        const globalResult = fixture({
          refineImpl: () => Promise.resolve({ appliedEdits: [], scope: "global" }),
        });
        const globalResultRuntime = yield* globalResult.make();
        expect(yield* globalResultRuntime.refineLocalHarness.pipe(Effect.flip)).toMatchObject({
          operation: "refine-local-harness",
          reason: "invalid-response",
        });

        const rejected = fixture({
          refineImpl: () => Promise.reject(new Error("/private/native/refinement")),
        });
        const rejectedRuntime = yield* rejected.make();
        expect(yield* rejectedRuntime.refineLocalHarness.pipe(Effect.flip)).toMatchObject({
          operation: "refine-local-harness",
          reason: "request-failed",
          detail: expect.not.stringContaining("/private"),
        });

        const missing = fixture({ omitRefine: true });
        const unsupportedRuntime = yield* missing.make();
        expect(unsupportedRuntime.refinementAvailable).toBe(false);
        expect(yield* unsupportedRuntime.refineLocalHarness.pipe(Effect.flip)).toMatchObject({
          operation: "refine-local-harness",
          reason: "incompatible-api",
        });

        const restored = fixture();
        const restoredRuntime = yield* restored.make(
          PRIME_AGENT_DAEMON_RESUME_CURSOR,
          undefined,
          undefined,
          "session-1",
        );
        expect(restoredRuntime.refinementAvailable).toBe(false);

        const supervisedSnapshot = snapshot();
        const supervised = fixture({ rawSnapshot: { ...supervisedSnapshot, children: [] } });
        const supervisedRuntime = yield* supervised.make(
          undefined,
          ["/state/pylon/permission.mjs"],
          {
            path: "/state/pylon/permission.mjs",
            markerCommand: "pylon-permission-gate-v1",
          },
        );
        expect(supervisedRuntime.refinementAvailable).toBe(false);
      }),
    ),
  );

  it.effect("uses argument-free compaction controls and projects only safe state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let isCompacting = false;
        let autoCompactionEnabled = true;
        const { captures, make } = fixture({
          rawSnapshotImpl: () => {
            const current = snapshot();
            return {
              ...current,
              state: {
                ...current.state,
                isCompacting,
                autoCompactionEnabled,
              },
            };
          },
          compactImpl: () => {
            isCompacting = true;
            return Promise.resolve({
              summary: "private summary",
              details: { path: "/Users/private" },
              tokenCount: 1234,
            });
          },
          abortCompactionImpl: () => {
            isCompacting = false;
            return Promise.resolve(undefined);
          },
          setAutoCompactionImpl: (enabled) => {
            autoCompactionEnabled = enabled;
            return Promise.resolve(undefined);
          },
        });
        const runtime = yield* make();
        expect(runtime.compactionAvailable).toBe(true);
        expect(runtime.autoCompactionWritable).toBe(true);
        expect(runtime.initialCompactionState).toEqual({
          isCompacting: false,
          autoCompactionEnabled: true,
          isStreaming: false,
          isBashRunning: false,
          inputQueueActive: false,
          steeringCount: 0,
          followUpCount: 0,
        });

        expect(yield* runtime.compact).toBeUndefined();
        expect(yield* runtime.getCompactionState).toMatchObject({
          isCompacting: true,
          autoCompactionEnabled: true,
        });
        yield* runtime.abortCompaction;
        yield* runtime.setAutoCompactionEnabled(false);
        const state = yield* runtime.getCompactionState;
        expect(state).toEqual({
          isCompacting: false,
          autoCompactionEnabled: false,
          isStreaming: false,
          isBashRunning: false,
          inputQueueActive: false,
          steeringCount: 0,
          followUpCount: 0,
        });
        expect(captures.connectionCalls).toContainEqual({ method: "compact", args: [] });
        expect(captures.connectionCalls).toContainEqual({ method: "abortCompaction", args: [] });
        expect(captures.connectionCalls).toContainEqual({
          method: "setAutoCompactionEnabled",
          args: [false],
        });
      }),
    ),
  );

  it.effect("resumes input once before prompts continue after compaction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture();
        const runtime = yield* test.make();

        yield* runtime.compact;
        yield* runtime.prompt({ text: "first prompt after compaction" });
        yield* runtime.prompt({ text: "second prompt after compaction" });

        expect(
          test.captures.commands.filter((command) => command.type === "resume_queue"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.findIndex((call) => call.method === "resumeQueue"),
        ).toBeLessThan(test.captures.connectionCalls.findIndex((call) => call.method === "prompt"));
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(2);
      }),
    ),
  );

  it.effect("resumes input before the next prompt when compaction is declined", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture({
          compactImpl: () => Promise.reject(new Error("private native compaction failure")),
        });
        const runtime = yield* test.make();

        expect(yield* runtime.compact.pipe(Effect.flip)).toMatchObject({
          operation: "compact",
          reason: "request-failed",
          detail: expect.not.stringContaining("private"),
        });
        yield* runtime.prompt({ text: "continue after declined compaction" });

        expect(
          test.captures.commands.filter((command) => command.type === "resume_queue"),
        ).toHaveLength(1);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("retries post-compaction input resume before admitting a prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture({
          resumeQueueResponses: [
            {
              type: "response",
              command: "resume_queue",
              success: false,
              error: "private native resume failure",
            },
            {
              type: "response",
              command: "resume_queue",
              success: true,
              data: { resumed: true },
            },
          ],
        });
        const runtime = yield* test.make();

        yield* runtime.compact;
        expect(yield* runtime.prompt({ text: "blocked prompt" }).pipe(Effect.flip)).toMatchObject({
          operation: "resume-after-abort",
          reason: "invalid-response",
        });
        yield* runtime.prompt({ text: "retry after compaction" });

        expect(
          test.captures.commands.filter((command) => command.type === "resume_queue"),
        ).toHaveLength(2);
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "prompt"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("rejects malformed and timed-out input delivery mode mutations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const malformed = fixture({
          setSteeringModeImpl: () => Promise.resolve({ native: "secret" }),
        });
        const malformedRuntime = yield* malformed.make();
        expect(
          yield* malformedRuntime
            .setInputQueueMode({ queue: "steering", mode: "all-at-once" })
            .pipe(Effect.flip),
        ).toMatchObject({ operation: "set-input-queue-mode", reason: "invalid-response" });

        const timedOut = fixture({
          setFollowUpModeImpl: () => new Promise<unknown>(() => undefined),
        });
        const timedOutRuntime = yield* timedOut.make();
        const fiber = yield* timedOutRuntime
          .setInputQueueMode({ queue: "follow-up", mode: "all-at-once" })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("30 seconds");
        expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({
          operation: "set-input-queue-mode",
          reason: "request-timed-out",
        });
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("allows image-only prompts and rejects empty prompt, steer, and follow-up inputs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { make } = fixture();
        const runtime = yield* make();
        yield* runtime.prompt({
          text: "",
          images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        });
        for (const operation of [
          runtime.prompt({ text: "   " }),
          runtime.steer({ text: "" }),
          runtime.followUp({ text: "\n" }),
        ]) {
          const error = yield* Effect.flip(operation);
          expect(error.reason).toBe("invalid-input");
        }
      }),
    ),
  );

  it.effect("accepts the same bounded per-category queue counts from events and reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const steering = Array.from({ length: 600 }, (_, index) => `steer-${index}`);
        const followUp = Array.from({ length: 600 }, (_, index) => `follow-up-${index}`);
        const base = snapshot();
        const { make } = fixture({
          rawSnapshot: {
            ...base,
            state: {
              ...base.state,
              sessionActions: { ...actions, steering, followUps: followUp, queuedCount: 1_200 },
            },
          },
          getQueueImpl: () => Promise.resolve({ steering, followUp }),
        });
        const runtime = yield* make();
        expect(runtime.initialInputQueue).toEqual({
          steeringCount: 600,
          followUpCount: 600,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
        });
        expect(yield* runtime.getInputQueue).toEqual({ steeringCount: 600, followUpCount: 600 });
      }),
    ),
  );

  it.effect("rejects malformed command and snapshot outputs with typed errors", () =>
    Effect.gen(function* () {
      const invalidCreate = fixture({ createResponse: { success: true, data: {} } });
      const createError = yield* Effect.scoped(invalidCreate.make().pipe(Effect.flip));
      expect(createError).toMatchObject({
        _tag: "PrimeAgentDaemonSessionRuntimeError",
        operation: "create-session",
        reason: "invalid-response",
      });

      const invalidSnapshot = fixture({ rawSnapshot: { native: { path: "/secret" } } });
      const snapshotError = yield* Effect.scoped(invalidSnapshot.make().pipe(Effect.flip));
      expect(snapshotError).toMatchObject({
        _tag: "PrimeAgentDaemonSessionRuntimeError",
        operation: "initial-snapshot",
        reason: "invalid-response",
      });
      expect(snapshotError.detail).not.toContain("/secret");

      const invalidStats = fixture({
        sessionStats: {
          sessionId: "wrong-session",
          contextUsage: { tokens: 1, contextWindow: 100, percent: 1 },
        },
      });
      const statsError = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* invalidStats.make();
          return yield* runtime.getSessionStats.pipe(Effect.flip);
        }),
      );
      expect(statsError).toMatchObject({
        operation: "session-stats",
        reason: "invalid-response",
      });
    }),
  );
});

describe("Prime Agent live activity privacy boundary", () => {
  it("keeps only non-empty assistant text parts and drops every native field", () => {
    const entries = sanitizePrimeAgentLiveActivityMessages([
      { role: "user", content: "private delegation prompt", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "  visible answer  " },
          { type: "toolCall", id: "native-tool", name: "bash", arguments: { secret: true } },
        ],
        usage: { cost: { total: 99 } },
        errorMessage: "private failure",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "native-tool",
        toolName: "bash",
        content: [{ type: "text", text: "private result" }],
        timestamp: 3,
      },
      { role: "assistant", content: [{ type: "text", text: "   " }], timestamp: 4 },
    ]);

    expect(entries).toEqual([
      { speaker: "assistant", text: "visible answer" },
      { kind: "tool", activityId: 1, label: "Shell", status: "completed" },
    ]);
    expect(entries.every((entry) => Object.keys(entry).length <= 4)).toBe(true);
  });

  it("hydrates only a coarse tool skeleton and maps IPython without native details", () => {
    const entries = sanitizePrimeAgentLiveActivityMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          {
            type: "toolCall",
            id: "native-tool",
            name: "functions.ipython",
            arguments: { path: "/tmp/private", code: "secret" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "native-tool",
        toolName: "functions.ipython",
        content: [{ type: "text", text: "private result" }],
        details: { path: "/private/result" },
        timestamp: 123,
      },
    ]);
    expect(entries).toEqual([
      { kind: "tool", activityId: 1, label: "IPython", status: "completed" },
    ]);
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(["activityId", "kind", "label", "status"]);
    expect(primeAgentLiveActivityToolLabel("ipython")).toBe("IPython");
    expect(primeAgentLiveActivityToolLabel("functions.ipython")).toBe("IPython");
    expect(primeAgentLiveActivityToolLabel("/private/custom-tool")).toBe("Tool");
  });

  it("bounds hydrated tool rows and never emits their correlation ids", () => {
    const entries = sanitizePrimeAgentLiveActivityMessages(
      Array.from({ length: 100 }, (_, index) => ({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `private-id-${index}`,
            name: index % 2 === 0 ? "ipython" : "unknown-private-tool",
            arguments: { secret: index },
          },
        ],
      })),
    );
    expect(entries).toHaveLength(32);
    expect(entries.at(-1)).toEqual({
      kind: "tool",
      activityId: 64,
      label: "Tool",
      status: "started",
    });
    expect(
      entries.every(
        (entry) => Object.keys(entry).sort().join(",") === "activityId,kind,label,status",
      ),
    ).toBe(true);
  });

  it.effect("does not attach a same-client live activity watcher in strict correlated mode", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const correlationId = "e2255184-e697-4245-87ab-52421a65f602";
        const test = fixture({
          correlatedPromptLifecycleCapability: true,
          rawSnapshot: {
            ...snapshot(),
            promptLifecycles: { records: [], expired: [] },
          },
          submitCorrelatedPromptImpl: (_message, options) =>
            Promise.resolve({
              lifecycle: promptLifecycle(options.correlationId, "owned", 1),
              duplicate: false,
            }),
        });
        const runtime = yield* test.make();

        expect(runtime.watchAgentActivityAvailable).toBe(false);
        const error = yield* Effect.flip(
          runtime.watchAgentActivity("native-child-active").pipe(Stream.runDrain),
        );
        expect(error).toMatchObject({
          operation: "watch-agent-activity",
          reason: "incompatible-api",
        });
        expect(test.captures.watchedActiveSessionIds).toEqual([]);

        yield* runtime.submitCorrelatedPrompt({
          text: "proof remains owned",
          correlationId,
          queueIfBusy: true,
        });
        expect(
          test.captures.connectionCalls.filter((call) => call.method === "submitCorrelatedPrompt"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("projects live tool lifecycle without reading private payload fields", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { emitWatch, make } = fixture({ getWatchMessages: () => [] });
        const runtime = yield* make();
        const observed = yield* Queue.unbounded<void>();
        const fiber = yield* runtime.watchAgentActivity("native-child-active").pipe(
          Stream.tap(() => Queue.offer(observed, undefined)),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Queue.take(observed);
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_event",
            event: {
              type: "tool_execution_start",
              toolCallId: "native-secret-id",
              toolName: "functions.ipython",
              args: { code: "private code", path: "/private/path" },
              timestamp: 123,
            },
          }),
        );
        yield* Queue.take(observed);
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_event",
            event: {
              type: "tool_execution_update",
              toolCallId: "native-secret-id",
              toolName: "functions.ipython",
              args: { code: "private update" },
              partialResult: { content: [{ type: "text", text: "private partial" }] },
            },
          }),
        );
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_event",
            event: {
              type: "tool_execution_end",
              toolCallId: "native-secret-id",
              toolName: "functions.ipython",
              result: { content: [{ type: "text", text: "private result" }] },
              isError: true,
              error: "private error",
            },
          }),
        );

        const collected = Array.from(yield* Fiber.join(fiber));
        expect(collected).toEqual([
          [],
          [{ kind: "tool", activityId: 1, label: "IPython", status: "started" }],
          [{ kind: "tool", activityId: 1, label: "IPython", status: "failed" }],
        ]);
        expect(
          collected
            .flat()
            .every(
              (entry) => Object.keys(entry).sort().join(",") === "activityId,kind,label,status",
            ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("buffers sanitized tool lifecycle events before the initial read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let markReadStarted!: () => void;
        let resolveInitialRead!: (messages: ReadonlyArray<unknown>) => void;
        const readStarted = new Promise<void>((resolve) => {
          markReadStarted = resolve;
        });
        const initialRead = new Promise<ReadonlyArray<unknown>>((resolve) => {
          resolveInitialRead = resolve;
        });
        const { emitWatch, make } = fixture({
          getWatchMessages: () => {
            markReadStarted();
            return initialRead;
          },
        });
        const runtime = yield* make();
        const fiber = yield* runtime
          .watchAgentActivity("native-child-active")
          .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
        yield* Effect.promise(() => readStarted);
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_event",
            event: {
              type: "tool_execution_start",
              toolCallId: "private-id",
              toolName: "ipython",
              args: { path: "/private" },
            },
          }),
        );
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_event",
            event: {
              type: "tool_execution_end",
              toolCallId: "private-id",
              toolName: "ipython",
              result: { content: [{ type: "text", text: "private" }] },
              isError: false,
            },
          }),
        );
        resolveInitialRead([]);

        expect(Array.from(yield* Fiber.join(fiber))).toEqual([
          [],
          [{ kind: "tool", activityId: 1, label: "IPython", status: "started" }],
          [{ kind: "tool", activityId: 1, label: "IPython", status: "completed" }],
        ]);
      }),
    ),
  );

  it.effect("keeps hydrated terminal tools monotonic across overlapping start events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let markReadStarted!: () => void;
        let resolveInitialRead!: (messages: ReadonlyArray<unknown>) => void;
        const readStarted = new Promise<void>((resolve) => {
          markReadStarted = resolve;
        });
        const initialRead = new Promise<ReadonlyArray<unknown>>((resolve) => {
          resolveInitialRead = resolve;
        });
        const { emitWatch, make } = fixture({
          getWatchMessages: () => {
            markReadStarted();
            return initialRead;
          },
        });
        const runtime = yield* make();
        const fiber = yield* runtime
          .watchAgentActivity("native-child-active")
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        yield* Effect.promise(() => readStarted);
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_event",
            event: {
              type: "tool_execution_start",
              toolCallId: "x".repeat(100_000),
              toolName: "ipython",
              args: { code: "private" },
            },
          }),
        );
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_event",
            event: {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "After the tool" }],
              },
            },
          }),
        );
        resolveInitialRead([
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "x".repeat(100_000), name: "ipython", arguments: {} },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "x".repeat(100_000),
            toolName: "ipython",
            content: [{ type: "text", text: "private result" }],
            isError: false,
          },
        ]);

        const collected = Array.from(yield* Fiber.join(fiber));
        expect(collected).toEqual([
          [{ kind: "tool", activityId: 1, label: "IPython", status: "completed" }],
          [
            { kind: "tool", activityId: 1, label: "IPython", status: "completed" },
            { speaker: "assistant", text: "After the tool" },
          ],
        ]);
      }),
    ),
  );

  it.effect("coalesces watcher events and closes the second connection when the stream ends", () =>
    Effect.gen(function* () {
      let messages: ReadonlyArray<unknown> = [
        { role: "assistant", content: [{ type: "text", text: "first" }] },
      ];
      const { captures, emitWatch, make } = fixture({ getWatchMessages: () => messages });

      const collected = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* make();
          const initialObserved = yield* Queue.unbounded<void>();
          const fiber = yield* runtime.watchAgentActivity("native-child-active").pipe(
            Stream.tap(() => Queue.offer(initialObserved, undefined)),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Queue.take(initialObserved);
          messages = [{ role: "assistant", content: [{ type: "text", text: "second" }] }];
          yield* Effect.promise(() =>
            Promise.all(
              Array.from({ length: 20 }, (_, index) =>
                emitWatch({
                  type: "session_event",
                  event: {
                    type: "message_update",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: `second-${index}` }],
                    },
                  },
                }),
              ),
            ),
          );
          yield* Effect.yieldNow;
          yield* TestClock.adjust(PRIME_AGENT_LIVE_ACTIVITY_REFRESH_DELAY_MS);
          return Array.from(yield* Fiber.join(fiber));
        }),
      );

      expect(collected).toEqual([
        [{ speaker: "assistant", text: "first" }],
        [
          { speaker: "assistant", text: "first" },
          { speaker: "assistant", text: "second-19" },
        ],
      ]);
      expect(captures.watchedActiveSessionIds).toEqual(["native-child-active"]);
      expect(captures.rootMessageReads).toBe(0);
      expect(captures.watcherMessageReads).toBe(1);
      expect(captures.watcherUnsubscribeCount).toBe(1);
      expect(captures.watcherCloseCount).toBe(1);
    }),
  );

  it.effect("flushes every safe initialization event in order after the initial read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let markReadStarted!: () => void;
        let resolveInitialRead!: (messages: ReadonlyArray<unknown>) => void;
        const readStarted = new Promise<void>((resolve) => {
          markReadStarted = resolve;
        });
        const initialRead = new Promise<ReadonlyArray<unknown>>((resolve) => {
          resolveInitialRead = resolve;
        });
        const { captures, emitWatch, make } = fixture({
          getWatchMessages: () => {
            markReadStarted();
            return initialRead;
          },
        });
        const runtime = yield* make();
        const fiber = yield* runtime
          .watchAgentActivity("native-child-active")
          .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
        yield* Effect.promise(() => readStarted);
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_replaced",
            state: { isStreaming: true },
            messages: [{ role: "assistant", content: [{ type: "text", text: "replacement" }] }],
          }),
        );
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_event",
            event: {
              type: "message_update",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "streaming one" }],
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_event",
            event: {
              type: "message_update",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "streaming two" }],
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_event",
            event: {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "final answer" }],
              },
            },
          }),
        );
        resolveInitialRead([{ role: "assistant", content: [{ type: "text", text: "initial" }] }]);

        expect(Array.from(yield* Fiber.join(fiber))).toEqual([
          [{ speaker: "assistant", text: "initial" }],
          [{ speaker: "assistant", text: "replacement" }],
          [
            { speaker: "assistant", text: "replacement" },
            { speaker: "assistant", text: "final answer" },
          ],
        ]);
        expect(captures.watcherMessageReads).toBe(1);
      }),
    ),
  );

  it.effect("does not count invisible initialization events against the bounded buffer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let markReadStarted!: () => void;
        let resolveInitialRead!: (messages: ReadonlyArray<unknown>) => void;
        const readStarted = new Promise<void>((resolve) => {
          markReadStarted = resolve;
        });
        const initialRead = new Promise<ReadonlyArray<unknown>>((resolve) => {
          resolveInitialRead = resolve;
        });
        const { emitWatch, make } = fixture({
          getWatchMessages: () => {
            markReadStarted();
            return initialRead;
          },
        });
        const runtime = yield* make();
        const fiber = yield* runtime
          .watchAgentActivity("native-child-active")
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        yield* Effect.promise(() => readStarted);
        for (let index = 0; index < 128; index += 1) {
          yield* Effect.promise(() =>
            emitWatch({
              type: "session_event",
              event: {
                type: "message_update",
                message: {
                  role: "assistant",
                  content: [
                    { type: "thinking", thinking: `private-${index}` },
                    {
                      type: "toolCall",
                      id: `native-${index}`,
                      name: "ipython",
                      arguments: { path: "/private/path" },
                    },
                  ],
                },
              },
            }),
          );
        }
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_event",
            event: {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "visible answer" }],
              },
            },
          }),
        );
        resolveInitialRead([]);

        expect(Array.from(yield* Fiber.join(fiber))).toEqual([
          [],
          [{ speaker: "assistant", text: "visible answer" }],
        ]);
      }),
    ),
  );

  it.effect("fails bounded initialization buffering instead of retaining unlimited events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let markReadStarted!: () => void;
        let resolveInitialRead!: (messages: ReadonlyArray<unknown>) => void;
        const readStarted = new Promise<void>((resolve) => {
          markReadStarted = resolve;
        });
        const initialRead = new Promise<ReadonlyArray<unknown>>((resolve) => {
          resolveInitialRead = resolve;
        });
        const { emitWatch, make } = fixture({
          getWatchMessages: () => {
            markReadStarted();
            return initialRead;
          },
        });
        const runtime = yield* make();
        const fiber = yield* runtime
          .watchAgentActivity("native-child-active")
          .pipe(Stream.runDrain, Effect.flip, Effect.forkChild);
        yield* Effect.promise(() => readStarted);
        for (let index = 0; index <= 64; index += 1) {
          yield* Effect.promise(() =>
            emitWatch({
              type: "session_event",
              event: {
                type: "message_update",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: `safe-${index}` }],
                },
              },
            }),
          );
        }
        resolveInitialRead([]);

        expect(yield* Fiber.join(fiber)).toMatchObject({
          operation: "watch-agent-activity",
          reason: "request-failed",
          detail: "Too many live agent activity events arrived during initialization.",
        });
      }),
    ),
  );

  it.effect("keeps committed activity when resync streaming content is not visible", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { emitWatch, make } = fixture({
          getWatchMessages: () => [
            { role: "assistant", content: [{ type: "text", text: "initial" }] },
          ],
        });
        const runtime = yield* make();
        const observed = yield* Queue.unbounded<void>();
        const fiber = yield* runtime.watchAgentActivity("native-child-active").pipe(
          Stream.tap(() => Queue.offer(observed, undefined)),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Queue.take(observed);
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_resynced",
            snapshot: {
              messages: [{ role: "assistant", content: [{ type: "text", text: "committed" }] }],
              streamingMessage: {
                role: "assistant",
                content: [{ type: "thinking", thinking: "private reasoning" }],
              },
            },
          }),
        );
        yield* Queue.take(observed);
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_event",
            event: {
              type: "message_update",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "visible streaming" }],
              },
            },
          }),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust(PRIME_AGENT_LIVE_ACTIVITY_REFRESH_DELAY_MS);

        expect(Array.from(yield* Fiber.join(fiber))).toEqual([
          [{ speaker: "assistant", text: "initial" }],
          [{ speaker: "assistant", text: "committed" }],
          [
            { speaker: "assistant", text: "committed" },
            { speaker: "assistant", text: "visible streaming" },
          ],
        ]);
      }),
    ),
  );

  it.effect("projects streaming message events without refetching the native transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, emitWatch, make } = fixture({
          getWatchMessages: () => [
            { role: "assistant", content: [{ type: "text", text: "committed" }] },
          ],
        });
        const runtime = yield* make();
        const initialObserved = yield* Queue.unbounded<void>();
        const fiber = yield* runtime.watchAgentActivity("native-child-active").pipe(
          Stream.tap(() => Queue.offer(initialObserved, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Queue.take(initialObserved);
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_event",
            event: {
              type: "message_update",
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: "private reasoning" },
                  { type: "text", text: "streaming answer" },
                  { type: "toolCall", name: "bash", arguments: { secret: true } },
                ],
              },
            },
          }),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust(PRIME_AGENT_LIVE_ACTIVITY_REFRESH_DELAY_MS);

        expect(Array.from(yield* Fiber.join(fiber))).toEqual([
          [{ speaker: "assistant", text: "committed" }],
          [
            { speaker: "assistant", text: "committed" },
            { speaker: "assistant", text: "streaming answer" },
          ],
        ]);
        expect(captures.watcherMessageReads).toBe(1);
      }),
    ),
  );

  it.effect("keeps tool activity ids monotonic and correlated across replacements", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { emitWatch, make } = fixture({
          getWatchMessages: () => [
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "native-a", name: "ipython", arguments: {} }],
            },
          ],
        });
        const runtime = yield* make();
        const observed = yield* Queue.unbounded<void>();
        const fiber = yield* runtime.watchAgentActivity("native-child-active").pipe(
          Stream.tap(() => Queue.offer(observed, undefined)),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Queue.take(observed);
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_replaced",
            messages: [
              {
                role: "assistant",
                content: [{ type: "toolCall", id: "native-b", name: "ipython", arguments: {} }],
              },
            ],
          }),
        );
        yield* Queue.take(observed);
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_resynced",
            snapshot: {
              messages: [
                {
                  role: "assistant",
                  content: [
                    { type: "toolCall", id: "native-b", name: "ipython", arguments: {} },
                    { type: "toolCall", id: "native-c", name: "ipython", arguments: {} },
                  ],
                },
              ],
            },
          }),
        );

        expect(Array.from(yield* Fiber.join(fiber))).toEqual([
          [{ kind: "tool", activityId: 1, label: "IPython", status: "started" }],
          [{ kind: "tool", activityId: 2, label: "IPython", status: "started" }],
          [
            { kind: "tool", activityId: 2, label: "IPython", status: "started" },
            { kind: "tool", activityId: 3, label: "IPython", status: "started" },
          ],
        ]);
      }),
    ),
  );

  it.effect("uses authoritative replacement and resync snapshots without closing the watcher", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { emitWatch, make } = fixture({
          getWatchMessages: () => [
            { role: "assistant", content: [{ type: "text", text: "first" }] },
          ],
        });
        const runtime = yield* make();
        const observed = yield* Queue.unbounded<void>();
        const fiber = yield* runtime.watchAgentActivity("native-child-active").pipe(
          Stream.tap(() => Queue.offer(observed, undefined)),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Queue.take(observed);
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_event",
            event: {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "first" }],
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_replaced",
            state: { isStreaming: true },
            messages: [{ role: "assistant", content: [{ type: "text", text: "replacement" }] }],
          }),
        );
        yield* Queue.take(observed);
        yield* Effect.promise(() =>
          emitWatch({
            type: "session_resynced",
            snapshot: {
              messages: [{ role: "assistant", content: [{ type: "text", text: "resynced" }] }],
              streamingMessage: {
                role: "assistant",
                content: [{ type: "text", text: "still streaming" }],
              },
            },
          }),
        );

        expect(Array.from(yield* Fiber.join(fiber))).toEqual([
          [{ speaker: "assistant", text: "first" }],
          [{ speaker: "assistant", text: "replacement" }],
          [
            { speaker: "assistant", text: "resynced" },
            { speaker: "assistant", text: "still streaming" },
          ],
        ]);
      }),
    ),
  );

  it.effect("fails when a native watcher closes unexpectedly or has a malformed surface", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closedFixture = fixture();
        const runtime = yield* closedFixture.make();
        const observed = yield* Queue.unbounded<void>();
        const fiber = yield* runtime.watchAgentActivity("native-child-active").pipe(
          Stream.tap(() => Queue.offer(observed, undefined)),
          Stream.runDrain,
          Effect.flip,
          Effect.forkChild,
        );
        yield* Queue.take(observed);
        yield* Effect.promise(() => closedFixture.emitWatch({ type: "closed" }));
        expect(yield* Fiber.join(fiber)).toMatchObject({
          operation: "watch-agent-activity",
          reason: "request-failed",
        });

        const malformed = fixture({ watchSessionMalformed: true });
        const malformedRuntime = yield* malformed.make();
        expect(
          yield* malformedRuntime
            .watchAgentActivity("native-child-active")
            .pipe(Stream.runDrain, Effect.flip),
        ).toMatchObject({ operation: "watch-agent-activity", reason: "request-failed" });
      }),
    ),
  );

  it.effect("fails closed when public watchSession cannot find the live agent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { make } = fixture({ watchSessionUndefined: true });
        const runtime = yield* make();
        const failure = yield* runtime
          .watchAgentActivity("gone-child")
          .pipe(Stream.runDrain, Effect.flip);
        expect(failure.reason).toBe("request-failed");
      }),
    ),
  );

  it.effect("keeps side-question methods optional and unavailable as a pair", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { make } = fixture({ omitSideQuestions: true });
        const runtime = yield* make();
        expect(runtime.sideQuestionsAvailable).toBe(false);
        const error = yield* Effect.flip(
          runtime.askSideQuestion("11111111-1111-4111-8111-111111111111", "question"),
        );
        expect(error).toMatchObject({ operation: "side-question", reason: "incompatible-api" });
      }),
    ),
  );

  it.effect(
    "evicts stale pre-registration aborts so the latest cancellation always prevents native start",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const side = fixture();
          const runtime = yield* side.make();
          const staleIds = [
            "20000000-0000-4000-8000-000000000001",
            "20000000-0000-4000-8000-000000000002",
            "20000000-0000-4000-8000-000000000003",
            "20000000-0000-4000-8000-000000000004",
          ];
          for (const staleId of staleIds) yield* runtime.abortSideQuestion(staleId);

          const latestId = "20000000-0000-4000-8000-000000000005";
          yield* runtime.abortSideQuestion(latestId);
          expect(yield* runtime.askSideQuestion(latestId, "question")).toEqual({
            disposition: "cancelled",
          });
          expect(side.captures.sideQuestionStarts).toEqual([]);
          expect(side.captures.sideQuestionAborts).toEqual([]);
        }),
      ),
  );

  it.effect(
    "subscribes before start, filters exact ids, strips prompt/error fields, and handles terminal-before-ack",
    () => {
      let emitFromStart: (event: unknown) => Promise<void>;
      const nativeId = "11111111-1111-4111-8111-111111111111";
      const side = fixture({
        startSideQuestionImpl: async () => {
          await emitFromStart({
            type: "side_question_event",
            event: {
              id: "22222222-2222-4222-8222-222222222222",
              question: "private unrelated prompt",
              answer: "unrelated answer",
              status: "complete",
              errorMessage: "private unrelated error",
            },
          });
          await emitFromStart({
            type: "side_question_event",
            event: {
              id: nativeId,
              question: "private echoed prompt",
              answer: "partial",
              status: "running",
              errorMessage: "private running error",
            },
          });
          await emitFromStart({ type: "session_status", recap: "safe recap" });
          await emitFromStart({
            type: "side_question_event",
            event: {
              id: nativeId,
              question: "private final prompt",
              answer: "safe answer",
              status: "complete",
              errorMessage: "private terminal error",
            },
          });
          await new Promise<unknown>(() => undefined);
        },
      });
      emitFromStart = (event) => side.emit(event);
      return Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* side.make();
          const eventsFiber = yield* collectEvents(runtime, 2).pipe(Effect.forkChild);
          expect(yield* runtime.askSideQuestion(nativeId, "public question")).toEqual({
            disposition: "answered",
            answer: "safe answer",
          });
          expect(side.captures.sideQuestionStarts).toEqual([
            { nativeId, question: "public question", argumentCount: 2 },
          ]);
          const genericEvents = yield* Fiber.join(eventsFiber);
          expect(genericEvents.map((event) => event._tag)).toEqual([
            "SessionResynced",
            "SessionStatus",
          ]);
          expect(genericEvents[1]).toMatchObject({ _tag: "SessionStatus", recap: "safe recap" });
          expect(side.captures.sideQuestionAborts).toEqual([]);

          // Late terminal traffic remains private and cannot resettle the completed request.
          yield* Effect.promise(() =>
            side.emit({
              type: "side_question_event",
              event: {
                id: nativeId,
                question: "late private prompt",
                answer: "late answer",
                status: "error",
                errorMessage: "late private error",
              },
            }),
          );
          expect(side.captures.sideQuestionAborts).toEqual([]);
        }),
      );
    },
  );

  it.effect("fails side questions generically on native errors and transport invalidation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeFailure = fixture();
        const failedRuntime = yield* nativeFailure.make();
        const failedId = "66666666-6666-4666-8666-666666666666";
        const failedFiber = yield* failedRuntime
          .askSideQuestion(failedId, "question")
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Effect.promise(() =>
          nativeFailure.emit({
            type: "side_question_event",
            event: {
              id: failedId,
              question: "private prompt",
              answer: "partial",
              status: "error",
              errorMessage: "private native error",
            },
          }),
        );
        const nativeError = yield* Fiber.join(failedFiber);
        expect(nativeError.detail).toBe("The Prime Agent side question did not complete safely.");
        expect(nativeFailure.captures.sideQuestionAborts).toEqual([]);

        const malformed = fixture();
        const malformedRuntime = yield* malformed.make();
        const malformedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const malformedFiber = yield* malformedRuntime
          .askSideQuestion(malformedId, "question")
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Effect.promise(() =>
          malformed.emit({
            type: "side_question_event",
            event: {
              id: malformedId,
              question: "private prompt",
              answer: "x".repeat(16_385),
              status: "running",
              errorMessage: "private native error",
            },
          }),
        );
        expect(yield* Fiber.join(malformedFiber)).toMatchObject({
          operation: "side-question",
          reason: "request-failed",
          detail: "The Prime Agent side question did not complete safely.",
        });
        expect(malformed.captures.sideQuestionAborts).toEqual([malformedId]);

        for (const invalidation of [
          { type: "connection_status", status: "reconnecting", error: "private disconnect" },
          { type: "session_resynced", snapshot: snapshot(9) },
          { type: "session_replaced", state: snapshot().state, messages: [] },
          { type: "closed", error: "private close" },
        ] as const) {
          const side = fixture();
          const runtime = yield* side.make();
          const nativeId = "33333333-3333-4333-8333-333333333333";
          const askFiber = yield* runtime
            .askSideQuestion(nativeId, "question")
            .pipe(Effect.flip, Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Effect.promise(() => side.emit(invalidation));
          const error = yield* Fiber.join(askFiber);
          expect(error).toMatchObject({
            operation: "side-question",
            reason: "request-failed",
            detail: "The Prime Agent side question did not complete safely.",
          });
          expect(side.captures.sideQuestionAborts).toEqual([nativeId]);
        }
      }),
    ),
  );

  it.effect("bounds every answer snapshot and aborts exactly once on interruption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const side = fixture();
        const runtime = yield* side.make();
        const nativeId = "44444444-4444-4444-8444-444444444444";
        const oversizedFiber = yield* runtime
          .askSideQuestion(nativeId, "question")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Effect.promise(() =>
          side.emit({
            type: "side_question_event",
            event: {
              id: nativeId,
              question: "private",
              answer: "a".repeat(8_193),
              status: "running",
              errorMessage: "private",
            },
          }),
        );
        expect(yield* Fiber.join(oversizedFiber)).toEqual({ disposition: "response-too-large" });
        expect(side.captures.sideQuestionAborts).toEqual([nativeId]);

        const nulId = "77777777-7777-4777-8777-777777777777";
        const nulFiber = yield* runtime.askSideQuestion(nulId, "question").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Effect.promise(() =>
          side.emit({
            type: "side_question_event",
            event: {
              id: nulId,
              question: "private",
              answer: "unsafe\0answer",
              status: "running",
            },
          }),
        );
        expect(yield* Fiber.join(nulFiber)).toEqual({ disposition: "response-too-large" });
        expect(side.captures.sideQuestionAborts).toEqual([nativeId, nulId]);

        const cumulativeId = "88888888-8888-4888-8888-888888888888";
        const cumulativeFiber = yield* runtime
          .askSideQuestion(cumulativeId, "question")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const boundedSnapshot = "b".repeat(8_192);
        for (let index = 0; index < 513; index += 1) {
          yield* Effect.promise(() =>
            side.emit({
              type: "side_question_event",
              event: {
                id: cumulativeId,
                question: "private",
                answer: boundedSnapshot,
                status: "running",
              },
            }),
          );
        }
        expect(yield* Fiber.join(cumulativeFiber)).toEqual({
          disposition: "response-too-large",
        });
        expect(side.captures.sideQuestionAborts).toEqual([nativeId, nulId, cumulativeId]);

        const interruptedId = "55555555-5555-4555-8555-555555555555";
        const interrupted = yield* runtime
          .askSideQuestion(interruptedId, "question")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(interrupted);
        expect(side.captures.sideQuestionAborts).toEqual([
          nativeId,
          nulId,
          cumulativeId,
          interruptedId,
        ]);
      }),
    ),
  );

  it.effect("bounds a never-resolving best-effort abort to two seconds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const side = fixture({
          abortSideQuestionImpl: () => new Promise<unknown>(() => undefined),
        });
        const runtime = yield* side.make();
        const nativeId = "99999999-9999-4999-8999-999999999999";
        const askFiber = yield* runtime
          .askSideQuestion(nativeId, "question")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const interrupted = yield* Deferred.make<void>();
        const interruptFiber = yield* Fiber.interrupt(askFiber).pipe(
          Effect.ensuring(Deferred.succeed(interrupted, undefined)),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(interrupted)).toBe(false);
        yield* TestClock.adjust(1_999);
        expect(yield* Deferred.isDone(interrupted)).toBe(false);
        yield* TestClock.adjust(1);
        yield* Fiber.join(interruptFiber);
        expect(yield* Deferred.isDone(interrupted)).toBe(true);
        expect(side.captures.sideQuestionAborts).toEqual([nativeId]);
      }),
    ),
  );

  it.effect("settles shared disposal when its owner is interrupted after election", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scheduledTasks: Array<() => void> = [];
        let schedulerChecks = 0;
        const electionYieldScheduler: Scheduler.Scheduler = {
          executionMode: "async",
          shouldYield: () => {
            schedulerChecks += 1;
            // The first checks enter dispose and elect this fiber. Yield once
            // immediately afterward, before the returned owner onExit is installed.
            return schedulerChecks === 3;
          },
          makeDispatcher: () => ({
            scheduleTask: (task) => {
              scheduledTasks.push(task);
            },
            flush: () => {
              while (scheduledTasks.length > 0) scheduledTasks.shift()?.();
            },
          }),
        };
        const side = fixture();
        const sessionScope = yield* Scope.make("sequential");
        const runtime = yield* side.make().pipe(Scope.provide(sessionScope));
        const [reconnecting, retirementListeners] = captureNextSetConstruction(() =>
          side.emit({ type: "connection_status", status: "reconnecting" }),
        );
        yield* Effect.promise(() => reconnecting);
        let retirementCount = 0;
        retirementListeners.add(() => {
          side.captures.order.push("retire");
          retirementCount += 1;
        });
        side.captures.order.length = 0;
        const shutdownSpy = vi.mocked(Queue.shutdown);
        const shutdownQueue = shutdownSpy.getMockImplementation();
        if (shutdownQueue === undefined) throw new Error("Expected Queue.shutdown to be mocked.");
        shutdownSpy.mockClear();
        shutdownSpy.mockImplementation((queue) => {
          side.captures.order.push("queue-shutdown");
          return shutdownQueue(queue);
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            shutdownSpy.mockImplementation(shutdownQueue);
            shutdownSpy.mockClear();
          }),
        );
        let ownerFinalizers = 0;
        let cancelledWaiterFinalizers = 0;
        let sharedWaiterFinalizers = 0;

        const owner = yield* runtime.dispose.pipe(
          Effect.provideService(Scheduler.Scheduler, electionYieldScheduler),
          Effect.ensuring(
            Effect.sync(() => {
              ownerFinalizers += 1;
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        expect(schedulerChecks).toBe(3);
        expect(scheduledTasks).toHaveLength(1);

        const cancelledWaiter = yield* runtime.dispose.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              cancelledWaiterFinalizers += 1;
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(cancelledWaiter);
        expect(cancelledWaiterFinalizers).toBe(1);
        const cancelledWaiterExit = cancelledWaiter.pollUnsafe();
        expect(cancelledWaiterExit).toBeDefined();
        if (cancelledWaiterExit !== undefined) {
          expect(Exit.isFailure(cancelledWaiterExit)).toBe(true);
          if (Exit.isFailure(cancelledWaiterExit)) {
            expect(Cause.hasInterruptsOnly(cancelledWaiterExit.cause)).toBe(true);
          }
        }

        const sharedWaiter = yield* runtime.dispose.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              sharedWaiterFinalizers += 1;
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        expect(sharedWaiter.pollUnsafe()).toBeUndefined();

        const interruptOwner = yield* Fiber.interrupt(owner).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        // Election and cleanup installation remain masked while the owner is yielded.
        expect(owner.pollUnsafe()).toBeUndefined();
        expect(ownerFinalizers).toBe(0);

        yield* Effect.sync(() => {
          const resumeOwner = scheduledTasks.shift();
          if (resumeOwner === undefined)
            throw new Error("Expected the dispose owner to be queued.");
          resumeOwner();
        });
        yield* Fiber.join(interruptOwner);
        const ownerExit = yield* Fiber.await(owner);
        const sharedWaiterExit = yield* Fiber.await(sharedWaiter);
        const lateExit = yield* runtime.dispose.pipe(Effect.exit);

        expect(Exit.isFailure(ownerExit)).toBe(true);
        if (Exit.isFailure(ownerExit)) expect(Cause.hasInterruptsOnly(ownerExit.cause)).toBe(true);
        expect(sharedWaiterExit).toEqual(ownerExit);
        expect(lateExit).toEqual(ownerExit);
        const scopeCloseExit = yield* Scope.close(sessionScope, Exit.void).pipe(Effect.exit);
        expect(Exit.isFailure(scopeCloseExit)).toBe(true);
        if (Exit.isFailure(scopeCloseExit)) {
          expect(Cause.hasInterruptsOnly(scopeCloseExit.cause)).toBe(true);
        }
        expect(scheduledTasks).toHaveLength(0);
        expect(ownerFinalizers).toBe(1);
        expect(sharedWaiterFinalizers).toBe(1);
        expect(retirementCount).toBe(1);
        expect(side.captures.unsubscribeCount).toBe(1);
        expect(side.captures.disposeCount).toBe(1);
        expect(side.captures.closeCount).toBe(1);
        expect(shutdownSpy).toHaveBeenCalledTimes(2);
        expect(side.captures.order).toEqual([
          "retire",
          "unsubscribe",
          "dispose",
          "close",
          "queue-shutdown",
          "queue-shutdown",
        ]);
      }),
    ),
  );

  it.effect("shares an unsubscribe defect across explicit and scope disposal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const unsubscribeDefect = new Error("unsubscribe defect");
        let reportNativeDisposeStarted!: () => void;
        const nativeDisposeStarted = new Promise<void>((resolve) => {
          reportNativeDisposeStarted = resolve;
        });
        let releaseNativeDispose!: () => void;
        const nativeDisposeRelease = new Promise<void>((resolve) => {
          releaseNativeDispose = resolve;
        });
        const side = fixture({
          unsubscribeImpl: () => {
            throw unsubscribeDefect;
          },
          disposeImpl: () => {
            reportNativeDisposeStarted();
            return nativeDisposeRelease;
          },
        });
        const sessionScope = yield* Scope.make("sequential");
        const runtime = yield* side.make().pipe(Scope.provide(sessionScope));

        const owner = yield* runtime.dispose.pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => nativeDisposeStarted);
        const scopeClose = yield* Scope.close(sessionScope, Exit.void).pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true }),
        );
        const waiter = yield* runtime.dispose.pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;

        expect(owner.pollUnsafe()).toBeUndefined();
        expect(waiter.pollUnsafe()).toBeUndefined();
        expect(scopeClose.pollUnsafe()).toBeUndefined();
        expect(side.captures.disposeCount).toBe(1);
        expect(side.captures.closeCount).toBe(0);

        releaseNativeDispose();
        const ownerExit = yield* Fiber.join(owner);
        const waiterExit = yield* Fiber.join(waiter);
        const scopeExit = yield* Fiber.join(scopeClose);
        const lateExit = yield* runtime.dispose.pipe(Effect.exit);

        expectDefectExit(ownerExit, unsubscribeDefect);
        expect(waiterExit).toEqual(ownerExit);
        expectDefectExit(scopeExit, unsubscribeDefect);
        expect(lateExit).toEqual(ownerExit);
        expect(side.captures.disposeCount).toBe(1);
        expect(side.captures.unsubscribeCount).toBe(1);
        expect(side.captures.closeCount).toBe(1);
      }),
    ),
  );

  it.effect("shares a retirement listener defect across scope and explicit disposal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const retirementDefect = new Error("retirement listener defect");
        let reportNativeDisposeStarted!: () => void;
        const nativeDisposeStarted = new Promise<void>((resolve) => {
          reportNativeDisposeStarted = resolve;
        });
        let releaseNativeDispose!: () => void;
        const nativeDisposeRelease = new Promise<void>((resolve) => {
          releaseNativeDispose = resolve;
        });
        const side = fixture({
          disposeImpl: () => {
            reportNativeDisposeStarted();
            return nativeDisposeRelease;
          },
        });
        const sessionScope = yield* Scope.make("sequential");
        const runtime = yield* side.make().pipe(Scope.provide(sessionScope));
        // Reconnect synchronously replaces the private current-fence listener Set.
        const [reconnecting, retirementListeners] = captureNextSetConstruction(() =>
          side.emit({ type: "connection_status", status: "reconnecting" }),
        );
        yield* Effect.promise(() => reconnecting);
        retirementListeners.add(() => {
          throw retirementDefect;
        });

        const scopeClose = yield* Scope.close(sessionScope, Exit.void).pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => nativeDisposeStarted);
        const firstWaiter = yield* runtime.dispose.pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true }),
        );
        const secondWaiter = yield* runtime.dispose.pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;

        expect(scopeClose.pollUnsafe()).toBeUndefined();
        expect(firstWaiter.pollUnsafe()).toBeUndefined();
        expect(secondWaiter.pollUnsafe()).toBeUndefined();
        expect(side.captures.disposeCount).toBe(1);
        expect(side.captures.closeCount).toBe(0);

        releaseNativeDispose();
        const firstExit = yield* Fiber.join(firstWaiter);
        const secondExit = yield* Fiber.join(secondWaiter);
        const scopeExit = yield* Fiber.join(scopeClose);
        const lateExit = yield* runtime.dispose.pipe(Effect.exit);

        expectDefectExit(firstExit, retirementDefect);
        expect(secondExit).toEqual(firstExit);
        expectDefectExit(scopeExit, retirementDefect);
        expect(lateExit).toEqual(firstExit);
        expect(side.captures.disposeCount).toBe(1);
        expect(side.captures.unsubscribeCount).toBe(0);
        expect(side.captures.closeCount).toBe(1);
      }),
    ),
  );

  it.effect("makes explicit disposal await scope-owned native cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let reportDisposeStarted!: () => void;
        const disposeStarted = new Promise<void>((resolve) => {
          reportDisposeStarted = resolve;
        });
        let releaseDispose!: () => void;
        const disposeRelease = new Promise<void>((resolve) => {
          releaseDispose = resolve;
        });
        const side = fixture({
          disposeImpl: () => {
            reportDisposeStarted();
            return disposeRelease;
          },
        });
        const sessionScope = yield* Scope.make("sequential");
        const runtime = yield* side.make().pipe(Scope.provide(sessionScope));

        const scopeClose = yield* Scope.close(sessionScope, Exit.void).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => disposeStarted);
        const explicitDispose = yield* runtime.dispose.pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;

        expect(side.captures.disposeCount).toBe(1);
        expect(explicitDispose.pollUnsafe()).toBeUndefined();
        expect(side.captures.closeCount).toBe(0);

        releaseDispose();
        expect(yield* Fiber.join(explicitDispose)).toEqual(Exit.void);
        yield* Fiber.join(scopeClose);
        expect(side.captures.disposeCount).toBe(1);
        expect(side.captures.closeCount).toBe(1);
      }),
    ),
  );

  it.effect("bounds daemon session disposal during a lost connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let reportDisposeStarted: (() => void) | undefined;
        const disposeStarted = new Promise<void>((resolve) => {
          reportDisposeStarted = resolve;
        });
        const side = fixture({
          disposeImpl: () => {
            reportDisposeStarted?.();
            return new Promise<unknown>(() => undefined);
          },
        });
        const runtime = yield* side.make();
        const disposing = yield* runtime.dispose.pipe(
          Effect.flip,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => disposeStarted);
        const waiter = yield* runtime.dispose.pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* TestClock.adjust(29_999);
        expect(side.captures.closeCount).toBe(0);
        expect(waiter.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(1);
        const error = yield* Fiber.join(disposing);
        const waiterExit = yield* Fiber.join(waiter);
        const lateExit = yield* runtime.dispose.pipe(Effect.exit);

        expect(error).toMatchObject({
          operation: "dispose",
          reason: "request-timed-out",
          detail: "Timed out while disposing the daemon session.",
        });
        expect(Exit.isFailure(waiterExit)).toBe(true);
        expect(lateExit).toEqual(waiterExit);
        expect(side.captures.disposeCount).toBe(1);
        expect(side.captures.unsubscribeCount).toBe(1);
        expect(side.captures.closeCount).toBe(1);
      }),
    ),
  );

  it.effect("deduplicates explicit abort, dispose, and ask finalization", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const side = fixture();
        const runtime = yield* side.make();
        const nativeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const askFiber = yield* runtime
          .askSideQuestion(nativeId, "question")
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* runtime.abortSideQuestion(nativeId);
        yield* runtime.dispose;
        const error = yield* Fiber.join(askFiber);
        expect(error).toMatchObject({ operation: "side-question", reason: "request-failed" });
        expect(side.captures.sideQuestionAborts).toEqual([nativeId]);
      }),
    ),
  );
  it.effect("persists create authority before exposing a recoverable runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const side = fixture({
          recoveryMode: "create",
          rawSnapshot: {
            ...snapshot(),
            lastEventCursor: { generation: "events-1", sequence: 4 },
          },
        });
        const runtime = yield* side.make(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            kind: "create",
            requestId: "request-create-1",
            correlationId: "correlation-1",
            mcpOwnerId: "pylon:none:1",
            onAuthorityReady: async (authority) => {
              expect(authority.cursor).toEqual({ generation: "events-1", sequence: 4 });
              side.captures.order.push("authority-durable");
            },
          },
        );

        expect(side.captures.order.indexOf("create-recoverable")).toBeLessThan(
          side.captures.order.indexOf("authority-durable"),
        );
        expect(runtime.recoveryCorrelationId).toBe("correlation-1");
        yield* runtime.detach!;
      }),
    ),
  );

  it.effect("commits adoption before replay and defers MCP replacement to the next prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const side = fixture({
          recoveryMode: "adopt",
          rawSnapshot: {
            ...snapshot(),
            lastEventCursor: { generation: "events-1", sequence: 9 },
          },
        });
        const runtime = yield* side.make(
          PRIME_AGENT_DAEMON_RESUME_CURSOR,
          undefined,
          undefined,
          "session-1",
          {
            ownerId: "pylon:mcp-2",
            server: {
              name: "t3-code",
              type: "http",
              url: "http://127.0.0.1/mcp",
              headers: {},
            },
          },
          undefined,
          {
            kind: "adopt",
            requestId: "request-adopt-1",
            recoveryHandle: "handle-1",
            expectedSupervisorGeneration: "supervisor-1",
            activeSessionId: "active-secret-1",
            sessionId: "session-1",
            sessionFile: "/state/provider-sessions/thread-safe/session.jsonl",
            correlationId: "correlation-1",
            cursor: { generation: "events-1", sequence: 4 },
            previousMcpOwnerId: "pylon:mcp-1",
            mcpOwnerId: "pylon:mcp-2",
            recoveryConfig: { cwd: "/work/project" },
            launchEnvironment: { HOME: "/private/home" },
            onAdoptionCommitted: async () => {
              side.captures.order.push("ledger-committed");
            },
          },
        );
        const initial = yield* Stream.runHead(runtime.events);

        expect(initial._tag).toBe("Some");
        expect(side.captures.order).toEqual(
          expect.arrayContaining([
            "adopt-recoverable",
            "retain-daemon",
            "ledger-committed",
            "confirm-adoption",
          ]),
        );
        expect(side.captures.order).not.toContain("replace-mcp");
        expect(side.captures.order.indexOf("ledger-committed")).toBeLessThan(
          side.captures.order.indexOf("confirm-adoption"),
        );

        yield* runtime.prompt({ text: "next prompt after adoption" });
        expect(side.captures.order).toContain("replace-mcp");
        expect(side.captures.order.indexOf("confirm-adoption")).toBeLessThan(
          side.captures.order.indexOf("replace-mcp"),
        );
        yield* runtime.detach!;
      }),
    ),
  );

  it.effect("uses authoritative owned cleanup and releases daemon retention only after proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const side = fixture({
          recoveryMode: "create",
          rawSnapshot: {
            ...snapshot(),
            lastEventCursor: { generation: "events-1", sequence: 4 },
          },
        });
        const runtime = yield* side.make(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            kind: "create",
            requestId: "request-create-cleanup",
            correlationId: "correlation-cleanup",
            mcpOwnerId: "pylon:none:cleanup",
            onAuthorityReady: async () => undefined,
          },
        );
        yield* runtime.dispose;

        expect(side.captures.order).toContain("dispose-owned");
        expect(side.captures.order.indexOf("dispose-owned")).toBeLessThan(
          side.captures.order.indexOf("release-daemon"),
        );
        expect(side.captures.order).not.toContain("dispose");
      }),
    ),
  );
});
