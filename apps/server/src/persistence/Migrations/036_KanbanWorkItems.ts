import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS kanban_events (
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
    CREATE TABLE IF NOT EXISTS kanban_work_items (
      item_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      position INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kanban_events_item_sequence
    ON kanban_events(item_id, sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kanban_work_items_board_order
    ON kanban_work_items(archived_at, status, position, item_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kanban_work_items_project
    ON kanban_work_items(project_id, archived_at, status, position)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_kanban_work_items_thread
    ON kanban_work_items(thread_id)
  `;
});
