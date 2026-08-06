/**
 * Normalizes provider `account.rate-limits.updated` payloads into the shared
 * {@link ServerProviderRateLimit} shape.
 *
 * The runtime-event payload is `Schema.Unknown` at the contract layer by
 * design — drivers own their own wire shapes — so the provider-specific
 * knowledge lives here rather than in orchestration, matching how
 * `providerUsageLimits.ts` handles the polled gauge.
 *
 * Every parse fails closed. An unfamiliar or malformed payload yields
 * `undefined`, which leaves existing drain state untouched. Losing one signal
 * is recoverable — the next turn re-reports it — whereas throwing here would
 * take down the ingestion worker for every thread.
 *
 * @module provider/providerRateLimitEvents
 */
import type { ServerProviderRateLimit } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const RATE_LIMIT_STATUSES = new Set(["allowed", "allowed_warning", "rejected"]);

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
