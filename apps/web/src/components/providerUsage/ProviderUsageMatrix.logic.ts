/**
 * Arranging several accounts' usage as one comparison.
 *
 * With one account a list reads fine. With two, the question stops being "how
 * much is left" and becomes "which one has more" — and a stacked list answers
 * that by making you scroll between the two things you are comparing. Sharing
 * one row per window turns it into a glance.
 *
 * @module components/providerUsage/ProviderUsageMatrix.logic
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import type { ProviderUsageAccount } from "./ProviderUsageAccounts";

/** Older than this and a reading is labelled rather than shown as current. */
export const USAGE_STALE_AFTER_MS = 3 * 60_000;

export interface ProviderUsageCell {
  readonly accountId: string;
  /** `undefined` when this account does not report the row's window at all. */
  readonly window: ServerProviderUsageWindow | undefined;
  readonly usedPercent: number | undefined;
}

export interface ProviderUsageMatrixRow {
  readonly label: string;
  readonly cells: ReadonlyArray<ProviderUsageCell>;
}

export interface ProviderUsageMatrix {
  readonly accounts: ReadonlyArray<ProviderUsageAccount>;
  readonly rows: ReadonlyArray<ProviderUsageMatrixRow>;
}

const usedFrom = (window: ServerProviderUsageWindow | undefined): number | undefined =>
  window === undefined ? undefined : Math.max(0, Math.min(100, Math.round(window.usedPercent)));

/**
 * Build the shared-row view of several accounts.
 *
 * Row order follows the first account that reports each window, so the common
 * case — accounts on the same plan reporting the same windows — keeps the
 * provider's own ordering. Accounts on different plans genuinely report
 * different windows, so a row an account does not have becomes an empty cell
 * rather than being dropped or faked.
 */
export function buildProviderUsageMatrix(
  accounts: ReadonlyArray<ProviderUsageAccount>,
): ProviderUsageMatrix {
  const labels: string[] = [];
  for (const account of accounts) {
    for (const window of account.usageLimits.windows) {
      if (!labels.includes(window.label)) labels.push(window.label);
    }
  }

  const rows = labels.map((label): ProviderUsageMatrixRow => {
    const cells = accounts.map((account): ProviderUsageCell => {
      const window = account.usageLimits.windows.find((candidate) => candidate.label === label);
      return {
        accountId: account.instanceId,
        window,
        usedPercent: usedFrom(window),
      };
    });
    // Reset times live in the cells: each account resets on its own schedule,
    // so a single time for the row would misreport one of them.
    return { label, cells };
  });

  return { accounts, rows };
}

/**
 * Whether a reading is old enough to say so.
 *
 * The server keeps serving the last good reading when a probe fails, which is
 * what stops the gauge blinking out. That is only honest if the client admits
 * when a number has stopped being current.
 */
export function isUsageReadingStale(input: {
  readonly checkedAt: string;
  readonly nowMs: number;
  /**
   * Overrides the default bound. Callers that know the server's refresh
   * interval pass a bound just past it, so a healthy poll never reads as
   * stale for the tail of every interval.
   */
  readonly staleAfterMs?: number | undefined;
}): boolean {
  const checkedAtMs = Date.parse(input.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return false;
  return input.nowMs - checkedAtMs > (input.staleAfterMs ?? USAGE_STALE_AFTER_MS);
}

/**
 * How long the server holds a good reading before it will read the provider
 * again (`USAGE_PROBE_SUCCESS_TTL` in `ClaudeDriver`). The usage endpoints
 * are rate limited, so refreshes inside this window are served from cache.
 */
export const USAGE_READING_CACHE_MS = 5 * 60_000;

/**
 * How old a reading may get before the popover and strip call it stale, given
 * how often the server polls. A minute past the longer of the poll interval
 * and the server's own cache leaves room for the probe itself — and means
 * "stale" is exactly when a refresh would reach the provider rather than the
 * cache, which is what makes the Refresh affordance honest.
 */
export function usageStaleAfterMs(refreshIntervalMs: number): number {
  return Math.max(refreshIntervalMs, USAGE_READING_CACHE_MS) + 60_000;
}
