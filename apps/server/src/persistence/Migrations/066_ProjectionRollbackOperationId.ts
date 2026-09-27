import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/** Keep the public rollback operation identity with its projected shell state. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "rollback_operation_id")) {
    yield* sql.unsafe("ALTER TABLE projection_threads ADD COLUMN rollback_operation_id TEXT");
  }
});
