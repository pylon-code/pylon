import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

import { presentMobileContextWindow } from "./contextWindow";

function snapshot(
  input: Partial<ContextWindowSnapshot> & Pick<ContextWindowSnapshot, "usedTokens">,
): ContextWindowSnapshot {
  return {
    totalProcessedTokens: null,
    maxTokens: null,
    remainingTokens: null,
    usedPercentage: null,
    remainingPercentage: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
    autoCompactThreshold: null,
    updatedAt: "2026-03-23T00:00:00.000Z",
    ...input,
    usedTokens: input.usedTokens,
  };
}

describe("presentMobileContextWindow", () => {
  it("presents known model windows with a ring percentage and readable counts", () => {
    expect(
      presentMobileContextWindow(
        snapshot({ usedTokens: 82_000, maxTokens: 258_000, usedPercentage: 31.78 }),
      ),
    ).toEqual({
      percent: 32,
      detailLabel: "82k / 258k · 32%",
      accessibilityText: "32 percent, 82,000 of 258,000 tokens used.",
      warning: false,
    });
  });

  it("leaves the ring empty and says so when the model window is unknown", () => {
    expect(presentMobileContextWindow(snapshot({ usedTokens: 1_400 }))).toMatchObject({
      percent: null,
      detailLabel: "1.4k used · window size unknown",
      accessibilityText: "Context window, 1,400 tokens used.",
    });
  });

  it("warns only above ninety percent and hides absent snapshots", () => {
    expect(
      presentMobileContextWindow(snapshot({ usedTokens: 90, maxTokens: 100, usedPercentage: 90 })),
    ).toMatchObject({ warning: false });
    expect(
      presentMobileContextWindow(snapshot({ usedTokens: 91, maxTokens: 100, usedPercentage: 91 })),
    ).toMatchObject({ warning: true });
    expect(presentMobileContextWindow(null)).toBeNull();
  });
});
