import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// The Relay worker bridge adopts every persisted Relay receipt on boot, so its
// first run bound each historical job an environment had ever dispatched. Those
// jobs were long gone, and the failed observation published an idle outage row
// into the turn that had launched them -- reopening a thread showed a wall of
// stale workers. The bridge no longer announces a worker it never started;
// clear the rows it already wrote without rewriting the event history.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DELETE FROM projection_thread_activities AS outage
    WHERE outage.kind = 'task.progress'
      AND outage.activity_id LIKE 'relay-observer-unavailable:%'
      AND NOT EXISTS (
        SELECT 1 FROM projection_thread_activities AS started
        WHERE started.thread_id = outage.thread_id
          AND started.kind = 'task.started'
          AND CASE WHEN json_valid(started.payload_json)
            THEN json_extract(started.payload_json, '$.taskId') END
            = CASE WHEN json_valid(outage.payload_json)
              THEN json_extract(outage.payload_json, '$.taskId') END
      )
  `;
});
