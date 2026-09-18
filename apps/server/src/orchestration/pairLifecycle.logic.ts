/**
 * Pure rules for what a lead's lifecycle means for its pair executor.
 *
 * STUB: written by the lead so the tests compile. The executor replaces the
 * bodies; exported names and signatures must not change.
 *
 * @module orchestration/pairLifecycle.logic
 */
import type { OrchestrationEvent, OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";

/**
 * - `archive`, `delete`, `settle`: the executor follows its lead.
 * - `interrupt`: the lead is being rewound. Both threads share one worktree, so
 *   an executor that keeps editing would write over the restored files.
 */
export type PairLifecycleAction = "archive" | "delete" | "settle" | "interrupt";

export interface PairLifecycleIntent {
  readonly leadThreadId: ThreadId;
  readonly action: PairLifecycleAction;
}

/** What a domain event asks of the pair, or null when it asks nothing. */
export function pairLifecycleIntent(_event: OrchestrationEvent): PairLifecycleIntent | null {
  throw new Error("pairLifecycle.logic.pairLifecycleIntent is not implemented");
}

/** Whether the action still has something to do for this executor. */
export function pairLifecycleApplies(
  _action: PairLifecycleAction,
  _executor: OrchestrationThreadShell,
): boolean {
  throw new Error("pairLifecycle.logic.pairLifecycleApplies is not implemented");
}
