import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationSession,
} from "@t3tools/contracts";
import { pairExecutorThreadId } from "@t3tools/shared/delegatedThreads";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "./models.ts";
import {
  PAIR_UNSUPPORTED_LEAD_REASON,
  isPairLeadSupported,
  pairExecutorCreateInput,
  resolvePairState,
  withoutPairExecutors,
} from "./pair.ts";

const NOW = "2026-09-18T00:00:00.000Z";
const ENV = EnvironmentId.make("env-1");
const OTHER_ENV = EnvironmentId.make("env-2");
const LEAD = ThreadId.make("lead:with:colons");
const EXECUTOR = pairExecutorThreadId(LEAD);
const FAN_OUT_CHILD = ThreadId.make(`delegated:${LEAD}:0123456789abcdef`);
const EXECUTOR_SELECTION = {
  instanceId: ProviderInstanceId.make("antigravity"),
  model: "gemini-3-flash",
};

function shell(
  id: ThreadId,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: ENV,
    id,
    projectId: ProjectId.make("project-1"),
    title: "Fix the parser",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feat/work",
    worktreePath: "/wt/repo/lead",
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
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

const turnId = TurnId.make("turn-1");
const completedTurn = {
  turnId,
  state: "completed" as const,
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: NOW,
  assistantMessageId: null,
};
const runningTurn = { ...completedTurn, state: "running" as const, completedAt: null };
const session = (overrides: Partial<OrchestrationSession> = {}): OrchestrationSession => ({
  threadId: EXECUTOR,
  status: "ready",
  providerName: "antigravity",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: NOW,
  ...overrides,
});
const executor = (overrides: Partial<EnvironmentThreadShell> = {}) =>
  shell(EXECUTOR, { modelSelection: EXECUTOR_SELECTION, ...overrides });

const lead = (driverKind: string | null | undefined = "codex") => ({
  environmentId: ENV,
  threadId: LEAD,
  driverKind,
});

describe("isPairLeadSupported", () => {
  it("refuses only Antigravity", () => {
    expect(isPairLeadSupported("antigravity")).toBe(false);
    for (const driver of [
      "codex",
      "claudeAgent",
      "primeAgent",
      "cursor",
      "opencode",
      null,
      undefined,
    ])
      expect(isPairLeadSupported(driver)).toBe(true);
  });
});

describe("resolvePairState", () => {
  it("says why when the lead's provider cannot lead, even if an executor exists", () => {
    expect(
      resolvePairState({ threads: [shell(LEAD), executor()], lead: lead("antigravity") }),
    ).toEqual({ kind: "unsupported-lead", reason: PAIR_UNSUPPORTED_LEAD_REASON });
  });

  it("is off, with the id a client would create, when no executor is listed", () => {
    expect(resolvePairState({ threads: [shell(LEAD)], lead: lead() })).toEqual({
      kind: "off",
      executorId: EXECUTOR,
    });
    // A fan-out child is not the pair, and an archived executor means the pair is off.
    expect(
      resolvePairState({
        threads: [shell(LEAD), shell(FAN_OUT_CHILD), executor({ archivedAt: NOW })],
        lead: lead(),
      }),
    ).toEqual({ kind: "off", executorId: EXECUTOR });
    // An executor with the same id in another environment belongs to another lead.
    expect(
      resolvePairState({
        threads: [shell(LEAD), executor({ environmentId: OTHER_ENV })],
        lead: lead(),
      }),
    ).toEqual({ kind: "off", executorId: EXECUTOR });
  });

  it("reads an executor that never ran as idle", () => {
    expect(resolvePairState({ threads: [shell(LEAD), executor()], lead: lead() })).toEqual({
      kind: "on",
      executorId: EXECUTOR,
      phase: "idle",
      modelSelection: EXECUTOR_SELECTION,
      activity: null,
    });
  });

  it("follows the executor through a turn", () => {
    const phaseOf = (overrides: Partial<EnvironmentThreadShell>) => {
      const state = resolvePairState({ threads: [executor(overrides)], lead: lead() });
      return state.kind === "on" ? state.phase : state.kind;
    };
    expect(phaseOf({ session: session({ status: "starting" }) })).toBe("running");
    expect(
      phaseOf({
        latestTurn: runningTurn,
        session: session({ status: "running", activeTurnId: turnId }),
      }),
    ).toBe("running");
    expect(phaseOf({ latestTurn: completedTurn, session: session() })).toBe("completed");
    // A session stopped after the turn finished does not make it interrupted.
    expect(phaseOf({ latestTurn: completedTurn, session: session({ status: "stopped" }) })).toBe(
      "completed",
    );
    expect(phaseOf({ latestTurn: { ...completedTurn, state: "interrupted" } })).toBe("interrupted");
    expect(phaseOf({ latestTurn: { ...completedTurn, state: "error" } })).toBe("error");
    expect(phaseOf({ latestTurn: runningTurn, hasPendingApprovals: true })).toBe("needs-approval");
    expect(phaseOf({ latestTurn: runningTurn, hasPendingUserInput: true })).toBe("needs-input");
  });

  it("carries one line of activity: the error, or the plan step while running", () => {
    const failed = resolvePairState({
      threads: [
        executor({
          latestTurn: { ...completedTurn, state: "error" },
          session: session({ status: "error", lastError: "quota\n  exceeded   today" }),
        }),
      ],
      lead: lead(),
    });
    expect(failed).toMatchObject({ kind: "on", phase: "error", activity: "quota exceeded today" });
  });
});

describe("withoutPairExecutors", () => {
  it("drops executors and keeps leads, fan-out children, and ordinary threads in order", () => {
    const other = shell(ThreadId.make("thread-2"));
    const threads = [executor(), shell(LEAD), shell(FAN_OUT_CHILD), other];
    expect(withoutPairExecutors(threads).map((thread) => thread.id)).toEqual([
      LEAD,
      FAN_OUT_CHILD,
      other.id,
    ]);
  });
});

describe("pairExecutorCreateInput", () => {
  it("creates the executor in the lead's location, always implementing", () => {
    expect(
      pairExecutorCreateInput({
        lead: shell(LEAD, { interactionMode: "plan" }),
        executorSelection: EXECUTOR_SELECTION,
        childRuntimeMode: "inherit",
      }),
    ).toEqual({
      threadId: EXECUTOR,
      projectId: ProjectId.make("project-1"),
      title: "Executor · Fix the parser",
      modelSelection: EXECUTOR_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feat/work",
      worktreePath: "/wt/repo/lead",
    });
  });

  it("honors Supervised child permissions and never broadens the lead's mode", () => {
    const input = {
      executorSelection: EXECUTOR_SELECTION,
      childRuntimeMode: "approval-required" as const,
    };
    expect(pairExecutorCreateInput({ ...input, lead: shell(LEAD) }).runtimeMode).toBe(
      "approval-required",
    );
    expect(
      pairExecutorCreateInput({
        lead: shell(LEAD, { runtimeMode: "approval-required" }),
        executorSelection: EXECUTOR_SELECTION,
        childRuntimeMode: "inherit",
      }).runtimeMode,
    ).toBe("approval-required");
  });

  it("keeps the title within the 200 character limit", () => {
    expect(
      pairExecutorCreateInput({
        lead: shell(LEAD, { title: "x".repeat(400) }),
        executorSelection: EXECUTOR_SELECTION,
        childRuntimeMode: "inherit",
      }).title,
    ).toHaveLength(200);
  });
});
