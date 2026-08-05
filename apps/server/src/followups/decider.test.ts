import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  FollowUpId,
  ProjectId,
  ThreadId,
  type FollowUp,
  type FollowUpSnapshot,
} from "@t3tools/contracts";

import { decideFollowUpCommand } from "./decider.ts";

const NOW = "2026-08-04T12:00:00.000Z";

function item(overrides: Partial<FollowUp> = {}): FollowUp {
  return {
    id: FollowUpId.make("item-1"),
    projectId: ProjectId.make("project-1"),
    kind: "open",
    status: "open",
    title: "Check the thing",
    observation: "The thing looked wrong during unrelated work.",
    deferReason: "out-of-scope",
    verifyCheck: "Open the thing and see whether it is still wrong.",
    evidence: [],
    gate: null,
    sourceKind: "agent",
    sourceThreadId: null,
    resolution: null,
    lastValidation: null,
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function snapshot(items: ReadonlyArray<FollowUp>): FollowUpSnapshot {
  return { sequence: 1, items };
}

describe("decideFollowUpCommand", () => {
  it("files a new follow-up at revision 0", () => {
    const decision = decideFollowUpCommand(
      snapshot([]),
      {
        type: "file",
        input: {
          commandId: CommandId.make("command-1"),
          itemId: FollowUpId.make("item-new"),
          projectId: ProjectId.make("project-1"),
          kind: "open",
          title: "Check the thing",
          observation: "Noticed during unrelated work.",
          deferReason: "out-of-scope",
          verifyCheck: "Does it still happen?",
          sourceKind: "agent",
        },
      },
      NOW,
    );

    expect(decision.kind).toBe("accepted");
    if (decision.kind === "accepted") {
      expect(decision.event.payload.item).toMatchObject({ status: "open", revision: 0 });
    }
  });

  it("rejects a blocker filed without a gate", () => {
    const decision = decideFollowUpCommand(
      snapshot([]),
      {
        type: "file",
        input: {
          commandId: CommandId.make("command-2"),
          itemId: FollowUpId.make("item-blocker"),
          projectId: ProjectId.make("project-1"),
          kind: "blocker",
          title: "Must fix before merge",
          observation: "A reviewer would refuse this.",
          deferReason: "needs-decision",
          verifyCheck: "Does the defect still reproduce?",
          sourceKind: "agent",
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({ kind: "rejected", error: { code: "invalid-command" } });
  });

  it.each(["open", "idea"] as const)("rejects a %s follow-up with a branch gate", (kind) => {
    const decision = decideFollowUpCommand(
      snapshot([]),
      {
        type: "file",
        input: {
          commandId: CommandId.make(`command-gated-${kind}`),
          itemId: FollowUpId.make(`item-gated-${kind}`),
          projectId: ProjectId.make("project-1"),
          kind,
          title: "Must not gate",
          observation: "Only blockers can gate a branch.",
          deferReason: kind === "idea" ? "idea" : "out-of-scope",
          verifyCheck: "Does this remain non-blocking?",
          gate: { kind: "branch", ref: "feature/x" },
          sourceKind: "agent",
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({ kind: "rejected", error: { code: "invalid-command" } });
  });

  it("refuses to let an agent waive", () => {
    const current = item();
    const decision = decideFollowUpCommand(
      snapshot([current]),
      {
        type: "update-status",
        input: {
          commandId: CommandId.make("command-3"),
          itemId: current.id,
          projectId: current.projectId,
          expectedRevision: 0,
          status: "waived",
          actor: "agent",
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({ kind: "rejected", error: { code: "forbidden" } });
  });

  it("lets a human waive", () => {
    const current = item();
    const decision = decideFollowUpCommand(
      snapshot([current]),
      {
        type: "update-status",
        input: {
          commandId: CommandId.make("command-4"),
          itemId: current.id,
          projectId: current.projectId,
          expectedRevision: 0,
          status: "waived",
          actor: "human",
          resolution: { note: "Not worth doing.", threadId: null, commitSha: null },
        },
      },
      NOW,
    );

    expect(decision.kind).toBe("accepted");
    if (decision.kind === "accepted") {
      expect(decision.event.payload.item).toMatchObject({ status: "waived", revision: 1 });
    }
  });

  it("requires a resolution to leave open", () => {
    const current = item();
    const decision = decideFollowUpCommand(
      snapshot([current]),
      {
        type: "update-status",
        input: {
          commandId: CommandId.make("command-5"),
          itemId: current.id,
          projectId: current.projectId,
          expectedRevision: 0,
          status: "resolved",
          actor: "agent",
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({ kind: "rejected", error: { code: "invalid-command" } });
  });

  it("rejects stale revisions", () => {
    const current = item({ revision: 3 });
    const decision = decideFollowUpCommand(
      snapshot([current]),
      {
        type: "update-status",
        input: {
          commandId: CommandId.make("command-6"),
          itemId: current.id,
          projectId: current.projectId,
          expectedRevision: 2,
          status: "moot",
          actor: "agent",
          resolution: { note: "Code deleted.", threadId: null, commitSha: null },
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({ kind: "rejected", error: { code: "conflict" } });
  });

  it("rejects a direct moot status change without a validation result", () => {
    const current = item();
    const decision = decideFollowUpCommand(
      snapshot([current]),
      {
        type: "update-status",
        input: {
          commandId: CommandId.make("command-moot-without-validation"),
          itemId: current.id,
          projectId: current.projectId,
          expectedRevision: current.revision,
          status: "moot",
          actor: "agent",
          resolution: { note: "It no longer applies.", threadId: null, commitSha: null },
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({ kind: "rejected", error: { code: "invalid-command" } });
  });

  it("records an evidence-backed moot validation and closes atomically", () => {
    const current = item();
    const decision = decideFollowUpCommand(
      snapshot([current]),
      {
        type: "record-validation",
        input: {
          commandId: CommandId.make("command-moot-with-validation"),
          itemId: current.id,
          projectId: current.projectId,
          expectedRevision: current.revision,
          outcome: "moot",
          verifyCheck: current.verifyCheck,
          note: "The obsolete implementation was removed.",
          evidence: [{ path: "src/removed.ts", line: null, commitSha: "abc123" }],
          checkedCommitSha: "abc123",
          threadId: ThreadId.make("thread-validation"),
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({
      kind: "accepted",
      event: { payload: { item: { status: "moot", revision: 1 } } },
    });
  });

  it("fails closed when a moot validation has no evidence", () => {
    const current = item();
    const decision = decideFollowUpCommand(
      snapshot([current]),
      {
        type: "record-validation",
        input: {
          commandId: CommandId.make("command-moot-empty-evidence"),
          itemId: current.id,
          projectId: current.projectId,
          expectedRevision: current.revision,
          outcome: "moot",
          verifyCheck: current.verifyCheck,
          note: "No evidence was recorded.",
          evidence: [],
          checkedCommitSha: null,
          threadId: ThreadId.make("thread-validation"),
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({ kind: "rejected", error: { code: "invalid-command" } });
  });

  it.each(["still-needed", "uncertain"] as const)(
    "records %s while keeping the follow-up open",
    (outcome) => {
      const current = item();
      const decision = decideFollowUpCommand(
        snapshot([current]),
        {
          type: "record-validation",
          input: {
            commandId: CommandId.make(`command-validation-${outcome}`),
            itemId: current.id,
            projectId: current.projectId,
            expectedRevision: current.revision,
            outcome,
            verifyCheck: current.verifyCheck,
            note: outcome === "uncertain" ? "The evidence was inconclusive." : "Still reproduces.",
            evidence: [],
            checkedCommitSha: null,
            threadId: ThreadId.make("thread-validation"),
          },
        },
        NOW,
      );

      expect(decision).toMatchObject({
        kind: "accepted",
        event: {
          type: "follow-up.validated",
          payload: { item: { status: "open", revision: 1, lastValidation: { outcome } } },
        },
      });
    },
  );

  it("rejects a validation recorded against a stale revision", () => {
    const current = item({ revision: 2 });
    const decision = decideFollowUpCommand(
      snapshot([current]),
      {
        type: "record-validation",
        input: {
          commandId: CommandId.make("command-validation-stale"),
          itemId: current.id,
          projectId: current.projectId,
          expectedRevision: 1,
          outcome: "uncertain",
          verifyCheck: current.verifyCheck,
          note: "This result raced another update.",
          evidence: [],
          checkedCommitSha: null,
          threadId: ThreadId.make("thread-validation"),
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({ kind: "rejected", error: { code: "conflict" } });
  });

  it("reopens a closed follow-up and clears its resolution", () => {
    const current = item({
      status: "resolved",
      revision: 1,
      resolution: { note: "Done once.", threadId: null, commitSha: null },
    });
    const decision = decideFollowUpCommand(
      snapshot([current]),
      {
        type: "update-status",
        input: {
          commandId: CommandId.make("command-reopen"),
          itemId: current.id,
          projectId: current.projectId,
          expectedRevision: current.revision,
          status: "open",
          actor: "human",
          resolution: null,
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({
      kind: "accepted",
      event: { payload: { item: { status: "open", resolution: null, revision: 2 } } },
    });
  });
});
