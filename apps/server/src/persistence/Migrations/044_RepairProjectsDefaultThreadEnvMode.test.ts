import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  return columns.map((column) => column.name);
});

layer("044_RepairProjectsDefaultThreadEnvMode", (it) => {
  it.effect("restores the column on a database that skipped 041", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Reproduce a build that shipped session lifecycle as 41: stop before
      // 041, then claim 41 so the runner treats everything at or below it as
      // done. 042 and 043 still run; 041 never does.
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (41, 'ProjectionThreadSessionLifecycle', CURRENT_TIMESTAMP)
      `;
      yield* runMigrations({ toMigrationInclusive: 43 });

      assert.isFalse(
        (yield* columnNames).includes("default_thread_env_mode"),
        "expected the skip this migration exists to repair",
      );

      yield* runMigrations({ toMigrationInclusive: 44 });

      assert.isTrue((yield* columnNames).includes("default_thread_env_mode"));
    }),
  );

  it.effect("leaves a correctly migrated database alone", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 43 });
      const before = yield* columnNames;
      assert.isTrue(before.includes("default_thread_env_mode"));

      yield* runMigrations({ toMigrationInclusive: 44 });

      assert.deepStrictEqual(yield* columnNames, before);
    }),
  );
});
