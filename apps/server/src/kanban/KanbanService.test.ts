import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, KanbanWorkItemId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { KanbanService, layer as KanbanServiceLive } from "./KanbanService.ts";

const testLayer = it.layer(
  KanbanServiceLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const now = "2026-08-02T12:00:00.000Z";

const seedProject = Effect.fn("KanbanServiceTest.seedProject")(function* (projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id,
      title,
      workspace_root,
      default_model_selection_json,
      scripts_json,
      created_at,
      updated_at,
      deleted_at
    ) VALUES (
      ${projectId},
      ${"T3 Code"},
      ${"/tmp/t3-code"},
      ${null},
      ${"[]"},
      ${now},
      ${now},
      ${null}
    )
  `;
});

testLayer("KanbanService", (it) => {
  it.effect("persists, reorders, archives, and restores work items", () =>
    Effect.gen(function* () {
      const service = yield* KanbanService;
      const projectId = ProjectId.make("project-kanban-roundtrip");
      yield* seedProject(projectId);

      const first = yield* service.create({
        commandId: CommandId.make("command-create-first"),
        itemId: KanbanWorkItemId.make("item-first"),
        projectId,
        title: "Build the board",
      });
      const second = yield* service.create({
        commandId: CommandId.make("command-create-second"),
        itemId: KanbanWorkItemId.make("item-second"),
        projectId,
        title: "Polish the board",
      });

      assert.equal(first.position, 0);
      assert.equal(second.position, 1);

      const moved = yield* service.move({
        commandId: CommandId.make("command-move-second"),
        itemId: second.id,
        expectedRevision: second.revision,
        status: "ready",
        index: 0,
      });
      assert.equal(moved.status, "ready");
      assert.equal(moved.position, 0);

      const archived = yield* service.archive({
        commandId: CommandId.make("command-archive-second"),
        itemId: moved.id,
        expectedRevision: moved.revision,
      });
      assert.notEqual(archived.archivedAt, null);

      const restored = yield* service.restore({
        commandId: CommandId.make("command-restore-second"),
        itemId: archived.id,
        expectedRevision: archived.revision,
      });
      assert.equal(restored.archivedAt, null);
      assert.equal(restored.status, "ready");

      const snapshot = yield* service.getSnapshot;
      assert.equal(snapshot.items.length, 2);
      assert.equal(snapshot.sequence, 5);
      assert.deepStrictEqual(
        snapshot.items.map((item) => [item.id, item.status, item.position, item.archivedAt]),
        [
          [first.id, "backlog", 0, null],
          [second.id, "ready", 0, null],
        ],
      );
    }),
  );

  it.effect("deduplicates a retried command", () =>
    Effect.gen(function* () {
      const service = yield* KanbanService;
      const projectId = ProjectId.make("project-kanban-idempotency");
      yield* seedProject(projectId);
      const input = {
        commandId: CommandId.make("command-create-idempotent"),
        itemId: KanbanWorkItemId.make("item-idempotent"),
        projectId,
        title: "Create once",
      } as const;

      const first = yield* service.create(input);
      const retried = yield* service.create(input);
      const snapshot = yield* service.getSnapshot;

      assert.deepStrictEqual(retried, first);
      assert.equal(snapshot.items.filter((item) => item.id === first.id).length, 1);
    }),
  );

  it.effect("rejects work for a project outside the environment catalog", () =>
    Effect.gen(function* () {
      const service = yield* KanbanService;
      const error = yield* service
        .create({
          commandId: CommandId.make("command-invalid-project"),
          itemId: KanbanWorkItemId.make("item-invalid-project"),
          projectId: ProjectId.make("missing-project"),
          title: "Should fail",
        })
        .pipe(Effect.flip);

      assert.equal(error.code, "invalid-project");
    }),
  );
});
