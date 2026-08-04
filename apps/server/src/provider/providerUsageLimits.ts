import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function codexWindowLabel(windowDurationMins: number | null | undefined): string {
  return windowDurationMins !== undefined &&
    windowDurationMins !== null &&
    windowDurationMins >= 7 * 24 * 60
    ? "Weekly"
    : "Session";
}

function mapCodexWindow(
  window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow | null | undefined,
): ServerProviderUsageWindow | undefined {
  if (!window) return undefined;
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

export function usageLimitsFromCodexRateLimits(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  const windows = [
    mapCodexWindow(response.rateLimits.primary),
    mapCodexWindow(response.rateLimits.secondary),
  ].filter((window): window is ServerProviderUsageWindow => window !== undefined);
  return windows.length > 0 ? { source: "codexAppServer", checkedAt, windows } : undefined;
}

function parseClaudeReset(input: {
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string | undefined;
  readonly meridiem: string;
  readonly timeZone: string;
  readonly checkedAt: string;
}): string | undefined {
  const month =
    MONTHS.indexOf(input.month.toLowerCase().slice(0, 3) as (typeof MONTHS)[number]) + 1;
  if (month === 0) return undefined;
  const checked = DateTime.make(input.checkedAt);
  if (Option.isNone(checked)) return undefined;
  const checkedInResetZone = DateTime.setZoneNamed(checked.value, input.timeZone);
  if (Option.isNone(checkedInResetZone)) return undefined;
  const checkedParts = DateTime.toParts(checkedInResetZone.value);
  const day = Number.parseInt(input.day, 10);
  let hour = Number.parseInt(input.hour, 10);
  if (
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    day < 1 ||
    day > 31 ||
    hour < 1 ||
    hour > 12
  ) {
    return undefined;
  }
  if (hour === 12) hour = 0;
  if (input.meridiem.toLowerCase() === "pm") hour += 12;
  // Claude reports resets without a year, and a reset is always upcoming. Pick the earliest
  // candidate year that still lands at or after the probe time, which handles both directions
  // of a year boundary (a January reset probed in December, and a December reset probed just
  // after New Year in UTC). A minute of slack absorbs rounding in the reported time.
  const checkedMillis = DateTime.toEpochMillis(checkedInResetZone.value) - 60_000;
  let best: { readonly iso: string; readonly millis: number } | undefined;
  for (const year of [checkedParts.year - 1, checkedParts.year, checkedParts.year + 1]) {
    const localDateTime = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${input.minute ?? "00"}:00`;
    const reset = DateTime.makeZoned(localDateTime, {
      timeZone: input.timeZone,
      adjustForTimeZone: true,
    });
    if (Option.isNone(reset)) continue;
    const millis = DateTime.toEpochMillis(reset.value);
    if (millis < checkedMillis) continue;
    if (!best || millis < best.millis) {
      best = { iso: DateTime.formatIso(reset.value), millis };
    }
  }
  return best?.iso;
}

const resultTextFrom = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as { result?: unknown }).result;
  return typeof candidate === "string" ? candidate : undefined;
};

/**
 * Pull the assistant's text out of a `claude --print --output-format json`
 * payload.
 *
 * Claude Code 2.1.x emits an array of stream messages and carries the text on
 * the trailing `type: "result"` entry; older builds emitted a single object
 * with the same field. Both are accepted because the format has already moved
 * once and Pylon does not control it \u2014 reading the last matching entry keeps
 * a future prefix message from hijacking the parse.
 */
function readClaudePrintResult(output: string): string | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch {
    return undefined;
  }

  if (!Array.isArray(decoded)) return resultTextFrom(decoded);
  for (let index = decoded.length - 1; index >= 0; index -= 1) {
    const entry = decoded[index];
    if (
      typeof entry === "object" &&
      entry !== null &&
      (entry as { type?: unknown }).type !== "result"
    ) {
      continue;
    }
    const text = resultTextFrom(entry);
    if (text !== undefined) return text;
  }
  return undefined;
}

export function parseClaudeUsageLimitsJson(
  output: string,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  const rawResult = readClaudePrintResult(output);
  if (rawResult === undefined) return undefined;
  const result = rawResult.replaceAll("\r\n", "\n");

  const windows: ServerProviderUsageWindow[] = [];
  // The day/time separator is " at " on Claude Code 2.1.x and was "," before
  // it; accept either rather than chasing the current build.
  const pattern =
    /^Current (session|week(?: \([^)]+\))?):\s*(\d{1,3}(?:\.\d+)?)% used\s*[\u00b7-]\s*resets ([A-Za-z]{3,9}) (\d{1,2})(?:,| at) (\d{1,2})(?::(\d{2}))?(am|pm) \(([^)]+)\)$/gim;
  for (const match of result.matchAll(pattern)) {
    const [, rawLabel, percent, month, day, hour, minute, meridiem, timeZone] = match;
    if (!rawLabel || !percent || !month || !day || !hour || !meridiem || !timeZone) continue;
    const usedPercent = Number.parseFloat(percent);
    if (!Number.isFinite(usedPercent)) continue;
    const isSession = rawLabel.toLowerCase() === "session";
    const suffix = rawLabel.match(/\(([^)]+)\)/)?.[1];
    const resetsAt = parseClaudeReset({
      month,
      day,
      hour,
      minute,
      meridiem,
      timeZone,
      checkedAt,
    });
    windows.push({
      label: isSession ? "Session" : suffix ? `Weekly (${suffix})` : "Weekly",
      usedPercent: clampPercent(usedPercent),
      windowDurationMins: isSession ? 5 * 60 : 7 * 24 * 60,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  return windows.length > 0 ? { source: "claudePrint", checkedAt, windows } : undefined;
}
