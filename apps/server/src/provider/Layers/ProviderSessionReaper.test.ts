import type { ApiEvent, SessionInfo } from "@1jehuang/jcode-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_PROVIDER_RUNTIME_MODES,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderValidationError } from "../Errors.ts";
import type { JcodeInstanceManager } from "../jcode/JcodeInstanceManager.ts";
import {
  makeJcodeSdkBridge,
  type JcodeSdkClientLike,
  type JcodeSdkModule,
} from "../jcode/JcodeSdkBridge.ts";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { makeJcodeAdapter, type JcodeAdapterShape } from "./JcodeAdapter.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper.ts";

const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

const drainFibers = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
});

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

/** Every provider a binding can name in these tests. */
type ProviderName =
  | "codex"
  | "claudeAgent"
  | "cursor"
  | "grok"
  | "opencode"
  | "primeAgent"
  | "jcode";

function makeReadModel(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly session: {
      readonly threadId: ThreadId;
      readonly status: "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
      readonly providerName: ProviderName;
      readonly runtimeMode: "approval-required" | "full-access" | "auto-accept-edits";
      readonly activeTurnId: TurnId | null;
      readonly lastError: string | null;
      readonly updatedAt: string;
    } | null;
  }>,
) {
  const now = "2026-01-01T00:00:00.000Z";
  const projectId = ProjectId.make("project-provider-session-reaper");

  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        title: "Provider Reaper Project",
        workspaceRoot: "/tmp/provider-reaper-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: threads.map((thread) => ({
      id: thread.id,
      projectId,
      title: `Thread ${thread.id}`,
      modelSelection: defaultModelSelection,
      interactionMode: "default" as const,
      runtimeMode: "full-access" as const,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      latestTurn: null,
      messages: [],
      session: thread.session,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    })),
  };
}

/** The six sibling providers whose adapters a Jcode reap must never engage. */
const SIBLING_PROVIDERS = [
  "primeAgent",
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
] as const satisfies ReadonlyArray<ProviderName>;

const JCODE_INSTANCE_ID = ProviderInstanceId.make("jcode_local");
const JCODE_NATIVE_SESSION_ID = "native-session-reaper";

/**
 * The child connection an abandoned Jcode session owns.
 *
 * Its event stream stays open until `close`, exactly as a live daemon
 * connection does, so "the reaper closed the child client" is observed rather
 * than assumed: nothing else in this test can end that stream.
 */
function makeJcodeChildDouble() {
  const state = { closes: 0, detached: [] as string[] };
  let ended = false;
  const waiters: Array<() => void> = [];
  const sessionInfo = (sessionId: string, workingDir?: string): SessionInfo => ({
    session_id: sessionId,
    status: "idle",
    ...(workingDir === undefined ? {} : { working_dir: workingDir }),
  });

  const client: JcodeSdkClientLike = {
    server: "jcode-harness-api-bridge/0.1.0",
    capabilities: ["sessions", "models"],
    supports: () => true,
    createSession: async (workingDir) => sessionInfo(JCODE_NATIVE_SESSION_ID, workingDir),
    attachSession: async (sessionId) => sessionInfo(sessionId),
    detachSession: async (sessionId) => {
      state.detached.push(sessionId);
    },
    listSessions: async () => [],
    listModels: async () => ({ models: [] }),
    getRuntimeInfo: async () => {
      throw new Error("The reaper test never probes runtime info.");
    },
    setModel: async () => {},
    setReasoningEffort: async () => {},
    sendMessage: async () => {},
    cancel: async () => {},
    getHistory: async () => [],
    events: (): AsyncIterableIterator<ApiEvent> =>
      (async function* () {
        while (!ended) {
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
          });
        }
      })(),
    close: async () => {
      state.closes += 1;
      ended = true;
      for (const waiter of waiters.splice(0)) waiter();
    },
  };

  return { client, state };
}

const jcodeAdapterLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "provider-session-reaper-jcode-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeJcodeAdapterRuntime = () => ManagedRuntime.make(jcodeAdapterLayer);

