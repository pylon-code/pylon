/**
 * Pure rules for what a lead's lifecycle means for its pair executor.
 *
 * @module orchestration/pairLifecycle.logic
 */
import type { OrchestrationEvent, OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import { isDelegatedThreadId } from "../mcp/toolkits/delegation/logic.ts";
import { derivePairExecutorState } from "../mcp/toolkits/pair/logic.ts";

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
export function pairLifecycleIntent(event: OrchestrationEvent): PairLifecycleIntent | null {
  if (event.metadata.historyImport === true) {
    return null;
  }
  let action: PairLifecycleAction;
  switch (event.type) {
    case "thread.archived":
      action = "archive";
      break;
    case "thread.deleted":
      action = "delete";
      break;
    case "thread.settled":
      action = "settle";
      break;
    case "thread.checkpoint-revert-requested":
      action = "interrupt";
      break;
    default:
      return null;
  }
  const leadThreadId = event.payload.threadId;
  if (isDelegatedThreadId(leadThreadId)) {
    return null;
  }
  return { leadThreadId, action };
}

/** Whether the action still has something to do for this executor. */
export function pairLifecycleApplies(
  action: PairLifecycleAction,
  executor: OrchestrationThreadShell,
): boolean {
  switch (action) {
    case "archive":
      return executor.archivedAt === null;
    case "delete":
      return true;
    case "settle":
      return executor.archivedAt === null && executor.settledOverride !== "settled";
    case "interrupt":
      return derivePairExecutorState(executor) === "running";
  }
}

/** How long a never-briefed executor may wait for a lead that does not exist yet. */
export const ORPHAN_EXECUTOR_GRACE_MS = 24 * 60 * 60 * 1_000;

/**
 * Pair executors nothing will ever brief. Turning Pair on in a draft creates the
 * executor before the lead thread exists, so a missing lead is normal for a
 * while; an abandoned draft, or a draft whose id changed before its first send,
 * leaves that executor behind for good. Only an executor that never ran, whose
 * lead is unknown, and that is older than the grace period counts.
 */
export function orphanedExecutorIds(_input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  /** Every thread id the server knows, archived ones included. */
  readonly knownThreadIds: ReadonlySet<string>;
  readonly nowMs: number;
}): ReadonlyArray<ThreadId> {
  return [];
}
