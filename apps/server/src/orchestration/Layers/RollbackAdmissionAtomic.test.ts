// @effect-diagnostics preferSchemaOverJson:off
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { RollbackSagaRepositoryLive } from "../../persistence/Layers/RollbackSagas.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RollbackSagaRepository } from "../../persistence/Services/RollbackSagas.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { RollbackAdmission } from "../../rollback/RollbackAdmission.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const now = "2026-08-31T00:00:00.000Z";
const threadId = ThreadId.make("thread-atomic-rollback");
const siblingThreadId = ThreadId.make("thread-atomic-sibling");
const projectId = ProjectId.make("project-atomic-rollback");
const providerInstanceId = ProviderInstanceId.make("fake-absolute");
const sessionIncarnationId = RuntimeSessionId.make("session-atomic-rollback");
const operationId = "operation-atomic-rollback";
const privateCanary = "PRIVATE_ATOMIC_TARGET_CANARY";

const admission = Layer.succeed(RollbackAdmission, {
  prepare: ({ requestEventId }) =>
    Effect.succeed(
      Option.some({
        operationId,
        requestEventId,
        threadId,
        projectId,
        workspaceKey: "workspace-atomic",
        workspaceCwd: "/workspace/atomic",
        sourceRevision: 2,
        targetRevision: 1,
        sourceCheckpointRef: checkpointRefForThreadTurn(threadId, 2),
        sourceCheckpointOid: "2".repeat(40),
        targetCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        targetCheckpointOid: "1".repeat(40),
        targetCheckpointDigest: "target-tree",
        providerInstanceId,
        sessionIncarnationId,
        phase: "source-anchor-capture-started" as const,
        attempt: 0,
        lastErrorCode: null,
        compensation: "none" as const,
        cleanup: "pending" as const,
        sourceAnchor: null,
        sourceAnchorDigest: null,
        desiredAnchor: { leafId: privateCanary },
        desiredAnchorDigest: "target-anchor",
        preimage: null,
        workspaceReceiptDigest: null,
        providerReceiptDigest: null,
        projectionCommitSequence: null,
        createdAt: now,
        updatedAt: now,
      }),
    ),
});

const engine = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provideMerge(admission),
  Layer.provideMerge(RollbackSagaRepositoryLive),
);
const app = Layer.mergeAll(
  engine,
  OrchestrationProjectionSnapshotQueryLive,
  RollbackSagaRepositoryLive,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-rollback-atomic-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const layer = it.layer(app);
layer("durable rollback admission", (it) => {
  it.effect(
    "atomically admits private state, publishes pending, and fences concurrent mutations",
    () =>
      Effect.gen(function* () {
        const orchestration = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const repository = yield* RollbackSagaRepository;
        yield* orchestration.dispatch({
          type: "project.create",
          commandId: CommandId.make("command-atomic-project"),
          projectId,
          title: "Atomic rollback",
          workspaceRoot: "/workspace/atomic",
          defaultModelSelection: { instanceId: providerInstanceId, model: "fake" },
          createdAt: now,
        });
        for (const [id, title] of [
          [threadId, "Atomic rollback"],
          [siblingThreadId, "Atomic rollback sibling"],
        ] as const) {
          yield* orchestration.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`command-create-${id}`),
            threadId: id,
            projectId,
            title,
            modelSelection: { instanceId: providerInstanceId, model: "fake" },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          });
        }

        yield* orchestration.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("command-atomic-revert"),
          threadId,
          turnCount: 1,
          expectedSourceRevision: 2,
          createdAt: now,
        });

        const fencedCommands = [
          orchestration.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("command-fenced-send"),
            threadId,
            message: {
              messageId: MessageId.make("message-fenced-send"),
              role: "user",
              text: "must not start",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: now,
          }),
          orchestration.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("command-fenced-sibling-send"),
            threadId: siblingThreadId,
            message: {
              messageId: MessageId.make("message-fenced-sibling-send"),
              role: "user",
              text: "must not mutate shared workspace",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: now,
          }),
          orchestration.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make("command-fenced-stop"),
            threadId,
            createdAt: now,
          }),
          orchestration.dispatch({
            type: "thread.checkpoint.revert",
            commandId: CommandId.make("command-fenced-second-revert"),
            threadId,
            turnCount: 0,
            expectedSourceRevision: 2,
            createdAt: now,
          }),
          orchestration.dispatch({
            type: "project.meta.update",
            commandId: CommandId.make("command-fenced-project"),
            projectId,
            title: "must not change",
          }),
        ];
        for (const [index, command] of fencedCommands.entries()) {
          const result = yield* command.pipe(Effect.result);
          assert.equal(result._tag, "Failure", `fenced command index ${index}`);
        }

        assert.isTrue(Option.isSome(yield* repository.get(operationId)));
        const snapshot = yield* snapshots.getSnapshot();
        const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
        assert.deepEqual(thread?.rollbackStatus, { state: "pending", updatedAt: now });
        const shell = yield* snapshots.getShellSnapshot();
        assert.deepEqual(
          shell.threads.find((candidate) => candidate.id === threadId)?.rollbackStatus,
          { state: "pending", updatedAt: now },
        );

        const events = yield* Stream.runCollect(orchestration.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        assert.deepEqual(
          events.slice(0, 5).map((event) => event.type),
          [
            "project.created",
            "thread.created",
            "thread.created",
            "thread.checkpoint-revert-requested",
            "thread.rollback-status-updated",
          ],
        );
        assert.notInclude(JSON.stringify(events), privateCanary);
        assert.notInclude(JSON.stringify(snapshot), privateCanary);
      }),
  );
});
