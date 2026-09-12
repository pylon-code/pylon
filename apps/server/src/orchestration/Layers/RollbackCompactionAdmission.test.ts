import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { RollbackSagaRepositoryLive } from "../../persistence/Layers/RollbackSagas.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RollbackSagaRepository } from "../../persistence/Services/RollbackSagas.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as RollbackAdmission from "../../rollback/RollbackAdmission.ts";
import { RollbackWorkspace } from "../../rollback/RollbackWorkspace.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const now = "2026-09-12T00:00:00.000Z";
const threadId = ThreadId.make("thread-rollback-compaction");
const projectId = ProjectId.make("project-rollback-compaction");
const providerInstanceId = ProviderInstanceId.make("fake-absolute");
const sessionIncarnationId = RuntimeSessionId.make("session-rollback-compaction");
const modelSelection = { instanceId: providerInstanceId, model: "fake-model" };
const workspaceCwd = "/workspace/rollback-compaction";
const compactionRequestId = CommandId.make("compact");

const admission = RollbackAdmission.layer.pipe(
  Layer.provide(
    Layer.succeed(ProviderService, {
      getCapabilities: () => Effect.succeed({ conversationRollback: "absolute" }),
      hasAbsoluteConversationRollback: () => Effect.succeed(true),
      captureConversationAnchor: () => Effect.succeed({ anchor: {}, digest: "source" }),
      inspectConversationAnchor: () => Effect.succeed({ anchor: {}, digest: "source" }),
      applyConversationAnchor: () => Effect.void,
      releaseConversationAnchor: () => Effect.void,
      getSessionInputQueue: () =>
        Effect.succeed({
          steeringCount: 0,
          followUpCount: 0,
          mode: "steer",
          steering: [],
          followUps: [],
        }),
      listSessions: () =>
        Effect.succeed([
          {
            threadId,
            provider: "fake",
            providerInstanceId,
            sessionIncarnationId,
            cwd: workspaceCwd,
            status: "ready",
            createdAt: now,
            updatedAt: now,
          },
        ]),
    } as never),
  ),
  Layer.provide(
    Layer.succeed(RollbackWorkspace, {
      resolveIdentity: () =>
        Effect.succeed({
          cwd: workspaceCwd,
          workspaceKey: "workspace-rollback-compaction",
          gitCommonDir: "/git/common",
        }),
      resolveCheckpoint: ({ checkpointRef }: { readonly checkpointRef: string }) =>
        Effect.succeed({
          oid:
            checkpointRef === checkpointRefForThreadTurn(threadId, 1)
              ? "1".repeat(40)
              : "2".repeat(40),
          digest: "checkpoint-tree",
        }),
    } as never),
  ),
);
const engine = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(admission),
  Layer.provideMerge(RollbackSagaRepositoryLive),
);
const app = Layer.mergeAll(engine, OrchestrationProjectionSnapshotQueryLive).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-rollback-compaction-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

for (const commandType of ["thread.checkpoint.revert", "thread.conversation.revert"] as const) {
  it.layer(app)(`compaction and ${commandType}`, (it) => {
    it.effect("rejects rewind before leasing and leaves the draining FIFO able to resume", () =>
      Effect.gen(function* () {
        const orchestration = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const repository = yield* RollbackSagaRepository;
        yield* orchestration.dispatch({
          type: "project.create",
          commandId: CommandId.make("create-project"),
          projectId,
          title: "Compaction rollback",
          workspaceRoot: workspaceCwd,
          defaultModelSelection: modelSelection,
          createdAt: now,
        });
        yield* orchestration.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-thread"),
          threadId,
          projectId,
          title: "Compaction rollback",
          modelSelection,
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        });
        for (const revision of [1, 2]) {
          yield* orchestration.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.make(`checkpoint-${revision}`),
            threadId,
            turnId: TurnId.make(`turn-${revision}`),
            completedAt: now,
            checkpointRef: checkpointRefForThreadTurn(threadId, revision),
            checkpointTurnCount: revision,
            status: "ready",
            files: [],
            createdAt: now,
          });
        }
        yield* repository.putCheckpointAnchor({
          threadId,
          checkpointTurnCount: 1,
          turnId: TurnId.make("turn-1"),
          sourceRevision: 1,
          providerInstanceId,
          sessionIncarnationId,
          checkpointRef: checkpointRefForThreadTurn(threadId, 1),
          checkpointOid: "1".repeat(40),
          anchor: { leafId: "target" },
          anchorDigest: "target-anchor",
          capturedAt: now,
        });
        yield* orchestration.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("ready-session"),
          threadId,
          session: {
            threadId,
            providerName: "fake",
            providerInstanceId,
            sessionIncarnationId,
            status: "ready",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });
        for (const [id, text] of [
          [compactionRequestId, "/compact"],
          [CommandId.make("first"), "first queued prompt"],
          [CommandId.make("second"), "second queued prompt"],
        ] as const) {
          yield* orchestration.dispatch({
            type: "thread.turn.start",
            commandId: id,
            threadId,
            message: { messageId: MessageId.make(id), role: "user", text, attachments: [] },
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            sourceEpoch: 0,
            createdAt: now,
          });
        }
        yield* orchestration.dispatch({
          type: "thread.compaction.complete",
          commandId: CommandId.make("complete-compaction"),
          threadId,
          requestId: compactionRequestId,
          success: true,
          expectedProviderInstanceId: providerInstanceId,
          expectedSessionIncarnationId: sessionIncarnationId,
          createdAt: now,
        });

        // The provider is ready and its native queue is empty, but the reactor
        // has not yet resumed the durable prompts accepted during compaction.
        const before = yield* snapshots.getSnapshot();
        const session = before.threads[0]?.session;
        assert.equal(session?.status, "ready");
        assert.isUndefined(session?.pendingTurnRequestId);
        assert.equal(session?.compactionQueue?.phase, "draining");
        assert.equal(session?.compactionQueue?.queued.length, 2);
        const sequenceBefore = yield* orchestration.latestSequence;
        const result = yield* orchestration
          .dispatch({
            type: commandType,
            commandId: CommandId.make("rewind"),
            threadId,
            turnCount: 1,
            expectedSourceRevision: 2,
            createdAt: now,
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "OrchestrationCommandInvariantError");
          assert.include(result.failure.message, "exactly idle");
        }
        assert.equal(yield* orchestration.latestSequence, sequenceBefore);
        assert.deepEqual(yield* snapshots.getSnapshot(), before);
        assert.isTrue(Option.isNone(yield* repository.getActiveByThread(threadId)));
        assert.isTrue(
          Option.isNone(yield* repository.findLeaseByWorkspace("workspace-rollback-compaction")),
        );

        yield* orchestration.dispatch({
          type: "thread.compaction.queue.resume",
          commandId: CommandId.make("resume-first"),
          threadId,
          requestId: compactionRequestId,
          createdAt: now,
        });
        const resumed = (yield* snapshots.getSnapshot()).threads[0]?.session;
        assert.equal(resumed?.pendingTurnMessageId, MessageId.make("first"));
        assert.equal(resumed?.compactionQueue?.inFlightMessageId, MessageId.make("first"));
        assert.deepEqual(
          resumed?.compactionQueue?.queued.map((message) => message.messageId),
          [MessageId.make("second")],
        );
      }),
    );
  });
}
