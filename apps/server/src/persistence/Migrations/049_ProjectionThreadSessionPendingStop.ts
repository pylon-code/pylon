import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const pendingStopColumns = [
  ["pending_stop_request_id", "TEXT"],
  ["pending_stop_provider_instance_id", "TEXT"],
  ["pending_stop_session_incarnation_id", "TEXT"],
  ["pending_stop_turn_request_id", "TEXT"],
  ["pending_stop_turn_id", "TEXT"],
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  const existing = new Set(columns.map((column) => column.name));
  for (const [name, type] of pendingStopColumns) {
    if (!existing.has(name)) {
      yield* sql.unsafe(`ALTER TABLE projection_thread_sessions ADD COLUMN ${name} ${type}`);
    }
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_pending_stop
    ON projection_thread_sessions(pending_stop_request_id, thread_id)
  `;
});
