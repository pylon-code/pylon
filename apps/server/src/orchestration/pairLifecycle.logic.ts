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
