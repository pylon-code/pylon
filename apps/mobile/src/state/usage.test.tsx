import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { useUsage, type EnvironmentUsageStatus, type UsageView } from "./usage";

const state = vi.hoisted(() => ({ environments: [] as EnvironmentUsageStatus[] }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.environments }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./presentation", () => ({ environmentPresentations: {} }));
vi.mock("./server", () => ({ serverEnvironment: {} }));

const input = {
  sinceDay: UsageDay.make("2026-09-04"),
  untilDay: UsageDay.make("2026-09-05"),
  timeZone: "UTC",
};
function reading(id: string, partial: boolean): EnvironmentUsageStatus {
  const cell = (day: UsageDay, costUsd: number) => ({
    day,
    provider: "codex" as const,
    model: "gpt-6",
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
    },
    costUsd,
    cacheSavingsUsd: 0,
    costSource: "modelPriced" as const,
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
  });
  const buckets = partial
    ? [cell(input.sinceDay, 4), cell(input.untilDay, 3)]
    : [cell(input.sinceDay, 10)];
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    isPending: false,
    isConnected: true,
    error: null,
    summary: {
      ...input,
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: partial ? "2026-09-05T12:00:00Z" : "2026-09-04T12:00:00Z",
      buckets,
      sources: [
        {
          fingerprint: {
            hostId: "host",
            provider: "codex",
            resolvedHomePath: "/sessions",
            volumeId: "physical-volume",
          },
          status: partial ? "partial" : "ok",
          scannedFiles: 1,
          skippedFiles: partial ? 1 : 0,
          malformedRecords: 0,
          distinctSessions: partial ? 2 : 1,
          message: partial ? "One source file could not be read." : null,
          buckets,
        },
      ],
      pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
    },
  };
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe("mobile usage scan selection", () => {
  it("retains complete cells and new partial cells, then recomputes ownership when the selection changes", async () => {
    state.environments = [reading("complete", false), reading("partial", true)];
    let latest: UsageView | undefined;
    let renderer: ReactTestRenderer | undefined;
    function Probe({ selected }: { selected: ReadonlySet<EnvironmentId> | null }) {
      const usage = useUsage(input, selected);
      useLayoutEffect(() => {
        latest = usage;
      }, [usage]);
      return null;
    }
    try {
      await act(async () => {
        renderer = create(<Probe selected={null} />);
      });
      expect(latest?.merged.costUsd).toBe(13);
      expect(latest?.merged.sessions).toBe(2);
      expect(latest?.merged.duplicateSources).toEqual(["partial: /sessions"]);
      await act(async () =>
        renderer?.update(<Probe selected={new Set([EnvironmentId.make("partial")])} />),
      );
      expect(latest?.merged.costUsd).toBe(7);
      expect(latest?.merged.duplicateSources).toEqual([]);
      await act(async () =>
        renderer?.update(<Probe selected={new Set([EnvironmentId.make("complete")])} />),
      );
      expect(latest?.merged.costUsd).toBe(10);
      state.environments = state.environments.toReversed();
      await act(async () => renderer?.update(<Probe selected={null} />));
      expect(latest?.merged.costUsd).toBe(13);
      expect(latest?.merged.sessions).toBe(2);
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
});
