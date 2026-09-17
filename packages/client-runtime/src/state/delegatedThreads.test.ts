import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  delegatedParentThreadId,
  delegatedThreadRows,
  flattenNestedThreads,
  nestDelegatedThreads,
  nestedRowContainsThread,
} from "./delegatedThreads.ts";

const HASH = "0123456789abcdef";
const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const thread = (environmentId: EnvironmentId, id: string) => ({
  environmentId,
  id: ThreadId.make(id),
});
const ids = (threads: readonly { readonly id: string }[] | undefined) =>
  threads?.map((entry) => entry.id);

describe("delegatedParentThreadId", () => {
  it("returns the parent of a delegated child", () => {
    expect(delegatedParentThreadId(ThreadId.make(`delegated:parent-1:${HASH}`))).toBe("parent-1");
  });

  it("keeps colons inside the parent id", () => {
    expect(delegatedParentThreadId(ThreadId.make(`delegated:import:a:b:${HASH}`))).toBe(
      "import:a:b",
    );
  });

  it("ignores ordinary and malformed ids", () => {
    for (const id of [
      "parent-1",
      `delegated:${HASH}`,
      `delegated::${HASH}`,
      "delegated:parent-1:0123",
      "delegated:parent-1:0123456789ABCDEF",
      `delegated:parent-1:${HASH}0`,
    ]) {
      expect(delegatedParentThreadId(ThreadId.make(id))).toBeNull();
    }
  });
});

describe("nestDelegatedThreads", () => {
  it("nests children under a parent in the same list, keeping input order", () => {
    const parent = thread(local, "parent");
    const first = thread(local, `delegated:parent:${HASH}`);
    const other = thread(local, "other");
    const second = thread(local, "delegated:parent:fedcba9876543210");
    const nested = nestDelegatedThreads([first, parent, other, second]);
    expect(ids(nested.topLevel)).toEqual(["parent", "other"]);
    expect(ids(nested.childrenByParentKey.get("local:parent"))).toEqual([
      `delegated:parent:${HASH}`,
      "delegated:parent:fedcba9876543210",
    ]);
  });

  it("keeps a child top-level when its parent is not in the list", () => {
    const orphan = thread(local, `delegated:elsewhere:${HASH}`);
    const nested = nestDelegatedThreads([thread(local, "parent"), orphan]);
    expect(ids(nested.topLevel)).toEqual(["parent", `delegated:elsewhere:${HASH}`]);
    expect(nested.childrenByParentKey.size).toBe(0);
  });

  it("nests one level deep, leaving a grandchild top-level", () => {
    const grandchildId = `delegated:delegated:parent:${HASH}:fedcba9876543210`;
    const nested = nestDelegatedThreads([
      thread(local, "parent"),
      thread(local, `delegated:parent:${HASH}`),
      thread(local, grandchildId),
    ]);
    expect(ids(nested.topLevel)).toEqual(["parent", grandchildId]);
    expect(ids(nested.childrenByParentKey.get("local:parent"))).toEqual([
      `delegated:parent:${HASH}`,
    ]);
  });

  it("matches the parent within the child's own environment", () => {
    const nested = nestDelegatedThreads([
      thread(remote, "parent"),
      thread(local, `delegated:parent:${HASH}`),
    ]);
    expect(nested.topLevel).toHaveLength(2);
    expect(nested.childrenByParentKey.size).toBe(0);
  });
});

describe("rendered nested rows", () => {
  const parent = thread(local, "parent");
  const child = thread(local, `delegated:parent:${HASH}`);
  const other = thread(local, "other");
  const nested = nestDelegatedThreads([parent, other, child]);

  it("flattens each row followed by its children", () => {
    expect(ids(flattenNestedThreads(nested.topLevel, nested))).toEqual([
      "parent",
      `delegated:parent:${HASH}`,
      "other",
    ]);
    expect(ids(flattenNestedThreads([other], nested))).toEqual(["other"]);
  });

  it("treats a parent row as containing its nested children", () => {
    expect(nestedRowContainsThread(parent, nested, `local:delegated:parent:${HASH}`)).toBe(true);
    expect(nestedRowContainsThread(parent, nested, "local:parent")).toBe(true);
    expect(nestedRowContainsThread(other, nested, `local:delegated:parent:${HASH}`)).toBe(false);
  });
});

