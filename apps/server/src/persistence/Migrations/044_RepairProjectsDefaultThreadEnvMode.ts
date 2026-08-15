import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repairs installs that skipped migration 041.
 *
 * Some builds shipped `ProjectionThreadSessionLifecycle` as id 41 before this
 * branch settled on 041 = `ProjectionProjectsDefaultThreadEnvMode`, 042 =
 * `ProjectionProjectFaviconPath`, 043 = session lifecycle. The runner only
 * applies ids above the highest one recorded, so a database written by such a
 * build reports 41 as done, runs 042 and 043, and never runs 041 — leaving
 * `projection_projects` without `default_thread_env_mode`. Every project query
 * then fails with `no such column`, which takes the server down at startup.
 *
 * Renumbering after release is what caused this, so the fix cannot be another
 * renumber: those databases would still skip whatever sits below their high
 * water mark. A new migration above it is the only thing they will run.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "default_thread_env_mode")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN default_thread_env_mode TEXT
    `;
  }
});
