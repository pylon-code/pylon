import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

export function deriveReportedTurnCosts(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<TurnId, number> {
  const costs = new Map<TurnId, number>();
  for (const activity of activities) {
    if (activity.kind !== "turn.cost" || activity.turnId === null) continue;
    const payload = activity.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    const totalCostUsd = (payload as Record<string, unknown>).totalCostUsd;
    if (typeof totalCostUsd !== "number" || !Number.isFinite(totalCostUsd) || totalCostUsd < 0) {
      continue;
    }
    costs.set(activity.turnId, totalCostUsd);
  }
  return costs;
}

export function formatReportedTurnCost(totalCostUsd: number): string | null {
  if (!Number.isFinite(totalCostUsd) || totalCostUsd < 0) return null;
  if (totalCostUsd === 0) return "Reported cost $0.0000";
  if (totalCostUsd < 0.01) return "Reported cost <$0.01";
  if (totalCostUsd < 1) return `Reported cost $${totalCostUsd.toFixed(4)}`;
  if (totalCostUsd < 100) return `Reported cost $${totalCostUsd.toFixed(3)}`;
  return `Reported cost $${totalCostUsd.toFixed(2)}`;
}
