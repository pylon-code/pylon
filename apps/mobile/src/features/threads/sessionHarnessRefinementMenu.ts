import type { MenuAction } from "@react-native-menu/menu";
import type { ServerProvider } from "@t3tools/contracts";

export const SESSION_HARNESS_REFINEMENT_ACTION = "refine" as const;

type RefinableSession = {
  readonly status: string;
  readonly runtimeMode: string;
  readonly restored?: boolean;
  readonly startedAt?: string;
  readonly harnessRefinementStatus?: "available" | "running" | "outcome-unknown";
};

export function sessionHarnessRefinementScopeKey(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly providerInstanceId: string | null | undefined;
  readonly sessionStartedAt: string | null | undefined;
}): string {
  return JSON.stringify([
    input.environmentId,
    input.threadId,
    input.providerInstanceId ?? null,
    input.sessionStartedAt ?? null,
  ]);
}

export function sessionHarnessRefinementActionId(scopeKey: string): string {
  return `session-harness-refinement:${encodeURIComponent(scopeKey)}:${SESSION_HARNESS_REFINEMENT_ACTION}`;
}

export function parseSessionHarnessRefinementAction(
  eventId: string,
  scopeKey: string,
): typeof SESSION_HARNESS_REFINEMENT_ACTION | null {
  return eventId === sessionHarnessRefinementActionId(scopeKey)
    ? SESSION_HARNESS_REFINEMENT_ACTION
    : null;
}

export function canRefineSessionHarness(input: {
  readonly connectionState: string;
  readonly session: RefinableSession | null;
  readonly provider: Pick<ServerProvider, "featureCapabilities"> | null;
}): boolean {
  const context = input.provider?.featureCapabilities?.context;
  return (
    input.connectionState === "connected" &&
    input.session?.runtimeMode === "full-access" &&
    input.session.restored !== true &&
    input.session.startedAt !== undefined &&
    (input.session.status === "ready" || input.session.status === "running") &&
    context?.support === "read-write" &&
    context.operations.includes("refine")
  );
}

export function buildSessionHarnessRefinementMenuActions(input: {
  readonly scopeKey: string | null;
  readonly connectionState: string;
  readonly session: RefinableSession | null;
  readonly provider: Pick<ServerProvider, "featureCapabilities"> | null;
  readonly pendingScopeKey: string | null;
  readonly outcomeUnknownScopeKey: string | null;
}): MenuAction[] {
  if (
    input.scopeKey === null ||
    !canRefineSessionHarness({
      connectionState: input.connectionState,
      session: input.session,
      provider: input.provider,
    })
  ) {
    return [];
  }

  const pending =
    input.pendingScopeKey === input.scopeKey ||
    input.session?.harnessRefinementStatus === "running";
  const outcomeUnknown =
    input.outcomeUnknownScopeKey === input.scopeKey ||
    input.session?.harnessRefinementStatus === "outcome-unknown";
  return [
    {
      id: sessionHarnessRefinementActionId(input.scopeKey),
      title: pending
        ? "Refining local harness…"
        : outcomeUnknown
          ? "Refinement outcome unavailable"
          : "Refine local harness",
      subtitle: outcomeUnknown
        ? "Unavailable until this provider session ends"
        : "Privately improve only this thread's session harness",
      image: "wand.and.stars",
      attributes: pending || outcomeUnknown ? { disabled: true } : undefined,
    },
  ];
}
