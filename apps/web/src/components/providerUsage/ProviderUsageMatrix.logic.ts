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
  readonly remainingPercent: number | undefined;
}

export interface ProviderUsageMatrixRow {
  readonly label: string;
  readonly cells: ReadonlyArray<ProviderUsageCell>;
  /** Earliest reset across the row, so one line can stand for the row. */
  readonly resetsAt: string | undefined;
}

export interface ProviderUsageMatrix {
  readonly accounts: ReadonlyArray<ProviderUsageAccount>;
  readonly rows: ReadonlyArray<ProviderUsageMatrixRow>;
}

const remainingFrom = (window: ServerProviderUsageWindow | undefined): number | undefined =>
  window === undefined ? undefined : Math.max(0, Math.round(100 - window.usedPercent));

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
        remainingPercent: remainingFrom(window),
      };
    });
    // The soonest reset is the one that changes the answer first.
    const resetsAt = cells
      .flatMap((cell) => (cell.window?.resetsAt ? [cell.window.resetsAt] : []))
      .toSorted()
      .at(0);
    return { label, cells, ...(resetsAt ? { resetsAt } : { resetsAt: undefined }) };
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
}): boolean {
  const checkedAtMs = Date.parse(input.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return false;
  return input.nowMs - checkedAtMs > USAGE_STALE_AFTER_MS;
}
