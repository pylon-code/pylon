import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("064_PullRequestFilesViewed", (it) => {
  it.effect("creates viewed-file storage after the Relay recovery migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });
      const before = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_request_files_viewed'
        `;
      assert.deepStrictEqual(before, []);

      yield* runMigrations({ toMigrationInclusive: 64 });
      const after = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_request_files_viewed'
        `;
      assert.deepStrictEqual(after, [{ name: "pull_request_files_viewed" }]);
    }),
  );
});
