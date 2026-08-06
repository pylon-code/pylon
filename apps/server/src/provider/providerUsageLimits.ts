import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function codexWindowLabel(windowDurationMins: number | null | undefined): string {
  return windowDurationMins !== undefined &&
    windowDurationMins !== null &&
    windowDurationMins >= 7 * 24 * 60
    ? "Weekly"
    : "Session";
}

function mapCodexWindow(
  window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow | null | undefined,
): ServerProviderUsageWindow | undefined {
  if (!window) return undefined;
  return {
    label: codexWindowLabel(window.windowDurationMins),
    usedPercent: clampPercent(window.usedPercent),
    ...(window.windowDurationMins !== undefined && window.windowDurationMins !== null
      ? { windowDurationMins: Math.max(0, window.windowDurationMins) }
      : {}),
    ...(window.resetsAt !== undefined && window.resetsAt !== null
      ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(window.resetsAt * 1000)) }
      : {}),
  };
}

export function usageLimitsFromCodexRateLimits(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  const windows = [
    mapCodexWindow(response.rateLimits.primary),
    mapCodexWindow(response.rateLimits.secondary),
  ].filter((window): window is ServerProviderUsageWindow => window !== undefined);
  return windows.length > 0 ? { source: "codexAppServer", checkedAt, windows } : undefined;
}
