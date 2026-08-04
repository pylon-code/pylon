import { describe, expect, it } from "vite-plus/test";
import { FollowUpId, ProjectId, type FollowUp } from "@t3tools/contracts";

import { applyFollowUpStreamItem, EMPTY_FOLLOW_UP_CLIENT_STATE } from "./followups.ts";

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

describe("applyFollowUpStreamItem", () => {
  it("adopts a snapshot and marks the state synchronized", () => {
    const next = applyFollowUpStreamItem(EMPTY_FOLLOW_UP_CLIENT_STATE, {
      kind: "snapshot",
      snapshot: { sequence: 3, items: [item()] },
    });
    expect(next.synchronized).toBe(true);
    expect(next.snapshot.items).toHaveLength(1);
  });

  it("ignores events that arrive before a snapshot", () => {
    const next = applyFollowUpStreamItem(EMPTY_FOLLOW_UP_CLIENT_STATE, {
      kind: "event",
      event: {
        sequence: 4,
        eventId: "event-1",
        commandId: "command-1",
        type: "follow-up.filed",
        occurredAt: "2026-08-04T12:00:00.000Z",
        payload: { item: item() },
      },
    } as never);
    expect(next).toBe(EMPTY_FOLLOW_UP_CLIENT_STATE);
  });

  it("applies a later event over the snapshot", () => {
    const base = applyFollowUpStreamItem(EMPTY_FOLLOW_UP_CLIENT_STATE, {
      kind: "snapshot",
      snapshot: { sequence: 3, items: [item()] },
    });
    const next = applyFollowUpStreamItem(base, {
      kind: "event",
      event: {
        sequence: 4,
        eventId: "event-1",
        commandId: "command-1",
        type: "follow-up.status-changed",
        occurredAt: "2026-08-04T12:00:00.000Z",
        payload: { item: item({ status: "resolved", revision: 1 }) },
      },
    } as never);
    expect(next.snapshot.items[0]?.status).toBe("resolved");
    expect(next.snapshot.sequence).toBe(4);
  });
});
