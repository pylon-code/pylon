import { describe, expect, it } from "vite-plus/test";

import { usageLimitsFromCodexRateLimits } from "./providerUsageLimits.ts";

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
