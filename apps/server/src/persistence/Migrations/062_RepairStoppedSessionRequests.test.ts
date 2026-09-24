import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "062_RepairStoppedSessionRequests",
  (it) => {
    it.effect("repairs orphaned requests without dropping other pending work", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 61 });

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, created_at, updated_at,
            pending_approval_count, pending_user_input_count
          ) VALUES
            ('thread-affected', 'project-1', 'Affected', '2026-09-24T00:00:00.000Z',
              '2026-09-24T00:00:00.000Z', 1, 3),
            ('thread-other', 'project-1', 'Other', '2026-09-24T00:00:00.000Z',
              '2026-09-24T00:00:00.000Z', 0, 1)
        `;
        yield* sql`
          INSERT INTO projection_pending_approvals (
            request_id, thread_id, status, created_at
          ) VALUES ('approval-orphaned', 'thread-affected', 'pending',
            '2026-09-24T00:00:01.000Z')
        `;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES
            ('input-orphaned', 'thread-affected', 'approval', 'user-input.requested',
              'Question', '{"requestId":"input-orphaned"}', 1, '2026-09-24T00:00:01.000Z'),
            ('input-retryable', 'thread-affected', 'approval', 'user-input.requested',
              'Question', '{"requestId":"input-retryable"}', 2, '2026-09-24T00:00:02.000Z'),
            ('interaction-open', 'thread-affected', 'approval', 'interaction.requested',
              'Interaction', '{"requestId":"interaction-open"}', 3, '2026-09-24T00:00:03.000Z'),
            ('input-orphaned-failed', 'thread-affected', 'error',
              'provider.user-input.respond.failed', 'Reply failed',
              '{"requestId":"input-orphaned","detail":"No active provider session is bound to this thread."}',
              4, '2026-09-24T00:00:04.000Z'),
            ('input-retryable-failed', 'thread-affected', 'error',
              'provider.user-input.respond.failed', 'Reply failed',
              '{"requestId":"input-retryable","detail":"Provider timeout"}',
              5, '2026-09-24T00:00:05.000Z'),
            ('approval-orphaned-failed', 'thread-affected', 'error',
              'provider.approval.respond.failed', 'Approval failed',
              '{"requestId":"approval-orphaned","detail":"No active provider session is bound to this thread."}',
              6, '2026-09-24T00:00:06.000Z'),
            ('malformed-tool', 'thread-affected', 'tool', 'tool.completed',
              'Tool completed', '{not-json', 7, '2026-09-24T00:00:07.000Z')
        `;

        yield* runMigrations({ toMigrationInclusive: 62 });

        const threads = yield* sql<{
          readonly threadId: string;
          readonly pendingApprovalCount: number;
          readonly pendingUserInputCount: number;
        }>`
          SELECT thread_id AS "threadId", pending_approval_count AS "pendingApprovalCount",
            pending_user_input_count AS "pendingUserInputCount"
          FROM projection_threads ORDER BY thread_id
        `;
        assert.deepStrictEqual(threads, [
          { threadId: "thread-affected", pendingApprovalCount: 0, pendingUserInputCount: 2 },
          { threadId: "thread-other", pendingApprovalCount: 0, pendingUserInputCount: 1 },
        ]);

        const approvals = yield* sql<{ readonly status: string }>`
          SELECT status FROM projection_pending_approvals WHERE request_id = 'approval-orphaned'
        `;
        assert.deepStrictEqual(approvals, [{ status: "resolved" }]);
      }),
    );
  },
);
