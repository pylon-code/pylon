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
    updatedAt: "2026-03-23T00:00:00.000Z",
    ...input,
    usedTokens: input.usedTokens,
  };
}

describe("presentMobileContextWindow", () => {
  it("presents known model windows with visible and accessible percentages", () => {
    expect(
      presentMobileContextWindow(
        snapshot({ usedTokens: 82_000, maxTokens: 258_000, usedPercentage: 31.78 }),
      ),
    ).toEqual({
      compactLabel: "32%",
      expandedLabel: "Context 82k / 258k · 32%",
      accessibilityText: "32 percent, 82,000 of 258,000 tokens used.",
      warning: false,
    });
  });

  it("falls back to current tokens when the model window is unknown", () => {
    expect(presentMobileContextWindow(snapshot({ usedTokens: 1_400 }))).toMatchObject({
      compactLabel: "1.4k",
      expandedLabel: "Context 1.4k",
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
