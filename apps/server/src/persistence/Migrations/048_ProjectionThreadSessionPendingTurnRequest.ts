import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

const pendingColumns = [
  ["pending_turn_request_id", "TEXT"],
  ["pending_turn_request_ambiguous", "INTEGER NOT NULL DEFAULT 0"],
  ["pending_turn_message_id", "TEXT"],
  ["pending_turn_requested_at", "TEXT"],
  ["pending_turn_deadline_at", "TEXT"],
  ["pending_turn_session_id", "TEXT"],
  ["session_incarnation_id", "TEXT"],
  ["active_turn_request_id", "TEXT"],
  ["failed_turn_request_id", "TEXT"],
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  const existing = new Set(columns.map((column) => column.name));
  for (const [name, type] of pendingColumns) {
    if (existing.has(name)) continue;
    yield* sql.unsafe(`ALTER TABLE projection_thread_sessions ADD COLUMN ${name} ${type}`);
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_pending_admission
    ON projection_thread_sessions(status, pending_turn_deadline_at, thread_id)
    WHERE status = 'starting' AND pending_turn_request_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_turn_start_correlation
    ON orchestration_events(aggregate_kind, stream_id, sequence)
    WHERE event_type = 'thread.turn-start-requested' AND command_id IS NOT NULL
  `;

  // A crash can commit the turn projector after the event append but before
  // the session projector runs. Synthesize the same starting row that a full
  // replay creates, but only when one exact current pending turn owns the
  // thread. The correlation update below then applies the duplicate fence.
  yield* sql`
    INSERT INTO projection_thread_sessions (
      thread_id,
      status,
      provider_name,
      provider_instance_id,
      runtime_mode,
      restored,
      started_at,
      harness_refinement_status,
      active_turn_id,
      last_error,
      updated_at
    )
    SELECT
      turns.thread_id,
      'starting',
      NULL,
      NULL,
      COALESCE(json_extract(first_event.payload_json, '$.runtimeMode'), 'full-access'),
      0,
      NULL,
      NULL,
      NULL,
      NULL,
      first_event.occurred_at
    FROM projection_turns AS turns
    JOIN orchestration_events AS first_event
      ON first_event.sequence = (
        SELECT MIN(events.sequence)
        FROM orchestration_events AS events
        WHERE events.aggregate_kind = 'thread'
          AND events.stream_id = turns.thread_id
          AND events.event_type = 'thread.turn-start-requested'
          AND events.command_id IS NOT NULL
          AND json_extract(events.payload_json, '$.messageId') = turns.pending_message_id
          AND json_extract(events.payload_json, '$.createdAt') = turns.requested_at
      )
    WHERE turns.turn_id IS NULL
      AND turns.state = 'pending'
      AND turns.pending_message_id IS NOT NULL
      AND turns.checkpoint_turn_count IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM projection_thread_sessions AS sessions
        WHERE sessions.thread_id = turns.thread_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM projection_turns AS other_turns
        WHERE other_turns.thread_id = turns.thread_id
          AND other_turns.row_id <> turns.row_id
          AND other_turns.turn_id IS NULL
          AND other_turns.state = 'pending'
          AND other_turns.pending_message_id IS NOT NULL
          AND other_turns.checkpoint_turn_count IS NULL
      )
  `;

  // Recover only the event set that owns the projection's current pending
  // message. Duplicate legacy events are explicitly ambiguous: migration and
  // full replay both keep the request id unset rather than choosing a winner.
  yield* sql`
    UPDATE projection_thread_sessions AS sessions
    SET
      pending_turn_request_id = correlation.command_id,
      pending_turn_request_ambiguous = CASE WHEN correlation.match_count > 1 THEN 1 ELSE 0 END,
      pending_turn_message_id = correlation.message_id,
      pending_turn_requested_at = correlation.requested_at,
      pending_turn_deadline_at = '1970-01-01T00:00:00.000Z',
      pending_turn_session_id = NULL
    FROM (
      SELECT
        turns.thread_id,
        turns.pending_message_id AS message_id,
        turns.requested_at,
        (
          SELECT CASE
            WHEN COUNT(*) = 1 THEN MAX(events.command_id)
            ELSE NULL
          END
          FROM orchestration_events AS events
          WHERE events.aggregate_kind = 'thread'
            AND events.stream_id = turns.thread_id
            AND events.event_type = 'thread.turn-start-requested'
            AND events.command_id IS NOT NULL
            AND json_extract(events.payload_json, '$.messageId') = turns.pending_message_id
            AND json_extract(events.payload_json, '$.createdAt') = turns.requested_at
        ) AS command_id,
        (
          SELECT COUNT(*)
          FROM orchestration_events AS events
          WHERE events.aggregate_kind = 'thread'
            AND events.stream_id = turns.thread_id
            AND events.event_type = 'thread.turn-start-requested'
            AND events.command_id IS NOT NULL
            AND json_extract(events.payload_json, '$.messageId') = turns.pending_message_id
            AND json_extract(events.payload_json, '$.createdAt') = turns.requested_at
        ) AS match_count
      FROM projection_turns AS turns
      WHERE turns.turn_id IS NULL
        AND turns.state = 'pending'
        AND turns.pending_message_id IS NOT NULL
        AND turns.checkpoint_turn_count IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM projection_turns AS other_turns
          WHERE other_turns.thread_id = turns.thread_id
            AND other_turns.row_id <> turns.row_id
            AND other_turns.turn_id IS NULL
            AND other_turns.state = 'pending'
            AND other_turns.pending_message_id IS NOT NULL
            AND other_turns.checkpoint_turn_count IS NULL
        )
    ) AS correlation
    WHERE sessions.thread_id = correlation.thread_id
      AND sessions.status = 'starting'
      AND sessions.pending_turn_request_id IS NULL
      AND correlation.match_count > 0
  `;
});
