import { describe, expect, it } from "vite-plus/test";

import { rateLimitFromRuntimeEventPayload } from "./providerRateLimitEvents.ts";

const OBSERVED_AT = "2026-08-04T18:30:00.000Z";

// Captured verbatim from a real `claude --print` run, including the unix
// *seconds* resetsAt and the absent `utilization` field.
const REAL_CLAUDE_EVENT = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1785808200,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled_until",
    isUsingOverage: false,
  },
  uuid: "2146322c-ec38-4460-ac3b-209bc654e71c",
  session_id: "206c8150-dd19-47a5-b3aa-c50fc6a1e1fd",
};

describe("rateLimitFromRuntimeEventPayload", () => {
  it("reads a real Claude rate_limit_event", () => {
    const parsed = rateLimitFromRuntimeEventPayload(REAL_CLAUDE_EVENT, OBSERVED_AT);

    expect(parsed?.status).toBe("allowed");
    expect(parsed?.rateLimitType).toBe("five_hour");
    expect(parsed?.observedAt).toBe(OBSERVED_AT);
    // Seconds, not milliseconds — a naive `new Date(resetsAt)` lands in 1970.
    // The event was captured at 2026-08-03T22:38Z, so this window had 3h11m
    // left on it, consistent with a partly-used five-hour window.
    expect(parsed?.resetsAt).toBe("2026-08-04T01:50:00.000Z");
  });

  it("reads a rejected verdict", () => {
    const parsed = rateLimitFromRuntimeEventPayload(
      { rate_limit_info: { status: "rejected", rateLimitType: "seven_day" } },
      OBSERVED_AT,
    );

    expect(parsed?.status).toBe("rejected");
    expect(parsed?.resetsAt).toBeUndefined();
  });

  it("keeps a window kind this build has never seen", () => {
    const parsed = rateLimitFromRuntimeEventPayload(
      { rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day_opus" } },
      OBSERVED_AT,
    );

    expect(parsed?.rateLimitType).toBe("seven_day_opus");
  });

  // Failing closed matters more than parsing hard: dropping one signal is
  // recoverable on the next turn, throwing would take down ingestion.
  it.each([
    ["null", null],
    ["a string", "rate limited"],
    ["an array", []],
    ["an empty object", {}],
    ["a missing rate_limit_info", { type: "rate_limit_event" }],
    ["an unknown status", { rate_limit_info: { status: "on_fire" } }],
    ["a non-string status", { rate_limit_info: { status: 429 } }],
  ])("returns undefined for %s", (_label, payload) => {
    expect(rateLimitFromRuntimeEventPayload(payload, OBSERVED_AT)).toBeUndefined();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["not a number", "soon"],
    ["already in milliseconds", 1785808200000],
  ])("drops an implausible resetsAt (%s) without dropping the verdict", (_label, resetsAt) => {
    const parsed = rateLimitFromRuntimeEventPayload(
      { rate_limit_info: { status: "rejected", resetsAt } },
      OBSERVED_AT,
    );

    expect(parsed?.status).toBe("rejected");
    expect(parsed?.resetsAt).toBeUndefined();
  });

  // Codex emits the same runtime event with percentage windows rather than a
  // verdict. The polled gauge already covers that, so it must not be coerced
  // into a drain decision it does not express.
  it("returns undefined for a Codex-shaped payload", () => {
    const parsed = rateLimitFromRuntimeEventPayload(
      { rateLimits: { primary: { usedPercent: 80, windowDurationMins: 300 } } },
      OBSERVED_AT,
    );

    expect(parsed).toBeUndefined();
  });
});
