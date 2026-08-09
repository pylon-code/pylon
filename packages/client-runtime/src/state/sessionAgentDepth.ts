import * as Option from "effect/Option";

import {
  decodeOrchestrationSessionActivity,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
  type ServerProvider,
  type SessionAgentDepthUpdatedActivityPayload,
} from "@t3tools/contracts";

export type SessionAgentDepthSnapshot = SessionAgentDepthUpdatedActivityPayload & {
  readonly updatedAt: string;
};

export function deriveLatestSessionAgentDepth(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  providerInstanceId: ProviderInstanceId,
): SessionAgentDepthSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "session.agent-depth.updated") continue;
    const decoded = decodeOrchestrationSessionActivity(activity);
    if (Option.isNone(decoded) || decoded.value.kind !== "session.agent-depth.updated") continue;
    if (decoded.value.payload.providerInstanceId !== providerInstanceId) continue;
    return { ...decoded.value.payload, updatedAt: activity.createdAt };
  }
  return null;
}

export function supportsSessionAgentDepth(
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
): boolean {
  const agents = provider?.featureCapabilities?.agents;
  return (
    (agents?.support === "read-only" || agents?.support === "read-write") &&
    agents.operations.includes("set-depth")
  );
}

export function canSetSessionAgentDepth(
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
  snapshot: SessionAgentDepthSnapshot | null,
): boolean {
  const agents = provider?.featureCapabilities?.agents;
  return (
    snapshot?.writable === true &&
    snapshot.settable &&
    agents?.support === "read-write" &&
    agents.operations.includes("set-depth")
  );
}
