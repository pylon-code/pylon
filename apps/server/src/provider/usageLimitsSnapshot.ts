import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
  readonly source?: string;
}): ServerProviderUsageLimits {
  return {
    source: input.source ?? "provider",
    checkedAt: input.checkedAt,
    windows: [...input.windows],
  };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
  readonly source?: string;
}): ServerProviderUsageLimits {
  return {
    ...makeUsageLimits({ ...input, windows: [] }),
    unavailable: { reason: input.reason, ...(input.message ? { message: input.message } : {}) },
  };
}
