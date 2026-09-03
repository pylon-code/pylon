import type { OrchestrationRollbackStatus } from "@t3tools/contracts";

export interface MobileRollbackStatusPresentation {
  readonly title: string;
  readonly detail: string;
  readonly severe: boolean;
  readonly accessibilityRole: "alert" | "summary";
  readonly accessibilityLiveRegion: "assertive" | "polite";
  readonly actions: ReadonlyArray<"retry-verification" | "resume-compensation">;
}

export function resolveMobileRollbackStatus(
  detailStatus: OrchestrationRollbackStatus | null | undefined,
  shellStatus: OrchestrationRollbackStatus | null | undefined,
): OrchestrationRollbackStatus | null | undefined {
  return detailStatus ?? shellStatus;
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
