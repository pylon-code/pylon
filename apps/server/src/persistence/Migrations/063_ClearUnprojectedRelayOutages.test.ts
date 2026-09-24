import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "063_ClearUnprojectedRelayOutages",
  (it) => {
    it.effect("drops outages for workers a thread never started and keeps the rest", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 62 });

        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES
            ('relay-observer-unavailable:job-historical:1', 'thread-a', 'info', 'task.progress',
              'Relay observer unavailable',
              '{"taskId":"relay:job-historical","status":"idle","summary":"Relay observer unavailable"}',
              1, '2026-09-24T21:16:16.382Z'),
            ('relay-start:job-live:1', 'thread-a', 'info', 'task.started',
              'Relay worker started', '{"taskId":"relay:job-live","attempt":1}',
              2, '2026-09-24T20:00:00.000Z'),
            ('relay-observer-unavailable:job-live:1', 'thread-a', 'info', 'task.progress',
              'Relay observer unavailable',
              '{"taskId":"relay:job-live","status":"idle","summary":"Relay observer unavailable"}',
              3, '2026-09-24T21:16:16.400Z'),
            ('relay-progress:job-historical', 'thread-a', 'info', 'task.progress',
              'Relay worker', '{"taskId":"relay:job-historical","status":"running"}',
              4, '2026-09-24T21:16:16.500Z'),
            ('relay-observer-unavailable:job-other-thread:1', 'thread-b', 'info', 'task.progress',
              'Relay observer unavailable',
              '{"taskId":"relay:job-other-thread","status":"idle"}',
              5, '2026-09-24T21:16:16.600Z'),
            ('relay-start:job-other-thread:1', 'thread-c', 'info', 'task.started',
              'Relay worker started', '{"taskId":"relay:job-other-thread","attempt":1}',
              6, '2026-09-24T20:00:00.000Z')
        `;

        yield* runMigrations({ toMigrationInclusive: 63 });

        const remaining = yield* sql`
          SELECT activity_id AS activityId FROM projection_thread_activities
          ORDER BY activity_id
        `;
        assert.deepStrictEqual(
          remaining.map((row) => (row as { activityId: string }).activityId),
          [
            // A worker the thread started keeps the row that explains it.
            "relay-observer-unavailable:job-live:1",
            "relay-progress:job-historical",
            "relay-start:job-live:1",
            "relay-start:job-other-thread:1",
          ],
        );
      }),
    );
  },
);
