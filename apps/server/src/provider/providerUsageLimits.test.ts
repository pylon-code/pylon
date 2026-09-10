import { ServerProvider, ServerProviders } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  accumulatePushedUsageWindows,
  applyPushedUsageWindows,
  usageLimitsFromCodexRateLimits,
  usageWindowsFromCodexRateLimitSnapshot,
} from "./providerUsageLimits.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeServerProviders = Schema.decodeUnknownSync(ServerProviders);
const providerJsonCodec = Schema.toCodecJson(ServerProviders);
const encodeProviderJson = Schema.encodeSync(providerJsonCodec);
const decodeProviderJson = Schema.decodeUnknownSync(providerJsonCodec);

describe("usageLimitsFromCodexRateLimits", () => {
  it("selects the main allowance when the legacy snapshot names Spark", () => {
    const spark = {
      limitId: "codex_bengalfox",
      secondary: { usedPercent: 90, windowDurationMins: 10_080 },
    };
    expect(
      usageLimitsFromCodexRateLimits(
        {
          rateLimits: spark,
          rateLimitsByLimitId: {
            codex_bengalfox: spark,
            codex: { secondary: { usedPercent: 42, windowDurationMins: 10_080 } },
          },
        },
        "2026-09-07T00:00:00.000Z",
      )?.windows,
    ).toEqual([
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 42,
        windowDurationMins: 10_080,
      },
    ]);
  });

  it.each([undefined, null, {}])(
    "supports legacy reads with bucket map %j",
    (rateLimitsByLimitId) => {
      const rateLimits = { primary: { usedPercent: 12, windowDurationMins: 300 } };
      const checkedAt = "2026-09-07T00:00:00.000Z";
      expect(
        usageLimitsFromCodexRateLimits(
          {
            rateLimits,
            ...(rateLimitsByLimitId === undefined ? {} : { rateLimitsByLimitId }),
          },
          checkedAt,
        ),
      ).toEqual(usageLimitsFromCodexRateLimits({ rateLimits }, checkedAt));
    },
  );

  it("does not publish a model-specific legacy snapshot as the main allowance", () => {
    expect(
      usageLimitsFromCodexRateLimits(
        {
          rateLimits: {
            limitId: "codex_bengalfox",
            secondary: { usedPercent: 90, windowDurationMins: 10_080 },
          },
        },
        "2026-09-07T00:00:00.000Z",
      ),
    ).toBeUndefined();
  });

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
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: "2026-03-20T09:46:40.000Z",
        },
        {
          id: "secondary",
          kind: "weekly",
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
    ).toEqual([
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 61,
        windowDurationMins: 10_080,
      },
    ]);
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
  it.each([
    { label: "a missing probe", current: undefined },
    { label: "a successful probe", current: PROBED },
    {
      label: "a failed probe",
      current: {
        ...PROBED,
        unavailable: { reason: "probeFailed", message: "Probe failed." },
      } as const,
    },
  ])("keeps provider JSON serializable when a push replaces $label", ({ current }) => {
    const usageLimits = applyPushedUsageWindows(
      current,
      [
        pushed(
          { label: "Session", usedPercent: 15, windowDurationMins: 300 },
          "2026-08-04T18:10:00.000Z",
        ),
      ],
      { nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS, source: "push" },
    );
    const provider = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-08-04T18:10:00.000Z",
      models: [],
      usageLimits,
    });
    const encoded = encodeProviderJson([provider]);

    expect(usageLimits).not.toHaveProperty("unavailable");
    expect(decodeProviderJson(encoded)).toEqual([provider]);
    expect(decodeServerProviders(encoded)).toEqual([provider]);
  });

  it("preserves the reset-credit balance and its original read time on a window push", () => {
    const resetCredits = { availableCount: 0, checkedAt: PROBED.checkedAt };
    const result = applyPushedUsageWindows(
      { ...PROBED, resetCredits },
      [
        pushed(
          { label: "Session", usedPercent: 15, windowDurationMins: 300 },
          "2026-08-04T18:10:00.000Z",
        ),
      ],
      { nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS, source: "push" },
    );
    expect(result?.checkedAt).toBe("2026-08-04T18:10:00.000Z");
    expect(result?.resetCredits).toEqual(resetCredits);
  });

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

// A session reports its windows on every API call; most say the same
// thing. Each accepted push republishes the provider list to every client,
// so a same-value push only lands once the reading is a minute old.
it("skips a push that repeats the current reading within a minute", () => {
  const applied = applyPushedUsageWindows(
    PROBED,
    [
      pushed(
        {
          label: "Session",
          usedPercent: 10.3,
          windowDurationMins: 300,
          resetsAt: "2026-08-04T22:00:00.000Z",
        },
        "2026-08-04T18:00:30.000Z",
      ),
    ],
    { nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS, source: "push" },
  );

  expect(applied).toBe(PROBED);
});

it("lets a same-value push refresh the reading's age after a minute", () => {
  const applied = applyPushedUsageWindows(
    PROBED,
    [
      pushed(
        { label: "Session", usedPercent: 10, windowDurationMins: 300 },
        "2026-08-04T18:01:00.000Z",
      ),
    ],
    { nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS, source: "push" },
  );

  expect(applied?.checkedAt).toBe("2026-08-04T18:01:00.000Z");
  expect(applied?.windows[0]?.usedPercent).toBe(10);
});

it("applies a changed value immediately", () => {
  const applied = applyPushedUsageWindows(
    PROBED,
    [
      pushed(
        { label: "Session", usedPercent: 11, windowDurationMins: 300 },
        "2026-08-04T18:00:05.000Z",
      ),
    ],
    { nowMs: NOW_MS, maxAgeMs: MAX_AGE_MS, source: "push" },
  );

  expect(applied?.windows[0]?.usedPercent).toBe(11);
  expect(applied?.checkedAt).toBe("2026-08-04T18:00:05.000Z");
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
