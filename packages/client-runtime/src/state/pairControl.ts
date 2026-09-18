import {
  pairExecutorCreateInput,
  pairStatusLine,
  type PairExecutorCreateInput,
  type PairState,
} from "./pair.ts";
import type {
  ModelSelection,
  OrchestrationSession,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

export interface PairLead {
  readonly id: ThreadId;
  readonly projectId: PairExecutorCreateInput["projectId"];
  readonly title: string;
  readonly runtimeMode: RuntimeMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null;
}

/**
 * - `create`: turn the pair on. If the thread already exists it is an archived
 *   executor from an earlier pair, and the caller unarchives it instead.
 * - `delete`: turn off a pair whose executor was never briefed; nothing is lost.
 * - `archive`: turn off a pair that has history, keeping its transcript.
 */
export type PairToggleStep =
  | { readonly kind: "create"; readonly input: PairExecutorCreateInput }
  | { readonly kind: "delete"; readonly threadId: ThreadId }
  | { readonly kind: "archive"; readonly threadId: ThreadId };

/** Why the switch cannot change right now, or null when it can. */
export function pairLockedReason(lead: PairLead | null): string | null {
  if (lead === null) {
    return "Open a thread to pair it.";
  }
  if (lead.session?.status === "running" || lead.session?.status === "starting") {
    return "Changes apply between turns.";
  }
  return null;
}

/** The step a toggle performs, or null when the toggle changes nothing or is not allowed. */
export function pairToggleStep(input: {
  readonly on: boolean;
  readonly state: PairState;
  readonly lead: PairLead | null;
  readonly executorSelection: ModelSelection | null;
  readonly childRuntimeMode: "inherit" | "approval-required";
}): PairToggleStep | null {
  if (input.lead === null) {
    return null;
  }
  if (pairLockedReason(input.lead) !== null) {
    return null;
  }
  if (input.state.kind === "unsupported-lead") {
    return null;
  }
  if (input.on && input.state.kind === "on") {
    return null;
  }
  if (!input.on && input.state.kind === "off") {
    return null;
  }
  if (input.on && input.executorSelection === null) {
    return null;
  }

  if (input.on) {
    if (input.executorSelection === null) {
      return null;
    }
    return {
      kind: "create",
      input: pairExecutorCreateInput({
        lead: input.lead,
        executorSelection: input.executorSelection,
        childRuntimeMode: input.childRuntimeMode,
      }),
    };
  }

  if (input.state.kind !== "on") {
    return null;
  }

  switch (input.state.phase) {
    case "idle":
      return { kind: "delete", threadId: input.state.executorId };
    case "completed":
    case "interrupted":
    case "error":
      return { kind: "archive", threadId: input.state.executorId };
    case "running":
    case "needs-approval":
    case "needs-input":
      return null;
  }
}

/**
 * A lead's session learns that it is paired when it is prepared. An idle
 * session is stopped so its next turn starts a new one, resumed from the same
 * conversation; a lead with no session, or one already stopped, needs nothing.
 */
export function shouldRestartLeadSession(lead: PairLead | null): boolean {
  return lead?.session?.status === "ready" || lead?.session?.status === "idle";
}

/** The executor model to show: the executor's own when on, else the user's pick, else the default. */
export function resolveExecutorSelection(input: {
  readonly state: PairState;
  readonly picked: ModelSelection | null;
  readonly defaultSelection: ModelSelection | null;
}): ModelSelection | null {
  if (input.state.kind === "on") {
    return input.state.modelSelection;
  }
  return input.picked ?? input.defaultSelection;
}

/**
 * The phone's Pair switch. A phone has no executor picker: the executor is the
 * project's default delegation model, so without one the switch explains where
 * to set it. `detail` is the one line shown under the switch.
 */
export function pairSettingsRow(input: {
  readonly state: PairState;
  readonly lockedReason: string | null;
  /** The executor's own model while the pair is on; the project's default while it is off. */
  readonly executorSelection: ModelSelection | null;
  /** That model's display name, or "" when there is none. */
  readonly executorLabel: string;
}): { readonly value: boolean; readonly disabled: boolean; readonly detail: string | null } {
  if (input.state.kind === "unsupported-lead") {
    return { value: false, disabled: true, detail: input.state.reason };
  }
  const value = input.state.kind === "on";
  if (input.lockedReason !== null && input.lockedReason.length > 0) {
    return { value, disabled: true, detail: input.lockedReason };
  }
  if (input.state.kind === "on") {
    return {
      value: true,
      disabled: false,
      detail: pairStatusLine(input.state, input.executorLabel),
    };
  }
  if (input.executorSelection === null) {
    return {
      value: false,
      disabled: true,
      detail: "Set a default delegation model in the project's settings to pair from here.",
    };
  }
  return {
    value: false,
    disabled: false,
    detail: `Pairs this thread with ${input.executorLabel}.`,
  };
}
