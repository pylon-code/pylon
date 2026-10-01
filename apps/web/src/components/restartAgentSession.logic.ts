import {
  deriveLatestSessionCompaction,
  isSessionCompactionInProgress,
} from "@t3tools/client-runtime/state/context-compaction";
import {
  deriveLatestSessionInputQueue,
  sessionInputQueueCount,
} from "@t3tools/client-runtime/state/session-input-queue";
import type {
  OrchestrationThread,
  OrchestrationThreadActivity,
  ProviderInstanceId,
} from "@t3tools/contracts";

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
      /** The active turn, else the admission waiting to start one. */
      readonly turnKey: string | null;
      readonly compacting: boolean;
      /** Identity of the running compaction; null when none runs or it cannot be identified. */
      readonly compactionKey: string | null;
      /** Messages that would be cancelled: compaction queue plus provider input queue. */
      readonly queuedMessages: number;
    };

export function planRestartAgentSession(
  thread: Pick<OrchestrationThread, "session" | "activities">,
): RestartAgentSessionPlan {
  const session = thread.session;
  if (!session) return { kind: "idle" };
  // The stop decider marks the session stopped together with the pending stop,
  // so check the pending cleanup before treating a stopped session as idle.
  if (session.pendingStopRequestId !== undefined) return { kind: "stopping" };
  if (session.status === "stopped") return { kind: "idle" };
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
  const native =
    instanceId === undefined
      ? { compacting: false, key: null }
      : nativeCompaction(thread.activities, instanceId);
  const compacting = compactionQueue !== undefined || native.compacting;
  const compactionKey =
    compactionQueue !== undefined
      ? `slash:${compactionQueue.requestId}`
      : native.key === null
        ? null
        : `native:${native.key}`;
  const queuedMessages = (compactionQueue?.queued.length ?? 0) + sessionInputQueueCount(inputQueue);
  if (!runningTurn && !compacting && queuedMessages === 0) return { kind: "idle" };
  const turnKey = session.activeTurnId ?? session.pendingTurnRequestId ?? null;
  return { kind: "busy", runningTurn, turnKey, compacting, compactionKey, queuedMessages };
}

/**
 * Native compaction is one upserted activity row per thread, so the row's own
 * id cannot tell runs apart. The server stamps `runStartedAt` on every update
 * of a run. Rows from older servers lack it and yield a null key while
 * compacting, which the confirmation check treats as unprovable.
 */
function nativeCompaction(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  instanceId: ProviderInstanceId,
): { readonly compacting: boolean; readonly key: string | null } {
  const snapshot = deriveLatestSessionCompaction(activities, instanceId);
  if (!isSessionCompactionInProgress(snapshot)) return { compacting: false, key: null };
  return { compacting: true, key: snapshot?.runStartedAt ?? null };
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

/**
 * True when stopping now would end work the confirmation did not describe:
 * a different turn, a turn or compaction that was not running, or more
 * queued messages than were shown.
 */
export function restartPlanExceedsConfirmed(
  confirmed: Extract<RestartAgentSessionPlan, { kind: "busy" }>,
  current: RestartAgentSessionPlan,
): boolean {
  if (current.kind !== "busy") return false;
  if (current.runningTurn && (!confirmed.runningTurn || current.turnKey !== confirmed.turnKey)) {
    return true;
  }
  // A compaction without an identity cannot be proven to be the confirmed one.
  if (
    current.compacting &&
    (current.compactionKey === null || current.compactionKey !== confirmed.compactionKey)
  ) {
    return true;
  }
  return current.queuedMessages > confirmed.queuedMessages;
}
