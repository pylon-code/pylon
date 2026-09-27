import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "066_ProjectionRollbackOperationId",
  (it) => {
    it.effect("adds nullable rollback identity after the current migration lineage", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 65 });
        const before = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
        assert.isFalse(before.some((column) => column.name === "rollback_operation_id"));
        yield* runMigrations({ toMigrationInclusive: 66 });
        const after = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
        const operationId = after.find((column) => column.name === "rollback_operation_id");
        assert.ok(operationId);
        assert.equal(operationId.notnull, 0);
      }),
    );
  },
);
