import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Historical rows have no provable title provenance. Keep them null; future
// manual and generated title events record a command-correlated version.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "title_state_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
  }
});
