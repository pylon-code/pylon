import { isSessionCompactionInProgress } from "@t3tools/client-runtime/state/context-compaction";
import {
  deriveLatestSessionInputQueue,
  sessionInputQueueCount,
} from "@t3tools/client-runtime/state/session-input-queue";
import {
  decodeOrchestrationSessionActivity,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

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
      /** Identity of the running compaction, or null when none runs. */
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
  const nativeCompactionKey =
    instanceId === undefined ? null : nativeCompactionRunKey(thread.activities, instanceId);
  const compactionKey =
    compactionQueue !== undefined
      ? `slash:${compactionQueue.requestId}`
      : nativeCompactionKey === null
        ? null
        : `native:${nativeCompactionKey}`;
  const compacting = compactionKey !== null;
  const queuedMessages = (compactionQueue?.queued.length ?? 0) + sessionInputQueueCount(inputQueue);
  if (!runningTurn && !compacting && queuedMessages === 0) return { kind: "idle" };
  const turnKey = session.activeTurnId ?? session.pendingTurnRequestId ?? null;
  return { kind: "busy", runningTurn, turnKey, compacting, compactionKey, queuedMessages };
}

/**
 * Native compaction updates carry no compaction id, so a run is identified by
 * the activity that started it: the earliest update in the latest unbroken
 * sequence of in-progress updates for this provider instance. A compaction
 * that finishes and another that starts are separated by a finished update,
 * so they get different keys. Returns null when none is in progress.
 */
function nativeCompactionRunKey(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  instanceId: ProviderInstanceId,
): string | null {
  let runStart: string | null = null;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "session.compaction.updated") continue;
    const decoded = decodeOrchestrationSessionActivity(activity);
    if (Option.isNone(decoded) || decoded.value.kind !== "session.compaction.updated") continue;
    if (decoded.value.payload.providerInstanceId !== instanceId) continue;
    if (!isSessionCompactionInProgress(decoded.value.payload)) break;
    runStart = activity.id;
  }
  return runStart;
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
  if (current.compacting && current.compactionKey !== confirmed.compactionKey) return true;
  return current.queuedMessages > confirmed.queuedMessages;
}
