import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!columns.some((column) => column.name === "restored")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN restored INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!columns.some((column) => column.name === "started_at")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN started_at TEXT
    `;
  }
  if (!columns.some((column) => column.name === "harness_refinement_status")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN harness_refinement_status TEXT
    `;
  }
});
