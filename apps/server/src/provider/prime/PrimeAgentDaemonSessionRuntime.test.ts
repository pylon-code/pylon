import { describe, expect, it } from "@effect/vitest";
import { PROVIDER_AGENT_CONTROL_ID_MAX_CHARS } from "@t3tools/contracts";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  type PrimeAgentDaemonAgentConnection,
  type PrimeAgentDaemonBridge,
  type PrimeAgentDaemonClient,
  type PrimeAgentDaemonExtensionUiResponse,
  type PrimeAgentDaemonImage,
  type PrimeAgentDaemonPromptOptions,
  type PrimeAgentDaemonServiceTier,
  type PrimeAgentDaemonThinkingLevel,
} from "./PrimeAgentDaemonBridge.ts";
import type { PrimeAgentDaemonManager } from "./PrimeAgentDaemonManager.ts";
import {
  makePrimeAgentDaemonSessionRuntime,
  PRIME_AGENT_DAEMON_RESUME_CURSOR,
  type PrimeAgentDaemonSessionRuntime,
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
}

function fixture(options?: {
  readonly rawSnapshot?: unknown;
  readonly rawSnapshotImpl?: () => unknown;
  readonly createResponse?: unknown;
  readonly duringSnapshot?: ReadonlyArray<unknown>;
  readonly afterSnapshotEvent?: unknown;
  readonly attachFailure?: boolean;
  readonly resourceSnapshot?: unknown;
  readonly commands?: unknown;
  readonly reloadImpl?: () => Promise<unknown>;
  readonly rlmDepth?: number;
  readonly rlmStatus?: unknown;
  readonly setRlmImpl?: (maxDepth: number) => Promise<unknown>;
  readonly cancelRlmImpl?: (agentId: string) => Promise<unknown>;
  readonly sessionStats?: unknown;
  readonly getQueueImpl?: () => Promise<unknown>;
  readonly clearQueueImpl?: () => Promise<unknown>;
  readonly getStateImpl?: () => Promise<unknown>;
  readonly setSteeringModeImpl?: (mode: "all" | "one-at-a-time") => Promise<unknown>;
  readonly setFollowUpModeImpl?: (mode: "all" | "one-at-a-time") => Promise<unknown>;
  readonly compactImpl?: () => Promise<unknown>;
  readonly abortCompactionImpl?: () => Promise<unknown>;
  readonly setAutoCompactionImpl?: (enabled: boolean) => Promise<unknown>;
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
  };
  let listener: ((event: unknown) => void | Promise<void>) | undefined;

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
    enableAutoReconnect(reconnectOptions: { readonly recoverDaemon: () => Promise<void> }): void {
      captures.reconnectOptions.push(reconnectOptions);
    }
    close(): void {
      this.isConnected = false;
      captures.closeCount += 1;
    }
  }

  class FakeConnection implements PrimeAgentDaemonAgentConnection {
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
      return Promise.resolve(undefined);
    }
    steer(message: string, images?: ReadonlyArray<PrimeAgentDaemonImage>): Promise<unknown> {
      captures.connectionCalls.push({ method: "steer", args: [message, images] });
      return Promise.resolve(undefined);
    }
    followUp(message: string, images?: ReadonlyArray<PrimeAgentDaemonImage>): Promise<unknown> {
      captures.connectionCalls.push({ method: "followUp", args: [message, images] });
      return Promise.resolve(undefined);
    }
    abort(): Promise<unknown> {
      captures.connectionCalls.push({ method: "abort", args: [] });
      return Promise.resolve(undefined);
    }
    abortAndClearQueue(): Promise<unknown> {
      captures.connectionCalls.push({ method: "abortAndClearQueue", args: [] });
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
    getResourceSnapshot(): Promise<unknown> {
      captures.connectionCalls.push({ method: "getResourceSnapshot", args: [] });
      return Promise.resolve(
        options?.resourceSnapshot ?? {
          extensions: [{ path: "/state/pylon/permission.mjs" }],
          diagnostics: { extensions: [] },
        },
      );
    }
    reload(): Promise<unknown> {
      captures.connectionCalls.push({ method: "reload", args: [] });
      return options?.reloadImpl?.() ?? Promise.resolve(undefined);
    }
    getSessionStats(): Promise<unknown> {
      captures.connectionCalls.push({ method: "getSessionStats", args: [] });
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
    setRlmMaxDepth(maxDepth: number): Promise<unknown> {
      captures.connectionCalls.push({ method: "setRlmMaxDepth", args: [maxDepth] });
      return (
        options?.setRlmImpl?.(maxDepth) ??
        Promise.resolve({ maxDepth, source: "chat", globalSaved: false })
      );
    }
    dispose(): Promise<unknown> {
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
  const client = new FakeClient();
  const manager: PrimeAgentDaemonManager = {
    bridge,
    socket: "/tmp/pylon-prime.sock",
    sessionDir: "/state/shared-daemon-sessions",
    openClient: () =>
      Effect.sync(() => {
        captures.openCount += 1;
        return client;
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
    });
  return { captures, make };
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

  it.effect("bounds native agent cancellation and roster reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let snapshotReads = 0;
        const never = () => new Promise<unknown>(() => undefined);
        const { make } = fixture({
          rawSnapshotImpl: () => {
            snapshotReads += 1;
            return snapshotReads === 1 ? snapshot() : never();
          },
          cancelRlmImpl: never,
        });
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

        const rosterFiber = yield* runtime.getAgentRoster.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("30 seconds");
        const rosterError = yield* Fiber.join(rosterFiber).pipe(Effect.flip);
        expect(rosterError).toMatchObject({
          operation: "get-agent-roster",
          reason: "request-failed",
          detail: expect.stringContaining("Timed out"),
        });
      }).pipe(Effect.provide(TestClock.layer())),
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

  it.effect("exposes typed operations and strips native model payloads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { captures, make } = fixture();
        const runtime = yield* make();
        const images = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] as const;
        const signal = new AbortController().signal;
        yield* runtime.prompt({ text: "prompt", images, signal });
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
          contextUsage: { usedTokens: 320, maxTokens: 200_000 },
        });
        expect(stats).not.toHaveProperty("sessionFile");
        expect(stats).not.toHaveProperty("sessionId");
        expect(stats).not.toHaveProperty("cost");
        expect(captures.connectionCalls).toEqual(
          [
            ["getResourceSnapshot", []],
            ["getCommands", []],
            ["getRlmMaxDepthStatus", []],
            ["prompt", ["prompt", { queueIfBusy: false, images, signal }]],
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
