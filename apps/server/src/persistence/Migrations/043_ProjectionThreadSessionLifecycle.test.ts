import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const legacyRow = {
  threadId: "thread-existing",
  status: "running",
  providerName: "primeAgent",
  providerSessionId: "session-existing",
  providerThreadId: "provider-thread-existing",
  activeTurnId: "turn-existing",
  lastError: "historical-error",
  updatedAt: "2026-08-14T00:00:00.000Z",
  runtimeMode: "full-access",
  providerInstanceId: "prime-instance",
} as const;

const readSessionRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly threadId: string;
    readonly status: string;
    readonly providerName: string | null;
    readonly providerSessionId: string | null;
    readonly providerThreadId: string | null;
    readonly activeTurnId: string | null;
    readonly lastError: string | null;
    readonly updatedAt: string;
    readonly runtimeMode: string;
    readonly providerInstanceId: string | null;
    readonly restored: number;
    readonly startedAt: string | null;
    readonly harnessRefinementStatus: string | null;
  }>`
    SELECT
      thread_id AS "threadId",
      status,
      provider_name AS "providerName",
      provider_session_id AS "providerSessionId",
      provider_thread_id AS "providerThreadId",
      active_turn_id AS "activeTurnId",
      last_error AS "lastError",
      updated_at AS "updatedAt",
      runtime_mode AS "runtimeMode",
      provider_instance_id AS "providerInstanceId",
      restored,
      started_at AS "startedAt",
      harness_refinement_status AS "harnessRefinementStatus"
    FROM projection_thread_sessions
    ORDER BY thread_id ASC
  `;
});

it.layer(NodeServices.layer)("043_ProjectionThreadSessionLifecycle", (it) => {
  it.effect("upgrades a pre-43 file database and remains idempotent after reopen", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pylon-migration-043-",
      });
      const filename = path.join(root, "state.sqlite");
      const databaseLayer = NodeSqliteClient.layer({ filename });

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 42 });
        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id,
            status,
            provider_name,
            provider_session_id,
            provider_thread_id,
            active_turn_id,
            last_error,
            updated_at,
            runtime_mode,
            provider_instance_id
          ) VALUES (
            ${legacyRow.threadId},
            ${legacyRow.status},
            ${legacyRow.providerName},
            ${legacyRow.providerSessionId},
            ${legacyRow.providerThreadId},
            ${legacyRow.activeTurnId},
            ${legacyRow.lastError},
            ${legacyRow.updatedAt},
            ${legacyRow.runtimeMode},
            ${legacyRow.providerInstanceId}
          )
        `;
      }).pipe(Effect.provide(databaseLayer), Effect.scoped);

      const rowsAfterUpgrade = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const executed = yield* runMigrations({ toMigrationInclusive: 43 });
        assert.deepStrictEqual(executed, [[43, "ProjectionThreadSessionLifecycle"]]);

        const rows = yield* readSessionRows;
        assert.deepStrictEqual(rows, [
          { ...legacyRow, restored: 0, startedAt: null, harnessRefinementStatus: null },
        ]);

        const columns = yield* sql<{
          readonly name: string;
          readonly type: string;
          readonly notNull: number;
          readonly dfltValue: string | null;
        }>`
          SELECT
            name,
            type,
            "notnull" AS "notNull",
            dflt_value AS "dfltValue"
          FROM pragma_table_info('projection_thread_sessions')
        `;
        const byName = new Map(columns.map((column) => [column.name, column]));
        assert.deepStrictEqual(byName.get("restored"), {
          name: "restored",
          type: "INTEGER",
          notNull: 1,
          dfltValue: "0",
        });
        assert.deepStrictEqual(byName.get("started_at"), {
          name: "started_at",
          type: "TEXT",
          notNull: 0,
          dfltValue: null,
        });
        assert.deepStrictEqual(byName.get("harness_refinement_status"), {
          name: "harness_refinement_status",
          type: "TEXT",
          notNull: 0,
          dfltValue: null,
        });

        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id,
            status,
            updated_at,
            runtime_mode
          ) VALUES (
            'thread-new',
            'ready',
            '2026-08-14T01:00:00.000Z',
            'full-access'
          )
        `;
        return yield* readSessionRows;
      }).pipe(Effect.provide(databaseLayer), Effect.scoped);

      const rowsAfterReopen = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const executed = yield* runMigrations({ toMigrationInclusive: 43 });
        assert.deepStrictEqual(executed, []);
        const migrationRows = yield* sql<{
          readonly migrationId: number;
          readonly name: string;
        }>`
          SELECT migration_id AS "migrationId", name
          FROM effect_sql_migrations
          WHERE migration_id = 43
        `;
        assert.deepStrictEqual(migrationRows, [
          { migrationId: 43, name: "ProjectionThreadSessionLifecycle" },
        ]);
        return yield* readSessionRows;
      }).pipe(Effect.provide(databaseLayer), Effect.scoped);

      assert.deepStrictEqual(rowsAfterReopen, rowsAfterUpgrade);
      assert.deepStrictEqual(rowsAfterReopen, [
        { ...legacyRow, restored: 0, startedAt: null, harnessRefinementStatus: null },
        {
          threadId: "thread-new",
          status: "ready",
          providerName: null,
          providerSessionId: null,
          providerThreadId: null,
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-08-14T01:00:00.000Z",
          runtimeMode: "full-access",
          providerInstanceId: null,
          restored: 0,
          startedAt: null,
          harnessRefinementStatus: null,
        },
      ]);
    }),
  );
});
