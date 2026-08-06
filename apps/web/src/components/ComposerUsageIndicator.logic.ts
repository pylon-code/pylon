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
  /**
   * Time until this window resets ("1h 45m"), falling back to the window's
   * length ("5h") when the provider reports no reset.
   *
   * The countdown is the number worth glancing at: how long the window is says
   * nothing about whether to keep working, and when it comes back says
   * everything.
   */
  readonly label: string;
  /** What is left, matching the bar, which drains. */
  readonly remainingPercent: number;
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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Coarse countdown to a reset.
 *
 * Deliberately never finer than a minute: this sits in a strip a user stares
 * at all day, and a ticking seconds display would repaint forever for no
 * decision it could change. Returns `undefined` once the reset has passed or
 * cannot be read, so the caller falls back to the window's length.
 */
export function formatTimeUntilReset(resetsAt: string, nowMs: number): string | undefined {
  const resetsAtMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetsAtMs)) return undefined;
  const remaining = resetsAtMs - nowMs;
  if (remaining <= 0) return undefined;

  if (remaining >= DAY_MS) {
    const days = Math.floor(remaining / DAY_MS);
    const hours = Math.floor((remaining % DAY_MS) / HOUR_MS);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (remaining >= HOUR_MS) {
    const hours = Math.floor(remaining / HOUR_MS);
    const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${Math.max(1, Math.floor(remaining / MINUTE_MS))}m`;
}

const entryFrom = (
  window: ServerProviderUsageWindow,
  fallbackLabel: string,
  nowMs: number,
): ComposerUsageEntry => ({
  label:
    (window.resetsAt ? formatTimeUntilReset(window.resetsAt, nowMs) : undefined) ?? fallbackLabel,
  remainingPercent: Math.max(0, Math.min(100, Math.round(100 - window.usedPercent))),
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
