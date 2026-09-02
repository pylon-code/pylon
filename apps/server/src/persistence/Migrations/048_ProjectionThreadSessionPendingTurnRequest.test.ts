import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../Layers/OrchestrationEventStore.ts";
import { runMigrations } from "../Migrations.ts";
import migration048 from "./048_ProjectionThreadSessionPendingTurnRequest.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const persistenceLayer = NodeSqliteClient.layerMemory();
const layer = it.layer(
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pylon-migration-048-" })),
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const pendingPayload =
  '{"threadId":"thread-pending","messageId":"message-pending","runtimeMode":"approval-required","interactionMode":"default","createdAt":"2026-01-01T00:00:00.000Z"}';

const insertPendingTurn = Effect.fn("insertPendingTurn")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_turns (
      thread_id,
      turn_id,
      pending_message_id,
      state,
      requested_at,
      checkpoint_files_json
    ) VALUES (
      'thread-pending',
      NULL,
      'message-pending',
      'pending',
      '2026-01-01T00:00:00.000Z',
      '[]'
    )
  `;
});

const insertPendingSessionAndTurn = Effect.fn("insertPendingSessionAndTurn")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_thread_sessions (
      thread_id,
      status,
      provider_name,
      runtime_mode,
      restored,
      active_turn_id,
      last_error,
      updated_at
    ) VALUES (
      'thread-pending',
      'starting',
      'codex',
      'approval-required',
      0,
      NULL,
      NULL,
      '2026-01-01T00:00:00.000Z'
    )
  `;
  yield* insertPendingTurn();
});

