import { describe, expect, it } from "vite-plus/test";

import {
  accessTokenFromKeychainValue,
  claudeConfigDirKeychainService,
  OAUTH_USAGE_THROTTLE_DEFAULT_MS,
  OAUTH_USAGE_THROTTLE_MAX_MS,
  OAUTH_USAGE_THROTTLE_MIN_MS,
  throttleDelayFromRetryAfter,
  usageLimitsFromClaudeOAuthResponse,
} from "./claudeOAuthUsage.ts";

const CHECKED_AT = "2026-08-04T21:45:00.000Z";

// Captured verbatim from a live `GET /api/oauth/usage`, trimmed of the
// dollar/severity fields Pylon does not read. Note `seven_day_opus` and
// `seven_day_sonnet` are null while a model-scoped weekly is present in
// `limits` — that asymmetry is why `limits[]` has to be read at all.
const REAL_RESPONSE = {
  five_hour: {
    utilization: 11.0,
    resets_at: "2026-08-05T01:00:00.949765+00:00",
    limit_dollars: null,
  },
  seven_day: {
    utilization: 40.0,
    resets_at: "2026-08-09T17:00:00.949790+00:00",
    limit_dollars: null,
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, monthly_limit: 0, used_credits: 0.0, currency: "USD" },
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 11,
      resets_at: "2026-08-05T01:00:00.949765+00:00",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 40,
      resets_at: "2026-08-09T17:00:00.949790+00:00",
      scope: null,
      is_active: true,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 11,
      resets_at: "2026-08-09T17:00:00.950186+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
  member_dashboard_available: false,
};

describe("usageLimitsFromClaudeOAuthResponse", () => {
  it("reads a real OAuth usage payload", () => {
    const parsed = usageLimitsFromClaudeOAuthResponse(REAL_RESPONSE, CHECKED_AT);

    expect(parsed).toEqual({
      source: "claudeOAuth",
      checkedAt: CHECKED_AT,
      windows: [
        {
          label: "Session",
          usedPercent: 11,
          windowDurationMins: 300,
          resetsAt: "2026-08-05T01:00:00.949Z",
        },
        {
          label: "Weekly (all models)",
          usedPercent: 40,
          windowDurationMins: 10_080,
          resetsAt: "2026-08-09T17:00:00.949Z",
        },
        {
          label: "Weekly (Fable)",
          usedPercent: 11,
          windowDurationMins: 10_080,
          resetsAt: "2026-08-09T17:00:00.950Z",
        },
      ],
    });
  });

  // The CLI-scraping parser produced these same labels, so the popover reads
  // identically whichever source served the reading.
  it("labels windows the way the CLI parser did", () => {
    const labels = usageLimitsFromClaudeOAuthResponse(REAL_RESPONSE, CHECKED_AT)?.windows.map(
      (window) => window.label,
    );

    expect(labels).toEqual(["Session", "Weekly (all models)", "Weekly (Fable)"]);
  });

  it("keeps a window whose reset time is missing or unparseable", () => {
    const parsed = usageLimitsFromClaudeOAuthResponse(
      { five_hour: { utilization: 4, resets_at: "not-a-date" } },
      CHECKED_AT,
    );

    expect(parsed?.windows[0]?.usedPercent).toBe(4);
    expect(parsed?.windows[0]?.resetsAt).toBeUndefined();
  });

  it("ignores a scoped limit that names no model", () => {
    const parsed = usageLimitsFromClaudeOAuthResponse(
      {
        five_hour: { utilization: 4 },
        limits: [{ kind: "weekly_scoped", percent: 9, scope: { model: null } }],
      },
      CHECKED_AT,
    );

    expect(parsed?.windows).toHaveLength(1);
  });

  it("does not duplicate a window already taken from the top level", () => {
    const parsed = usageLimitsFromClaudeOAuthResponse(
      {
        seven_day: { utilization: 40 },
        limits: [{ kind: "weekly_all", percent: 40 }],
      },
      CHECKED_AT,
    );

    expect(parsed?.windows).toHaveLength(1);
    expect(parsed?.windows[0]?.label).toBe("Weekly (all models)");
  });

  it("clamps a percentage outside 0-100 to the contract's range", () => {
    const parsed = usageLimitsFromClaudeOAuthResponse(
      { five_hour: { utilization: 140 }, seven_day: { utilization: -3 } },
      CHECKED_AT,
    );

    expect(parsed?.windows.map((window) => window.usedPercent)).toEqual([100, 0]);
  });

  // A private endpoint can change shape without notice, so an unreadable
  // payload has to yield no reading rather than a wrong one.
  it.each([
    ["null", null],
    ["a string", "429 Too Many Requests"],
    ["an array", []],
    ["an error body", { error: { type: "rate_limit_error" } }],
    ["windows with no usable percentage", { five_hour: { resets_at: "2026-08-05T01:00:00Z" } }],
    ["a non-numeric percentage", { five_hour: { utilization: "11%" } }],
  ])("returns undefined for %s", (_label, payload) => {
    expect(usageLimitsFromClaudeOAuthResponse(payload, CHECKED_AT)).toBeUndefined();
  });
});

