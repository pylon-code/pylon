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

const DAY_MINS = 24 * 60;
const WEEK_MINS = 7 * DAY_MINS;

export interface ComposerUsageEntry {
  /** Short enough to sit in the strip without crowding the branch selector. */
  readonly label: string;
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

const entryFrom = (window: ServerProviderUsageWindow, label: string): ComposerUsageEntry => ({
  label,
  usedPercent: Math.round(window.usedPercent),
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
): ComposerUsageView | null {
  const windows = provider?.usageLimits?.windows;
  if (!windows || windows.length === 0) return null;

  const entries: ComposerUsageEntry[] = [];
  const session = windows.find(isSessionWindow);
  if (session) entries.push(entryFrom(session, "5h"));
  // The first weekly is the account-wide one; model-scoped weeklies follow it
  // and are left to the popover.
  const weekly = windows.find(isWeeklyWindow);
  if (weekly) entries.push(entryFrom(weekly, "7d"));
  if (entries.length === 0) return null;

  return {
    accountName: provider?.displayName?.trim() || undefined,
    ...(provider?.accentColor ? { accentColor: provider.accentColor } : {}),
    entries,
  };
}
