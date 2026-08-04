import { describe, expect, it } from "vite-plus/test";
import { FollowUpId, ProjectId, type FollowUp } from "@t3tools/contracts";

import { groupFollowUps } from "./followUps.logic";

function item(overrides: Partial<FollowUp> = {}): FollowUp {
  return {
    id: FollowUpId.make("item-1"),
    projectId: ProjectId.make("project-1"),
    kind: "open",
    status: "open",
    title: "Check the thing",
    observation: "Noticed during unrelated work.",
    deferReason: "out-of-scope",
    verifyCheck: "Does it still happen?",
    evidence: [],
    gate: null,
    sourceKind: "agent",
    sourceThreadId: null,
    resolution: null,
    revision: 0,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
    ...overrides,
  };
}

describe("groupFollowUps", () => {
  it("groups open items by kind and excludes closed ones", () => {
    const grouped = groupFollowUps([
      item({ id: FollowUpId.make("a"), kind: "blocker", gate: { kind: "branch", ref: "main" } }),
      item({ id: FollowUpId.make("b"), kind: "open" }),
      item({ id: FollowUpId.make("c"), kind: "idea" }),
      item({ id: FollowUpId.make("d"), kind: "open", status: "resolved" }),
    ]);
    expect(grouped.blocker).toHaveLength(1);
    expect(grouped.open).toHaveLength(1);
    expect(grouped.idea).toHaveLength(1);
    expect(grouped.closed).toHaveLength(1);
  });

  it("orders each group newest first", () => {
    const grouped = groupFollowUps([
      item({ id: FollowUpId.make("older"), createdAt: "2026-08-01T00:00:00.000Z" }),
      item({ id: FollowUpId.make("newer"), createdAt: "2026-08-03T00:00:00.000Z" }),
    ]);
    expect(grouped.open.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });
});
