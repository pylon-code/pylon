/**
 * Picks the two usage windows the composer strip shows for the account that
 * leads the composer's capacity readout.
 *
 * Only the rolling session window and the weekly total appear. Providers
 * report more than that — model-scoped weeklies, overage credits — but the
 * strip is a glance, not a readout, and the popover already carries the full
 * set.
 *
 * @module components/ComposerUsageIndicator.logic
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import type { ProviderUsageAccount } from "./providerUsage/ProviderUsageAccounts";
import { isUsageReadingStale } from "./providerUsage/ProviderUsageMatrix.logic";
import { formatTimeSinceChecked, formatTimeUntilReset } from "./providerUsage/usageTime";

export { formatTimeUntilReset };

const DAY_MINS = 24 * 60;
const WEEK_MINS = 7 * DAY_MINS;

export interface ComposerUsageEntry {
  /**
   * Time until this window resets ("1h 45m"), falling back to the window's
   * length ("5h") when the provider reports no reset.
   *
   * The countdown is the number worth glancing at: how long the window is says
   * nothing about whether to keep working, and when it comes back says
   * everything.
   */
  readonly label: string;
  /** How much of the window is spent. High means nearly out. */
  readonly usedPercent: number;
  readonly detail: string;
  readonly resetsAt?: string | undefined;
}

export interface ComposerUsageView {
  readonly accountName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly entries: ReadonlyArray<ComposerUsageEntry>;
  /**
   * True once the reading is older than the server should have let it get.
   * The strip dims rather than hides — a slightly old number still beats no
   * number when deciding where to send work — and the popover says the age.
   */
  readonly stale: boolean;
  /** How long ago the reading was taken ("4m"), once it is at least a minute old. */
  readonly age: string | undefined;
}

/**
 * Windows are matched on duration rather than label so every provider is
 * treated the same — Codex and Claude name their windows differently but
 * both report the durations.
 */
const isSessionWindow = (window: ServerProviderUsageWindow): boolean =>
  window.windowDurationMins !== undefined && window.windowDurationMins < DAY_MINS;

const isWeeklyWindow = (window: ServerProviderUsageWindow): boolean =>
  window.windowDurationMins !== undefined && window.windowDurationMins >= WEEK_MINS;

const entryFrom = (
  window: ServerProviderUsageWindow,
  fallbackLabel: string,
  nowMs: number,
): ComposerUsageEntry => ({
  label:
    (window.resetsAt ? formatTimeUntilReset(window.resetsAt, nowMs) : undefined) ?? fallbackLabel,
  usedPercent: Math.max(0, Math.min(100, Math.round(window.usedPercent))),
  detail: window.label,
  ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
});

/**
 * Build the strip's view for the leading account, or `null` when it reports
 * no usage — an unauthenticated account, a provider that has none, or a
 * reading that has not landed yet. The strip renders nothing rather than a
 * placeholder in that case.
 */
export function getComposerUsageView(
  account: ProviderUsageAccount | null | undefined,
  nowMs: number,
  staleAfterMs?: number,
): ComposerUsageView | null {
  const windows = account?.usageLimits.windows;
  if (!account || !windows || windows.length === 0) return null;

  const entries: ComposerUsageEntry[] = [];
  const session = windows.find(isSessionWindow);
  if (session) entries.push(entryFrom(session, "5h", nowMs));
  // The first weekly is the account-wide one; model-scoped weeklies follow it
  // and are left to the popover.
  const weekly = windows.find(isWeeklyWindow);
  if (weekly) entries.push(entryFrom(weekly, "7d", nowMs));
  if (entries.length === 0) return null;

  const checkedAt = account.usageLimits.checkedAt;
  return {
    accountName: account.displayName.trim() || undefined,
    ...(account.accentColor ? { accentColor: account.accentColor } : {}),
    entries,
    stale: isUsageReadingStale({ checkedAt, nowMs, staleAfterMs }),
    age: formatTimeSinceChecked(checkedAt, nowMs),
  };
}
