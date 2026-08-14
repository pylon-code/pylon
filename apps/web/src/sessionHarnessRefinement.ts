import type {
  ProviderRefineSessionHarnessResult,
  RuntimeMode,
  ServerProvider,
} from "@t3tools/contracts";

export type SessionHarnessRefinementOutcome =
  | ProviderRefineSessionHarnessResult["outcome"]
  | "unknown";

export const SESSION_HARNESS_REFINEMENT_CONFIRMATION =
  "Refine the local harness for this thread? This improves only this thread's private session harness. It may take time and cannot be cancelled or rolled back here.";

export function sessionHarnessRefinementScopeKey(input: {
  readonly sessionScopeKey: string | null;
  readonly sessionStartedAt: string | null | undefined;
}): string | null {
  return input.sessionScopeKey && input.sessionStartedAt
    ? JSON.stringify([input.sessionScopeKey, input.sessionStartedAt])
    : null;
}

export function canRefineSessionHarness(input: {
  readonly provider: Pick<ServerProvider, "featureCapabilities" | "status"> | null | undefined;
  readonly hasActiveThread: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly sessionStatus: string | null | undefined;
  readonly isConnecting: boolean;
  readonly environmentAvailable: boolean;
  readonly restored: boolean;
  readonly sessionStartedAt: string | null | undefined;
}): boolean {
  const context = input.provider?.featureCapabilities?.context;
  return (
    input.hasActiveThread &&
    input.runtimeMode === "full-access" &&
    (input.sessionStatus === "ready" || input.sessionStatus === "running") &&
    !input.isConnecting &&
    input.environmentAvailable &&
    input.sessionStartedAt !== null &&
    input.sessionStartedAt !== undefined &&
    !input.restored &&
    input.provider?.status === "ready" &&
    context?.support === "read-write" &&
    context.operations.includes("refine")
  );
}

export type SessionHarnessRefinementRequestIdentity = {
  readonly scopeKey: string;
  readonly id: number;
};

export function sessionHarnessRefinementControlState(input: {
  readonly lifecycle: "available" | "running" | "outcome-unknown";
  readonly locallyPending: boolean;
  readonly locallyOutcomeUnknown: boolean;
}): { readonly pending: boolean; readonly outcomeUnknown: boolean; readonly canRefine: boolean } {
  const pending = input.locallyPending || input.lifecycle === "running";
  const outcomeUnknown = input.locallyOutcomeUnknown || input.lifecycle === "outcome-unknown";
  return { pending, outcomeUnknown, canRefine: !pending && !outcomeUnknown };
}

export function isCurrentSessionHarnessRefinementRequest(
  currentScopeKey: string | null,
  currentRequestId: number,
  request: SessionHarnessRefinementRequestIdentity,
): boolean {
  return currentScopeKey === request.scopeKey && currentRequestId === request.id;
}

export function harnessRefinementToast(outcome: SessionHarnessRefinementOutcome): {
  readonly type: "success" | "warning" | "error";
  readonly title: string;
  readonly description: string;
} {
  switch (outcome) {
    case "completed":
      return {
        type: "success",
        title: "Local harness refined",
        description: "The private refinement for this thread completed.",
      };
    case "partial":
      return {
        type: "warning",
        title: "Local harness partly refined",
        description: "The private refinement for this thread completed only in part.",
      };
    case "failed":
      return {
        type: "error",
        title: "Local harness refinement failed",
        description: "The private refinement for this thread could not be completed.",
      };
    case "unknown":
      return {
        type: "warning",
        title: "Refinement outcome unavailable",
        description:
          "Pylon could not confirm whether the private refinement completed and will not retry it automatically.",
      };
  }
}
