import * as Option from "effect/Option";

import {
  decodeOrchestrationSessionActivity,
  type EnvironmentId,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
  type ThreadId,
  type ServerProvider,
  type SessionCompactionUpdatedActivityPayload,
} from "@t3tools/contracts";

export type SessionCompactionSnapshot = SessionCompactionUpdatedActivityPayload & {
  readonly updatedAt: string;
};
export type SessionCompactionControlSnapshot = Omit<
  SessionCompactionSnapshot,
  "provider" | "providerInstanceId" | "updatedAt"
> & {
  readonly updatedAt?: string;
};

export type SessionCompactionRequestIdentity = {
  readonly scopeKey: string;
  readonly id: number;
};

export function sessionCompactionScopeKey(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}): string {
  return JSON.stringify([input.environmentId, input.threadId, input.providerInstanceId]);
}

export function isCurrentSessionCompactionRequest(
  currentScopeKey: string | null | undefined,
  currentRequestId: number,
  request: SessionCompactionRequestIdentity,
): boolean {
  return currentScopeKey === request.scopeKey && currentRequestId === request.id;
}

export function isAcceptedSessionCompactionMutationResult(input: {
  readonly succeeded: boolean;
  readonly isCurrent: boolean;
  readonly supersededByActivity: boolean;
}): boolean {
  return input.succeeded && (input.isCurrent || input.supersededByActivity);
}

export function deriveLatestSessionCompaction(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  providerInstanceId: ProviderInstanceId,
): SessionCompactionSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "session.compaction.updated") continue;
    const decoded = decodeOrchestrationSessionActivity(activity);
    if (Option.isNone(decoded) || decoded.value.kind !== "session.compaction.updated") continue;
    if (decoded.value.payload.providerInstanceId !== providerInstanceId) continue;
    return { ...decoded.value.payload, updatedAt: activity.createdAt };
  }
  return null;
}

function supportsOperation(
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
  operation: "observe" | "compact" | "abort-compaction" | "configure-compaction",
  write: boolean,
): boolean {
  const context = provider?.featureCapabilities?.context;
  return (
    context !== undefined &&
    (write ? context.support === "read-write" : context.support !== "unavailable") &&
    context.operations.includes(operation)
  );
}

export const supportsSessionCompaction = (
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
): boolean => supportsOperation(provider, "observe", false);

export const supportsSessionCompactNow = (
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
): boolean => supportsOperation(provider, "compact", true);

export const supportsSessionAbortCompaction = (
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
): boolean => supportsOperation(provider, "abort-compaction", true);

export const supportsSessionAutoCompaction = (
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
): boolean => supportsOperation(provider, "configure-compaction", true);

export const isSessionCompactionInProgress = (
  snapshot: Pick<SessionCompactionSnapshot, "status"> | null | undefined,
): boolean =>
  snapshot?.status === "starting" ||
  snapshot?.status === "compacting" ||
  snapshot?.status === "abort-requested";

export const isSessionCompactionSubmissionBlocked = (input: {
  readonly current: Pick<SessionCompactionSnapshot, "status"> | null | undefined;
  readonly activity: Pick<SessionCompactionSnapshot, "status"> | null | undefined;
  readonly compactPending: boolean;
}): boolean =>
  input.compactPending ||
  isSessionCompactionInProgress(input.activity) ||
  isSessionCompactionInProgress(input.current);

export const canStartSessionCompaction = (
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
  snapshot:
    | Pick<SessionCompactionSnapshot, "available" | "status" | "manualCompactionSettable">
    | null
    | undefined,
): boolean =>
  supportsSessionCompactNow(provider) &&
  snapshot?.available === true &&
  snapshot.status === "idle" &&
  snapshot.manualCompactionSettable;

export const canAbortSessionCompaction = (
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
  snapshot:
    | Pick<SessionCompactionSnapshot, "available" | "status" | "abortable">
    | null
    | undefined,
): boolean =>
  supportsSessionAbortCompaction(provider) &&
  snapshot?.available === true &&
  snapshot.abortable &&
  (snapshot.status === "starting" || snapshot.status === "compacting");

export const canConfigureSessionAutoCompaction = (
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
  snapshot:
    | Pick<
        SessionCompactionSnapshot,
        "available" | "autoCompactionEnabled" | "autoCompactionWritable" | "autoCompactionScope"
      >
    | null
    | undefined,
): boolean =>
  supportsSessionAutoCompaction(provider) &&
  snapshot?.available === true &&
  snapshot.autoCompactionEnabled !== undefined &&
  snapshot.autoCompactionWritable &&
  snapshot.autoCompactionScope === "session-and-provider-default";
