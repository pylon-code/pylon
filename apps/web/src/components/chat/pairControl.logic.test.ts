import { PAIR_UNSUPPORTED_LEAD_REASON, type PairState } from "@t3tools/client-runtime/state/pair";
import { ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { pairExecutorThreadId } from "@t3tools/shared/delegatedThreads";
import { describe, expect, it } from "vite-plus/test";

import {
  pairLockedReason,
  pairToggleStep,
  resolveExecutorSelection,
  shouldRestartLeadSession,
  type PairLead,
} from "./pairControl.logic";

const LEAD_ID = ThreadId.make("lead-1");
const EXECUTOR = pairExecutorThreadId(LEAD_ID);
const SELECTION = { instanceId: ProviderInstanceId.make("antigravity"), model: "gemini-3-flash" };
const OTHER = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" };

const lead = (overrides: Partial<PairLead> = {}): PairLead => ({
  id: LEAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Fix the parser",
  runtimeMode: "full-access",
  branch: "feat/work",
  worktreePath: "/wt/lead",
  session: null,
  ...overrides,
});
const running = { status: "running" as const, activeTurnId: TurnId.make("turn-1") };
const ready = { status: "ready" as const, activeTurnId: null };

const off: PairState = { kind: "off", executorId: EXECUTOR };
const on = (phase: Extract<PairState, { kind: "on" }>["phase"]): PairState => ({
  kind: "on",
  executorId: EXECUTOR,
  phase,
  modelSelection: SELECTION,
  activity: null,
});
const base = { executorSelection: SELECTION, childRuntimeMode: "inherit" as const };

describe("pairLockedReason", () => {
  it("makes a change wait while the lead is mid-turn, and only then", () => {
    expect(pairLockedReason(lead({ session: running }))).toBe("Changes apply between turns.");
    expect(pairLockedReason(lead({ session: { status: "starting", activeTurnId: null } }))).toBe(
      "Changes apply between turns.",
    );
    expect(pairLockedReason(lead({ session: ready }))).toBeNull();
    expect(pairLockedReason(lead())).toBeNull();
    expect(pairLockedReason(null)).toBe("Open a thread to pair it.");
  });
});

describe("pairToggleStep", () => {
  it("creates the executor in the lead's location when turned on", () => {
    expect(pairToggleStep({ ...base, on: true, state: off, lead: lead() })).toEqual({
      kind: "create",
      input: {
        threadId: EXECUTOR,
        projectId: ProjectId.make("project-1"),
        title: "Executor · Fix the parser",
        modelSelection: SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feat/work",
        worktreePath: "/wt/lead",
      },
    });
  });

  it("deletes an executor that was never briefed and archives one with history", () => {
    expect(pairToggleStep({ ...base, on: false, state: on("idle"), lead: lead() })).toEqual({
      kind: "delete",
      threadId: EXECUTOR,
    });
    for (const phase of ["completed", "interrupted", "error"] as const) {
      expect(pairToggleStep({ ...base, on: false, state: on(phase), lead: lead() })).toEqual({
        kind: "archive",
        threadId: EXECUTOR,
      });
    }
  });

  it("does nothing when nothing would change or the change is not allowed", () => {
    expect(pairToggleStep({ ...base, on: true, state: on("idle"), lead: lead() })).toBeNull();
    expect(pairToggleStep({ ...base, on: false, state: off, lead: lead() })).toBeNull();
    // No executor model chosen yet.
    expect(
      pairToggleStep({ ...base, executorSelection: null, on: true, state: off, lead: lead() }),
    ).toBeNull();
    // The lead is mid-turn.
    expect(
      pairToggleStep({ ...base, on: true, state: off, lead: lead({ session: running }) }),
    ).toBeNull();
    expect(
      pairToggleStep({
        ...base,
        on: false,
        state: on("completed"),
        lead: lead({ session: running }),
      }),
    ).toBeNull();
    // A provider that cannot lead, and no thread at all.
    expect(
      pairToggleStep({
        ...base,
        on: true,
        state: { kind: "unsupported-lead", reason: PAIR_UNSUPPORTED_LEAD_REASON },
        lead: lead(),
      }),
    ).toBeNull();
    expect(pairToggleStep({ ...base, on: true, state: off, lead: null })).toBeNull();
  });

  it("never turns a pair off under a working executor without stopping it first", () => {
    // Archiving a running executor would orphan its turn; the user stops it, then turns the pair off.
    for (const phase of ["running", "needs-approval", "needs-input"] as const) {
      expect(pairToggleStep({ ...base, on: false, state: on(phase), lead: lead() })).toBeNull();
    }
  });

  it("applies Supervised child permissions", () => {
    const step = pairToggleStep({
      ...base,
      childRuntimeMode: "approval-required",
      on: true,
      state: off,
      lead: lead(),
    });
    expect(step?.kind === "create" ? step.input.runtimeMode : null).toBe("approval-required");
  });
});

describe("shouldRestartLeadSession", () => {
  it("restarts only an idle live session", () => {
    expect(shouldRestartLeadSession(lead({ session: ready }))).toBe(true);
    expect(
      shouldRestartLeadSession(lead({ session: { status: "idle", activeTurnId: null } })),
    ).toBe(true);
    expect(shouldRestartLeadSession(lead())).toBe(false);
    expect(shouldRestartLeadSession(lead({ session: running }))).toBe(false);
    for (const status of ["stopped", "error", "interrupted", "starting"] as const) {
      expect(shouldRestartLeadSession(lead({ session: { status, activeTurnId: null } }))).toBe(
        false,
      );
    }
    expect(shouldRestartLeadSession(null)).toBe(false);
  });
});

describe("resolveExecutorSelection", () => {
  it("shows the executor's own model when on, else the pick, else the default", () => {
    expect(
      resolveExecutorSelection({ state: on("idle"), picked: OTHER, defaultSelection: OTHER }),
    ).toEqual(SELECTION);
    expect(
      resolveExecutorSelection({ state: off, picked: OTHER, defaultSelection: SELECTION }),
    ).toEqual(OTHER);
    expect(
      resolveExecutorSelection({ state: off, picked: null, defaultSelection: SELECTION }),
    ).toEqual(SELECTION);
    expect(
      resolveExecutorSelection({ state: off, picked: null, defaultSelection: null }),
    ).toBeNull();
  });
});
