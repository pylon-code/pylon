import type { ModelTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  cacheHitRate,
  costPerMillionTokens,
  costTypeSegments,
  sortModelsByTokens,
  speedCostSegments,
  tokenTypeSegments,
} from "./usageBreakdown";

const model = (
  name: string,
  totalTokens: number,
  costUsd: number,
  overrides: Partial<ModelTotals> = {},
): ModelTotals => ({
  model: name,
  provider: "codex",
  costUsd,
  totalTokens,
  tokens: {
    uncachedInputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  records: 1,
  unpricedRecords: 0,
  unpricedTokens: 0,
  costShare: 0,
  ...overrides,
});

describe("sortModelsByTokens", () => {
  it("sorts by tokens, breaks ties by cost, and leaves the input alone", () => {
    const models = [
      model("lower-cost", 100, 1),
      model("more-tokens", 200, 2),
      model("higher-cost", 100, 3),
    ];

    expect(sortModelsByTokens(models).map((item) => item.model)).toEqual([
      "more-tokens",
      "higher-cost",
      "lower-cost",
    ]);
    expect(models.map((item) => item.model)).toEqual(["lower-cost", "more-tokens", "higher-cost"]);
  });
});

describe("model rates", () => {
  it("counts cache writes as misses and leaves unpriced tokens out of $/1M", () => {
    const mixed = model("mixed", 4_000_000, 6, {
      tokens: {
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheCreationTokens: 2_000_000,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      records: 4,
      unpricedRecords: 1,
      unpricedTokens: 1_000_000,
    });

    expect(cacheHitRate(mixed)).toBe(0.25);
    expect(costPerMillionTokens(mixed)).toBe(2);
    expect(costPerMillionTokens({ ...mixed, unpricedRecords: 4 })).toBeNull();
  });
});

describe("share segments", () => {
  const values = (segments: readonly { label: string; value: number }[]) =>
    segments.map(({ label, value }) => [label, value]);

  it("splits cost by type, treating sub-cent unsplit cost as rounding", () => {
    const cost = { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, unsplit: 0.004 };

    expect(values(costTypeSegments(cost))).toEqual([
      ["Input", 1],
      ["Cache read", 2],
      ["Cache write", 3],
      ["Output", 4],
      ["Other", 0],
    ]);
    expect(costTypeSegments({ ...cost, unsplit: 5 }).at(-1)?.value).toBe(5);
  });

  it("orders speeds by price and tokens by type", () => {
    expect(values(speedCostSegments({ standard: 9, fast: 6, ultrafast: 2, premium: 4 }))).toEqual([
      ["Standard", 9],
      ["Fast", 6],
      ["Ultrafast", 2],
    ]);
    expect(
      values(
        tokenTypeSegments({
          uncachedInputTokens: 1,
          cachedInputTokens: 2,
          cacheCreationTokens: 3,
          outputTokens: 4,
        }),
      ),
    ).toEqual([
      ["Input", 1],
      ["Cache read", 2],
      ["Cache write", 3],
      ["Output", 4],
    ]);
  });
});
