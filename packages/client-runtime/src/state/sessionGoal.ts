import * as Option from "effect/Option";

import {
  decodeOrchestrationSessionActivity,
  type OrchestrationSessionStatus,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  type SessionGoalStatus,
  type SessionGoalUpdatedActivityPayload,
} from "@t3tools/contracts";

export type SessionGoalSnapshot = SessionGoalUpdatedActivityPayload & {
  readonly updatedAt: string;
};

export function supportsSessionGoalObservation(
  provider: Pick<ServerProvider, "featureCapabilities" | "availability"> | null | undefined,
): boolean {
  const goals = provider?.featureCapabilities?.goals;
  return (
    provider?.availability !== "unavailable" &&
    goals !== undefined &&
    goals.support !== "unavailable" &&
    goals.operations.includes("observe")
  );
}

/**
 * Selects goal state only for the provider session that is currently attached
 * to the thread. Goal observation is daemon/full-access only today: an
 * unavailable barrier, a supervised runtime, a stopped session, or a provider
 * instance change must retract an older snapshot rather than display it as
 * current.
 */
export function deriveActiveSessionGoal(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly provider:
    | Pick<ServerProvider, "featureCapabilities" | "availability">
    | null
    | undefined;
  readonly providerInstanceId: ProviderInstanceId | undefined;
  readonly runtimeMode: RuntimeMode | undefined;
  readonly sessionStatus: OrchestrationSessionStatus | undefined;
}): SessionGoalSnapshot | null {
  if (
    input.providerInstanceId === undefined ||
    input.runtimeMode !== "full-access" ||
    (input.sessionStatus !== "ready" && input.sessionStatus !== "running") ||
    !supportsSessionGoalObservation(input.provider)
  ) {
    return null;
  }

  for (let index = input.activities.length - 1; index >= 0; index -= 1) {
    const activity = input.activities[index];
    if (!activity || activity.kind !== "session.goal.updated") continue;
    const decoded = decodeOrchestrationSessionActivity(activity);
    if (Option.isNone(decoded) || decoded.value.kind !== "session.goal.updated") continue;
    if (decoded.value.payload.providerInstanceId !== input.providerInstanceId) continue;
    if (!decoded.value.payload.available) return null;
    return { ...decoded.value.payload, updatedAt: decoded.value.createdAt };
  }
  return null;
}

export function formatSessionGoalStatus(status: SessionGoalStatus): string {
  switch (status) {
    case "budget-limited":
      return "Budget limited";
    case "complete":
      return "Complete";
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "error":
      return "Error";
    case "idle":
      return "No goal";
  }
}

export function formatSessionGoalTokenUsage(
  snapshot: Pick<SessionGoalSnapshot, "tokensUsed" | "tokenBudget">,
): string {
  const used = snapshot.tokensUsed.toLocaleString("en-US");
  return snapshot.tokenBudget === undefined
    ? `${used} tokens`
    : `${used} / ${snapshot.tokenBudget.toLocaleString("en-US")} tokens`;
}

export function formatSessionGoalElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

export function boundSessionGoalObjective(objective: string, maxChars = 240): string {
  const characters = [...objective];
  if (characters.length <= maxChars) return objective;
  if (maxChars <= 1) return "…".slice(0, maxChars);
  return `${characters
    .slice(0, maxChars - 1)
    .join("")
    .trimEnd()}…`;
}
