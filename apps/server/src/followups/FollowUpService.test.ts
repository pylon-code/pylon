import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, FollowUpId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
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

const seedProject = Effect.fn("FollowUpServiceTest.seedProject")(function* (
  projectId: ProjectId,
  workspaceRoot = `/tmp/${projectId}`,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json,
        scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        ${projectId}, ${"Pylon"}, ${workspaceRoot}, ${null},
        ${"[]"}, ${now}, ${now}, ${null}
      )
    `;
});

const seedThread = Effect.fn("FollowUpServiceTest.seedThread")(function* (
  threadId: ThreadId,
  projectId: ProjectId,
  worktreePath: string | null = null,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, branch, worktree_path, latest_turn_id,
      latest_user_message_at, pending_approval_count, pending_user_input_count,
      has_actionable_proposed_plan, created_at, updated_at, deleted_at
    ) VALUES (
      ${threadId}, ${projectId}, ${"Follow-up thread"},
      ${'{"provider":"codex","model":"gpt-5-codex"}'}, ${"full-access"},
      ${"default"}, ${null}, ${worktreePath}, ${null}, ${null}, 0, 0, 0,
      ${now}, ${now}, ${null}
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
        projectId,
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
      const snapshot = yield* service.getSnapshot(projectId);

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

      const before = yield* service.openBlockersForBranch(projectId, "feature/x");
      assert.equal(before.length, 1);

      yield* service.updateStatus({
        commandId: CommandId.make("command-clear-other"),
        itemId: other.id,
        projectId,
        expectedRevision: other.revision,
        status: "resolved",
        actor: "agent",
        resolution: { note: "Done.", threadId: null, commitSha: null },
      });
      const otherAfter = yield* service.openBlockersForBranch(projectId, "feature/y");
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

  it.effect("isolates snapshots and same-named branch gates by project", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const firstProjectId = ProjectId.make("project-isolation-first");
      const secondProjectId = ProjectId.make("project-isolation-second");
      yield* seedProject(firstProjectId);
      yield* seedProject(secondProjectId);

      const first = yield* service.file({
        commandId: CommandId.make("command-isolation-first"),
        itemId: FollowUpId.make("item-isolation-first"),
        projectId: firstProjectId,
        kind: "blocker",
        title: "First project blocker",
        observation: "First project only.",
        deferReason: "out-of-scope",
        verifyCheck: "Check the first project.",
        gate: { kind: "branch", ref: "feature/shared" },
        sourceKind: "agent",
      });
      yield* service.file({
        commandId: CommandId.make("command-isolation-second"),
        itemId: FollowUpId.make("item-isolation-second"),
        projectId: secondProjectId,
        kind: "blocker",
        title: "Second project blocker",
        observation: "Second project only.",
        deferReason: "out-of-scope",
        verifyCheck: "Check the second project.",
        gate: { kind: "branch", ref: "feature/shared" },
        sourceKind: "agent",
      });

      const firstSnapshot = yield* service.getSnapshot(firstProjectId);
      const secondSnapshot = yield* service.getSnapshot(secondProjectId);
      const firstGate = yield* service.openBlockersForBranch(firstProjectId, "feature/shared");
      const secondGate = yield* service.openBlockersForBranch(secondProjectId, "feature/shared");

      assert.deepStrictEqual(
        firstSnapshot.items.map((item) => item.id),
        [first.id],
      );
      assert.deepStrictEqual(
        secondSnapshot.items.map((item) => item.id),
        [FollowUpId.make("item-isolation-second")],
      );
      assert.deepStrictEqual(
        firstGate.map((item) => item.title),
        ["First project blocker"],
      );
      assert.deepStrictEqual(
        secondGate.map((item) => item.title),
        ["Second project blocker"],
      );
    }),
  );

  it.effect("rejects cross-project mutation and idempotency replay", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const firstProjectId = ProjectId.make("project-owner-first");
      const secondProjectId = ProjectId.make("project-owner-second");
      yield* seedProject(firstProjectId);
      yield* seedProject(secondProjectId);

      const filed = yield* service.file({
        commandId: CommandId.make("command-owner-file"),
        itemId: FollowUpId.make("item-owner"),
        projectId: firstProjectId,
        kind: "open",
        title: "Owned by first",
        observation: "Must stay in the first project.",
        deferReason: "out-of-scope",
        verifyCheck: "Check ownership.",
        sourceKind: "agent",
      });

      const mutationError = yield* service
        .updateStatus({
          commandId: CommandId.make("command-owner-cross-update"),
          itemId: filed.id,
          projectId: secondProjectId,
          expectedRevision: filed.revision,
          status: "resolved",
          actor: "agent",
          resolution: { note: "Spoofed.", threadId: null, commitSha: null },
        })
        .pipe(Effect.flip);
      assert.equal(mutationError.code, "invalid-project");

      const replayError = yield* service
        .file({
          commandId: CommandId.make("command-owner-file"),
          itemId: FollowUpId.make("item-owner-replayed"),
          projectId: secondProjectId,
          kind: "open",
          title: "Replay in second",
          observation: "Must not reveal the first item.",
          deferReason: "out-of-scope",
          verifyCheck: "Check replay scope.",
          sourceKind: "agent",
        })
        .pipe(Effect.flip);
      assert.equal(replayError.code, "invalid-project");

      const snapshot = yield* service.getSnapshot(firstProjectId);
      assert.equal(snapshot.items[0]?.status, "open");
      assert.equal(snapshot.items[0]?.revision, 0);
    }),
  );

  it.effect("validates resolution threads against the follow-up project", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const projectId = ProjectId.make("project-resolution-thread");
      const otherProjectId = ProjectId.make("project-resolution-thread-other");
      const sameProjectThreadId = ThreadId.make("thread-resolution-same");
      const otherProjectThreadId = ThreadId.make("thread-resolution-other");
      yield* seedProject(projectId);
      yield* seedProject(otherProjectId);
      yield* seedThread(sameProjectThreadId, projectId);
      yield* seedThread(otherProjectThreadId, otherProjectId);

      const sameProjectItem = yield* service.file({
        commandId: CommandId.make("command-resolution-same-file"),
        itemId: FollowUpId.make("item-resolution-same"),
        projectId,
        kind: "open",
        title: "Resolve in a thread",
        observation: "A linked thread should belong to this project.",
        deferReason: "out-of-scope",
        verifyCheck: "Open the linked thread.",
        sourceKind: "human",
      });
      const resolved = yield* service.updateStatus({
        commandId: CommandId.make("command-resolution-same-update"),
        itemId: sameProjectItem.id,
        projectId,
        expectedRevision: sameProjectItem.revision,
        status: "resolved",
        actor: "human",
        resolution: { note: "Handled there.", threadId: sameProjectThreadId, commitSha: null },
      });
      assert.equal(resolved.resolution?.threadId, sameProjectThreadId);

      const crossProjectItem = yield* service.file({
        commandId: CommandId.make("command-resolution-cross-file"),
        itemId: FollowUpId.make("item-resolution-cross"),
        projectId,
        kind: "open",
        title: "Reject another project",
        observation: "The resolution link must not cross projects.",
        deferReason: "out-of-scope",
        verifyCheck: "Check the linked thread project.",
        sourceKind: "human",
      });
      const error = yield* service
        .updateStatus({
          commandId: CommandId.make("command-resolution-cross-update"),
          itemId: crossProjectItem.id,
          projectId,
          expectedRevision: crossProjectItem.revision,
          status: "resolved",
          actor: "human",
          resolution: {
            note: "Wrong project.",
            threadId: otherProjectThreadId,
            commitSha: null,
          },
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "invalid-thread");

      const snapshot = yield* service.getSnapshot(projectId);
      const unchanged = snapshot.items.find((item) => item.id === crossProjectItem.id);
      assert.equal(unchanged?.status, "open");
      assert.equal(unchanged?.revision, 0);
    }),
  );

  it.effect("derives MCP and repository project authority from persisted projections", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const projectId = ProjectId.make("project-authority");
      const threadId = ThreadId.make("thread-authority");
      const workspaceRoot = "/tmp/followup-authority-root";
      const worktreePath = "/tmp/followup-authority-worktree";
      yield* seedProject(projectId, workspaceRoot);
      yield* seedThread(threadId, projectId, worktreePath);

      assert.equal(yield* service.projectIdForThread(threadId), projectId);
      assert.equal(yield* service.projectIdForRepositoryPath(workspaceRoot), projectId);
      assert.equal(yield* service.projectIdForRepositoryPath(worktreePath), projectId);
    }),
  );

  it.effect("serializes concurrent revisions so exactly one update wins", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const projectId = ProjectId.make("project-concurrent-revision");
      yield* seedProject(projectId);
      const filed = yield* service.file({
        commandId: CommandId.make("command-concurrent-file"),
        itemId: FollowUpId.make("item-concurrent"),
        projectId,
        kind: "open",
        title: "Concurrent close",
        observation: "Only one close can win revision zero.",
        deferReason: "out-of-scope",
        verifyCheck: "Inspect the final revision.",
        sourceKind: "agent",
      });

      const results = yield* Effect.all(
        ["first", "second"].map((suffix) =>
          service
            .updateStatus({
              commandId: CommandId.make(`command-concurrent-${suffix}`),
              itemId: filed.id,
              projectId,
              expectedRevision: 0,
              status: "resolved",
              actor: "agent",
              resolution: { note: `${suffix} resolution`, threadId: null, commitSha: null },
            })
            .pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      );

      assert.equal(results.filter(Result.isSuccess).length, 1);
      const failures = results.filter(Result.isFailure);
      assert.equal(failures.length, 1);
      const snapshot = yield* service.getSnapshot(projectId);
      assert.equal(snapshot.items[0]?.revision, 1);
      assert.equal(snapshot.items[0]?.status, "resolved");
    }),
  );

  it.effect("persists validation outcomes and only evidence-backed moot closes", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const projectId = ProjectId.make("project-validation-history");
      const threadId = ThreadId.make("thread-validation-history");
      yield* seedProject(projectId);
      yield* seedThread(threadId, projectId);
      const filed = yield* service.file({
        commandId: CommandId.make("command-validation-file"),
        itemId: FollowUpId.make("item-validation-history"),
        projectId,
        kind: "open",
        title: "Recheck the edge case",
        observation: "The edge case may have changed.",
        deferReason: "out-of-scope",
        verifyCheck: "Run the focused edge-case check.",
        sourceKind: "agent",
        sourceThreadId: threadId,
      });

      const stillNeededInput = {
        commandId: CommandId.make("command-validation-still-needed"),
        itemId: filed.id,
        projectId,
        expectedRevision: filed.revision,
        outcome: "still-needed" as const,
        verifyCheck: filed.verifyCheck,
        note: "The focused check still fails.",
        evidence: [],
        checkedCommitSha: null,
        threadId,
      };
      const stillNeeded = yield* service.recordValidation(stillNeededInput);
      const replayed = yield* service.recordValidation(stillNeededInput);
      assert.deepStrictEqual(replayed, stillNeeded);
      assert.equal(stillNeeded.status, "open");
      assert.equal(stillNeeded.lastValidation?.outcome, "still-needed");

      const moot = yield* service.recordValidation({
        commandId: CommandId.make("command-validation-moot"),
        itemId: filed.id,
        projectId,
        expectedRevision: stillNeeded.revision,
        outcome: "moot",
        verifyCheck: filed.verifyCheck,
        note: "The obsolete path was removed.",
        evidence: [{ path: "src/obsolete.ts", line: null, commitSha: "abc123" }],
        checkedCommitSha: "abc123",
        threadId,
      });
      assert.equal(moot.status, "moot");
      assert.equal(moot.resolution?.threadId, threadId);
      assert.equal(moot.lastValidation?.outcome, "moot");

      const sql = yield* SqlClient.SqlClient;
      const eventTypes = yield* sql<{ readonly event_type: string }>`
        SELECT event_type FROM follow_up_events
        WHERE item_id = ${filed.id}
        ORDER BY sequence
      `;
      assert.deepStrictEqual(
        eventTypes.map((row) => row.event_type),
        ["follow-up.filed", "follow-up.validated", "follow-up.validated"],
      );
    }),
  );

  it.effect("streams a project snapshot and the next concurrent event without a gap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* FollowUpService;
        const projectId = ProjectId.make("project-stream-gap");
        yield* seedProject(projectId);
        const snapshotSeen = yield* Deferred.make<void>();
        const collectedFiber = yield* service.stream(projectId).pipe(
          Stream.tap((item) =>
            item.kind === "snapshot" ? Deferred.succeed(snapshotSeen, undefined) : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );

        yield* Deferred.await(snapshotSeen);
        yield* service.file({
          commandId: CommandId.make("command-stream-gap"),
          itemId: FollowUpId.make("item-stream-gap"),
          projectId,
          kind: "open",
          title: "Arrives after snapshot",
          observation: "The subscription was already attached.",
          deferReason: "out-of-scope",
          verifyCheck: "Observe both stream items.",
          sourceKind: "agent",
        });

        const items = Array.from(yield* Fiber.join(collectedFiber));
        assert.equal(items.length, 2);
        assert.equal(items[0]?.kind, "snapshot");
        assert.equal(items[1]?.kind, "event");
        if (items[0]?.kind === "snapshot" && items[1]?.kind === "event") {
          assert.equal(items[1].event.sequence, items[0].snapshot.sequence + 1);
          assert.equal(items[1].event.payload.item.projectId, projectId);
        }
      }),
    ),
  );
});
