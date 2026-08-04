import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  FollowUpId,
  ProjectId,
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

  it("refuses to let an agent waive", () => {
    const current = item();
    const decision = decideFollowUpCommand(
      snapshot([current]),
      {
        type: "update-status",
        input: {
          commandId: CommandId.make("command-3"),
          itemId: current.id,
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
});
