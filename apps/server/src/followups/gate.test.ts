import { describe, expect, it } from "@effect/vitest";
import { FollowUpId, ProjectId, type FollowUp } from "@t3tools/contracts";

import { describeBlockers, isBlocked } from "./gate.ts";

function blocker(ref: string, title: string): FollowUp {
  return {
    id: FollowUpId.make(`item-${title}`),
    projectId: ProjectId.make("project-1"),
    kind: "blocker",
    status: "open",
    title,
    observation: "Would fail review.",
    deferReason: "needs-decision",
    verifyCheck: "Does it still reproduce?",
    evidence: [],
    gate: { kind: "branch", ref },
    sourceKind: "agent",
    sourceThreadId: null,
    resolution: null,
    lastValidation: null,
    revision: 0,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
  };
}

describe("follow-up gate", () => {
  it("is not blocked when there are no open blockers", () => {
    expect(isBlocked([])).toBe(false);
  });

  it("is blocked when any open blocker exists", () => {
    expect(isBlocked([blocker("feature/x", "a11y")])).toBe(true);
  });

  it("names every blocker in its message", () => {
    const message = describeBlockers([blocker("feature/x", "a11y"), blocker("feature/x", "perf")]);
    expect(message).toContain("a11y");
    expect(message).toContain("perf");
    expect(message).toContain("waive");
  });
});
