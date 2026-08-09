import * as Option from "effect/Option";

import {
  decodeOrchestrationSessionActivity,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
  type ServerProvider,
  type SessionInputQueueUpdatedActivityPayload,
} from "@t3tools/contracts";

export type SessionInputQueueSnapshot = SessionInputQueueUpdatedActivityPayload & {
  readonly updatedAt: string;
};

export function deriveLatestSessionInputQueue(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  providerInstanceId: ProviderInstanceId,
): SessionInputQueueSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "session.input-queue.updated") continue;
    const decoded = decodeOrchestrationSessionActivity(activity);
    if (Option.isNone(decoded) || decoded.value.kind !== "session.input-queue.updated") continue;
    if (decoded.value.payload.providerInstanceId !== providerInstanceId) continue;
    return { ...decoded.value.payload, updatedAt: activity.createdAt };
  }
  return null;
}

function supportsOperation(
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
  operation: "observe" | "follow-up" | "clear" | "set-modes",
  write: boolean,
): boolean {
  const queue = provider?.featureCapabilities?.inputQueue;
  return (
    queue !== undefined &&
    (write ? queue.support === "read-write" : queue.support !== "unavailable") &&
    queue.operations.includes(operation)
  );
}

export const supportsSessionInputQueue = (
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
): boolean => supportsOperation(provider, "observe", false);

export const supportsSessionInputQueueFollowUp = (
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
): boolean => supportsOperation(provider, "follow-up", true);

export const supportsSessionInputQueueClear = (
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
): boolean => supportsOperation(provider, "clear", true);

export const supportsSessionInputQueueSetModes = (
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
): boolean => supportsOperation(provider, "set-modes", true);

export function hasSessionInputQueueModes(
  snapshot: SessionInputQueueSnapshot | null,
): snapshot is SessionInputQueueSnapshot & {
  readonly steeringMode: NonNullable<SessionInputQueueSnapshot["steeringMode"]>;
  readonly followUpMode: NonNullable<SessionInputQueueSnapshot["followUpMode"]>;
} {
  return snapshot?.steeringMode !== undefined && snapshot.followUpMode !== undefined;
}

export function sessionInputQueueCount(snapshot: SessionInputQueueSnapshot | null): number {
  return snapshot === null ? 0 : snapshot.steeringCount + snapshot.followUpCount;
}
