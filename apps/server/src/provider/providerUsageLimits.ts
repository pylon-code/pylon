/**
 * Subscription usage windows: the polled gauge and the pushed updates that
 * keep it current between polls.
 *
 * Every provider's capacity is expressed as {@link ServerProviderUsageWindow}s.
 * A probe reads the full set at once; a running session pushes one or two
 * windows at a time. Both land here so the rules for classifying a window and
 * for folding a push into an older reading live in one place and can be
 * tested without a provider.
 *
 * @module provider/providerUsageLimits
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";

const DAY_MINS = 24 * 60;
const WEEK_MINS = 7 * DAY_MINS;

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Windows are classified by duration rather than label so Codex and Claude,
 * which name their windows differently, match the same way everywhere: the
 * composer strip, the popover, and the push merge below.
 */
export const isSessionUsageWindow = (window: ServerProviderUsageWindow): boolean =>
  window.windowDurationMins !== undefined && window.windowDurationMins < DAY_MINS;

export const isWeeklyUsageWindow = (window: ServerProviderUsageWindow): boolean =>
  window.windowDurationMins !== undefined && window.windowDurationMins >= WEEK_MINS;

/**
 * The window shape Codex uses for both `account/rateLimits/read` and the
 * `account/rateLimits/updated` notification.
 */
export interface CodexRateLimitWindowLike {
  readonly usedPercent: number;
  readonly windowDurationMins?: number | null | undefined;
  readonly resetsAt?: number | null | undefined;
}

export interface CodexRateLimitSnapshotLike {
  readonly primary?: CodexRateLimitWindowLike | null | undefined;
  readonly secondary?: CodexRateLimitWindowLike | null | undefined;
}

function codexWindowLabel(windowDurationMins: number | null | undefined): string {
  return windowDurationMins !== undefined &&
    windowDurationMins !== null &&
    windowDurationMins >= WEEK_MINS
    ? "Weekly"
    : "Session";
}

function mapCodexWindow(
  window: CodexRateLimitWindowLike | null | undefined,
): ServerProviderUsageWindow | undefined {
  if (!window) return undefined;
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) {
    return undefined;
  }
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

/**
 * Map whichever of Codex's two windows are present. A pushed update is
 * sparse by design, so one window alone is a valid result.
 */
export function usageWindowsFromCodexRateLimitSnapshot(
  snapshot: CodexRateLimitSnapshotLike,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [mapCodexWindow(snapshot.primary), mapCodexWindow(snapshot.secondary)].filter(
    (window): window is ServerProviderUsageWindow => window !== undefined,
  );
}

export function usageLimitsFromCodexRateLimits(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  const windows = usageWindowsFromCodexRateLimitSnapshot(response.rateLimits);
  return windows.length > 0 ? { source: "codexAppServer", checkedAt, windows } : undefined;
}

/**
 * One window a running session reported, stamped with when it was observed.
 *
 * The stamp is per window rather than per batch because Claude pushes its
 * session and weekly windows in separate events, and a probe can land between
 * them. Applying a batch as a unit would let the older half of it overwrite a
 * newer probe.
 */
export interface PushedUsageWindow {
  readonly window: ServerProviderUsageWindow;
  readonly observedAt: string;
}

/**
 * Two windows describe the same limit when they fall in the same class —
 * rolling session or weekly — or, for anything else, carry the same label.
 * Only the first weekly counts as the account-wide one; model-scoped weeklies
 * that follow it are never pushed and so never matched.
 */
function isSameUsageWindow(
  candidate: ServerProviderUsageWindow,
  pushed: ServerProviderUsageWindow,
): boolean {
  if (isSessionUsageWindow(pushed)) return isSessionUsageWindow(candidate);
  if (isWeeklyUsageWindow(pushed)) return isWeeklyUsageWindow(candidate);
  return candidate.label === pushed.label;
}

function findSameUsageWindowIndex(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  pushed: ServerProviderUsageWindow,
): number {
  return windows.findIndex((candidate) => isSameUsageWindow(candidate, pushed));
}

/**
 * Fold a newer batch of pushes into the ones already retained for an
 * instance. A push for a window that is already retained replaces it, so the
 * set never grows past one entry per limit.
 */
export function accumulatePushedUsageWindows(
  retained: ReadonlyArray<PushedUsageWindow>,
  pushed: ReadonlyArray<PushedUsageWindow>,
): ReadonlyArray<PushedUsageWindow> {
  const next = [...retained];
  for (const entry of pushed) {
    const index = next.findIndex((candidate) => isSameUsageWindow(candidate.window, entry.window));
    if (index === -1) {
      next.push(entry);
    } else if (Date.parse(entry.observedAt) >= Date.parse(next[index]!.observedAt)) {
      next[index] = entry;
    }
  }
  return next;
}

function parseMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Overlay pushed windows onto the most recent probe reading.
 *
 * Only pushes newer than the reading apply — a probe that ran after a push is
 * the better source, and a push older than `maxAgeMs` is dropped rather than
 * left to quietly mislead. When nothing applies the reading is returned as
 * is, so a caller can compare by identity. A matched window keeps the probe's
 * label and duration and takes the pushed percentage and reset; an unmatched
 * one is appended, which is how a push seeds the gauge before any probe has
 * succeeded.
 */
export function applyPushedUsageWindows(
  current: ServerProviderUsageLimits | undefined,
  pushed: ReadonlyArray<PushedUsageWindow>,
  options: {
    readonly nowMs: number;
    readonly maxAgeMs: number;
    /** Provenance stamped when a push has to stand in for a missing reading. */
    readonly source: string;
  },
): ServerProviderUsageLimits | undefined {
  const currentCheckedAtMs = current ? parseMs(current.checkedAt) : undefined;
  const applicable = pushed.filter((entry) => {
    const observedAtMs = parseMs(entry.observedAt);
    if (observedAtMs === undefined) return false;
    if (options.nowMs - observedAtMs > options.maxAgeMs) return false;
    return currentCheckedAtMs === undefined || observedAtMs > currentCheckedAtMs;
  });
  if (applicable.length === 0) return current;

  const windows: ServerProviderUsageWindow[] = [...(current?.windows ?? [])];
  let checkedAtMs = currentCheckedAtMs ?? 0;
  for (const entry of applicable) {
    checkedAtMs = Math.max(checkedAtMs, parseMs(entry.observedAt) ?? 0);
    const index = findSameUsageWindowIndex(windows, entry.window);
    if (index === -1) {
      windows.push(entry.window);
      continue;
    }
    const matched = windows[index]!;
    windows[index] = {
      ...matched,
      usedPercent: entry.window.usedPercent,
      ...(entry.window.resetsAt ? { resetsAt: entry.window.resetsAt } : {}),
    };
  }

  return {
    source: current?.source ?? options.source,
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(checkedAtMs)),
    windows,
  };
}
