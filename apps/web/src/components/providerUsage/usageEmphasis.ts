/**
 * When a usage number stops being background and starts being a decision.
 *
 * Shared so the composer strip and the capacity popover cross the same
 * thresholds — the same window reading as fine in one place and urgent in the
 * other would be worse than no colour at all.
 *
 * Keyed on how much is *spent*, so a high number is the alarming one.
 *
 * @module components/providerUsage/usageEmphasis
 */

/** Past this, the window is worth planning around. */
export const USAGE_WARNING_PERCENT = 75;

/** Past this, the window is nearly gone. */
export const USAGE_CRITICAL_PERCENT = 90;

export function usageEmphasisClassName(usedPercent: number): string {
  if (usedPercent >= USAGE_CRITICAL_PERCENT) return "text-red-400";
  if (usedPercent >= USAGE_WARNING_PERCENT) return "text-amber-400";
  return "text-muted-foreground/70";
}

/**
 * Same thresholds, for surfaces where the number *is* the content rather than
 * ambient detail.
 *
 * The composer strip stays dim on purpose — it sits in a context line you read
 * past. Inside the capacity popover the percentage is the reason you opened it,
 * so an unremarkable window reads at full contrast and the reset countdown
 * beside it carries the muted tone. Matches how the usage page ranks a value
 * against its detail line.
 */
export function usageValueClassName(usedPercent: number): string {
  if (usedPercent >= USAGE_CRITICAL_PERCENT) return "text-red-400";
  if (usedPercent >= USAGE_WARNING_PERCENT) return "text-amber-400";
  return "text-foreground";
}

/**
 * Whether a reading has crossed out of "background" and has to carry the alarm
 * colour, overriding any per-account tint a surface would otherwise apply.
 */
export function isUsageElevated(usedPercent: number): boolean {
  return usedPercent >= USAGE_WARNING_PERCENT;
}

/** Bar fill for the popover, where length carries the comparison. */
export function usageBarClassName(usedPercent: number): string {
  if (usedPercent >= USAGE_CRITICAL_PERCENT) return "bg-red-500";
  if (usedPercent >= USAGE_WARNING_PERCENT) return "bg-amber-500";
  return "bg-sky-500";
}
