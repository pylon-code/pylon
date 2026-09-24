import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Older projections retained native requests after the provider session had
// stopped. The reply failure is durable, so repair the cached shell counts
// without rewriting the event history.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_pending_approvals AS pending
    SET status = 'resolved', decision = NULL, resolved_at = (
      SELECT MAX(activity.created_at)
      FROM projection_thread_activities AS activity
      WHERE activity.thread_id = pending.thread_id
        AND activity.kind = 'provider.approval.respond.failed'
        AND json_extract(activity.payload_json, '$.requestId') = pending.request_id
        AND lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
          LIKE '%no active provider session is bound to this thread%'
    )
    WHERE pending.status = 'pending'
      AND EXISTS (
        SELECT 1 FROM projection_thread_activities AS activity
        WHERE activity.thread_id = pending.thread_id
          AND activity.kind = 'provider.approval.respond.failed'
          AND json_extract(activity.payload_json, '$.requestId') = pending.request_id
          AND activity.created_at >= pending.created_at
          AND lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
            LIKE '%no active provider session is bound to this thread%'
      )
  `;

  yield* sql`
    WITH affected_threads AS (
      SELECT DISTINCT thread_id
      FROM projection_thread_activities
      WHERE kind = 'provider.user-input.respond.failed'
        AND lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
          LIKE '%no active provider session is bound to this thread%'
    )
    UPDATE projection_threads AS thread
    SET pending_approval_count = (
      SELECT COUNT(*) FROM projection_pending_approvals AS approval
      WHERE approval.thread_id = thread.thread_id AND approval.status = 'pending'
    ),
    pending_user_input_count = (
      SELECT COUNT(*) FROM (
        SELECT activity.kind,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(activity.payload_json, '$.requestId')
            ORDER BY activity.sequence DESC, activity.created_at DESC,
              CASE WHEN activity.kind IN ('user-input.requested', 'interaction.requested')
                THEN 0 ELSE 1 END DESC,
              activity.activity_id DESC
          ) AS request_order
        FROM projection_thread_activities AS activity
        WHERE activity.thread_id = thread.thread_id
          AND json_type(
            CASE WHEN json_valid(activity.payload_json) THEN activity.payload_json ELSE '{}' END,
            '$.requestId'
          ) = 'text'
          AND (
            activity.kind IN ('user-input.requested', 'user-input.resolved',
              'interaction.requested', 'interaction.resolved')
            OR (activity.kind = 'provider.user-input.respond.failed' AND (
              lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                LIKE '%no active provider session is bound to this thread%'
              OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                LIKE '%stale pending user-input request%'
              OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                LIKE '%unknown pending user-input request%'
              OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                LIKE '%unknown pending user input request%'
              OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                LIKE '%unknown pending codex user input request%'
            ))
            OR (activity.kind = 'provider.interaction.respond.failed' AND (
              lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                LIKE '%stale pending interaction request%'
              OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                LIKE '%unknown pending interaction request%'
            ))
          )
      ) AS latest
      WHERE latest.request_order = 1
        AND latest.kind IN ('user-input.requested', 'interaction.requested')
    )
    WHERE thread.thread_id IN (SELECT thread_id FROM affected_threads)
  `;

  yield* sql`
    UPDATE projection_threads AS thread
    SET pending_approval_count = (
      SELECT COUNT(*) FROM projection_pending_approvals AS approval
      WHERE approval.thread_id = thread.thread_id AND approval.status = 'pending'
    )
    WHERE EXISTS (
      SELECT 1 FROM projection_thread_activities AS activity
      WHERE activity.thread_id = thread.thread_id
        AND activity.kind = 'provider.approval.respond.failed'
        AND lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
          LIKE '%no active provider session is bound to this thread%'
    )
  `;
});
