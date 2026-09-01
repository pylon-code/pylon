import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/** Private rollback state. Nothing in these tables is projected or sent to clients. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const projectionColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_threads)`;
  const projectionColumnNames = new Set(projectionColumns.map((column) => column.name));
  if (!projectionColumnNames.has("rollback_status")) {
    yield* sql.unsafe("ALTER TABLE projection_threads ADD COLUMN rollback_status TEXT");
  }
  if (!projectionColumnNames.has("rollback_updated_at")) {
    yield* sql.unsafe("ALTER TABLE projection_threads ADD COLUMN rollback_updated_at TEXT");
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS rollback_sagas (
      operation_id TEXT PRIMARY KEY,
      request_event_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      phase TEXT NOT NULL,
      terminal INTEGER NOT NULL DEFAULT 0,
      owner_id TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      private_state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rollback_sagas_active_thread
    ON rollback_sagas(thread_id) WHERE terminal = 0
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_rollback_sagas_nonterminal
    ON rollback_sagas(terminal, created_at, operation_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS rollback_workspace_leases (
      workspace_key TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      FOREIGN KEY (operation_id) REFERENCES rollback_sagas(operation_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS rollback_checkpoint_anchors (
      thread_id TEXT NOT NULL,
      checkpoint_turn_count INTEGER NOT NULL,
      provider_instance_id TEXT NOT NULL,
      session_incarnation_id TEXT NOT NULL,
      checkpoint_ref TEXT NOT NULL,
      checkpoint_oid TEXT NOT NULL,
      anchor_json TEXT NOT NULL,
      anchor_digest TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (
        thread_id,
        checkpoint_turn_count,
        provider_instance_id,
        session_incarnation_id
      )
    )
  `;
});
