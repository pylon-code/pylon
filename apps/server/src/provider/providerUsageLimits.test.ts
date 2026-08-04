import { describe, expect, it } from "vite-plus/test";

import {
  parseClaudeUsageLimitsJson,
  usageLimitsFromCodexRateLimits,
} from "./providerUsageLimits.ts";

describe("usageLimitsFromCodexRateLimits", () => {
  it("maps primary and secondary windows", () => {
    expect(
      usageLimitsFromCodexRateLimits(
        {
          rateLimits: {
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_774_000_000 },
            secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_775_000_000 },
          },
        },
        "2026-03-20T00:00:00.000Z",
      ),
    ).toEqual({
      source: "codexAppServer",
      checkedAt: "2026-03-20T00:00:00.000Z",
      windows: [
        {
          label: "Session",
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: "2026-03-20T09:46:40.000Z",
        },
        {
          label: "Weekly",
          usedPercent: 40,
          windowDurationMins: 10_080,
          resetsAt: "2026-03-31T23:33:20.000Z",
        },
      ],
    });
  });
});

describe("parseClaudeUsageLimitsJson", () => {
  it("parses dynamic usage windows from the JSON result", () => {
    const output = JSON.stringify({
      result: [
        "Current session: 30% used \u00b7 resets Jul 23, 1:30am (America/Chicago)",
        "Current week (all models): 16% used \u00b7 resets Jul 28, 1am (America/Chicago)",
        "Current week (Fable): 26% used \u00b7 resets Jul 28, 1am (America/Chicago)",
      ].join("\n"),
    });

    expect(parseClaudeUsageLimitsJson(output, "2026-07-22T12:00:00.000Z")).toEqual({
      source: "claudePrint",
      checkedAt: "2026-07-22T12:00:00.000Z",
      windows: [
        {
          label: "Session",
          usedPercent: 30,
          windowDurationMins: 300,
          resetsAt: "2026-07-23T06:30:00.000Z",
        },
        {
          label: "Weekly (all models)",
          usedPercent: 16,
          windowDurationMins: 10_080,
          resetsAt: "2026-07-28T06:00:00.000Z",
        },
        {
          label: "Weekly (Fable)",
          usedPercent: 26,
          windowDurationMins: 10_080,
          resetsAt: "2026-07-28T06:00:00.000Z",
        },
      ],
    });
  });

  // Captured from Claude Code 2.1.220. Two things moved since the parser was
  // written: `--output-format json` now emits an array of stream messages
  // rather than one object, and the reset separator is " at " rather than ", ".
  it("parses the array envelope and ' at ' separator real Claude Code emits", () => {
    const output = JSON.stringify([
      { type: "system", subtype: "init", session_id: "2f33563e" },
      { type: "assistant", message: { role: "assistant" } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: [
          "You are currently using your subscription to power your Claude Code usage",
          "",
          "Current session: 12% used · resets Aug 4 at 6:49pm (America/Denver)",
          "Current week (all models): 16% used · resets Aug 9 at 4:59pm (America/Denver)",
          "Current week (Fable): 1% used · resets Aug 9 at 5pm (America/Denver)",
        ].join("\n"),
      },
    ]);

    expect(parseClaudeUsageLimitsJson(output, "2026-08-04T20:00:00.000Z")).toEqual({
      source: "claudePrint",
      checkedAt: "2026-08-04T20:00:00.000Z",
      windows: [
        {
          label: "Session",
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAt: "2026-08-05T00:49:00.000Z",
        },
        {
          label: "Weekly (all models)",
          usedPercent: 16,
          windowDurationMins: 10_080,
          resetsAt: "2026-08-09T22:59:00.000Z",
        },
        {
          label: "Weekly (Fable)",
          usedPercent: 1,
          windowDurationMins: 10_080,
          resetsAt: "2026-08-09T23:00:00.000Z",
        },
      ],
    });
  });

  it("ignores non-result entries in the array envelope", () => {
    const output = JSON.stringify([
      { type: "system", result: "Current session: 99% used · resets Aug 4 at 1am (UTC)" },
      {
        type: "result",
        result: "Current session: 12% used · resets Aug 4 at 6:49pm (America/Denver)",
      },
    ]);

    expect(parseClaudeUsageLimitsJson(output, "2026-08-04T20:00:00.000Z")?.windows[0]).toEqual({
      label: "Session",
      usedPercent: 12,
      windowDurationMins: 300,
      resetsAt: "2026-08-05T00:49:00.000Z",
    });
  });

  it("fails closed for malformed or changed output", () => {
    expect(parseClaudeUsageLimitsJson("not json", "2026-07-22T12:00:00.000Z")).toBeUndefined();
    expect(
      parseClaudeUsageLimitsJson(
        JSON.stringify({ result: "Your limits look healthy." }),
        "2026-07-22T12:00:00.000Z",
      ),
    ).toBeUndefined();
  });

  it("uses the reset zone's local year around the UTC new-year boundary", () => {
    const output = JSON.stringify({
      result: "Current session: 30% used \u00b7 resets Dec 31, 11pm (America/Los_Angeles)",
    });

    expect(
      parseClaudeUsageLimitsJson(output, "2027-01-01T00:30:00.000Z")?.windows[0]?.resetsAt,
    ).toBe("2027-01-01T07:00:00.000Z");
  });

  it("rolls the reset year forward when the reported date already passed this year", () => {
    const output = JSON.stringify({
      result: "Current session: 30% used \u00b7 resets Jan 2, 1am (America/Chicago)",
    });

    expect(
      parseClaudeUsageLimitsJson(output, "2026-12-31T12:00:00.000Z")?.windows[0]?.resetsAt,
    ).toBe("2027-01-02T07:00:00.000Z");
  });

  it("never reports a reset in the past", () => {
    const output = JSON.stringify({
      result: "Current week (all models): 30% used \u00b7 resets Jan 5, 1am (America/Chicago)",
    });

    expect(
      parseClaudeUsageLimitsJson(output, "2026-02-10T12:00:00.000Z")?.windows[0]?.resetsAt,
    ).toBe("2027-01-05T07:00:00.000Z");
  });

  it("parses Claude usage with CRLF line endings", () => {
    const output = JSON.stringify({
      result: [
        "Current session: 30% used \u00b7 resets Jul 23, 1:30am (America/Chicago)",
        "Current week (all models): 16% used \u00b7 resets Jul 28, 1am (America/Chicago)",
      ].join("\r\n"),
    });

    expect(parseClaudeUsageLimitsJson(output, "2026-07-22T12:00:00.000Z")?.windows).toHaveLength(2);
  });
});
