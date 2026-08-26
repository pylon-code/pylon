/**
 * Normalizes provider `account.rate-limits.updated` payloads into the shared
 * {@link ServerProviderRateLimit} verdict and the usage windows they carry.
 *
 * The runtime-event payload is `Schema.Unknown` at the contract layer by
 * design — drivers own their own wire shapes — so the provider-specific
 * knowledge lives here rather than in orchestration, matching how
 * `providerUsageLimits.ts` handles the polled gauge.
 *
 * Every parse fails closed. An unfamiliar or malformed payload yields
 * `undefined`, which leaves existing state untouched. Losing one signal is
 * recoverable — the next turn re-reports it — whereas throwing here would
 * take down the ingestion worker for every thread.
 *
 * @module provider/providerRateLimitEvents
 */
import type { ServerProviderRateLimit, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { usageWindowsFromCodexRateLimitSnapshot } from "./providerUsageLimits.ts";

const RATE_LIMIT_STATUSES = new Set(["allowed", "allowed_warning", "rejected"]);

const SESSION_WINDOW_MINS = 5 * 60;
const WEEKLY_WINDOW_MINS = 7 * 24 * 60;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Claude reports `resetsAt` as unix **seconds**, not milliseconds. Guard the
 * conversion: a value already in milliseconds, or a nonsense one, would
 * otherwise produce a reset timestamp thousands of years out and make a
 * drained account look permanently unavailable.
 */
const MAX_PLAUSIBLE_RESET_UNIX_SECONDS = 2_208_988_800; // 2040-01-01T00:00:00Z

function isoFromUnixSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  // A value already expressed in milliseconds lands far beyond this bound, as
  // does any nonsense figure. Every real subscription window resets in days.
  if (value > MAX_PLAUSIBLE_RESET_UNIX_SECONDS) return undefined;
  return DateTime.formatIso(DateTime.makeUnsafe(value * 1000));
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read Claude's `rate_limit_event` message.
 *
 * The adapter forwards the whole SDK message, so the interesting fields sit
 * under `rate_limit_info`.
 */
export function rateLimitFromClaudeEvent(
  payload: unknown,
  observedAt: string,
): ServerProviderRateLimit | undefined {
  const message = asRecord(payload);
  const info = asRecord(message?.["rate_limit_info"]);
  if (!info) return undefined;

  const status = info["status"];
  if (typeof status !== "string" || !RATE_LIMIT_STATUSES.has(status)) return undefined;

  const rateLimitType = trimmedString(info["rateLimitType"]);
  const resetsAt = isoFromUnixSeconds(info["resetsAt"]);

  return {
    status: status as ServerProviderRateLimit["status"],
    ...(rateLimitType ? { rateLimitType } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    observedAt,
  };
}

/**
 * Normalize an `account.rate-limits.updated` payload from whichever provider
 * emitted it.
 *
 * Both emitters wrap the driver's own message under `rateLimits`, so unwrap
 * that envelope before handing the message to a driver reader.
 *
 * Only Claude is understood today. Codex emits the same runtime event, but its
 * message carries percentage windows rather than an allowed/rejected verdict,
 * which the polled `usageLimits` gauge already covers — so it returns
 * `undefined` here rather than being coerced into a drain verdict it does not
 * express. Grok, Cursor, and OpenCode never emit this event at all.
 */
export function rateLimitFromRuntimeEventPayload(
  payload: unknown,
  observedAt: string,
): ServerProviderRateLimit | undefined {
  const envelope = asRecord(payload);
  if (!envelope) return undefined;
  return rateLimitFromClaudeEvent(envelope["rateLimits"], observedAt);
}

/** Usage windows a running session reported, with where they came from. */
export interface PushedUsageWindows {
  /** Provenance only, mirroring `ServerProviderUsageLimits.source`. */
  readonly source: string;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
}

/**
 * Claude reports `utilization` for the window named by `rateLimitType`.
 *
 * The SDK does not document the scale. The unified rate-limit headers it is
 * read from carry a fraction, so anything up to 1 is treated as one; a value
 * past that up to 100 is taken as a percentage already. Anything else is not
 * a reading this build can trust, and yields nothing.
 */
function claudeUtilizationPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  if (value <= 1) return value * 100;
  return value <= 100 ? value : undefined;
}

/**
 * Only the two account-wide windows are mapped. `seven_day_opus` and
 * `seven_day_sonnet` are model-scoped weeklies whose labels come from the
 * usage endpoint's display names, which a push does not carry, and `overage`
 * is credit, not capacity.
 */
function claudeWindowShape(
  rateLimitType: string,
): { readonly label: string; readonly windowDurationMins: number } | undefined {
  switch (rateLimitType) {
    case "five_hour":
      return { label: "Session", windowDurationMins: SESSION_WINDOW_MINS };
    case "seven_day":
      return { label: "Weekly (all models)", windowDurationMins: WEEKLY_WINDOW_MINS };
    default:
      return undefined;
  }
}

export function usageWindowsFromClaudeEvent(payload: unknown): PushedUsageWindows | undefined {
  const message = asRecord(payload);
  const info = asRecord(message?.["rate_limit_info"]);
  if (!info) return undefined;

  const rateLimitType = trimmedString(info["rateLimitType"]);
  const shape = rateLimitType ? claudeWindowShape(rateLimitType) : undefined;
  if (!shape) return undefined;
  const usedPercent = claudeUtilizationPercent(info["utilization"]);
  if (usedPercent === undefined) return undefined;
  const resetsAt = isoFromUnixSeconds(info["resetsAt"]);

  return {
    source: "claudeRateLimitEvent",
    windows: [{ ...shape, usedPercent, ...(resetsAt ? { resetsAt } : {}) }],
  };
}

/**
 * Codex's `account/rateLimits/updated` is a sparse rolling update carrying
 * the same window shape as `account/rateLimits/read`, one level down under
 * its own `rateLimits` key.
 */
export function usageWindowsFromCodexEvent(payload: unknown): PushedUsageWindows | undefined {
  const notification = asRecord(payload);
  const snapshot = asRecord(notification?.["rateLimits"]);
  if (!snapshot) return undefined;

  const readWindow = (value: unknown) => {
    const window = asRecord(value);
    if (!window) return undefined;
    const usedPercent = window["usedPercent"];
    if (typeof usedPercent !== "number") return undefined;
    const windowDurationMins = window["windowDurationMins"];
    const resetsAt = window["resetsAt"];
    return {
      usedPercent,
      windowDurationMins: typeof windowDurationMins === "number" ? windowDurationMins : null,
      resetsAt: typeof resetsAt === "number" ? resetsAt : null,
    };
  };
  const windows = usageWindowsFromCodexRateLimitSnapshot({
    primary: readWindow(snapshot["primary"]),
    secondary: readWindow(snapshot["secondary"]),
  });
  return windows.length > 0 ? { source: "codexAppServerPush", windows } : undefined;
}

/**
 * Read the usage windows an `account.rate-limits.updated` payload carries,
 * from whichever provider emitted it.
 *
 * Distinct from {@link rateLimitFromRuntimeEventPayload}: that one answers
 * "is this account refusing turns", this one answers "how much is left". A
 * Claude event may carry both; a Codex event carries only the latter.
 */
export function usageWindowsFromRuntimeEventPayload(
  payload: unknown,
): PushedUsageWindows | undefined {
  const envelope = asRecord(payload);
  const message = asRecord(envelope?.["rateLimits"]);
  if (!message) return undefined;
  if (message["type"] === "rate_limit_event" || "rate_limit_info" in message) {
    return usageWindowsFromClaudeEvent(message);
  }
  return usageWindowsFromCodexEvent(message);
}
