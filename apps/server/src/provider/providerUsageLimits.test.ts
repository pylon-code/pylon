import { describe, expect, it } from "vite-plus/test";

import {
  accumulatePushedUsageWindows,
  applyPushedUsageWindows,
  usageLimitsFromCodexRateLimits,
  usageWindowsFromCodexRateLimitSnapshot,
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

describe("usageWindowsFromCodexRateLimitSnapshot", () => {
  // A rolling update is sparse by design: one window alone is a valid result.
  it("maps whichever windows are present", () => {
    expect(
      usageWindowsFromCodexRateLimitSnapshot({
        secondary: { usedPercent: 61, windowDurationMins: 10_080 },
      }),
    ).toEqual([{ label: "Weekly", usedPercent: 61, windowDurationMins: 10_080 }]);
  });

  it("drops a window without a usable percentage", () => {
    expect(
      usageWindowsFromCodexRateLimitSnapshot({
        primary: { usedPercent: Number.NaN, windowDurationMins: 300 },
        secondary: null,
      }),
    ).toEqual([]);
  });
});

const PROBED = {
  source: "claudeOAuth",
  checkedAt: "2026-08-04T18:00:00.000Z",
  windows: [
    {
      label: "Session",
      usedPercent: 10,
      windowDurationMins: 300,
      resetsAt: "2026-08-04T22:00:00.000Z",
    },
    {
      label: "Weekly (all models)",
      usedPercent: 40,
      windowDurationMins: 10_080,
      resetsAt: "2026-08-09T17:00:00.000Z",
    },
    { label: "Weekly (Fable)", usedPercent: 12, windowDurationMins: 10_080 },
  ],
} as const;

const NOW_MS = Date.parse("2026-08-04T18:30:00.000Z");
const MAX_AGE_MS = 30 * 60_000;

const pushed = (
  window:
    | (typeof PROBED.windows)[number]
    | { label: string; usedPercent: number; windowDurationMins?: number; resetsAt?: string },
  observedAt: string,
) => ({ window, observedAt });

describe("applyPushedUsageWindows", () => {
  it("replaces the matching window's percentage and reset, keeping the probe's label", () => {
    const applied = applyPushedUsageWindows(
      PROBED,
      [
        pushed(
          {
            label: "Codex-style label",
            usedPercent: 15,
            windowDurationMins: 300,
            resetsAt: "2026-08-04T22:05:00.000Z",
          },
          "2026-08-04T18:10:00.000Z",
        ),
      ],
      { nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS, source: "push" },
    );

    expect(applied).toEqual({
      source: "claudeOAuth",
      checkedAt: "2026-08-04T18:10:00.000Z",
      windows: [
        {
          label: "Session",
          usedPercent: 15,
          windowDurationMins: 300,
          resetsAt: "2026-08-04T22:05:00.000Z",
        },
        PROBED.windows[1],
        PROBED.windows[2],
      ],
    });
  });

  // The first weekly is the account-wide one; the model-scoped weekly behind
  // it is never what a provider pushes, so it must not be the one replaced.
  it("matches a pushed weekly to the account-wide weekly, not a scoped one", () => {
    const applied = applyPushedUsageWindows(
      PROBED,
      [
        pushed(
          { label: "Weekly", usedPercent: 44, windowDurationMins: 10_080 },
          "2026-08-04T18:10:00.000Z",
        ),
      ],
      { nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS, source: "push" },
    );

    expect(applied?.windows.map((window) => window.usedPercent)).toEqual([10, 44, 12]);
  });

  // A probe that ran after the push is the better source.
  it("returns the reading untouched when every push is older than it", () => {
    const applied = applyPushedUsageWindows(
      PROBED,
      [
        pushed(
          { label: "Session", usedPercent: 99, windowDurationMins: 300 },
          "2026-08-04T17:59:00.000Z",
        ),
      ],
      { nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS, source: "push" },
    );

    expect(applied).toBe(PROBED);
  });

  it("drops a push older than the retention window", () => {
    const applied = applyPushedUsageWindows(
      undefined,
      [
        pushed(
          { label: "Session", usedPercent: 50, windowDurationMins: 300 },
          "2026-08-04T17:00:00.000Z",
        ),
      ],
      { nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS, source: "push" },
    );

    expect(applied).toBeUndefined();
  });

  // Before any probe has succeeded a push is all there is; it seeds the gauge
  // rather than waiting minutes for the poll.
  it("seeds a reading from pushes when there is no probe result", () => {
    const applied = applyPushedUsageWindows(
      undefined,
      [
        pushed(
          { label: "Session", usedPercent: 20, windowDurationMins: 300 },
          "2026-08-04T18:20:00.000Z",
        ),
        pushed(
          { label: "Weekly", usedPercent: 30, windowDurationMins: 10_080 },
          "2026-08-04T18:25:00.000Z",
        ),
      ],
      { nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS, source: "codexAppServerPush" },
    );

    expect(applied).toEqual({
      source: "codexAppServerPush",
      checkedAt: "2026-08-04T18:25:00.000Z",
      windows: [
        { label: "Session", usedPercent: 20, windowDurationMins: 300 },
        { label: "Weekly", usedPercent: 30, windowDurationMins: 10_080 },
      ],
    });
  });

  it("appends a pushed window the reading does not have", () => {
    const applied = applyPushedUsageWindows(
      { source: "codexAppServer", checkedAt: "2026-08-04T18:00:00.000Z", windows: [] },
      [
        pushed(
          { label: "Weekly", usedPercent: 30, windowDurationMins: 10_080 },
          "2026-08-04T18:25:00.000Z",
        ),
      ],
      { nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS, source: "push" },
    );

    expect(applied?.windows).toEqual([
      { label: "Weekly", usedPercent: 30, windowDurationMins: 10_080 },
    ]);
  });
});

describe("accumulatePushedUsageWindows", () => {
  it("keeps one entry per window, newest observation winning", () => {
    const retained = accumulatePushedUsageWindows(
      [
        pushed(
          { label: "Session", usedPercent: 10, windowDurationMins: 300 },
          "2026-08-04T18:00:00.000Z",
        ),
      ],
      [
        pushed(
          { label: "Session", usedPercent: 12, windowDurationMins: 300 },
          "2026-08-04T18:05:00.000Z",
        ),
        pushed(
          { label: "Weekly", usedPercent: 40, windowDurationMins: 10_080 },
          "2026-08-04T18:05:00.000Z",
        ),
      ],
    );

    expect(retained.map((entry) => `${entry.window.label} ${entry.window.usedPercent}`)).toEqual([
      "Session 12",
      "Weekly 40",
    ]);
  });

  // Events can arrive out of order across threads; an older observation must
  // not overwrite a newer one.
  it("ignores a push observed before the retained one", () => {
    const retained = accumulatePushedUsageWindows(
      [
        pushed(
          { label: "Session", usedPercent: 12, windowDurationMins: 300 },
          "2026-08-04T18:05:00.000Z",
        ),
      ],
      [
        pushed(
          { label: "Session", usedPercent: 10, windowDurationMins: 300 },
          "2026-08-04T18:00:00.000Z",
        ),
      ],
    );

    expect(retained[0]?.window.usedPercent).toBe(12);
  });
});
