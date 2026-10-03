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
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import { codexRateLimitsToLimits, codexRateLimitsToWindows } from "./Layers/codexUsageLimits.ts";
export { makeUnavailableUsageLimits } from "./usageLimitsSnapshot.ts";

const DAY_MINS = 24 * 60;
const WEEK_MINS = 7 * DAY_MINS;

/**
 * Windows are classified by duration rather than label so Codex and Claude,
 * which name their windows differently, match the same way everywhere: the
 * composer strip, the popover, and the push merge below.
 */
const isSessionUsageWindow = (window: ServerProviderUsageWindow): boolean =>
  window.windowDurationMins !== undefined && window.windowDurationMins < DAY_MINS;

const isWeeklyUsageWindow = (window: ServerProviderUsageWindow): boolean =>
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
  readonly limitId?: string | null | undefined;
  readonly planType?: string | null | undefined;
  readonly primary?: CodexRateLimitWindowLike | null | undefined;
  readonly secondary?: CodexRateLimitWindowLike | null | undefined;
}

/**
 * Map whichever of Codex's two windows are present. A pushed update is
 * sparse by design, so one window alone is a valid result.
 */
export function usageWindowsFromCodexRateLimitSnapshot(
  snapshot: CodexRateLimitSnapshotLike,
): ReadonlyArray<ServerProviderUsageWindow> {
  return codexRateLimitsToWindows(snapshot);
}

export function usageLimitsFromCodexRateLimits(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
  checkedAt: string,
  source: string = "codexAppServer",
): ServerProviderUsageLimits | undefined {
  const limits = codexRateLimitsToLimits({
    checkedAt,
    snapshot: response.rateLimits,
    rateLimitsByLimitId: response.rateLimitsByLimitId,
    resetCredits: response.rateLimitResetCredits,
  });
  return limits.windows.length > 0 || limits.resetCredits !== undefined
    ? { ...limits, source }
    : undefined;
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
  if (candidate.id !== undefined && pushed.id !== undefined) return candidate.id === pushed.id;
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
 * A running session can report its windows on every API call. Most of those
 * say the same thing as the last one, and each accepted push republishes the
 * provider list to every client, so a push that changes nothing visible is
 * folded in only once a minute — enough to keep the reading's age honest
 * without a snapshot per tool call.
 */
const SAME_VALUE_PUSH_INTERVAL_MS = 60_000;

function isSameReading(
  current: ServerProviderUsageWindow,
  pushed: ServerProviderUsageWindow,
): boolean {
  return (
    Math.round(current.usedPercent) === Math.round(pushed.usedPercent) &&
    (pushed.resetsAt === undefined || pushed.resetsAt === current.resetsAt)
  );
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
  if (current?.unavailable?.reason === "unsupported") return current;
  const currentCheckedAtMs = current ? parseMs(current.checkedAt) : undefined;
  const applicable = pushed.filter((entry) => {
    const observedAtMs = parseMs(entry.observedAt);
    if (observedAtMs === undefined) return false;
    if (options.nowMs - observedAtMs > options.maxAgeMs) return false;
    if (currentCheckedAtMs === undefined) return true;
    if (observedAtMs <= currentCheckedAtMs) return false;
    // Same number as the reading already shows: not worth a republish until
    // the reading is old enough that saying "still current" means something.
    const index = current ? findSameUsageWindowIndex(current.windows, entry.window) : -1;
    const matched = index === -1 ? undefined : current?.windows[index];
    if (matched && isSameReading(matched, entry.window)) {
      return observedAtMs - currentCheckedAtMs >= SAME_VALUE_PUSH_INTERVAL_MS;
    }
    return true;
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

  // Clear the stale marker without putting undefined into the JSON provider snapshot.
  const { unavailable: _unavailable, ...currentReading } = current ?? {};
  return {
    ...currentReading,
    source: current?.source ?? options.source,
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(checkedAtMs)),
    windows,
  };
}

const WINDOW_KIND_ORDER: Record<NonNullable<ServerProviderUsageWindow["kind"]>, number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind ?? "other"] - WINDOW_KIND_ORDER[right.kind ?? "other"] ||
      (left.id ?? left.label).localeCompare(right.id ?? right.label),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

/**
 * Fold a sparse runtime update into the limits a provider currently
 * publishes. Windows upsert by `id`; a window the update omits keeps its
 * previous values, and a window that arrives without `resetsAt` or
 * `windowDurationMins` keeps whatever the last probe resolved for it. An
 * update with no windows leaves `previous` untouched.
 *
 * An `unsupported` snapshot stays unsupported: an account that cannot have
 * subscription windows will not start reporting them mid-turn.
 */
export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (update.windows.length === 0 || previous?.unavailable?.reason === "unsupported") {
    return previous;
  }
  const merged = new Map(
    previous?.windows.map((window) => [window.id ?? window.label, window] as const),
  );
  // Codex sends this notification beside every token-usage tick, almost
  // always with unchanged numbers. Decide "nothing changed" per window on
  // the way through so the no-op case never allocates a new snapshot.
  let changed = false;
  for (const window of update.windows) {
    const existing = merged.get(window.id ?? window.label);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id ?? window.label, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined && previous.unavailable === undefined) {
    return previous;
  }
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    ...(previous?.source !== undefined ? { source: previous.source } : {}),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

/**
 * Choose what to publish after a status probe finishes. A probe that failed
 * this time must not wipe bars a previous probe or a turn already
 * established, so the last good snapshot stays; `unsupported` is
 * authoritative and replaces them.
 *
 * A successful probe replaces the published windows outright, including any
 * runtime update that landed while it was running. That is a deliberate
 * trade-off: the Codex and Claude reads take a few seconds at most, the
 * probe is the fresher full read in every case except that window, and the
 * per-window epoch bookkeeping needed to reconcile the two was more code
 * than the sub-second regression it prevented. The next runtime event
 * corrects it.
 */
export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return published;
  }
  return probed;
}
