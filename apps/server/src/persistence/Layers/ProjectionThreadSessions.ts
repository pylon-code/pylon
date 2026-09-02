import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionThreadSession,
  ProjectionThreadSessionRepository,
  type ProjectionThreadSessionRepositoryShape,
  DeleteProjectionThreadSessionInput,
  GetProjectionThreadSessionInput,
} from "../Services/ProjectionThreadSessions.ts";

const ProjectionThreadSessionDbRow = Schema.Struct({
  ...ProjectionThreadSession.fields,
  restored: Schema.Number,
  pendingTurnRequestAmbiguous: Schema.Number,
});

const toProjectionThreadSession = (
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRow>,
): ProjectionThreadSession => ({
  ...row,
  restored: row.restored === 1,
  pendingTurnRequestAmbiguous: row.pendingTurnRequestAmbiguous === 1,
});

const makeProjectionThreadSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadSessionRow = SqlSchema.void({
    Request: ProjectionThreadSession,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          runtime_mode,
          restored,
          started_at,
          session_incarnation_id,
          harness_refinement_status,
          pending_turn_request_id,
          pending_turn_request_ambiguous,
          pending_turn_message_id,
          pending_turn_requested_at,
          pending_turn_deadline_at,
          pending_turn_session_id,
          active_turn_request_id,
          failed_turn_request_id,
          pending_stop_request_id,
          pending_stop_provider_instance_id,
          pending_stop_session_incarnation_id,
          pending_stop_turn_request_id,
          pending_stop_turn_id,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          ${row.threadId},
          ${row.status},
          ${row.providerName},
          ${row.providerInstanceId},
          ${row.runtimeMode},
          ${row.restored ? 1 : 0},
          ${row.startedAt},
          ${row.sessionIncarnationId},
          ${row.harnessRefinementStatus},
          ${row.pendingTurnRequestId},
          ${row.pendingTurnRequestAmbiguous ? 1 : 0},
          ${row.pendingTurnMessageId},
          ${row.pendingTurnRequestedAt},
          ${row.pendingTurnDeadlineAt},
          ${row.pendingTurnSessionId},
          ${row.activeTurnRequestId},
          ${row.failedTurnRequestId},
          ${row.pendingStopRequestId},
          ${row.pendingStopProviderInstanceId},
          ${row.pendingStopSessionIncarnationId},
          ${row.pendingStopTurnRequestId},
          ${row.pendingStopTurnId},
          ${row.activeTurnId},
          ${row.lastError},
          ${row.updatedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          status = excluded.status,
          provider_name = excluded.provider_name,
          provider_instance_id = excluded.provider_instance_id,
          runtime_mode = excluded.runtime_mode,
          restored = excluded.restored,
          started_at = excluded.started_at,
          session_incarnation_id = excluded.session_incarnation_id,
          harness_refinement_status = excluded.harness_refinement_status,
          pending_turn_request_id = excluded.pending_turn_request_id,
          pending_turn_request_ambiguous = excluded.pending_turn_request_ambiguous,
          pending_turn_message_id = excluded.pending_turn_message_id,
          pending_turn_requested_at = excluded.pending_turn_requested_at,
          pending_turn_deadline_at = excluded.pending_turn_deadline_at,
          pending_turn_session_id = excluded.pending_turn_session_id,
          active_turn_request_id = excluded.active_turn_request_id,
          failed_turn_request_id = excluded.failed_turn_request_id,
          pending_stop_request_id = excluded.pending_stop_request_id,
          pending_stop_provider_instance_id = excluded.pending_stop_provider_instance_id,
          pending_stop_session_incarnation_id = excluded.pending_stop_session_incarnation_id,
          pending_stop_turn_request_id = excluded.pending_stop_turn_request_id,
          pending_stop_turn_id = excluded.pending_stop_turn_id,
          active_turn_id = excluded.active_turn_id,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionThreadSessionRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadSessionInput,
    Result: ProjectionThreadSessionDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          restored,
          started_at AS "startedAt",
          session_incarnation_id AS "sessionIncarnationId",
          harness_refinement_status AS "harnessRefinementStatus",
          pending_turn_request_id AS "pendingTurnRequestId",
          pending_turn_request_ambiguous AS "pendingTurnRequestAmbiguous",
          pending_turn_message_id AS "pendingTurnMessageId",
          pending_turn_requested_at AS "pendingTurnRequestedAt",
          pending_turn_deadline_at AS "pendingTurnDeadlineAt",
          pending_turn_session_id AS "pendingTurnSessionId",
          active_turn_request_id AS "activeTurnRequestId",
          failed_turn_request_id AS "failedTurnRequestId",
          pending_stop_request_id AS "pendingStopRequestId",
          pending_stop_provider_instance_id AS "pendingStopProviderInstanceId",
          pending_stop_session_incarnation_id AS "pendingStopSessionIncarnationId",
          pending_stop_turn_request_id AS "pendingStopTurnRequestId",
          pending_stop_turn_id AS "pendingStopTurnId",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteProjectionThreadSessionRow = SqlSchema.void({
    Request: DeleteProjectionThreadSessionInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadSessionRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadSessionRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadSessionRepository.upsert:query")),
    );

  const getByThreadId: ProjectionThreadSessionRepositoryShape["getByThreadId"] = (input) =>
    getProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.getByThreadId:query"),
      ),
      Effect.map(Option.map(toProjectionThreadSession)),
    );

  const deleteByThreadId: ProjectionThreadSessionRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadSessionRepositoryShape;
});

export const ProjectionThreadSessionRepositoryLive = Layer.effect(
  ProjectionThreadSessionRepository,
  makeProjectionThreadSessionRepository,
);
