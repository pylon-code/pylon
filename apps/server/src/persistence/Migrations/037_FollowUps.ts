import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS follow_up_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      command_id TEXT NOT NULL UNIQUE,
      item_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS follow_ups (
      item_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      observation TEXT NOT NULL,
      defer_reason TEXT NOT NULL,
      verify_check TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      gate_json TEXT,
      source_kind TEXT NOT NULL,
      source_thread_id TEXT,
      resolution_json TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS follow_ups_project_status_idx
    ON follow_ups(project_id, status, kind, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS follow_ups_gate_idx
    ON follow_ups(status, kind, gate_json)
  `;
});
