import { describe, expect, it } from "@effect/vitest";
import {
  PROVIDER_AGENT_CONTROL_ID_MAX_CHARS,
  PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS,
} from "@t3tools/contracts";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

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

function snapshot(sequence = 4) {
  return {
    state: {
      activeSessionId: "active-1",
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
  readonly duringSnapshot?: ReadonlyArray<unknown>;
  readonly duringResourceSnapshot?: ReadonlyArray<unknown>;
  readonly afterSnapshotEvent?: unknown;
  readonly attachFailure?: boolean;
  readonly omitMcpSupport?: boolean;
  readonly mcpSupported?: boolean;
  readonly replaceMcpImpl?: () => Promise<unknown>;
  readonly releaseMcpImpl?: () => Promise<unknown>;
  readonly resourceSnapshot?: unknown;
  readonly commands?: unknown;
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
  readonly resumeQueueResponses?: ReadonlyArray<unknown>;
  readonly listedActiveSessionId?: string;
  readonly waitForHeadlessCompletionImpl?: (options: {
    readonly waitForRlmQuiescence?: boolean;
  }) => Promise<unknown>;
  readonly omitRlmQuiescence?: boolean;
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

  class FakeClient implements PrimeAgentDaemonClient {
    isConnected = true;
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
        return Promise.resolve({
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
        });
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
      return Promise.resolve(
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
    supportsServerCapability(capability: "queue_message_mutation"): boolean {
      expect(capability).toBe("queue_message_mutation");
      return options?.queueMutationCapability ?? true;
    }
    enableAutoReconnect(reconnectOptions: { readonly recoverDaemon: () => Promise<void> }): void {
      captures.reconnectOptions.push(reconnectOptions);
    }
    close(): void {
      this.isConnected = false;
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
        captures.unsubscribeCount += 1;
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
    async getResourceSnapshot(): Promise<unknown> {
      captures.connectionCalls.push({ method: "getResourceSnapshot", args: [] });
      for (const event of options?.duringResourceSnapshot ?? []) await listener?.(event);
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
    dispose(): Promise<unknown> {
      captures.order.push("dispose");
      captures.disposeCount += 1;
      return Promise.resolve(undefined);
    }
  }

  const bridge: PrimeAgentDaemonBridge = {
    packageRoot: "/fake/prime-agent",
    moduleEntryPath: "/fake/prime-agent/dist/index.js",
    version: "0.7.1",
    protocolName: "prime-agent.daemon",
    protocolVersion: 7,
    DaemonClient: FakeClient,
    DaemonAgentConnection: FakeConnection,
    defaultDaemonSocketPath: () => "/tmp/prime-agent.sock",
  };
  const manager: PrimeAgentDaemonManager = {
    bridge,
    socket: "/tmp/pylon-prime.sock",
    sessionDir: "/state/shared-daemon-sessions",
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
  ) =>
    makePrimeAgentDaemonSessionRuntime({
      manager,
      cwd: "/work/project",
      sessionDir: "/state/provider-sessions/thread-safe",
      agentDir: "/state/prime-agent-home",
      model: "openai/gpt-5.3-codex",
      thinkingLevel: "high",
      ...(extensions === undefined ? {} : { extensions }),
      ...(requiredExtension === undefined
        ? {}
        : { disableExtensionDiscovery: true, disableAutoReconnect: true, requiredExtension }),
      ...(resumeCursor === undefined ? {} : { resumeCursor }),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      ...(mcpServer === undefined ? {} : { mcpServer }),
    });
  const emit = (event: unknown) => Promise.resolve(listener?.(event));
  const emitWatch = (event: unknown) => Promise.resolve(watcherListener?.(event));
  return { captures, emit, emitWatch, make };
}

function collectEvents(runtime: PrimeAgentDaemonSessionRuntime, count: number) {
  return runtime.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((events) => Array.from(events)),
  );
}

describe("PrimeAgentDaemonSessionRuntime", () => {
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
          { method: "getRlmMaxDepthStatus", args: [] },
        ]);
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

  it.effect("backpressures a noisy daemon and preserves terminal event order exactly once", () =>
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
        const terminalOfferFiber = yield* Effect.forEach(terminalEvents, (event) =>
          Effect.promise(() => emit(event)),
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
        yield* runtime.waitForRlmQuiescence(token);
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
          .waitForRlmQuiescence("turn-1:1")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => firstStarted);
        const second = yield* runtime
          .waitForRlmQuiescence("turn-1:2")
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
          .waitForRlmQuiescence(token)
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
        yield* runtime.waitForRlmQuiescence(token);
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
        yield* runtime.waitForRlmQuiescence(token);

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
        const { make } = fixture({
          waitForHeadlessCompletionImpl: () =>
            Promise.reject(new Error("private daemon failure at /secret/path")),
        });
        const runtime = yield* make();

        yield* runtime.prompt({ text: "wait safely", rlmQuiescenceToken: "turn-1:1" });
        const error = yield* runtime.waitForRlmQuiescence("turn-1:1").pipe(Effect.flip);

        expect(error).toMatchObject({
          operation: "rlm-quiescence",
          reason: "request-failed",
          detail: "Prime Agent could not confirm descendant quiescence.",
        });
        expect(error.detail).not.toContain("/secret/path");
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
        yield* runtime.waitForRlmQuiescence("turn-typed:1");
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
});
