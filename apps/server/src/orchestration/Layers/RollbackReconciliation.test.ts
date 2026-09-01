import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { CheckpointStore } from "../../checkpointing/CheckpointStore.ts";
import {
  RollbackSagaRepository,
  type RollbackSagaRecord,
} from "../../persistence/Services/RollbackSagas.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { RollbackSagaRunner } from "../../rollback/RollbackSagaRunner.ts";
import { RollbackWorkspace } from "../../rollback/RollbackWorkspace.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { WorkspaceEntries } from "../../workspace/WorkspaceEntries.ts";
import { make as makeCheckpointReactor } from "./CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";

const operationId = "startup-operation";
const threadId = ThreadId.make("startup-thread");
const projectId = ProjectId.make("startup-project");
const pending = {
  operationId,
  requestEventId: "startup-event",
  threadId,
  projectId,
  workspaceKey: "startup-workspace",
  phase: "workspace-apply-started",
  terminal: false,
  ownerId: "dead-process-owner",
  version: 4,
  state: {
    operationId,
    requestEventId: "startup-event",
    threadId,
    projectId,
    workspaceKey: "startup-workspace",
    workspaceCwd: "/startup/workspace",
    sourceRevision: 2,
    targetRevision: 1,
    sourceTurnId: null,
    targetTurnId: null,
    sourceCheckpointRef: "refs/t3/checkpoints/source" as never,
    sourceCheckpointOid: "a".repeat(40),
    targetCheckpointRef: "refs/t3/checkpoints/target" as never,
    targetCheckpointOid: "b".repeat(40),
    targetCheckpointDigest: "tree-target",
    providerInstanceId: "fake" as never,
    sessionIncarnationId: "session" as never,
    phase: "workspace-apply-started" as const,
    attempt: 0,
    lastErrorCode: null,
    compensation: "none" as const,
    cleanup: "pending" as const,
    sourceAnchor: { leaf: "private-source" },
    sourceAnchorDigest: "source",
    desiredAnchor: { leaf: "private-target" },
    desiredAnchorDigest: "target",
    preimage: { path: "private" },
    workspaceReceiptDigest: null,
    providerReceiptDigest: null,
    projectionCommitSequence: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  },
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
} satisfies RollbackSagaRecord;

it.effect("clears stale owners and enqueues every nonterminal rollback during startup", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const repository = {
      clearOwnersForStartup: () =>
        Effect.sync(() => {
          calls.push("clear-owners");
        }),
      listNonterminal: () =>
        Effect.sync(() => {
          calls.push("list-nonterminal");
          return [pending];
        }),
    };
    const runner = {
      run: (id: string, recovering: boolean) =>
        Effect.sync(() => {
          calls.push(`run:${id}:${recovering}`);
        }),
    };
    const reactor = yield* makeCheckpointReactor.pipe(
      Effect.provideService(OrchestrationEngineService, {
        dispatch: () => Effect.succeed({ sequence: 1 }),
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(1),
      } as never),
      Effect.provideService(ProjectionSnapshotQuery, {} as never),
      Effect.provideService(ProviderService, { streamEvents: Stream.empty } as never),
      Effect.provideService(CheckpointStore, {} as never),
      Effect.provideService(RuntimeReceiptBus, {
        publish: () => Effect.void,
        streamEventsForTest: Stream.empty,
      }),
      Effect.provideService(WorkspaceEntries, {} as never),
      Effect.provideService(VcsStatusBroadcaster, {} as never),
      Effect.provideService(RollbackSagaRepository, repository as never),
      Effect.provideService(RollbackSagaRunner, runner),
      Effect.provideService(RollbackWorkspace, {} as never),
      Effect.provide(NodeServices.layer),
    );

    yield* reactor.start();
    yield* reactor.drain;
    assert.deepEqual(calls, ["clear-owners", "list-nonterminal", `run:${operationId}:true`]);
  }),
);
