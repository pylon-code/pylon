import {
  pairExecutorCreateInput,
  type PairExecutorCreateInput,
  type PairState,
} from "@t3tools/client-runtime/state/pair";
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

/**
 * What has to be set up before a pair can start, or null when nothing does. The
 * server only gives a lead its pair tools while Pylon delegation is on, so a pair
 * started without it would create an executor nothing could brief. Turning a pair
 * off is never blocked by this.
 */
export function pairSetupReason(input: {
  readonly delegationEnabled: boolean;
  readonly state: PairState;
}): string | null {
  if (input.state.kind === "off" && !input.delegationEnabled) {
    return "Turn on Pylon delegation in Settings → Integrations to pair.";
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
  readonly delegationEnabled: boolean;
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
  if (input.on && pairSetupReason(input) !== null) {
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
