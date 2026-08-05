import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records the thread a continuation was handed off from.
 *
 * Nullable with no backfill: every thread that existed before cross-account
 * handoff started its own work, so an absent value is the correct answer for
 * all of them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "continued_from_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN continued_from_thread_id TEXT
    `;
  }
});