describe("ProviderSessionReaper", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    ProviderSessionReaper | ProviderSessionRuntime.ProviderSessionRuntimeRepository,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  let jcodeRuntime: ReturnType<typeof makeJcodeAdapterRuntime> | null = null;
  let jcodeScope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (jcodeScope) {
      await Effect.runPromise(Scope.close(jcodeScope, Exit.void));
    }
    jcodeScope = null;
    if (jcodeRuntime) {
      await jcodeRuntime.dispose();
    }
    jcodeRuntime = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  /**
   * A real `JcodeAdapter` with one live session, over a faked SDK module.
   *
   * The adapter, its session runtime, the private sidecar write, and the child
   * connection are all production code; only the daemon is a double. That is
   * what makes the close assertion load-bearing.
   */
  async function startAbandonedJcodeSession(threadId: ThreadId): Promise<{
    readonly adapter: JcodeAdapterShape;
    readonly child: ReturnType<typeof makeJcodeChildDouble>;
    readonly connects: () => number;
  }> {
    const child = makeJcodeChildDouble();
    let connects = 0;
    const sdk: JcodeSdkModule = {
      launchInstance: async () => {
        throw new Error("The reaper test never launches a daemon.");
      },
      connect: async () => {
        connects += 1;
        return child.client;
      },
    };
    const bridge = makeJcodeSdkBridge(sdk);
    const manager: JcodeInstanceManager = {
      probe: Effect.die(new Error("The reaper test never probes the instance.")),
      connectSessionClient: bridge
        .connect({
          socketPath: "/tmp/provider-session-reaper-jcode/api.sock",
          clientName: "pylon-jcode-session/1",
        })
        .pipe(Effect.orDie),
      shutdown: Effect.void,
    };

    jcodeRuntime = makeJcodeAdapterRuntime();
    jcodeScope = await Effect.runPromise(Scope.make("sequential"));
    const adapter = await jcodeRuntime.runPromise(
      makeJcodeAdapter({
        providerInstanceId: JCODE_INSTANCE_ID,
        instanceKey: JCODE_INSTANCE_ID,
        bridge,
        manager,
      }).pipe(Scope.provide(jcodeScope)),
    );
    await jcodeRuntime.runPromise(
      adapter.startSession({ threadId, runtimeMode: "full-access", cwd: process.cwd() }),
    );
    return { adapter, child, connects: () => connects };
  }

  async function createHarness(input: {
    readonly readModel: ReturnType<typeof makeReadModel>;
    readonly stopSessionImplementation?: (input: {
      readonly threadId: ThreadId;
    }) => ReturnType<ProviderServiceShape["stopSession"]>;
  }) {
    const stoppedThreadIds = new Set<ThreadId>();
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(
      (request) =>
        (input.stopSessionImplementation
          ? input.stopSessionImplementation(request)
          : Effect.sync(() => {
              stoppedThreadIds.add(request.threadId);
            })) as ReturnType<ProviderServiceShape["stopSession"]>,
    );

    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      respondToInteraction: () => unsupported(),
      reloadSessionResources: () => unsupported(),
      askSessionSideQuestion: () => unsupported(),
      cancelSessionSideQuestion: () => unsupported(),
      cancelSessionAgent: () => unsupported(),
      messageSessionAgent: () => unsupported(),
      watchSessionAgentActivity: () => Stream.empty,
      getSessionAgentDepth: () => unsupported(),
      setSessionAgentDepth: () => unsupported(),
      followUp: () => unsupported(),
      getSessionInputQueue: () => unsupported(),
      clearSessionInputQueue: () => unsupported(),
      setSessionInputQueueMode: () => unsupported(),
      getSessionCompaction: () => unsupported(),
      compactSession: () => unsupported(),
      abortSessionCompaction: () => unsupported(),
      setSessionAutoCompaction: () => unsupported(),
      refineSessionHarness: () => unsupported(),
      stopSession,
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      getInstanceInfo: (instanceId) => {
        const driverKind = ProviderDriverKind.make(String(instanceId));
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
          supportedRuntimeModes: DEFAULT_SERVER_PROVIDER_RUNTIME_MODES,
        });
      },
      rollbackConversation: () => unsupported(),
      streamEvents: Stream.empty,
    };

    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(runtimeRepositoryLayer),
    );
    const layer = makeProviderSessionReaperLive({
      inactivityThresholdMs: 1_000,
      sweepIntervalMs: 60_000,
    }).pipe(
      Layer.provideMerge(providerSessionDirectoryLayer),
      Layer.provideMerge(runtimeRepositoryLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: input.readModel.snapshotSequence }),
          getCounts: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.die("unused"),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: (threadId) =>
            Effect.succeed(
              input.readModel.threads.find((thread) => thread.id === threadId)
                ? Option.some(input.readModel.threads.find((thread) => thread.id === threadId)!)
                : Option.none(),
            ),
          getThreadDetailById: () => Effect.die("unused"),
          getThreadDetailSnapshot: () => Effect.die("unused"),
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    return { stopSession, stoppedThreadIds };
  }

  it("reaps stale persisted sessions without active turns", async () => {
    const threadId = ThreadId.make("thread-reaper-stale");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stale",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 1);

    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ threadId });
    expect(harness.stoppedThreadIds.has(threadId)).toBe(true);
  });

  it("skips stale sessions when the thread still has an active turn", async () => {
    const threadId = ThreadId.make("thread-reaper-active-turn");
    const turnId = TurnId.make("turn-reaper-active");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-active-turn",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("does not reap sessions that are still within the inactivity threshold", async () => {
    const threadId = ThreadId.make("thread-reaper-fresh");
    const now = DateTime.formatIso(await Effect.runPromise(DateTime.now));
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-fresh",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("skips persisted sessions that are already marked stopped", async () => {
    const threadId = ThreadId.make("thread-reaper-stopped");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stopped",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("continues reaping other sessions when one stop attempt fails", async () => {
    const failedThreadId = ThreadId.make("thread-reaper-stop-failure");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-success");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: failedThreadId,
          session: {
            threadId: failedThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      stopSessionImplementation: (request) =>
        request.threadId === failedThreadId
          ? Effect.fail(
              new ProviderValidationError({
                operation: "ProviderSessionReaper.test",
                issue: "simulated stop failure",
              }),
            )
          : Effect.void,
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId: failedThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-failure",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-success",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      failedThreadId,
      reapedThreadId,
    ]);
  });

  it("continues reaping other sessions when one stop attempt defects", async () => {
    const defectThreadId = ThreadId.make("thread-reaper-stop-defect");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-after-defect");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: defectThreadId,
          session: {
            threadId: defectThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      stopSessionImplementation: (request) =>
        request.threadId === defectThreadId
          ? Effect.die(new Error("simulated stop defect"))
          : Effect.void,
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId: defectThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-defect",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-after-defect",
        },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(() => harness.stopSession.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      defectThreadId,
      reapedThreadId,
    ]);
  });

  it("closes an abandoned Jcode child client and engages no sibling provider adapter", async () => {
    const jcodeThreadId = ThreadId.make("thread-reaper-jcode-abandoned");
    const stale = "2026-01-01T00:00:00.000Z";
    const fresh = DateTime.formatIso(await Effect.runPromise(DateTime.now));
    const jcode = await startAbandonedJcodeSession(jcodeThreadId);
    expect(jcode.connects()).toBe(1);
    expect(jcode.child.state.closes).toBe(0);

    // One recording adapter per sibling provider. Each owns a *fresh* binding,
    // so the reaper has a reason to look at it and no reason to stop it.
    const siblings = SIBLING_PROVIDERS.map((provider) => ({
      provider,
      threadId: ThreadId.make(`thread-reaper-${provider}-fresh`),
      stops: [] as ThreadId[],
    }));

    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: jcodeThreadId,
          session: {
            threadId: jcodeThreadId,
            status: "ready",
            providerName: "jcode",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: stale,
          },
        },
        ...siblings.map((sibling) => ({
          id: sibling.threadId,
          session: {
            threadId: sibling.threadId,
            status: "ready" as const,
            providerName: sibling.provider,
            runtimeMode: "full-access" as const,
            activeTurnId: null,
            lastError: null,
            updatedAt: fresh,
          },
        })),
      ]),
      // Stands in for `ProviderService`'s routing only: each thread reaches the
      // adapter that owns it, and the Jcode thread reaches the real one.
      stopSessionImplementation: (request) => {
        if (request.threadId === jcodeThreadId) {
          return jcode.adapter.stopSession(request.threadId).pipe(Effect.orDie);
        }
        const sibling = siblings.find((candidate) => candidate.threadId === request.threadId);
        return Effect.sync(() => {
          sibling?.stops.push(request.threadId);
        });
      },
    });

    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: jcodeThreadId,
        providerName: "jcode",
        providerInstanceId: JCODE_INSTANCE_ID,
        adapterKey: "jcode",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: { opaque: "resume-jcode-abandoned" },
        runtimePayload: null,
      }),
    );
    for (const sibling of siblings) {
      await runtime!.runPromise(
        repository.upsert({
          threadId: sibling.threadId,
          providerName: sibling.provider,
          providerInstanceId: null,
          adapterKey: sibling.provider,
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: fresh,
          resumeCursor: { opaque: `resume-${sibling.provider}` },
          runtimePayload: null,
        }),
      );
    }

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    // The child client's `close` is the receipt this test waits on, not a sleep.
    await waitFor(() => jcode.child.state.closes === 1);
    await Effect.runPromise(drainFibers);

    // The abandoned native connection is gone and the thread is startable again.
    expect(jcode.child.state.closes).toBe(1);
    // Closing the connection *is* the teardown: a child client owns exactly one
    // session under protocol v1, so no separate detach is issued (only the
    // instance manager's shared control client detaches its probe session).
    expect(jcode.child.state.detached).toEqual([]);
    expect(await jcodeRuntime!.runPromise(jcode.adapter.hasSession(jcodeThreadId))).toBe(false);
    expect(await jcodeRuntime!.runPromise(jcode.adapter.listSessions())).toEqual([]);
    // No second connection was opened to replace it.
    expect(jcode.connects()).toBe(1);

    // Exactly one thread was reaped, and it was the Jcode one. No sibling
    // adapter was engaged, and every sibling binding survives.
    expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      jcodeThreadId,
    ]);
    expect(siblings.flatMap((sibling) => sibling.stops)).toEqual([]);
    for (const sibling of siblings) {
      const remaining = await runtime!.runPromise(
        repository.getByThreadId({ threadId: sibling.threadId }),
      );
      expect(Option.isSome(remaining)).toBe(true);
    }
  });
});
