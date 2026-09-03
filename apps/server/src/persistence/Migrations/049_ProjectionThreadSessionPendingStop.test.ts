import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

it.layer(NodeServices.layer)("049_ProjectionThreadSessionPendingStop", (it) => {
  it.effect("adds the exact pending-stop target columns and remains idempotent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pylon-migration-049-",
      });
      const databaseLayer = NodeSqliteClient.layer({ filename: path.join(root, "state.sqlite") });

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 48 });
        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id,
            status,
            provider_name,
            provider_instance_id,
            runtime_mode,
            restored,
            session_incarnation_id,
            active_turn_id,
            last_error,
            updated_at
          ) VALUES (
            'thread-pending-stop',
            'stopped',
            'codex',
            'codex',
            'approval-required',
            0,
            'session-pending-stop',
            NULL,
            NULL,
            '2026-01-01T00:00:00.000Z'
          )
        `;

        const executed = yield* runMigrations({ toMigrationInclusive: 49 });
        assert.deepStrictEqual(executed, [[49, "ProjectionThreadSessionPendingStop"]]);
        const columns = yield* sql<{ readonly name: string; readonly type: string }>`
          SELECT name, type
          FROM pragma_table_info('projection_thread_sessions')
          WHERE name LIKE 'pending_stop_%'
          ORDER BY cid ASC
        `;
        assert.deepStrictEqual(columns, [
          { name: "pending_stop_request_id", type: "TEXT" },
          { name: "pending_stop_provider_instance_id", type: "TEXT" },
          { name: "pending_stop_session_incarnation_id", type: "TEXT" },
          { name: "pending_stop_turn_request_id", type: "TEXT" },
          { name: "pending_stop_turn_id", type: "TEXT" },
        ]);
        const indexes = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM pragma_index_list('projection_thread_sessions')
          WHERE name = 'idx_projection_thread_sessions_pending_stop'
        `;
        assert.deepStrictEqual(indexes, [{ name: "idx_projection_thread_sessions_pending_stop" }]);
        yield* sql`
          UPDATE projection_thread_sessions
          SET
            pending_stop_request_id = 'cmd-stop',
            pending_stop_provider_instance_id = 'codex',
            pending_stop_session_incarnation_id = 'session-pending-stop',
            pending_stop_turn_request_id = 'cmd-turn',
            pending_stop_turn_id = 'turn-1'
          WHERE thread_id = 'thread-pending-stop'
        `;
      }).pipe(Effect.provide(databaseLayer), Effect.scoped);

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 49 }), []);
        const rows = yield* sql<{
          readonly requestId: string;
          readonly providerInstanceId: string;
          readonly sessionIncarnationId: string;
          readonly turnRequestId: string;
          readonly turnId: string;
        }>`
          SELECT
            pending_stop_request_id AS "requestId",
            pending_stop_provider_instance_id AS "providerInstanceId",
            pending_stop_session_incarnation_id AS "sessionIncarnationId",
            pending_stop_turn_request_id AS "turnRequestId",
            pending_stop_turn_id AS "turnId"
          FROM projection_thread_sessions
          WHERE thread_id = 'thread-pending-stop'
        `;
        assert.deepStrictEqual(rows, [
          {
            requestId: "cmd-stop",
            providerInstanceId: "codex",
            sessionIncarnationId: "session-pending-stop",
            turnRequestId: "cmd-turn",
            turnId: "turn-1",
          },
        ]);
      }).pipe(Effect.provide(databaseLayer), Effect.scoped);
    }),
  );
});
