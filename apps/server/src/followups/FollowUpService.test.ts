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

  it.effect("rejects a public snapshot for an unknown project", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const error = yield* service
        .getSnapshot(ProjectId.make("missing-snapshot-project"))
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

  it.effect("rejects a new command that reuses an item id owned by another project", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const firstProjectId = ProjectId.make("project-global-id-first");
      const secondProjectId = ProjectId.make("project-global-id-second");
      const itemId = FollowUpId.make("item-global-owner");
      yield* seedProject(firstProjectId);
      yield* seedProject(secondProjectId);

      yield* service.file({
        commandId: CommandId.make("command-global-id-first"),
        itemId,
        projectId: firstProjectId,
        kind: "blocker",
        title: "Original blocker",
        observation: "This blocker must remain owned by the first project.",
        deferReason: "needs-decision",
        verifyCheck: "Confirm the first project still owns the blocker.",
        gate: { kind: "branch", ref: "feature/original-gate" },
        sourceKind: "agent",
      });

      const error = yield* service
        .file({
          commandId: CommandId.make("command-global-id-second"),
          itemId,
          projectId: secondProjectId,
          kind: "open",
          title: "Attempted replacement",
          observation: "This must not replace or re-home the original blocker.",
          deferReason: "out-of-scope",
          verifyCheck: "Confirm the attempted replacement was rejected.",
          sourceKind: "agent",
        })
        .pipe(Effect.flip);

      assert.equal(error.code, "invalid-project");
      const firstSnapshot = yield* service.getSnapshot(firstProjectId);
      const secondSnapshot = yield* service.getSnapshot(secondProjectId);
      const blockers = yield* service.openBlockersForBranch(
        firstProjectId,
        "feature/original-gate",
      );
      assert.equal(firstSnapshot.items.length, 1);
      assert.equal(firstSnapshot.items[0]?.id, itemId);
      assert.equal(firstSnapshot.items[0]?.projectId, firstProjectId);
      assert.equal(firstSnapshot.items[0]?.title, "Original blocker");
      assert.equal(firstSnapshot.items[0]?.status, "open");
      assert.equal(firstSnapshot.items[0]?.revision, 0);
      assert.deepStrictEqual(firstSnapshot.items[0]?.gate, {
        kind: "branch",
        ref: "feature/original-gate",
      });
      assert.deepStrictEqual(secondSnapshot.items, []);
      assert.deepStrictEqual(
        blockers.map((item) => item.id),
        [itemId],
      );
    }),
  );

  it.effect("preserves same-project duplicate item conflicts for new commands", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const projectId = ProjectId.make("project-same-id-conflict");
      const itemId = FollowUpId.make("item-same-id-conflict");
      yield* seedProject(projectId);
      yield* service.file({
        commandId: CommandId.make("command-same-id-first"),
        itemId,
        projectId,
        kind: "open",
        title: "Original item",
        observation: "This item already exists.",
        deferReason: "out-of-scope",
        verifyCheck: "Confirm duplicate filing is rejected.",
        sourceKind: "agent",
      });

      const error = yield* service
        .file({
          commandId: CommandId.make("command-same-id-second"),
          itemId,
          projectId,
          kind: "open",
          title: "Duplicate item",
          observation: "A new command must not overwrite it.",
          deferReason: "out-of-scope",
          verifyCheck: "Confirm duplicate filing is rejected.",
          sourceKind: "agent",
        })
        .pipe(Effect.flip);

      assert.equal(error.code, "conflict");
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

  it.effect("rejects wrong-project threads for file, resolution, and validation commands", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const projectId = ProjectId.make("project-thread-table");
      const otherProjectId = ProjectId.make("project-thread-table-other");
      const otherThreadId = ThreadId.make("thread-table-other");
      yield* seedProject(projectId);
      yield* seedProject(otherProjectId);
      yield* seedThread(otherThreadId, otherProjectId);

      const resolutionItem = yield* service.file({
        commandId: CommandId.make("command-thread-table-resolution-file"),
        itemId: FollowUpId.make("item-thread-table-resolution"),
        projectId,
        kind: "open",
        title: "Resolution thread scope",
        observation: "Resolution threads must stay in the item project.",
        deferReason: "out-of-scope",
        verifyCheck: "Check the resolution thread owner.",
        sourceKind: "human",
      });
      const validationItem = yield* service.file({
        commandId: CommandId.make("command-thread-table-validation-file"),
        itemId: FollowUpId.make("item-thread-table-validation"),
        projectId,
        kind: "open",
        title: "Validation thread scope",
        observation: "Validation threads must stay in the item project.",
        deferReason: "out-of-scope",
        verifyCheck: "Check the validation thread owner.",
        sourceKind: "human",
      });

      const cases = [
        {
          label: "file",
          run: service.file({
            commandId: CommandId.make("command-thread-table-file"),
            itemId: FollowUpId.make("item-thread-table-file"),
            projectId,
            kind: "open",
            title: "File thread scope",
            observation: "Source threads must stay in the item project.",
            deferReason: "out-of-scope",
            verifyCheck: "Check the source thread owner.",
            sourceKind: "agent",
            sourceThreadId: otherThreadId,
          }),
        },
        {
          label: "resolution",
          run: service.updateStatus({
            commandId: CommandId.make("command-thread-table-resolution"),
            itemId: resolutionItem.id,
            projectId,
            expectedRevision: resolutionItem.revision,
            status: "resolved",
            actor: "human",
            resolution: { note: "Wrong project.", threadId: otherThreadId, commitSha: null },
          }),
        },
        {
          label: "validation",
          run: service.recordValidation({
            commandId: CommandId.make("command-thread-table-validation"),
            itemId: validationItem.id,
            projectId,
            expectedRevision: validationItem.revision,
            outcome: "uncertain",
            verifyCheck: validationItem.verifyCheck,
            note: "Wrong project.",
            evidence: [],
            checkedCommitSha: null,
            threadId: otherThreadId,
          }),
        },
      ] as const;

      for (const candidate of cases) {
        const error = yield* candidate.run.pipe(Effect.flip);
        assert.equal(error.code, "invalid-thread", candidate.label);
      }

      const snapshot = yield* service.getSnapshot(projectId);
      assert.equal(
        snapshot.items.some((item) => item.id === "item-thread-table-file"),
        false,
      );
      for (const itemId of [resolutionItem.id, validationItem.id]) {
        const unchanged = snapshot.items.find((item) => item.id === itemId);
        assert.equal(unchanged?.status, "open");
        assert.equal(unchanged?.revision, 0);
      }
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
      yield* seedThread(ThreadId.make("thread-authority-root-match"), projectId, workspaceRoot);

      assert.equal(yield* service.projectIdForThread(threadId), projectId);
      assert.equal(yield* service.projectIdForRepositoryPath(workspaceRoot), projectId);
      assert.equal(yield* service.projectIdForRepositoryPath(worktreePath), projectId);
    }),
  );

  it.effect("fails closed when a repository path has no owner or multiple owners", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const firstProjectId = ProjectId.make("project-path-owner-first");
      const secondProjectId = ProjectId.make("project-path-owner-second");
      const sharedPath = "/tmp/followup-ambiguous-owner";
      yield* seedProject(firstProjectId, sharedPath);
      yield* seedProject(secondProjectId, "/tmp/followup-second-root");
      yield* seedThread(ThreadId.make("thread-path-owner-second"), secondProjectId, sharedPath);

      const missing = yield* service
        .projectIdForRepositoryPath("/tmp/followup-missing-owner")
        .pipe(Effect.flip);
      const ambiguous = yield* service.projectIdForRepositoryPath(sharedPath).pipe(Effect.flip);

      assert.equal(missing.code, "invalid-project");
      assert.equal(ambiguous.code, "invalid-project");
      assert.match(ambiguous.message, /multiple projects/i);
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
      assert.equal(failures[0]?.failure.code, "conflict");
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

  it.effect("isolates a project stream from events published for another project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* FollowUpService;
        const firstProjectId = ProjectId.make("project-stream-isolation-first");
        const secondProjectId = ProjectId.make("project-stream-isolation-second");
        yield* seedProject(firstProjectId);
        yield* seedProject(secondProjectId);
        const snapshotSeen = yield* Deferred.make<void>();
        const collectedFiber = yield* service.stream(firstProjectId).pipe(
          Stream.tap((item) =>
            item.kind === "snapshot" ? Deferred.succeed(snapshotSeen, undefined) : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );

        yield* Deferred.await(snapshotSeen);
        yield* service.file({
          commandId: CommandId.make("command-stream-isolation-second"),
          itemId: FollowUpId.make("item-stream-isolation-second"),
          projectId: secondProjectId,
          kind: "open",
          title: "Other project event",
          observation: "This event must not cross the stream boundary.",
          deferReason: "out-of-scope",
          verifyCheck: "Observe the first project stream.",
          sourceKind: "agent",
        });
        yield* service.file({
          commandId: CommandId.make("command-stream-isolation-first"),
          itemId: FollowUpId.make("item-stream-isolation-first"),
          projectId: firstProjectId,
          kind: "open",
          title: "First project event",
          observation: "This is the next visible event for the subscribed project.",
          deferReason: "out-of-scope",
          verifyCheck: "Observe the first project stream.",
          sourceKind: "agent",
        });

        const items = Array.from(yield* Fiber.join(collectedFiber));
        assert.equal(items[0]?.kind, "snapshot");
        assert.equal(items[1]?.kind, "event");
        if (items[1]?.kind === "event") {
          assert.equal(items[1].event.payload.item.projectId, firstProjectId);
          assert.equal(items[1].event.payload.item.id, "item-stream-isolation-first");
        }
      }),
    ),
  );
});
