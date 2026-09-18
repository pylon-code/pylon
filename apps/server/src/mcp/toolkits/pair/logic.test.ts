import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { delegatedThreadId } from "../delegation/logic.ts";
import {
  PAIR_DELEGATION_KEY,
  changedProtectedPaths,
  derivePairExecutorState,
  isPairLeadSupported,
  pairAwaitBudgetSeconds,
  normalizeProtectedPath,
  isPairExecutorThreadId,
  pairAwaitCapSeconds,
  pairExecutorThreadId,
  pairExecutorTitle,
  pairMessageId,
  pairSteerMessageId,
} from "./logic.ts";

const NOW = "2026-09-18T00:00:00.000Z";
const LEAD = ThreadId.make("lead:with:colons");
const sha256Hex = (input: string) => NodeCrypto.createHash("sha256").update(input).digest("hex");
const EXECUTOR = pairExecutorThreadId(LEAD, sha256Hex);

const turn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: NOW,
  assistantMessageId: null,
};
const session = {
  threadId: EXECUTOR,
  status: "ready" as const,
  providerName: "antigravity",
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: NOW,
};
function shell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
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
    session,
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("pair executor identity", () => {
  it("is the delegated child id for the reserved key", () => {
    expect(PAIR_DELEGATION_KEY).toBe("pair");
    expect(EXECUTOR).toBe(delegatedThreadId(LEAD, "pair", sha256Hex));
    expect(EXECUTOR).toMatch(/^delegated:lead:with:colons:[0-9a-f]{16}$/);
  });

  it("recognizes only the reserved-key child of its own parent", () => {
    expect(isPairExecutorThreadId(EXECUTOR, sha256Hex)).toBe(true);
    expect(isPairExecutorThreadId(delegatedThreadId(LEAD, "other", sha256Hex), sha256Hex)).toBe(
      false,
    );
    expect(isPairExecutorThreadId(LEAD, sha256Hex)).toBe(false);
    expect(isPairExecutorThreadId(ThreadId.make("delegated:broken"), sha256Hex)).toBe(false);
  });
});

describe("derivePairExecutorState", () => {
  it("reads an executor that never ran as idle, not queued", () => {
    expect(derivePairExecutorState(shell({ session: null, latestTurn: null }))).toBe("idle");
  });

  it("reports archived before anything else", () => {
    expect(derivePairExecutorState(shell({ archivedAt: NOW }))).toBe("archived");
  });

  it("maps admission and active turns to running", () => {
    expect(derivePairExecutorState(shell({ session: { ...session, status: "starting" } }))).toBe(
      "running",
    );
    expect(
      derivePairExecutorState(
        shell({
          latestTurn: { ...turn, state: "running", completedAt: null },
          session: { ...session, status: "running", activeTurnId: turn.turnId },
        }),
      ),
    ).toBe("running");
    // A first brief waiting for admission has a session but no turn yet.
    expect(
      derivePairExecutorState(
        shell({
          latestTurn: null,
          session: {
            ...session,
            status: "starting",
            pendingTurnRequestId: CommandId.make("request-1"),
          },
        }),
      ),
    ).toBe("running");
  });

  it("keeps a completed turn completed after the session was stopped", () => {
    expect(derivePairExecutorState(shell())).toBe("completed");
    expect(derivePairExecutorState(shell({ session: { ...session, status: "stopped" } }))).toBe(
      "completed",
    );
  });

  it("reports interrupted and error turns", () => {
    expect(derivePairExecutorState(shell({ latestTurn: { ...turn, state: "interrupted" } }))).toBe(
      "interrupted",
    );
    expect(derivePairExecutorState(shell({ latestTurn: { ...turn, state: "error" } }))).toBe(
      "error",
    );
    expect(derivePairExecutorState(shell({ session: { ...session, status: "error" } }))).toBe(
      "error",
    );
  });
});

