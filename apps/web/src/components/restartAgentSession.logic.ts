import {
  deriveLatestSessionCompaction,
  isSessionCompactionInProgress,
} from "@t3tools/client-runtime/state/context-compaction";
import {
  deriveLatestSessionInputQueue,
  sessionInputQueueCount,
} from "@t3tools/client-runtime/state/session-input-queue";
import type { OrchestrationThread } from "@t3tools/contracts";

/**
 * What a restart would interrupt. Restart dispatches the same stop as the
 * Stop button, and that stop ends the running turn, cancels a compaction and
 * its queued messages, and clears the provider's input queue.
 */
export type RestartAgentSessionPlan =
  | { readonly kind: "idle" }
  | { readonly kind: "stopping" }
  | {
      readonly kind: "busy";
      readonly runningTurn: boolean;
      readonly compacting: boolean;
      /** Messages that would be cancelled: compaction queue plus provider input queue. */
      readonly queuedMessages: number;
    };

export function planRestartAgentSession(
  thread: Pick<OrchestrationThread, "session" | "activities">,
): RestartAgentSessionPlan {
  const session = thread.session;
  if (!session || session.status === "stopped") return { kind: "idle" };
  if (session.pendingStopRequestId !== undefined) return { kind: "stopping" };
  const runningTurn =
    session.status === "running" ||
    session.status === "starting" ||
    session.activeTurnId !== null ||
    session.pendingTurnRequestId !== undefined;
  const compactionQueue = session.compactionQueue;
  const instanceId = session.providerInstanceId;
  const inputQueue =
    instanceId === undefined ? null : deriveLatestSessionInputQueue(thread.activities, instanceId);
  // Slash-command compaction owns the durable queue; native compaction
  // reports progress through session activities.
  const compacting =
    compactionQueue !== undefined ||
    (instanceId !== undefined &&
      isSessionCompactionInProgress(deriveLatestSessionCompaction(thread.activities, instanceId)));
  const queuedMessages = (compactionQueue?.queued.length ?? 0) + sessionInputQueueCount(inputQueue);
  if (!runningTurn && !compacting && queuedMessages === 0) return { kind: "idle" };
  return { kind: "busy", runningTurn, compacting, queuedMessages };
}

/** Confirmation copy naming exactly what the restart will stop or cancel. */
export function restartAgentSessionConfirmMessage(
  plan: Extract<RestartAgentSessionPlan, { kind: "busy" }>,
): string {
  const stops = [
    ...(plan.runningTurn ? ["the running turn"] : []),
    ...(plan.compacting ? ["context compaction"] : []),
  ];
  const lines = ["Restart the agent session?"];
  if (stops.length > 0) lines.push(`This stops ${stops.join(" and ")}.`);
  if (plan.queuedMessages > 0) {
    lines.push(
      plan.queuedMessages === 1
        ? "1 queued message will be cancelled."
        : `${plan.queuedMessages} queued messages will be cancelled.`,
    );
  }
  return lines.join("\n");
}
