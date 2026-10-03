import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import {
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { deriveMobileThreadContextWindow, presentMobileContextWindow } from "./contextWindow";

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

const currentProvider = ProviderThreadId.make("provider-current");
const formerProvider = ProviderThreadId.make("provider-former");
const reportedAt = "2026-10-02T12:00:00.000Z";

function compaction(
  providerThreadId: ProviderThreadId | null,
  afterTokenCount?: number,
): {
  readonly item: OrchestrationV2TurnItem;
} {
  return {
    item: {
      id: TurnItemId.make(`compaction-${providerThreadId ?? "unscoped"}`),
      threadId: ThreadId.make("thread-context-window"),
      runId: null,
      nodeId: null,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe(reportedAt),
      type: "compaction",
      driver: null,
      beforeTokenCount: 12_000,
      ...(afterTokenCount === undefined ? {} : { afterTokenCount }),
    },
  };
}

describe("mobile v2 context ownership", () => {
  it("uses the last active-provider report across turns instead of a former provider", () => {
    const context = deriveMobileThreadContextWindow({
      thread: { activeProviderThreadId: currentProvider },
      providerThreads: [],
      providerTurns: [
        {
          providerThreadId: currentProvider,
          tokenUsage: { usedTokens: 21_000, maxTokens: 100_000, updatedAt: reportedAt },
        },
        { providerThreadId: currentProvider },
        {
          providerThreadId: formerProvider,
          tokenUsage: { usedTokens: 99_000, maxTokens: 100_000, updatedAt: reportedAt },
        },
      ],
    });
    expect(context).toMatchObject({ usedTokens: 21_000, usedPercentage: 21 });
  });

  it("does not carry former-provider context across handoff and restores it only when active again", () => {
    const projection = {
      thread: { activeProviderThreadId: currentProvider },
      providerThreads: [
        {
          id: formerProvider,
          contextUsage: { usedTokens: 91_000, maxTokens: 100_000 },
          updatedAt: DateTime.makeUnsafe(reportedAt),
        },
      ],
      providerTurns: [],
    };
    expect(
      deriveMobileThreadContextWindow(projection, [compaction(formerProvider, 5_000)]),
    ).toBeNull();
    expect(
      deriveMobileThreadContextWindow({
        ...projection,
        thread: { activeProviderThreadId: formerProvider },
      }),
    ).toMatchObject({ usedTokens: 91_000, usedPercentage: 91 });
    expect(
      deriveMobileThreadContextWindow({ ...projection, thread: { activeProviderThreadId: null } }),
    ).toBeNull();
  });

  it("shows active compaction counts with unknown capacity and excludes unscoped or former reports", () => {
    const projection = {
      thread: { activeProviderThreadId: currentProvider },
      providerThreads: [],
      providerTurns: [],
    };
    const context = deriveMobileThreadContextWindow(projection, [
      compaction(currentProvider, 2_500),
      compaction(formerProvider, 9_000),
      compaction(null, 8_000),
    ]);
    expect(context).toMatchObject({ usedTokens: 2_500, maxTokens: null, usedPercentage: null });
    expect(presentMobileContextWindow(context)).toMatchObject({
      percent: null,
      detailLabel: "2.5k used · window size unknown",
    });
    expect(deriveMobileThreadContextWindow(projection, [compaction(currentProvider)])).toBeNull();
    expect(deriveMobileThreadContextWindow(undefined)).toBeNull();
  });

  it("keeps unknown capacity for a live report rather than borrowing an older maximum", () => {
    const context = deriveMobileThreadContextWindow({
      thread: { activeProviderThreadId: currentProvider },
      providerThreads: [
        {
          id: currentProvider,
          contextUsage: { usedTokens: 1_000, maxTokens: 100_000 },
          updatedAt: DateTime.makeUnsafe(reportedAt),
        },
      ],
      providerTurns: [
        {
          providerThreadId: currentProvider,
          tokenUsage: { usedTokens: 3_000, updatedAt: reportedAt },
        },
      ],
    });
    expect(context).toMatchObject({ usedTokens: 3_000, maxTokens: null, usedPercentage: null });
  });
});