describe("pair wait cap", () => {
  it("allows a long wait only where Pylon sets the provider's tool timeout", () => {
    expect(pairAwaitCapSeconds("codex")).toBe(150);
    expect(pairAwaitCapSeconds("claudeAgent")).toBe(45);
    expect(pairAwaitCapSeconds("primeAgent")).toBe(45);
    expect(pairAwaitCapSeconds(undefined)).toBe(45);
  });
});

describe("pair message ids and title", () => {
  it("derives stable message ids", () => {
    expect(pairMessageId(EXECUTOR, "m-1")).toBe(`pair-message:${EXECUTOR}:m-1`);
    expect(pairSteerMessageId(EXECUTOR, TurnId.make("turn-9"))).toBe(
      `pair-message:${EXECUTOR}:steer:turn-9`,
    );
  });

  it("titles the executor after its lead within the 200 character limit", () => {
    expect(pairExecutorTitle("Fix the parser")).toBe("Executor · Fix the parser");
    expect(pairExecutorTitle("x".repeat(400))).toHaveLength(200);
  });
});

describe("pair lead support", () => {
  it("refuses only the provider that cannot be steered away from its own subagents", () => {
    // Codex keeps its collaboration tools whatever feature flags say, but once it
    // receives the pair protocol it briefs the executor and leaves them alone.
    expect(isPairLeadSupported("antigravity")).toBe(false);
    for (const driver of ["claudeAgent", "codex", "primeAgent", "cursor", "opencode", undefined]) {
      expect(isPairLeadSupported(driver)).toBe(true);
    }
  });
});

describe("protected paths", () => {
  it("reduces a path to a clean one relative to the worktree", () => {
    expect(normalizeProtectedPath("src/a.test.ts")).toBe("src/a.test.ts");
    expect(normalizeProtectedPath("./src//a.test.ts")).toBe("src/a.test.ts");
    expect(normalizeProtectedPath("src\\win\\a.test.ts")).toBe("src/win/a.test.ts");
    expect(normalizeProtectedPath("src/./nested/a.ts")).toBe("src/nested/a.ts");
  });

  it("refuses anything that could reach outside the worktree", () => {
    for (const path of [
      "/etc/passwd",
      "../secrets.env",
      "src/../../secrets.env",
      "C:\\Users\\me\\file.ts",
      "\\\\server\\share\\file.ts",
      "~/file.ts",
      "",
      ".",
      "src/\0evil",
    ]) {
      expect(normalizeProtectedPath(path)).toBeNull();
    }
  });

  it("reports changed and missing files in recorded order and nothing else", () => {
    const recorded = [
      { path: "b.test.ts", hash: "bbb" },
      { path: "a.test.ts", hash: "aaa" },
      { path: "c.test.ts", hash: "ccc" },
    ];
    expect(
      changedProtectedPaths(
        recorded,
        new Map([
          ["a.test.ts", "aaa"],
          ["b.test.ts", "edited"],
          ["c.test.ts", null],
          ["unrelated.ts", "zzz"],
        ]),
      ),
    ).toEqual(["b.test.ts", "c.test.ts"]);
    // A path with no current reading counts as changed: it could not be verified.
    expect(changedProtectedPaths(recorded.slice(0, 1), new Map())).toEqual(["b.test.ts"]);
    expect(changedProtectedPaths([], new Map([["a.test.ts", "aaa"]]))).toEqual([]);
  });
});

describe("pair await budget", () => {
  it("waits the whole cap unless the lead asks for an instant read", () => {
    // A lead that asks for ten seconds at a time is polling: every return is a
    // model turn. The wait ends early on any change anyway, so a long one is free.
    expect(pairAwaitBudgetSeconds(undefined, 45)).toBe(45);
    expect(pairAwaitBudgetSeconds(10, 45)).toBe(45);
    expect(pairAwaitBudgetSeconds(20, 150)).toBe(150);
    expect(pairAwaitBudgetSeconds(150, 45)).toBe(45);
    expect(pairAwaitBudgetSeconds(0, 45)).toBe(0);
  });
});