const insertTurnStartEvent = Effect.fn("insertTurnStartEvent")(function* (
  eventId: string,
  commandId: string,
  streamVersion: number,
  payloadJson = pendingPayload,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_events (
      event_id,
      aggregate_kind,
      stream_id,
      stream_version,
      event_type,
      occurred_at,
      command_id,
      actor_kind,
      payload_json,
      metadata_json
    ) VALUES (
      ${eventId},
      'thread',
      'thread-pending',
      ${streamVersion},
      'thread.turn-start-requested',
      '2026-01-01T00:00:00.000Z',
      ${commandId},
      'system',
      ${payloadJson},
      '{}'
    )
  `;
});

const readPendingSessionRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly threadId: string;
    readonly status: string;
    readonly providerName: string | null;
    readonly providerInstanceId: string | null;
    readonly runtimeMode: string;
    readonly restored: number;
    readonly startedAt: string | null;
    readonly sessionIncarnationId: string | null;
    readonly harnessRefinementStatus: string | null;
    readonly requestId: string | null;
    readonly ambiguous: number;
    readonly messageId: string | null;
    readonly requestedAt: string | null;
    readonly deadlineAt: string | null;
    readonly pendingSessionId: string | null;
    readonly activeRequestId: string | null;
    readonly failedRequestId: string | null;
    readonly activeTurnId: string | null;
    readonly lastError: string | null;
    readonly updatedAt: string;
  }>`
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
      pending_turn_request_id AS "requestId",
      pending_turn_request_ambiguous AS "ambiguous",
      pending_turn_message_id AS "messageId",
      pending_turn_requested_at AS "requestedAt",
      pending_turn_deadline_at AS "deadlineAt",
      pending_turn_session_id AS "pendingSessionId",
      active_turn_request_id AS "activeRequestId",
      failed_turn_request_id AS "failedRequestId",
      active_turn_id AS "activeTurnId",
      last_error AS "lastError",
      updated_at AS "updatedAt"
    FROM projection_thread_sessions
    WHERE thread_id = 'thread-pending'
  `;
});

layer("048_ProjectionThreadSessionPendingTurnRequest", (it) => {
  it.effect("synthesizes a missing pending session for boot inventory like a full rebuild", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      yield* runMigrations({ toMigrationInclusive: 47 });
      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      assert.ok(!before.some((column) => column.name === "pending_turn_request_id"));
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM orchestration_events`;
      yield* sql`DELETE FROM projection_state`;
      yield* insertPendingTurn();
      yield* insertTurnStartEvent("event-pending-turn", "command-pending-turn", 1);

      yield* runMigrations({ toMigrationInclusive: 48 });
      const migrated = yield* readPendingSessionRows;
      assert.deepStrictEqual(migrated, [
        {
          threadId: "thread-pending",
          status: "starting",
          providerName: null,
          providerInstanceId: null,
          runtimeMode: "approval-required",
          restored: 0,
          startedAt: null,
          sessionIncarnationId: null,
          harnessRefinementStatus: null,
          requestId: "command-pending-turn",
          ambiguous: 0,
          messageId: "message-pending",
          requestedAt: "2026-01-01T00:00:00.000Z",
          deadlineAt: "1970-01-01T00:00:00.000Z",
          pendingSessionId: null,
          activeRequestId: null,
          failedRequestId: null,
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      const bootInventory = yield* sql<{
        readonly threadId: string;
        readonly requestId: string;
        readonly messageId: string;
        readonly deadlineAt: string;
      }>`
        SELECT
          thread_id AS "threadId",
          pending_turn_request_id AS "requestId",
          pending_turn_message_id AS "messageId",
          pending_turn_deadline_at AS "deadlineAt"
        FROM projection_thread_sessions
        WHERE status = 'starting'
          AND pending_turn_request_id IS NOT NULL
      `;
      assert.deepStrictEqual(bootInventory, [
        {
          threadId: "thread-pending",
          requestId: "command-pending-turn",
          messageId: "message-pending",
          deadlineAt: "1970-01-01T00:00:00.000Z",
        },
      ]);

      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`
        DELETE FROM projection_state
        WHERE projector IN ('projection.thread-sessions', 'projection.thread-turns')
      `;
      // The current projector repository reads the additive pending-stop
      // columns introduced immediately after this historical migration.
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* projectionPipeline.bootstrap;
      assert.deepStrictEqual(yield* readPendingSessionRows, migrated);
    }),
  );

  it.effect("backfills the request joined to the current pending turn", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM orchestration_events`;
      yield* insertPendingSessionAndTurn();
      yield* insertTurnStartEvent("event-pending-turn", "command-pending-turn", 1);
      yield* insertTurnStartEvent(
        "event-unrelated-newer-turn",
        "command-unrelated-newer-turn",
        2,
        '{"threadId":"thread-pending","messageId":"other-message","createdAt":"2026-01-01T00:00:01.000Z"}',
      );

      yield* migration048;
      const after = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      assert.ok(after.some((column) => column.name === "pending_turn_request_id"));
      assert.ok(after.some((column) => column.name === "failed_turn_request_id"));
      const sessions = yield* sql<{
        readonly requestId: string | null;
        readonly ambiguous: number;
        readonly messageId: string | null;
        readonly requestedAt: string | null;
        readonly deadlineAt: string | null;
        readonly failedRequestId: string | null;
      }>`
        SELECT
          pending_turn_request_id AS "requestId",
          pending_turn_request_ambiguous AS "ambiguous",
          pending_turn_message_id AS "messageId",
          pending_turn_requested_at AS "requestedAt",
          pending_turn_deadline_at AS "deadlineAt",
          failed_turn_request_id AS "failedRequestId"
        FROM projection_thread_sessions
        WHERE thread_id = 'thread-pending'
      `;
      assert.deepStrictEqual(sessions[0], {
        requestId: "command-pending-turn",
        ambiguous: 0,
        messageId: "message-pending",
        requestedAt: "2026-01-01T00:00:00.000Z",
        deadlineAt: "1970-01-01T00:00:00.000Z",
        failedRequestId: null,
      });
    }),
  );

  it.effect("leaves an ambiguous historical correlation unset", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM orchestration_events`;
      yield* insertPendingTurn();
      yield* insertTurnStartEvent("event-pending-a", "command-pending-a", 1);
      yield* insertTurnStartEvent("event-pending-b", "command-pending-b", 2);

      yield* migration048;
      const sessions = yield* sql<{
        readonly requestId: string | null;
        readonly ambiguous: number;
      }>`
        SELECT
          pending_turn_request_id AS "requestId",
          pending_turn_request_ambiguous AS "ambiguous"
        FROM projection_thread_sessions
        WHERE thread_id = 'thread-pending'
      `;
      assert.deepStrictEqual(sessions[0], { requestId: null, ambiguous: 1 });
    }),
  );

  it.effect("is idempotent when the columns already exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* runMigrations({ toMigrationInclusive: 48 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      assert.strictEqual(
        columns.filter((column) => column.name === "pending_turn_request_id").length,
        1,
      );
      assert.strictEqual(
        columns.filter((column) => column.name === "pending_turn_request_ambiguous").length,
        1,
      );
      assert.strictEqual(
        columns.filter((column) => column.name === "failed_turn_request_id").length,
        1,
      );
    }),
  );
});
