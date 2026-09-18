import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pairLifecycleApplies, pairLifecycleIntent } from "./pairLifecycle.logic.ts";

const NOW = "2026-09-18T00:00:00.000Z";
const LEAD = ThreadId.make("lead:with:colons");
const EXECUTOR = ThreadId.make("delegated:lead:with:colons:0123456789abcdef");

const base = (threadId: ThreadId, historyImport = false) => ({
  eventId: EventId.make(`event-${threadId}`),
  sequence: 1,
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: NOW,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: { historyImport },
});

const archived = (threadId: ThreadId, historyImport = false): OrchestrationEvent => ({
  ...base(threadId, historyImport),
  type: "thread.archived",
  payload: { threadId, archivedAt: NOW, updatedAt: NOW },
});
const deleted = (threadId: ThreadId): OrchestrationEvent => ({
  ...base(threadId),
  type: "thread.deleted",
  payload: { threadId, deletedAt: NOW },
});
const settled = (threadId: ThreadId): OrchestrationEvent => ({
  ...base(threadId),
  type: "thread.settled",
  payload: { threadId, settledAt: NOW, updatedAt: NOW },
});
const rewound = (threadId: ThreadId): OrchestrationEvent => ({
  ...base(threadId),
  type: "thread.checkpoint-revert-requested",
  payload: { threadId, turnCount: 1, createdAt: NOW },
});
const unarchived = (threadId: ThreadId): OrchestrationEvent => ({
  ...base(threadId),
  type: "thread.unarchived",
  payload: { threadId, updatedAt: NOW },
});

const turn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: NOW,
  assistantMessageId: null,
};
function executor(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: EXECUTOR,
    projectId: ProjectId.make("project"),
    title: "Executor",
    modelSelection: { instanceId: ProviderInstanceId.make("antigravity"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: turn,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("pairLifecycleIntent", () => {
  it("maps a lead's lifecycle to what its executor should do", () => {
    expect(pairLifecycleIntent(archived(LEAD))).toEqual({ leadThreadId: LEAD, action: "archive" });
    expect(pairLifecycleIntent(deleted(LEAD))).toEqual({ leadThreadId: LEAD, action: "delete" });
    expect(pairLifecycleIntent(settled(LEAD))).toEqual({ leadThreadId: LEAD, action: "settle" });
    expect(pairLifecycleIntent(rewound(LEAD))).toEqual({
      leadThreadId: LEAD,
      action: "interrupt",
    });
  });

  it("never reacts to an executor's or a fan-out child's own lifecycle", () => {
    // Archiving the executor is how a user turns the pair off; it must not loop.
    for (const event of [
      archived(EXECUTOR),
      deleted(EXECUTOR),
      settled(EXECUTOR),
      rewound(EXECUTOR),
    ])
      expect(pairLifecycleIntent(event)).toBeNull();
  });

  it("ignores imported history and events that ask nothing of the pair", () => {
    expect(pairLifecycleIntent(archived(LEAD, true))).toBeNull();
    // Unarchiving a lead does not turn the pair back on: the user may have turned it off.
    expect(pairLifecycleIntent(unarchived(LEAD))).toBeNull();
  });
});

describe("pairLifecycleApplies", () => {
  it("archives only an executor that is not archived yet", () => {
    expect(pairLifecycleApplies("archive", executor())).toBe(true);
    expect(pairLifecycleApplies("archive", executor({ archivedAt: NOW }))).toBe(false);
  });

  it("always deletes, even an archived executor", () => {
    expect(pairLifecycleApplies("delete", executor())).toBe(true);
    expect(pairLifecycleApplies("delete", executor({ archivedAt: NOW }))).toBe(true);
  });

  it("settles only an executor that is active and not settled", () => {
    expect(pairLifecycleApplies("settle", executor())).toBe(true);
    expect(pairLifecycleApplies("settle", executor({ settledOverride: "settled" }))).toBe(false);
    expect(pairLifecycleApplies("settle", executor({ archivedAt: NOW }))).toBe(false);
  });

  it("interrupts only an executor that is running", () => {
    const running = executor({
      latestTurn: { ...turn, state: "running", completedAt: null },
      session: {
        threadId: EXECUTOR,
        status: "running",
        providerName: "antigravity",
        runtimeMode: "full-access",
        activeTurnId: turn.turnId,
        lastError: null,
        updatedAt: NOW,
      },
    });
    expect(pairLifecycleApplies("interrupt", running)).toBe(true);
    expect(pairLifecycleApplies("interrupt", executor())).toBe(false);
    expect(pairLifecycleApplies("interrupt", executor({ session: null, latestTurn: null }))).toBe(
      false,
    );
    expect(pairLifecycleApplies("interrupt", { ...running, archivedAt: NOW })).toBe(false);
  });
});
