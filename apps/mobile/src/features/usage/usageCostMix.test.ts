import { describe, expect, it } from "vite-plus/test";

import {
  costTypeSegments,
  hasFasterSpeedCost,
  speedCostSegments,
  visibleCostSegments,
  type CostMixColors,
} from "./usageCostMix";

const colors: CostMixColors = {
  input: "input",
  cacheRead: "cacheRead",
  cacheWrite: "cacheWrite",
  output: "output",
  other: "other",
  standard: "standard",
  fast: "fast",
  ultrafast: "ultrafast",
};

describe("usage cost mix", () => {
  it("splits cost by type and hides sub-cent unsplit rounding", () => {
    const cost = { input: 1, cacheRead: 2, cacheWrite: 0, output: 4, unsplit: 0.004 };

    expect(
      visibleCostSegments(costTypeSegments(cost, colors)).map(({ label, value }) => [label, value]),
    ).toEqual([
      ["Input", 1],
      ["Cache read", 2],
      ["Output", 4],
    ]);
    expect(visibleCostSegments(costTypeSegments({ ...cost, unsplit: 5 }, colors)).at(-1)).toEqual({
      label: "Other",
      value: 5,
      color: "other",
    });
  });

  it("shows the speed bar only when some cost ran faster than standard", () => {
    const standardOnly = { standard: 9, fast: 0, ultrafast: 0, premium: 0 };
    const mixed = { standard: 9, fast: 6, ultrafast: 2, premium: 4 };

    expect(hasFasterSpeedCost(standardOnly)).toBe(false);
    expect(hasFasterSpeedCost(mixed)).toBe(true);
    expect(speedCostSegments(mixed, colors)).toEqual([
      { label: "Standard", value: 9, color: "standard" },
      { label: "Fast", value: 6, color: "fast" },
      { label: "Ultrafast", value: 2, color: "ultrafast" },
    ]);
  });
});
