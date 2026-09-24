import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("064_ProjectionThreadTitleState", (it) => {
  it.effect("adds nullable title provenance for historical rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      const viewedTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_request_files_viewed'
      `;
      assert.equal(viewedTables.length, 1);
      yield* runMigrations({ toMigrationInclusive: 64 });
      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
          PRAGMA table_info(projection_threads)
        `;
      const titleState = columns.find((column) => column.name === "title_state_json");
      assert.ok(titleState);
      assert.equal(titleState.notnull, 0);
    }),
  );
});
