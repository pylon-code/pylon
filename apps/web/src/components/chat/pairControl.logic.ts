/**
 * The decisions behind the composer's pair control, kept pure so they are
 * tested without a composer: what a toggle does, when it has to wait, and
 * whether the lead's session must restart for the change to take effect.
 *
 * STUB: written by the lead so the tests compile. The executor replaces the
 * function bodies; exported names, types, and signatures must not change.
 */
import type { PairExecutorCreateInput, PairState } from "@t3tools/client-runtime/state/pair";
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
export function pairLockedReason(_lead: PairLead | null): string | null {
  throw new Error("pairControl.logic.pairLockedReason is not implemented");
}

/** The step a toggle performs, or null when the toggle changes nothing or is not allowed. */
export function pairToggleStep(_input: {
  readonly on: boolean;
  readonly state: PairState;
  readonly lead: PairLead | null;
  readonly executorSelection: ModelSelection | null;
  readonly childRuntimeMode: "inherit" | "approval-required";
}): PairToggleStep | null {
  throw new Error("pairControl.logic.pairToggleStep is not implemented");
}

/**
 * A lead's session learns that it is paired when it is prepared. An idle
 * session is stopped so its next turn starts a new one, resumed from the same
 * conversation; a lead with no session, or one already stopped, needs nothing.
 */
export function shouldRestartLeadSession(_lead: PairLead | null): boolean {
  throw new Error("pairControl.logic.shouldRestartLeadSession is not implemented");
}

/** The executor model to show: the executor's own when on, else the user's pick, else the default. */
export function resolveExecutorSelection(_input: {
  readonly state: PairState;
  readonly picked: ModelSelection | null;
  readonly defaultSelection: ModelSelection | null;
}): ModelSelection | null {
  throw new Error("pairControl.logic.resolveExecutorSelection is not implemented");
}
