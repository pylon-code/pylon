import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

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
  readonly createResponse?: unknown;
  readonly duringSnapshot?: ReadonlyArray<unknown>;
  readonly afterSnapshotEvent?: unknown;
  readonly attachFailure?: boolean;
  readonly resourceSnapshot?: unknown;
  readonly commands?: unknown;
  readonly rlmDepth?: number;
  readonly sessionStats?: unknown;
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
      return options?.rawSnapshot ?? snapshot();
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
      return Promise.resolve(undefined);
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
      return Promise.resolve({ maxDepth: options?.rlmDepth ?? 0, source: "chat" });
    }
    setRlmMaxDepth(maxDepth: number): Promise<unknown> {
      captures.connectionCalls.push({ method: "setRlmMaxDepth", args: [maxDepth] });
      return Promise.resolve({ maxDepth, source: "chat", globalSaved: false });
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
