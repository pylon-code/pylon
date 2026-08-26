import { describe, expect, it } from "vite-plus/test";

import {
  rateLimitFromRuntimeEventPayload,
  usageWindowsFromRuntimeEventPayload,
} from "./providerRateLimitEvents.ts";

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

// Both `ClaudeAdapter` and `CodexAdapter` publish the driver's own message
// under a `rateLimits` key, so every payload reaching the parser is wrapped.
const envelope = (rateLimits: unknown) => ({ rateLimits });

describe("rateLimitFromRuntimeEventPayload", () => {
  it("reads a real Claude rate_limit_event", () => {
    const parsed = rateLimitFromRuntimeEventPayload(envelope(REAL_CLAUDE_EVENT), OBSERVED_AT);

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
      envelope({ rate_limit_info: { status: "rejected", rateLimitType: "seven_day" } }),
      OBSERVED_AT,
    );

    expect(parsed?.status).toBe("rejected");
    expect(parsed?.resetsAt).toBeUndefined();
  });

  it("keeps a window kind this build has never seen", () => {
    const parsed = rateLimitFromRuntimeEventPayload(
      envelope({ rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day_opus" } }),
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
    ["a bare message with no envelope", REAL_CLAUDE_EVENT],
  ])("returns undefined for a payload that is %s", (_label, payload) => {
    expect(rateLimitFromRuntimeEventPayload(payload, OBSERVED_AT)).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["a string", "rate limited"],
    ["an empty object", {}],
    ["a missing rate_limit_info", { type: "rate_limit_event" }],
    ["an unknown status", { rate_limit_info: { status: "on_fire" } }],
    ["a non-string status", { rate_limit_info: { status: 429 } }],
  ])("returns undefined for a message that is %s", (_label, rateLimits) => {
    expect(rateLimitFromRuntimeEventPayload(envelope(rateLimits), OBSERVED_AT)).toBeUndefined();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["not a number", "soon"],
    ["already in milliseconds", 1785808200000],
  ])("drops an implausible resetsAt (%s) without dropping the verdict", (_label, resetsAt) => {
    const parsed = rateLimitFromRuntimeEventPayload(
      envelope({ rate_limit_info: { status: "rejected", resetsAt } }),
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
      envelope({ primary: { usedPercent: 80, windowDurationMins: 300 } }),
      OBSERVED_AT,
    );

    expect(parsed).toBeUndefined();
  });
});

describe("usageWindowsFromRuntimeEventPayload", () => {
  // Codex wraps its sparse rolling update under its own `rateLimits` key,
  // inside the adapter envelope: `{ rateLimits: { rateLimits: {...} } }`.
  it("reads Codex's pushed windows", () => {
    const parsed = usageWindowsFromRuntimeEventPayload(
      envelope({
        rateLimits: {
          primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_785_808_200 },
          secondary: { usedPercent: 62, windowDurationMins: 10_080, resetsAt: null },
          planType: "plus",
        },
      }),
    );

    expect(parsed).toEqual({
      source: "codexAppServerPush",
      windows: [
        {
          label: "Session",
          usedPercent: 37,
          windowDurationMins: 300,
          resetsAt: "2026-08-04T01:50:00.000Z",
        },
        { label: "Weekly", usedPercent: 62, windowDurationMins: 10_080 },
      ],
    });
  });

  it("reads a Codex update that carries only one window", () => {
    const parsed = usageWindowsFromRuntimeEventPayload(
      envelope({ rateLimits: { secondary: { usedPercent: 70, windowDurationMins: 10_080 } } }),
    );

    expect(parsed?.windows.map((window) => window.label)).toEqual(["Weekly"]);
  });

  it("reads Claude's utilization for the window the event names", () => {
    const parsed = usageWindowsFromRuntimeEventPayload(
      envelope({
        ...REAL_CLAUDE_EVENT,
        rate_limit_info: { ...REAL_CLAUDE_EVENT.rate_limit_info, utilization: 0.42 },
      }),
    );

    expect(parsed).toEqual({
      source: "claudeRateLimitEvent",
      windows: [
        {
          label: "Session",
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: "2026-08-04T01:50:00.000Z",
        },
      ],
    });
  });

  it("labels Claude's weekly window like the usage endpoint does", () => {
    const parsed = usageWindowsFromRuntimeEventPayload(
      envelope({
        rate_limit_info: { status: "allowed", rateLimitType: "seven_day", utilization: 0.8 },
      }),
    );

    expect(parsed?.windows).toEqual([
      { label: "Weekly (all models)", usedPercent: 80, windowDurationMins: 10_080 },
    ]);
  });

  // The SDK leaves the scale undocumented; a value past 1 can only be a
  // percentage, while a fraction must not be shown as "0%".
  it.each([
    ["a fraction", 0.155, 15.5],
    ["exactly one", 1, 100],
    ["a percentage", 42, 42],
  ])("accepts utilization expressed as %s", (_label, utilization, expected) => {
    const parsed = usageWindowsFromRuntimeEventPayload(
      envelope({ rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization } }),
    );

    expect(parsed?.windows[0]?.usedPercent).toBe(expected);
  });

  // The verdict still lands (see `rateLimitFromRuntimeEventPayload`); only the
  // gauge stays as it was.
  it.each([
    ["no utilization", REAL_CLAUDE_EVENT],
    [
      "an out-of-range utilization",
      { rate_limit_info: { rateLimitType: "five_hour", utilization: 250 } },
    ],
    [
      "a negative utilization",
      { rate_limit_info: { rateLimitType: "five_hour", utilization: -1 } },
    ],
    [
      "a model-scoped weekly",
      { rate_limit_info: { rateLimitType: "seven_day_opus", utilization: 0.5 } },
    ],
    ["an overage window", { rate_limit_info: { rateLimitType: "overage", utilization: 0.5 } }],
    ["no window kind", { rate_limit_info: { status: "allowed", utilization: 0.5 } }],
    ["a Codex update with no windows", { rateLimits: { planType: "plus" } }],
    ["an empty message", {}],
  ])("returns undefined for a message with %s", (_label, rateLimits) => {
    expect(usageWindowsFromRuntimeEventPayload(envelope(rateLimits))).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["a string", "rate limited"],
    ["an array", []],
    ["a bare message with no envelope", REAL_CLAUDE_EVENT],
  ])("returns undefined for a payload that is %s", (_label, payload) => {
    expect(usageWindowsFromRuntimeEventPayload(payload)).toBeUndefined();
  });
});
