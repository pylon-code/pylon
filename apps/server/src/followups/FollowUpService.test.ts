import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, FollowUpId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { FollowUpService, layer as FollowUpServiceLive } from "./FollowUpService.ts";

const testLayer = it.layer(
  FollowUpServiceLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const now = "2026-08-04T12:00:00.000Z";

const seedProject = Effect.fn("FollowUpServiceTest.seedProject")(function* (projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, ${"Pylon"}, ${"/tmp/pylon"}, ${null},
      ${"[]"}, ${now}, ${now}, ${null}
    )
  `;
});

testLayer("FollowUpService", (it) => {
  it.effect("files and resolves a follow-up", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const projectId = ProjectId.make("project-followups");
      yield* seedProject(projectId);

      const filed = yield* service.file({
        commandId: CommandId.make("command-file"),
        itemId: FollowUpId.make("item-1"),
        projectId,
        kind: "open",
        title: "Check the picker",
        observation: "Showed a raw id during unrelated work.",
        deferReason: "out-of-scope",
        verifyCheck: "Open the picker — does it show a name?",
        sourceKind: "agent",
      });
      assert.equal(filed.status, "open");
      assert.equal(filed.revision, 0);

      const resolved = yield* service.updateStatus({
        commandId: CommandId.make("command-resolve"),
        itemId: filed.id,
        expectedRevision: filed.revision,
        status: "resolved",
        actor: "agent",
        resolution: { note: "Fixed.", threadId: null, commitSha: null },
      });
      assert.equal(resolved.status, "resolved");
      assert.equal(resolved.revision, 1);
    }),
  );

  it.effect("deduplicates a retried command", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const projectId = ProjectId.make("project-idempotent");
      yield* seedProject(projectId);
      const input = {
        commandId: CommandId.make("command-idempotent"),
        itemId: FollowUpId.make("item-idempotent"),
        projectId,
        kind: "open",
        title: "File once",
        observation: "Only one row should exist.",
        deferReason: "out-of-scope",
        verifyCheck: "Count the rows.",
        sourceKind: "agent",
      } as const;

      const first = yield* service.file(input);
      const retried = yield* service.file(input);
      const snapshot = yield* service.getSnapshot;

      assert.deepStrictEqual(retried, first);
      assert.equal(snapshot.items.filter((item) => item.id === first.id).length, 1);
    }),
  );

  it.effect("reports open blockers for a branch and ignores resolved ones", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const projectId = ProjectId.make("project-gate");
      yield* seedProject(projectId);

      yield* service.file({
        commandId: CommandId.make("command-blocker"),
        itemId: FollowUpId.make("item-blocker"),
        projectId,
        kind: "blocker",
        title: "A11y regression",
        observation: "Nested interactive controls.",
        deferReason: "needs-decision",
        verifyCheck: "Does the wrapper still nest buttons?",
        gate: { kind: "branch", ref: "feature/x" },
        sourceKind: "agent",
      });
      const other = yield* service.file({
        commandId: CommandId.make("command-blocker-other"),
        itemId: FollowUpId.make("item-blocker-other"),
        projectId,
        kind: "blocker",
        title: "Other branch",
        observation: "Unrelated.",
        deferReason: "out-of-scope",
        verifyCheck: "n/a",
        gate: { kind: "branch", ref: "feature/y" },
        sourceKind: "agent",
      });

      const before = yield* service.openBlockersForBranch("feature/x");
      assert.equal(before.length, 1);

      yield* service.updateStatus({
        commandId: CommandId.make("command-clear-other"),
        itemId: other.id,
        expectedRevision: other.revision,
        status: "resolved",
        actor: "agent",
        resolution: { note: "Done.", threadId: null, commitSha: null },
      });
      const otherAfter = yield* service.openBlockersForBranch("feature/y");
      assert.equal(otherAfter.length, 0);
    }),
  );

  it.effect("rejects a follow-up for an unknown project", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const error = yield* service
        .file({
          commandId: CommandId.make("command-bad-project"),
          itemId: FollowUpId.make("item-bad-project"),
          projectId: ProjectId.make("missing-project"),
          kind: "open",
          title: "Should fail",
          observation: "No such project.",
          deferReason: "out-of-scope",
          verifyCheck: "n/a",
          sourceKind: "agent",
        })
        .pipe(Effect.flip);

      assert.equal(error.code, "invalid-project");
    }),
  );
});
