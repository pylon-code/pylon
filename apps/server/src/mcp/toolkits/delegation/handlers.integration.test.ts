// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  EnvironmentId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { ServerConfig } from "../../../config.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../../../orchestration/Services/ThreadDeletionReactor.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DelegationToolkitHandlersLive } from "./handlers.ts";
import { DelegationToolkit } from "./tools.ts";

const NOW = "2026-09-15T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("delegation-project");
const PARENT_ID = ThreadId.make("delegation-parent");
const ANTIGRAVITY = ProviderInstanceId.make("antigravity");
const childIdFor = (key: string) =>
  ThreadId.make(
    `delegated:${PARENT_ID}:${NodeCrypto.createHash("sha256")
      .update(`${PARENT_ID}\n${key}`)
      .digest("hex")
      .slice(0, 16)}`,
  );

const antigravity: ServerProvider = {
  instanceId: ANTIGRAVITY,
  driver: ProviderDriverKind.make("antigravity"),
  enabled: true,
  installed: true,
  version: "1.1.1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [
    {
      slug: "gemini-3-pro",
      name: "Gemini 3 Pro",
      isCustom: false,
      capabilities: null,
      isDefault: true,
    },
  ],
  slashCommands: [],
  skills: [],
};

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: PARENT_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("prime-agent"),
  capabilities: new Set(["delegation"]),
  issuedAt: 1,
};

/** The real engine, projections, and receipt store over in-memory SQLite. */
const orchestrationLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-delegation-integration-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const fakesLayer = (options: { readonly failCreateWorktree: boolean }) =>
  Layer.mergeAll(
    Layer.mock(ThreadDeletionReactor)({ drainThrough: () => Effect.void }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([antigravity]) }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      localStatus: () =>
        Effect.succeed({
          isRepo: true,
          hasPrimaryRemote: false,
          isDefaultRef: true,
          refName: "main",
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
        }),
      remoteExists: () => Effect.succeed(false),
      createWorktree: (input) =>
        options.failCreateWorktree
          ? Effect.fail(
              new GitCommandError({
                operation: "createWorktree",
                command: "git",
                cwd: input.cwd,
                detail: "worktree path already exists",
              }),
            )
          : Effect.succeed({
              worktree: {
                path: `/wt/delegation/${(input.newRefName ?? "none").replace("/", "-")}`,
                refName: input.newRefName ?? "none",
              },
            }),
      removeWorktree: () => Effect.void,
    }),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      refreshStatus: () =>
        Effect.succeed({
          isRepo: true,
          hasPrimaryRemote: false,
          isDefaultRef: false,
          refName: null,
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          pr: null,
        }),
    }),
    ServerSettings.layerTest({ enableAgentDelegation: true, newWorktreesStartFromOrigin: false }),
  );

/** The toolkit handlers over fakes and the real engine, built once per test. */
const systemLayer = (options: { readonly failCreateWorktree: boolean }) =>
  DelegationToolkitHandlersLive.pipe(
    Layer.provideMerge(fakesLayer(options)),
    Layer.provideMerge(orchestrationLayer),
  );

/** Seeds a project and a parent thread, and returns a tool caller bound to the parent. */
const setup = Effect.gen(function* () {
  const workspaceRoot = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-delegation-"))),
    (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
  );
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("delegation-project"),
    projectId: PROJECT_ID,
    title: "Delegation",
    workspaceRoot,
    createdAt: NOW,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("delegation-parent"),
    threadId: PARENT_ID,
    projectId: PROJECT_ID,
    title: "Parent",
    modelSelection: { instanceId: ProviderInstanceId.make("prime-agent"), model: "default" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    createdAt: NOW,
  });
  const toolkit = yield* DelegationToolkit;
  const call = <Name extends keyof typeof DelegationToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof DelegationToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );
  return { call, engine, snapshots };
});

const delegateInput = {
  delegationKey: "review",
  task: "Review the authentication flow",
  providerInstanceId: ANTIGRAVITY,
};

describe("delegation against the real orchestration engine", () => {
  it.effect("creates the child and its first turn, and absorbs a replayed key", () =>
    Effect.gen(function* () {
      const { call, engine, snapshots } = yield* setup;
      const childId = childIdFor("review");
      const first = yield* call("delegate_thread", delegateInput);
      expect(first).toMatchObject({
        created: true,
        threadId: childId,
        model: "gemini-3-pro",
        branch: expect.stringMatching(/^t3code\/[0-9a-f]{8}$/),
      });
      expect(first.worktreePath).toBe(`/wt/delegation/${first.branch?.replace("/", "-")}`);

      const shell = yield* snapshots.getThreadShellById(childId);
      expect(Option.getOrNull(shell)).toMatchObject({
        projectId: PROJECT_ID,
        title: "Review the authentication flow",
        modelSelection: { instanceId: ANTIGRAVITY, model: "gemini-3-pro" },
        runtimeMode: "full-access",
        branch: first.branch,
        worktreePath: first.worktreePath,
      });
      const initialMessage = yield* snapshots.getTurnStartMessage({
        threadId: childId,
        messageId: MessageId.make(`delegated-message:${childId}:initial`),
      });
      expect(Option.getOrNull(initialMessage)?.message.text).toBe("Review the authentication flow");

      const replay = yield* call("delegate_thread", delegateInput);
      expect(replay).toMatchObject({ created: false, threadId: childId });
      const events = yield* engine
        .readThreadEvents({
          threadId: childId,
          fromSequenceExclusive: 0,
          toSequenceInclusive: yield* engine.latestSequence,
        })
        .pipe(Stream.runCollect);
      expect([...events].filter((event) => event.type === "thread.created")).toHaveLength(1);

      const status = yield* call("delegated_thread_status", { delegationKey: "review" });
      expect(status.threadId).toBe(childId);
    }).pipe(Effect.scoped, Effect.provide(systemLayer({ failCreateWorktree: false }))),
  );

  it.effect("consumes the key for good after a failed attempt is cleaned up", () =>
    Effect.gen(function* () {
      const { call, snapshots } = yield* setup;
      const childId = childIdFor("review");
      const failed = yield* call("delegate_thread", delegateInput).pipe(Effect.flip);
      expect(failed._tag).toBe("DelegationWorktreeError");
      expect(Option.isNone(yield* snapshots.getThreadShellById(childId))).toBe(true);

      const retry = yield* call("delegate_thread", delegateInput).pipe(Effect.flip);
      expect(retry).toMatchObject({ _tag: "DelegationKeyConsumedError", delegationKey: "review" });
      expect(Option.isNone(yield* snapshots.getThreadShellById(childId))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(systemLayer({ failCreateWorktree: true }))),
  );
});
