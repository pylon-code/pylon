import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/** Monotonic server-owned generation for turns composed before/after rollback. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "source_epoch")) {
    yield* sql.unsafe(
      "ALTER TABLE projection_threads ADD COLUMN source_epoch INTEGER NOT NULL DEFAULT 0",
    );
  }
});
