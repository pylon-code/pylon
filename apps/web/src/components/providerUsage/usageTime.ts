/**
 * Countdowns for capacity windows.
 *
 * Shared because the composer strip and the capacity popover must agree: the
 * same window showing "1h 31m" in one place and "1h 45m" in the other would
 * read as a bug even when both are rounding honestly.
 *
 * @module components/providerUsage/usageTime
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Coarse countdown to a reset.
 *
 * Deliberately never finer than a minute: this sits in surfaces a user stares
 * at all day, and a ticking seconds display would repaint forever for no
 * decision it could change. Returns `undefined` once the reset has passed or
 * cannot be read, so callers can fall back to something meaningful.
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
