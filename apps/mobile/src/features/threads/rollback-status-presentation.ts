import type { OrchestrationRollbackStatus } from "@t3tools/contracts";
import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/unstable/reactivity";

export interface MobileRollbackStatusPresentation {
  readonly title: string;
  readonly detail: string;
  readonly severe: boolean;
  readonly accessibilityRole: "alert" | "summary";
  readonly accessibilityLiveRegion: "assertive" | "polite";
  readonly actions: ReadonlyArray<"retry-verification" | "resume-compensation">;
}

export interface RollbackStatusSource {
  readonly status: OrchestrationRollbackStatus | null | undefined;
  readonly sequence: number | undefined;
  readonly sessionOwner: object | null | undefined;
  readonly live: boolean;
}

/** A waiting success may retain the previous connection's value during replacement. */
export function currentMobileRollbackSessionOwner(
  result: AsyncResult.AsyncResult<SupervisorConnectionState, unknown>,
): object | null {
  return AsyncResult.isSuccess(result) && !result.waiting && result.value.phase === "connected"
    ? (result.value.sessionOwner ?? null)
    : null;
}

/** Both streams use the server's global event sequence, scoped to one RPC session. */
export function resolveMobileRollbackStatus(input: {
  readonly detail: RollbackStatusSource;
  readonly shell: RollbackStatusSource;
  readonly currentSessionOwner: object | null;
}): {
  readonly status: OrchestrationRollbackStatus | null | undefined;
  readonly uncertain: boolean;
} {
  const { detail, shell, currentSessionOwner } = input;
  if (currentSessionOwner === null) {
    // Keep a cached status visible offline, but never enable recovery actions
    // or sends using state from a session whose authority is no longer live.
    const cached = [detail, shell].filter((source) => source.sequence !== undefined);
    const latest = cached.sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))[0];
    return { status: latest?.status, uncertain: true };
  }
  const current = [detail, shell].filter(
    (source) => source.live && source.sessionOwner === currentSessionOwner,
  );
  if (current.length === 0) return { status: undefined, uncertain: true };
  const withoutUnprovedActions = (status: OrchestrationRollbackStatus | null | undefined) =>
    status == null ? status : { ...status, allowedActions: [] };
  if (current.length === 1) {
    return { status: withoutUnprovedActions(current[0]!.status), uncertain: false };
  }
  if (detail.sequence === undefined || shell.sequence === undefined) {
    return { status: undefined, uncertain: true };
  }
  const detailStatus = detail.status;
  const shellStatus = shell.status;
  // Shell snapshots deliberately omit the detail's explanation, revisions,
  // and recovery actions. An unrelated global event can advance shell's
  // sequence without changing this thread's rollback state.
  const sameProjectedStatus =
    detailStatus == null || shellStatus == null
      ? detailStatus == null && shellStatus == null
      : detailStatus.state === shellStatus.state &&
        detailStatus.updatedAt === shellStatus.updatedAt;
  if (!sameProjectedStatus) {
    const newer = detail.sequence > shell.sequence ? detailStatus : shellStatus;
    return { status: withoutUnprovedActions(newer), uncertain: true };
  }
  // UpdatedAt identifies the projected display state, not the durable saga.
  // Recovery requires the exact operation identity on both projections.
  const detailOperationId =
    detailStatus != null && "operationId" in detailStatus ? detailStatus.operationId : undefined;
  const shellOperationId =
    shellStatus != null && "operationId" in shellStatus ? shellStatus.operationId : undefined;
  if (
    typeof detailOperationId === "string" &&
    typeof shellOperationId === "string" &&
    detailOperationId !== shellOperationId
  ) {
    return { status: withoutUnprovedActions(shellStatus), uncertain: true };
  }
  const sameOperation =
    typeof detailOperationId === "string" &&
    detailOperationId.length > 0 &&
    detailOperationId === shellOperationId;
  return {
    status: sameOperation ? detailStatus : withoutUnprovedActions(detailStatus ?? shellStatus),
    uncertain: false,
  };
}

export function getMobileRollbackStatusPresentation(
  status: OrchestrationRollbackStatus,
): MobileRollbackStatusPresentation {
  const severe = status.state === "manual-recovery" || status.state === "failed";
  const title =
    status.state === "pending"
      ? "Rollback pending"
      : status.state === "recovering"
        ? "Rollback recovering"
        : status.state === "manual-recovery"
          ? "Manual recovery required"
          : status.state === "completed"
            ? "Rollback completed"
            : "Rollback failed safely";
  return {
    title,
    detail: status.detail ?? "Pylon is verifying rollback state.",
    severe,
    accessibilityRole: severe ? "alert" : "summary",
    accessibilityLiveRegion: severe ? "assertive" : "polite",
    actions: status.allowedActions ?? [],
  };
}
