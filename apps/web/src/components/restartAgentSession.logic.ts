import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { getUserQueuedThreadRuns } from "@t3tools/client-runtime/state/thread-workflows";
import type { ThreadShell } from "../types";

/** Work a provider-session detach may interrupt, from native V2 entities. */
export type RestartAgentSessionPlan =
  | { readonly kind: "idle" }
  | { readonly kind: "stopping" }
  | {
      readonly kind: "busy";
      readonly sessionKey: string | null;
      readonly runningTurn: boolean;
      readonly turnKey: string | null;
      readonly compacting: boolean;
      readonly compactionKey: string | null;
      /** V2 detaches preserve queued app runs. */
      readonly queuedMessages: number;
      readonly detailsKnown: boolean;
    };

type RestartProjection = Pick<
  OrchestrationV2ThreadProjection,
  "providerSessions" | "turnItems" | "runs" | "messages"
>;

export function planRestartAgentSession(
  thread: Pick<ThreadShell, "runtime" | "activeProviderThreadId">,
  projection: RestartProjection | null = null,
): RestartAgentSessionPlan {
  const runningTurn =
    thread.runtime !== null &&
    ["preparing", "starting", "running", "waiting"].includes(thread.runtime.status);
  const compaction = projection?.turnItems.findLast(
    (item) => item.type === "compaction" && ["pending", "running", "waiting"].includes(item.status),
  );
  const queuedMessages = projection === null ? 0 : getUserQueuedThreadRuns(projection).length;
  if (!runningTurn && compaction === undefined && queuedMessages === 0) return { kind: "idle" };
  const sessions = projection?.providerSessions
    .filter((session) => session.status !== "stopped")
    .map((session) => session.id)
    .sort();
  return {
    kind: "busy",
    sessionKey: sessions?.length ? JSON.stringify(sessions) : thread.activeProviderThreadId,
    runningTurn,
    turnKey: thread.runtime?.activeRunId ?? null,
    compacting: compaction !== undefined,
    compactionKey: compaction?.id ?? null,
    queuedMessages,
    detailsKnown: projection !== null,
  };
}

export function restartAgentSessionConfirmMessage(
  plan: Extract<RestartAgentSessionPlan, { kind: "busy" }>,
): string {
  const stops = [
    ...(plan.runningTurn ? ["the running run"] : []),
    ...(plan.compacting ? ["context compaction"] : []),
  ];
  const lines = ["Restart the agent session?"];
  if (stops.length > 0) lines.push(`This may interrupt ${stops.join(" and ")}.`);
  if (plan.queuedMessages > 0) {
    lines.push(
      plan.queuedMessages === 1
        ? "1 queued message remains queued."
        : `${plan.queuedMessages} queued messages remain queued.`,
    );
  }
  return lines.join("\n");
}

/** Reject a replacement session/run/compaction or details we cannot verify. */
export function restartPlanExceedsConfirmed(
  confirmed: Extract<RestartAgentSessionPlan, { kind: "busy" }>,
  current: RestartAgentSessionPlan,
): boolean {
  if (current.kind !== "busy") return false;
  if (!current.detailsKnown || current.sessionKey !== confirmed.sessionKey) return true;
  if (current.runningTurn && (!confirmed.runningTurn || current.turnKey !== confirmed.turnKey)) {
    return true;
  }
  if (
    current.compacting &&
    (current.compactionKey === null || current.compactionKey !== confirmed.compactionKey)
  ) {
    return true;
  }
  return current.queuedMessages > confirmed.queuedMessages;
}
