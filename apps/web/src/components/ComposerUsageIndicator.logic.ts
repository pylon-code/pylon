/**
 * Picks the two usage windows the composer strip shows for the account bound
 * to the current thread.
 *
 * Only the rolling session window and the weekly total appear. Providers
 * report more than that — model-scoped weeklies, overage credits — but the
 * strip is a glance, not a readout, and the popover already carries the full
 * set.
 *
 * @module components/ComposerUsageIndicator.logic
 */
import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";

import { formatTimeUntilReset } from "./providerUsage/usageTime";

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
 * Build the strip's view for one provider snapshot, or `null` when it reports
 * no usage — an unauthenticated account, a provider that has none, or a
 * reading that has not landed yet. The strip renders nothing rather than a
 * placeholder in that case.
 */
export function getComposerUsageView(
  provider: ServerProvider | null | undefined,
  nowMs: number,
): ComposerUsageView | null {
  const windows = provider?.usageLimits?.windows;
  if (!windows || windows.length === 0) return null;

  const entries: ComposerUsageEntry[] = [];
  const session = windows.find(isSessionWindow);
  if (session) entries.push(entryFrom(session, "5h", nowMs));
  // The first weekly is the account-wide one; model-scoped weeklies follow it
  // and are left to the popover.
  const weekly = windows.find(isWeeklyWindow);
  if (weekly) entries.push(entryFrom(weekly, "7d", nowMs));
  if (entries.length === 0) return null;

  return {
    accountName: provider?.displayName?.trim() || undefined,
    ...(provider?.accentColor ? { accentColor: provider.accentColor } : {}),
    entries,
  };
}
