/**
 * What a client needs to show and control a pair: whether this lead can have
 * one, whether it is on, what its executor is doing, and the command inputs
 * that turn it on and off. Pure, shared by web and mobile.
 *
 * STUB: written by the lead so the tests compile. The executor replaces the
 * function bodies; exported names, types, and signatures must not change.
 */
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

/** Shown wherever the pair control is disabled for the selected lead provider. */
export const PAIR_UNSUPPORTED_LEAD_REASON =
  "Pair needs a lead that can hold its own subagents. Antigravity works as the executor.";

export type PairExecutorPhase =
  | "idle"
  | "running"
  | "needs-approval"
  | "needs-input"
  | "completed"
  | "interrupted"
  | "error";

export type PairState =
  | { readonly kind: "unsupported-lead"; readonly reason: string }
  | { readonly kind: "off"; readonly executorId: ThreadId }
  | {
      readonly kind: "on";
      readonly executorId: ThreadId;
      readonly phase: PairExecutorPhase;
      readonly modelSelection: ModelSelection;
      /** The executor's last error, or the plan step it is on, trimmed for one line. */
      readonly activity: string | null;
    };

/** Antigravity cannot lead: Pylon cannot hold its own subagents for one session. */
export function isPairLeadSupported(_driverKind: string | null | undefined): boolean {
  throw new Error("state/pair.isPairLeadSupported is not implemented");
}

export function resolvePairState(_input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly lead: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly driverKind: string | null | undefined;
  };
}): PairState {
  throw new Error("state/pair.resolvePairState is not implemented");
}

/** Threads a list should show: an executor is reached through its lead, not the list. */
export function withoutPairExecutors<T extends { readonly id: ThreadId }>(
  _threads: readonly T[],
): readonly T[] {
  throw new Error("state/pair.withoutPairExecutors is not implemented");
}

export interface PairExecutorCreateInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: "default";
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

/** The `thread.create` fields that turn a pair on for a lead. */
export function pairExecutorCreateInput(_input: {
  readonly lead: Pick<
    EnvironmentThreadShell,
    "id" | "projectId" | "title" | "runtimeMode" | "branch" | "worktreePath"
  >;
  readonly executorSelection: ModelSelection;
  /** The user's Child permissions setting. */
  readonly childRuntimeMode: "inherit" | "approval-required";
}): PairExecutorCreateInput {
  throw new Error("state/pair.pairExecutorCreateInput is not implemented");
}
