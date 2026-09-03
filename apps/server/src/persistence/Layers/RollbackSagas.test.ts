// @effect-diagnostics preferSchemaOverJson:off
import {
  CheckpointRef,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { RollbackSagaRepository, type RollbackSagaState } from "../Services/RollbackSagas.ts";
import { RollbackSagaRepositoryLive } from "./RollbackSagas.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const now = "2026-08-31T00:00:00.000Z";
const threadA = ThreadId.make("thread-rollback-a");
const threadB = ThreadId.make("thread-rollback-b");
const threadC = ThreadId.make("thread-rollback-c");
const projectId = ProjectId.make("project-rollback");
const providerInstanceId = ProviderInstanceId.make("fake-absolute");
const sessionIncarnationId = RuntimeSessionId.make("session-incarnation-1");

const makeState = (
  operationId: string,
  threadId = threadA,
  workspaceKey = "workspace-key",
): RollbackSagaState => ({
  operationId,
  requestEventId: `event-${operationId}`,
  threadId,
  projectId,
  workspaceKey,
  workspaceCwd: "/private/workspace/canary",
  sourceRevision: 2,
  targetRevision: 1,
  sourceTurnId: null,
  targetTurnId: null,
  sourceCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-rollback-a/turn/2"),
  sourceCheckpointOid: "a".repeat(40),
  targetCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-rollback-a/turn/1"),
  targetCheckpointOid: "b".repeat(40),
  targetCheckpointDigest: "c".repeat(40),
  providerInstanceId,
  sessionIncarnationId,
  phase: "source-anchor-capture-started",
  attempt: 0,
  lastErrorCode: null,
  compensation: "none",
  cleanup: "pending",
  sourceAnchor: null,
  sourceAnchorDigest: null,
  desiredAnchor: { leafId: "PRIVATE_LEAF_TARGET" },
  desiredAnchorDigest: "target-digest",
  preimage: null,
  workspaceReceiptDigest: null,
  providerReceiptDigest: null,
  projectionCommitSequence: null,
  createdAt: now,
  updatedAt: now,
});

const layer = it.layer(
  RollbackSagaRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("RollbackSagaRepository", (it) => {
  it.effect("admits the saga and workspace lease atomically", () =>
    Effect.gen(function* () {
      const repository = yield* RollbackSagaRepository;
      yield* repository.admit(makeState("operation-a"));

      const competing = yield* repository
        .admit(makeState("operation-b", threadB, "workspace-key"))
        .pipe(Effect.result);
      assert.equal(competing._tag, "Failure");
      assert.isTrue(Option.isNone(yield* repository.get("operation-b")));

      const lease = yield* repository.findLeaseByWorkspace("workspace-key");
      assert.isTrue(Option.isSome(lease));
      if (Option.isSome(lease)) {
        assert.equal(lease.value.operationId, "operation-a");
        assert.equal(lease.value.threadId, threadA);
      }
      assert.equal((yield* repository.listNonterminal()).length, 1);
    }),
  );

  it.effect(
    "uses owner and version CAS, clears stale startup owners, and releases the lease last",
    () =>
      Effect.gen(function* () {
        const repository = yield* RollbackSagaRepository;
        const initial = makeState("operation-c", threadC, "workspace-c");
        yield* repository.admit(initial);

        const firstOwner = yield* repository.claim(initial.operationId, "owner-a");
        assert.isTrue(Option.isSome(firstOwner));
        if (Option.isNone(firstOwner)) return;
        assert.equal(firstOwner.value.version, 0);

        assert.isTrue(Option.isNone(yield* repository.claim(initial.operationId, "owner-b")));
        assert.isTrue(
          Option.isNone(
            yield* repository.updateOwned({
              operationId: initial.operationId,
              ownerId: "owner-a",
              expectedVersion: 99,
              state: { ...initial, phase: "source-anchor-captured" },
            }),
          ),
        );

        const updated = yield* repository.updateOwned({
          operationId: initial.operationId,
          ownerId: "owner-a",
          expectedVersion: firstOwner.value.version,
          state: { ...initial, phase: "source-anchor-captured" },
        });
        assert.isTrue(Option.isSome(updated));
        if (Option.isNone(updated)) return;
        assert.equal(updated.value.version, 1);

        yield* repository.clearOwnersForStartup();
        const reclaimed = yield* repository.claim(initial.operationId, "owner-after-restart");
        assert.isTrue(Option.isSome(reclaimed));
        if (Option.isNone(reclaimed)) return;
        const terminalState = {
          ...reclaimed.value.state,
          phase: "complete" as const,
          cleanup: "complete" as const,
          desiredAnchor: null,
          desiredAnchorDigest: null,
        };
        const released = yield* repository.releaseLeaseOwned({
          operationId: initial.operationId,
          ownerId: "owner-after-restart",
          expectedVersion: reclaimed.value.version,
          state: terminalState,
        });
        assert.isTrue(Option.isSome(released));
        assert.isTrue(Option.isNone(yield* repository.findLeaseByWorkspace("workspace-c")));
        assert.isFalse(
          (yield* repository.listNonterminal()).some(
            (record) => record.operationId === initial.operationId,
          ),
        );
      }),
  );

  it.effect(
    "keeps exact provider anchors private and deletes only anchors newer than the target",
    () =>
      Effect.gen(function* () {
        const repository = yield* RollbackSagaRepository;
        const sql = yield* SqlClient.SqlClient;
        const privateCanary = "PRIVATE_PROVIDER_LEAF_CANARY";
        for (const checkpointTurnCount of [0, 1, 2]) {
          yield* repository.putCheckpointAnchor({
            threadId: threadA,
            checkpointTurnCount,
            turnId: null,
            sourceRevision: checkpointTurnCount,
            providerInstanceId,
            sessionIncarnationId,
            checkpointRef: CheckpointRef.make(
              `refs/t3/checkpoints/thread-rollback-a/turn/${checkpointTurnCount}`,
            ),
            checkpointOid: String(checkpointTurnCount).repeat(40),
            anchor: { leafId: `${privateCanary}-${checkpointTurnCount}` },
            anchorDigest: `digest-${checkpointTurnCount}`,
            capturedAt: now,
          });
        }

        yield* repository.putCheckpointAnchor({
          threadId: threadA,
          checkpointTurnCount: 1,
          turnId: null,
          sourceRevision: 1,
          providerInstanceId,
          sessionIncarnationId,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-rollback-a/turn/1"),
          checkpointOid: "1".repeat(40),
          anchor: { leafId: `${privateCanary}-1` },
          anchorDigest: "digest-1",
          capturedAt: "2026-08-31T01:00:00.000Z",
        });

        const conflicting = yield* repository
          .putCheckpointAnchor({
            threadId: threadA,
            checkpointTurnCount: 1,
            turnId: null,
            sourceRevision: 1,
            providerInstanceId,
            sessionIncarnationId,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-rollback-a/turn/1"),
            checkpointOid: "9".repeat(40),
            anchor: { leafId: "MUST_NOT_OVERWRITE" },
            anchorDigest: "conflicting-digest",
            capturedAt: now,
          })
          .pipe(Effect.result);
        assert.equal(conflicting._tag, "Failure");

        const exact = yield* repository.getCheckpointAnchor({
          threadId: threadA,
          checkpointTurnCount: 1,
          providerInstanceId,
          sessionIncarnationId,
        });
        assert.isTrue(Option.isSome(exact));
        if (Option.isSome(exact)) {
          assert.deepEqual(exact.value.anchor, { leafId: `${privateCanary}-1` });
        }
        const privateRows = yield* sql<{ readonly anchorJson: string }>`
        SELECT anchor_json AS "anchorJson" FROM rollback_checkpoint_anchors
      `;
        assert.equal(privateRows.length, 3);
        assert.isTrue(privateRows.every((row) => row.anchorJson.includes(privateCanary)));

        yield* repository.deleteCheckpointAnchorsAfter({
          threadId: threadA,
          checkpointTurnCount: 1,
        });
        assert.isTrue(
          Option.isSome(
            yield* repository.getCheckpointAnchor({
              threadId: threadA,
              checkpointTurnCount: 0,
              providerInstanceId,
              sessionIncarnationId,
            }),
          ),
        );
        assert.isTrue(
          Option.isSome(
            yield* repository.getCheckpointAnchor({
              threadId: threadA,
              checkpointTurnCount: 1,
              providerInstanceId,
              sessionIncarnationId,
            }),
          ),
        );
        assert.isTrue(
          Option.isNone(
            yield* repository.getCheckpointAnchor({
              threadId: threadA,
              checkpointTurnCount: 2,
              providerInstanceId,
              sessionIncarnationId,
            }),
          ),
        );
      }),
  );
});
