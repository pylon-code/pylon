import type { HostResourcesSnapshot } from "@t3tools/contracts";

export type LoadBalancingStatus = "balanced" | "checking" | "unavailable";

/**
 * What Auto balance can promise an unresolved draft. A finished check that
 * chose no machine is unavailable even without a failed request: no eligible
 * candidates, or every candidate stale, saturated or excluded, also blocks send.
 */
export function resolveLoadBalancingStatus(input: {
  readonly balancedEnvironmentId: string | null | undefined;
  readonly pending: boolean;
  readonly chosenEnvironmentId: string | null;
}): LoadBalancingStatus {
  if (input.balancedEnvironmentId) return "balanced";
  if (input.pending) return "checking";
  // A chosen machine the draft has not stored yet is still being saved.
  return input.chosenEnvironmentId === null ? "unavailable" : "balanced";
}

/** Callers supply only connected machines hosting the project and selected provider. */
export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<{
    environmentId: string;
    resources: HostResourcesSnapshot | null;
    /** Client receipt time avoids comparing clocks on different machines. */
    receivedAt?: number;
    weight: number;
  }>,
  now: number,
): string | null {
  let selected: string | null = null;
  let bestScore = 0;
  for (const { environmentId, resources, receivedAt, weight } of candidates) {
    const sampledAt = receivedAt ?? resources?.sampledAt ?? 0;
    if (
      !resources ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      now - sampledAt > 15_000 ||
      sampledAt > now + 5_000 ||
      resources.cpuUtilization === null ||
      resources.cpuUtilization >= 0.95 ||
      resources.totalMemoryBytes <= 0 ||
      resources.cpuCount <= 0
    ) {
      continue;
    }
    const memoryAvailable = resources.availableMemoryBytes / resources.totalMemoryBytes;
    if (memoryAvailable <= 0.05) continue;
    const score = weight * resources.cpuCount * (1 - resources.cpuUtilization) * memoryAvailable;
    if (score > bestScore) {
      selected = environmentId;
      bestScore = score;
    }
  }
  return selected;
}
