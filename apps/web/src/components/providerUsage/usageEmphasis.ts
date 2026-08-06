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

/** Bar fill for the popover, where length carries the comparison. */
export function usageBarClassName(usedPercent: number): string {
  if (usedPercent >= USAGE_CRITICAL_PERCENT) return "bg-red-500";
  if (usedPercent >= USAGE_WARNING_PERCENT) return "bg-amber-500";
  return "bg-sky-500";
}