describe("claudeConfigDirKeychainService", () => {
  const DEFAULT_DIR = "/Users/example/.claude";

  it("uses the bare service name for the default config dir", () => {
    expect(claudeConfigDirKeychainService(DEFAULT_DIR, DEFAULT_DIR)).toBe(
      "Claude Code-credentials",
    );
  });

  // Claude Code's own convention. Matching it byte-for-byte is what lets a
  // second account be read without prompting the user.
  it("suffixes a second account's dir with a hash of its absolute path", () => {
    const service = claudeConfigDirKeychainService("/Users/example/.claude_personal", DEFAULT_DIR);

    expect(service).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/u);
  });

  it("gives different dirs different services", () => {
    const first = claudeConfigDirKeychainService("/Users/example/.claude_work", DEFAULT_DIR);
    const second = claudeConfigDirKeychainService("/Users/example/.claude_personal", DEFAULT_DIR);

    expect(first).not.toBe(second);
  });
});

describe("accessTokenFromKeychainValue", () => {
  const credentials = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-example" } });

  // Claude Code writes hex after `claude login`; older installs wrote raw JSON.
  it("reads hex-encoded credentials", () => {
    const hex = Buffer.from(credentials, "utf8").toString("hex");

    expect(accessTokenFromKeychainValue(hex)).toBe("sk-ant-oat01-example");
  });

  it("reads raw JSON credentials", () => {
    expect(accessTokenFromKeychainValue(credentials)).toBe("sk-ant-oat01-example");
  });

  it.each([
    ["empty", ""],
    ["not json or hex", "denied"],
    ["json without an oauth block", '{"other":true}'],
    ["an oauth block with no token", '{"claudeAiOauth":{}}'],
    ["a blank token", '{"claudeAiOauth":{"accessToken":"   "}}'],
  ])("returns undefined when the value is %s", (_label, raw) => {
    expect(accessTokenFromKeychainValue(raw)).toBeUndefined();
  });
});

describe("throttleDelayFromRetryAfter", () => {
  const NOW = Date.parse("2026-08-06T12:00:00.000Z");

  // The endpoint has asked for room; the whole point is to give it.
  it("honours Retry-After in seconds", () => {
    expect(throttleDelayFromRetryAfter("120", NOW)).toBe(120_000);
  });

  it("honours Retry-After as an HTTP date", () => {
    expect(throttleDelayFromRetryAfter("Thu, 06 Aug 2026 12:03:00 GMT", NOW)).toBe(180_000);
  });

  // Never under a minute: a burst of retries would keep the limit tripped.
  it("floors a short or past Retry-After to a minute", () => {
    expect(throttleDelayFromRetryAfter("5", NOW)).toBe(OAUTH_USAGE_THROTTLE_MIN_MS);
    expect(throttleDelayFromRetryAfter("Thu, 06 Aug 2026 11:00:00 GMT", NOW)).toBe(
      OAUTH_USAGE_THROTTLE_MIN_MS,
    );
  });

  // Never over half an hour: by then the retained reading has expired and a
  // fresh attempt is worth more than obedience.
  it("caps a long Retry-After", () => {
    expect(throttleDelayFromRetryAfter("86400", NOW)).toBe(OAUTH_USAGE_THROTTLE_MAX_MS);
  });

  // Without the header a throttled account is retried no faster than a
  // healthy one would be read.
  it.each([
    ["absent", undefined],
    ["blank", "  "],
    ["unparseable", "soon"],
  ])("waits a full poll when Retry-After is %s", (_label, header) => {
    expect(throttleDelayFromRetryAfter(header, NOW)).toBe(OAUTH_USAGE_THROTTLE_DEFAULT_MS);
  });
});