const parentRef = { environmentId: local, threadId: ThreadId.make("parent") };
const childId = ThreadId.make(`delegated:parent:${HASH}`);
const timestamp = "2026-09-17T12:00:00.000Z";
function child(
  overrides: Partial<import("./models.ts").EnvironmentThreadShell> = {},
): import("./models.ts").EnvironmentThreadShell {
  return {
    environmentId: local,
    id: childId,
    projectId: ProjectId.make("project"),
    title: "Inspect failure",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}
const completedTurn = {
  turnId: TurnId.make("turn"),
  state: "completed" as const,
  requestedAt: timestamp,
  startedAt: timestamp,
  completedAt: timestamp,
  assistantMessageId: null,
};
const readySession = {
  threadId: childId,
  status: "ready" as const,
  providerName: "Codex",
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: timestamp,
};
const statusOf = (overrides: Parameters<typeof child>[0]) =>
  delegatedThreadRows([child(overrides)], parentRef)[0]?.status;

describe("delegatedThreadRows", () => {
  it("keeps live children without a parent and isolates environment and exact parent", () => {
    const running = child({
      latestTurn: { ...completedTurn, state: "running", completedAt: null },
    });
    const rows = delegatedThreadRows(
      [
        running,
        child({ environmentId: remote }),
        child({ id: ThreadId.make(`delegated:parent-other:${HASH}`) }),
      ],
      parentRef,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("running");
    expect(
      delegatedThreadRows(
        [child({ id: parentRef.threadId, session: readySession }), running],
        parentRef,
      ),
    ).toEqual(rows);
  });

  it("keeps creation order stable across updates with deterministic ties", () => {
    const later = child({ id: ThreadId.make("delegated:parent:ffffffffffffffff") });
    expect(delegatedThreadRows([later, child()], parentRef).map((row) => row.threadId)).toEqual([
      childId,
      later.id,
    ]);
    expect(
      delegatedThreadRows([later, child({ updatedAt: "2026-09-18T12:00:00.000Z" })], parentRef).map(
        (row) => row.threadId,
      ),
    ).toEqual([childId, later.id]);
  });

  it("surfaces blockers and terminal states", () => {
    expect(statusOf({})).toBe("starting");
    expect(statusOf({ hasPendingApprovals: true, hasPendingUserInput: true })).toBe(
      "needs-approval",
    );
    expect(statusOf({ hasPendingUserInput: true })).toBe("needs-input");
    expect(statusOf({ latestTurn: completedTurn })).toBe("completed");
    expect(statusOf({ latestTurn: { ...completedTurn, state: "interrupted" } })).toBe(
      "interrupted",
    );
    expect(
      statusOf({ latestTurn: { ...completedTurn, state: "error" }, hasPendingApprovals: true }),
    ).toBe("error");
    expect(statusOf({ archivedAt: timestamp, hasPendingApprovals: true })).toBe("archived");
    expect(statusOf({ session: readySession })).toBe("interrupted");
  });

  it("handles follow-up admission, failed admission, and native work after completion", () => {
    expect(statusOf({ session: { ...readySession, status: "starting" } })).toBe("starting");
    expect(
      statusOf({ session: { ...readySession, status: "starting" }, latestTurn: completedTurn }),
    ).toBe("running");
    expect(
      statusOf({
        session: { ...readySession, failedTurnRequestId: CommandId.make("failed") },
        latestTurn: completedTurn,
      }),
    ).toBe("error");
    expect(
      statusOf({ session: { ...readySession, pendingTurnRequestId: CommandId.make("stale") } }),
    ).toBe("interrupted");
    expect(statusOf({ latestTurn: completedTurn, backgroundLiveness: "working" })).toBe("running");
    expect(statusOf({ latestTurn: completedTurn, backgroundLiveness: "monitoring" })).toBe(
      "completed",
    );
  });

  it("uses concise current shell activity and provider/model without leaking stale plans", () => {
    const shell = child({
      session: readySession,
      latestTurn: { ...completedTurn, state: "running" },
      planProgress: { step: "Check\n  lifecycle", completedSteps: 0, totalSteps: 1 },
    });
    expect(delegatedThreadRows([shell], parentRef)[0]).toMatchObject({
      providerName: "Codex",
      modelSelection: shell.modelSelection,
      activity: "Check lifecycle",
    });
    expect(
      delegatedThreadRows([{ ...shell, latestTurn: completedTurn }], parentRef)[0]?.activity,
    ).toBeNull();
    expect(
      delegatedThreadRows(
        [{ ...shell, session: { ...readySession, status: "error", lastError: "x".repeat(200) } }],
        parentRef,
      )[0]?.activity,
    ).toHaveLength(160);
  });
});
