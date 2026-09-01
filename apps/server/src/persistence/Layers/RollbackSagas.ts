// @effect-diagnostics preferSchemaOverJson:off
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { NonNegativeInt, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import {
  PersistenceDecodeError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../Errors.ts";
import {
  RollbackCheckpointAnchor,
  RollbackSagaRecord,
  RollbackSagaRepository,
  RollbackSagaState,
  type RollbackSagaRepositoryShape,
} from "../Services/RollbackSagas.ts";

const SagaDbRow = Schema.Struct({
  operationId: Schema.String,
  requestEventId: Schema.String,
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceKey: Schema.String,
  phase: Schema.String,
  terminal: Schema.Number,
  ownerId: Schema.NullOr(Schema.String),
  version: NonNegativeInt,
  privateStateJson: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const LeaseDbRow = Schema.Struct({
  operationId: Schema.String,
  threadId: ThreadId,
  projectId: ProjectId,
});
const AnchorDbRow = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
  turnId: Schema.NullOr(TurnId),
  sourceRevision: NonNegativeInt,
  providerInstanceId: Schema.String,
  sessionIncarnationId: Schema.String,
  checkpointRef: Schema.String,
  checkpointOid: Schema.String,
  anchorJson: Schema.String,
  anchorDigest: Schema.String,
  capturedAt: Schema.String,
});
const decodeSagaDbRows = Schema.decodeUnknownEffect(Schema.Array(SagaDbRow));
const decodeLeaseDbRows = Schema.decodeUnknownEffect(Schema.Array(LeaseDbRow));
const decodeAnchorDbRows = Schema.decodeUnknownEffect(Schema.Array(AnchorDbRow));
const decodeSagaState = Schema.decodeUnknownEffect(RollbackSagaState);
const decodeSagaRecord = Schema.decodeUnknownEffect(RollbackSagaRecord);
const decodeAnchor = Schema.decodeUnknownEffect(RollbackCheckpointAnchor);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let nonterminalFenceCache: ReadonlyArray<typeof RollbackSagaRecord.Type> | null = null;

  const mapSagaRow = Effect.fn("RollbackSagaRepository.mapSagaRow")(function* (
    row: typeof SagaDbRow.Type,
  ) {
    const state = yield* Effect.try({
      try: () => JSON.parse(row.privateStateJson) as unknown,
      catch: (cause) =>
        toPersistenceDecodeError("RollbackSagaRepository.parseSagaState")(
          cause as Schema.SchemaError,
        ),
    }).pipe(
      Effect.flatMap(decodeSagaState),
      Effect.mapError((cause) =>
        cause._tag === "PersistenceDecodeError"
          ? cause
          : toPersistenceDecodeError("RollbackSagaRepository.decodeSagaState")(cause),
      ),
    );
    return yield* decodeSagaRecord({
      operationId: row.operationId,
      requestEventId: row.requestEventId,
      threadId: row.threadId,
      projectId: row.projectId,
      workspaceKey: row.workspaceKey,
      phase: row.phase,
      terminal: row.terminal === 1,
      ownerId: row.ownerId,
      version: row.version,
      state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }).pipe(Effect.mapError(toPersistenceDecodeError("RollbackSagaRepository.decodeSagaRecord")));
  });

  const selectSagaRows = (query: Effect.Effect<ReadonlyArray<unknown>, SqlError>) =>
    query.pipe(
      Effect.mapError(toPersistenceSqlError("RollbackSagaRepository.select")),
      Effect.flatMap(decodeSagaDbRows),
      Effect.mapError((cause) =>
        cause._tag === "PersistenceSqlError"
          ? cause
          : toPersistenceDecodeError("RollbackSagaRepository.decodeRows")(cause),
      ),
      Effect.flatMap((rows) => Effect.forEach(rows, mapSagaRow)),
    );

  const admit: RollbackSagaRepositoryShape["admit"] = (state) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          INSERT INTO rollback_sagas (
            operation_id, request_event_id, thread_id, project_id, workspace_key,
            phase, terminal, owner_id, version, private_state_json, created_at, updated_at
          ) VALUES (
            ${state.operationId}, ${state.requestEventId}, ${state.threadId}, ${state.projectId},
            ${state.workspaceKey}, ${state.phase}, 0, NULL, 0, ${JSON.stringify(state)},
            ${state.createdAt}, ${state.updatedAt}
          )
        `;
          yield* sql`
          INSERT INTO rollback_workspace_leases (
            workspace_key, operation_id, thread_id, project_id, acquired_at
          ) VALUES (
            ${state.workspaceKey}, ${state.operationId}, ${state.threadId}, ${state.projectId},
            ${state.createdAt}
          )
        `;
        }),
      )
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            nonterminalFenceCache = null;
          }),
        ),
        Effect.mapError(toPersistenceSqlError("RollbackSagaRepository.admit")),
      );

  const get: RollbackSagaRepositoryShape["get"] = (operationId) =>
    selectSagaRows(sql`
      SELECT operation_id AS "operationId", request_event_id AS "requestEventId",
        thread_id AS "threadId", project_id AS "projectId", workspace_key AS "workspaceKey",
        phase, terminal, owner_id AS "ownerId", version,
        private_state_json AS "privateStateJson", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM rollback_sagas WHERE operation_id = ${operationId} LIMIT 1
    `).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const getByRequestEvent: RollbackSagaRepositoryShape["getByRequestEvent"] = (requestEventId) =>
    selectSagaRows(sql`
      SELECT operation_id AS "operationId", request_event_id AS "requestEventId",
        thread_id AS "threadId", project_id AS "projectId", workspace_key AS "workspaceKey",
        phase, terminal, owner_id AS "ownerId", version,
        private_state_json AS "privateStateJson", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM rollback_sagas WHERE request_event_id = ${requestEventId} LIMIT 1
    `).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const getActiveByThread: RollbackSagaRepositoryShape["getActiveByThread"] = (threadId) =>
    selectSagaRows(sql`
      SELECT operation_id AS "operationId", request_event_id AS "requestEventId",
        thread_id AS "threadId", project_id AS "projectId", workspace_key AS "workspaceKey",
        phase, terminal, owner_id AS "ownerId", version,
        private_state_json AS "privateStateJson", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM rollback_sagas WHERE thread_id = ${threadId} AND terminal = 0 LIMIT 1
    `).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const listNonterminal: RollbackSagaRepositoryShape["listNonterminal"] = () =>
    selectSagaRows(sql`
      SELECT operation_id AS "operationId", request_event_id AS "requestEventId",
        thread_id AS "threadId", project_id AS "projectId", workspace_key AS "workspaceKey",
        phase, terminal, owner_id AS "ownerId", version,
        private_state_json AS "privateStateJson", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM rollback_sagas WHERE terminal = 0 ORDER BY created_at ASC, operation_id ASC
    `).pipe(
      Effect.tap((records) =>
        Effect.sync(() => {
          nonterminalFenceCache = records;
        }),
      ),
    );

  const listNonterminalForFence: RollbackSagaRepositoryShape["listNonterminalForFence"] = () =>
    nonterminalFenceCache === null ? listNonterminal() : Effect.succeed(nonterminalFenceCache);

  const clearOwnersForStartup: RollbackSagaRepositoryShape["clearOwnersForStartup"] = () =>
    sql`UPDATE rollback_sagas SET owner_id = NULL WHERE terminal = 0`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("RollbackSagaRepository.clearOwnersForStartup")),
    );

  const claim: RollbackSagaRepositoryShape["claim"] = (operationId, ownerId) =>
    selectSagaRows(sql`
      UPDATE rollback_sagas
      SET owner_id = ${ownerId}
      WHERE operation_id = ${operationId} AND terminal = 0 AND (owner_id IS NULL OR owner_id = ${ownerId})
      RETURNING operation_id AS "operationId", request_event_id AS "requestEventId",
        thread_id AS "threadId", project_id AS "projectId", workspace_key AS "workspaceKey",
        phase, terminal, owner_id AS "ownerId", version,
        private_state_json AS "privateStateJson", created_at AS "createdAt", updated_at AS "updatedAt"
    `).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const updateOwned: RollbackSagaRepositoryShape["updateOwned"] = (input) =>
    selectSagaRows(sql`
      UPDATE rollback_sagas
      SET phase = ${input.state.phase}, terminal = ${input.terminal === true ? 1 : 0},
        private_state_json = ${JSON.stringify(input.state)}, updated_at = ${input.state.updatedAt},
        version = version + 1
      WHERE operation_id = ${input.operationId} AND owner_id = ${input.ownerId}
        AND version = ${input.expectedVersion} AND terminal = 0
      RETURNING operation_id AS "operationId", request_event_id AS "requestEventId",
        thread_id AS "threadId", project_id AS "projectId", workspace_key AS "workspaceKey",
        phase, terminal, owner_id AS "ownerId", version,
        private_state_json AS "privateStateJson", created_at AS "createdAt", updated_at AS "updatedAt"
    `).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.tap((updated) =>
        input.terminal === true && Option.isSome(updated)
          ? Effect.sync(() => {
              nonterminalFenceCache = null;
            })
          : Effect.void,
      ),
    );

  const releaseOwnerOwned: RollbackSagaRepositoryShape["releaseOwnerOwned"] = (
    operationId,
    ownerId,
  ) =>
    sql`UPDATE rollback_sagas SET owner_id = NULL WHERE operation_id = ${operationId} AND owner_id = ${ownerId} AND terminal = 0`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("RollbackSagaRepository.releaseOwnerOwned")),
    );

  const releaseLeaseOwned: RollbackSagaRepositoryShape["releaseLeaseOwned"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* selectSagaRows(sql`
          UPDATE rollback_sagas
          SET phase = ${input.state.phase}, terminal = 1, owner_id = NULL,
            private_state_json = ${JSON.stringify(input.state)}, updated_at = ${input.state.updatedAt},
            version = version + 1
          WHERE operation_id = ${input.operationId} AND owner_id = ${input.ownerId}
            AND version = ${input.expectedVersion} AND terminal = 0
          RETURNING operation_id AS "operationId", request_event_id AS "requestEventId",
            thread_id AS "threadId", project_id AS "projectId", workspace_key AS "workspaceKey",
            phase, terminal, owner_id AS "ownerId", version,
            private_state_json AS "privateStateJson", created_at AS "createdAt", updated_at AS "updatedAt"
        `);
          if (rows.length === 0) return Option.none<typeof RollbackSagaRecord.Type>();
          yield* sql`DELETE FROM rollback_workspace_leases WHERE operation_id = ${input.operationId}`;
          return Option.some(rows[0]!);
        }),
      )
      .pipe(
        Effect.tap((released) =>
          Option.isSome(released)
            ? Effect.sync(() => {
                nonterminalFenceCache = null;
              })
            : Effect.void,
        ),
        Effect.mapError((cause) =>
          cause._tag === "PersistenceDecodeError"
            ? cause
            : toPersistenceSqlError("RollbackSagaRepository.releaseLeaseOwned")(cause),
        ),
      );

  const findLeaseByWorkspace: RollbackSagaRepositoryShape["findLeaseByWorkspace"] = (
    workspaceKey,
  ) =>
    sql`
      SELECT operation_id AS "operationId", thread_id AS "threadId", project_id AS "projectId"
      FROM rollback_workspace_leases WHERE workspace_key = ${workspaceKey} LIMIT 1
    `.pipe(
      Effect.mapError(toPersistenceSqlError("RollbackSagaRepository.findLeaseByWorkspace")),
      Effect.flatMap(decodeLeaseDbRows),
      Effect.mapError((cause) =>
        cause._tag === "PersistenceSqlError"
          ? cause
          : toPersistenceDecodeError("RollbackSagaRepository.decodeLease")(cause),
      ),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const putCheckpointAnchor: RollbackSagaRepositoryShape["putCheckpointAnchor"] = Effect.fn(
    "RollbackSagaRepository.putCheckpointAnchor",
  )(function* (anchor) {
    const anchorJson = yield* Effect.try({
      try: () => JSON.stringify(anchor.anchor),
      catch: (cause) =>
        new PersistenceDecodeError({
          operation: "RollbackSagaRepository.encodeCheckpointAnchor",
          issue: "JsonEncoding",
          cause,
        }),
    });
    const rows = yield* sql<{ readonly anchorDigest: string }>`
      INSERT INTO rollback_checkpoint_anchors (
        thread_id, checkpoint_turn_count, turn_id, source_revision, provider_instance_id,
        session_incarnation_id, checkpoint_ref, checkpoint_oid, anchor_json, anchor_digest, captured_at
      ) VALUES (
        ${anchor.threadId}, ${anchor.checkpointTurnCount}, ${anchor.turnId}, ${anchor.sourceRevision},
        ${anchor.providerInstanceId},
        ${anchor.sessionIncarnationId}, ${anchor.checkpointRef}, ${anchor.checkpointOid},
        ${anchorJson}, ${anchor.anchorDigest}, ${anchor.capturedAt}
      )
      ON CONFLICT (thread_id, checkpoint_turn_count, provider_instance_id, session_incarnation_id)
      DO UPDATE SET captured_at = rollback_checkpoint_anchors.captured_at
      WHERE rollback_checkpoint_anchors.turn_id IS excluded.turn_id
        AND rollback_checkpoint_anchors.source_revision = excluded.source_revision
        AND rollback_checkpoint_anchors.checkpoint_ref = excluded.checkpoint_ref
        AND rollback_checkpoint_anchors.checkpoint_oid = excluded.checkpoint_oid
        AND rollback_checkpoint_anchors.anchor_digest = excluded.anchor_digest
      RETURNING anchor_digest AS "anchorDigest"
    `.pipe(Effect.mapError(toPersistenceSqlError("RollbackSagaRepository.putCheckpointAnchor")));
    if (rows.length !== 1) {
      return yield* new PersistenceDecodeError({
        operation: "RollbackSagaRepository.immutableCheckpointAnchorConflict",
        issue: "ImmutableIdentityConflict",
      });
    }
  });

  const getCheckpointAnchor: RollbackSagaRepositoryShape["getCheckpointAnchor"] = (input) =>
    sql`
      SELECT thread_id AS "threadId", checkpoint_turn_count AS "checkpointTurnCount",
        turn_id AS "turnId", source_revision AS "sourceRevision",
        provider_instance_id AS "providerInstanceId", session_incarnation_id AS "sessionIncarnationId",
        checkpoint_ref AS "checkpointRef", checkpoint_oid AS "checkpointOid",
        anchor_json AS "anchorJson", anchor_digest AS "anchorDigest", captured_at AS "capturedAt"
      FROM rollback_checkpoint_anchors
      WHERE thread_id = ${input.threadId} AND checkpoint_turn_count = ${input.checkpointTurnCount}
        AND provider_instance_id = ${input.providerInstanceId}
        AND session_incarnation_id = ${input.sessionIncarnationId}
      LIMIT 1
    `.pipe(
      Effect.mapError(toPersistenceSqlError("RollbackSagaRepository.getCheckpointAnchor")),
      Effect.flatMap(decodeAnchorDbRows),
      Effect.mapError((cause) =>
        cause._tag === "PersistenceSqlError"
          ? cause
          : toPersistenceDecodeError("RollbackSagaRepository.decodeAnchorRows")(cause),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Effect.try({
            try: () => JSON.parse(row.anchorJson) as unknown,
            catch: (cause) =>
              toPersistenceDecodeError("RollbackSagaRepository.parseAnchor")(
                cause as Schema.SchemaError,
              ),
          }).pipe(
            Effect.flatMap((anchor) =>
              decodeAnchor({
                threadId: row.threadId,
                checkpointTurnCount: row.checkpointTurnCount,
                turnId: row.turnId,
                sourceRevision: row.sourceRevision,
                providerInstanceId: row.providerInstanceId,
                sessionIncarnationId: row.sessionIncarnationId,
                checkpointRef: row.checkpointRef,
                checkpointOid: row.checkpointOid,
                anchor,
                anchorDigest: row.anchorDigest,
                capturedAt: row.capturedAt,
              }),
            ),
            Effect.mapError((cause) =>
              cause._tag === "PersistenceDecodeError"
                ? cause
                : toPersistenceDecodeError("RollbackSagaRepository.decodeAnchor")(cause),
            ),
          ),
        ),
      ),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const deleteCheckpointAnchorsAfter: RollbackSagaRepositoryShape["deleteCheckpointAnchorsAfter"] =
    (input) =>
      sql`DELETE FROM rollback_checkpoint_anchors WHERE thread_id = ${input.threadId} AND checkpoint_turn_count > ${input.checkpointTurnCount}`.pipe(
        Effect.asVoid,
        Effect.mapError(
          toPersistenceSqlError("RollbackSagaRepository.deleteCheckpointAnchorsAfter"),
        ),
      );

  return RollbackSagaRepository.of({
    admit,
    get,
    getByRequestEvent,
    getActiveByThread,
    listNonterminal,
    listNonterminalForFence,
    clearOwnersForStartup,
    claim,
    updateOwned,
    releaseOwnerOwned,
    releaseLeaseOwned,
    findLeaseByWorkspace,
    putCheckpointAnchor,
    getCheckpointAnchor,
    deleteCheckpointAnchorsAfter,
  });
});

export const RollbackSagaRepositoryLive = Layer.effect(RollbackSagaRepository, make);
