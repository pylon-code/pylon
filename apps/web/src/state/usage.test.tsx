import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { mergeAnsweredUsage, useUsage, type EnvironmentUsageStatus, type UsageView } from "./usage";

const testState = vi.hoisted(() => ({ environments: [] as EnvironmentUsageStatus[] }));
const rateRefresh = vi.hoisted(() => ({
  calls: 0,
  settle: [] as (() => void)[],
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: () => {
    rateRefresh.calls += 1;
    return new Promise<void>((resolve) => rateRefresh.settle.push(resolve));
  },
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { refresh: () => {} } }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => testState.environments,
}));

const input = {
  sinceDay: UsageDay.make("2026-09-04"),
  untilDay: UsageDay.make("2026-09-04"),
  timeZone: "UTC",
};

function environment(id: string, cost: number | null, hostId = id): EnvironmentUsageStatus {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    isPending: cost === null,
    error: null,
    summary:
      cost === null
        ? null
        : {
            ...input,
            contractVersion: USAGE_CONTRACT_VERSION,
            readAt: "2026-09-04T12:00:00Z",
            buckets: [
              {
                day: input.sinceDay,
                provider: "codex",
                model: id,
                totals: {
                  uncachedInputTokens: 100,
                  cachedInputTokens: 0,
                  cacheCreationTokens: 0,
                  outputTokens: 50,
                  reasoningTokens: 0,
                },
                costUsd: cost,
                cacheSavingsUsd: 0,
                costSource: "modelPriced",
                records: 1,
                unpricedRecords: 0,
                sessions: 1,
              },
            ],
            sources: [
              {
                fingerprint: {
                  hostId,
                  provider: "codex",
                  resolvedHomePath: "/sessions",
                  volumeId: hostId,
                },
                status: "ok",
                scannedFiles: 1,
                skippedFiles: 0,
                malformedRecords: 0,
                distinctSessions: 1,
                message: null,
              },
            ],
            pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
            scanDurationMs: 1,
          },
  };
}

let renderer: ReactTestRenderer | undefined;
let latest: UsageView;

function Probe({ selected }: { selected: ReadonlySet<EnvironmentId> | null }) {
  const usage = useUsage(input, selected);
  useLayoutEffect(() => {
    latest = usage;
  }, [usage]);
  return null;
}

async function select(...ids: string[]) {
  await act(() => {
    renderer?.update(<Probe selected={new Set(ids.map((id) => EnvironmentId.make(id)))} />);
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rateRefresh.calls = 0;
  rateRefresh.settle = [];
  testState.environments = [environment("a", 10), environment("b", 20), environment("slow", null)];
  await act(() => {
    renderer = create(<Probe selected={null} />);
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("usage environment selection", () => {
  it("keeps complete and supplemental partial cells when selection changes", async () => {
    const complete = environment("complete", 10, "shared");
    const partial = environment("partial", 4, "shared");
    if (complete.summary === null || partial.summary === null)
      throw new Error("Missing fixture summary");
    const completeBuckets = complete.summary.buckets.map((cell) => ({
      ...cell,
      model: "shared-model",
    }));
    const partialBuckets = [
      ...partial.summary.buckets.map((cell) => ({ ...cell, model: "shared-model" })),
      { ...partial.summary.buckets[0]!, model: "new-model", costUsd: 3 },
    ];
    testState.environments = [
      {
        ...complete,
        summary: {
          ...complete.summary,
          buckets: completeBuckets,
          sources: complete.summary.sources.map((source) => ({
            ...source,
            buckets: completeBuckets,
          })),
        },
      },
      {
        ...partial,
        summary: {
          ...partial.summary,
          readAt: "2026-09-04T13:00:00Z",
          buckets: partialBuckets,
          sources: partial.summary.sources.map((source) => ({
            ...source,
            status: "partial" as const,
            distinctSessions: 2,
            buckets: partialBuckets,
          })),
        },
      },
    ];
    await act(() => renderer?.update(<Probe selected={null} />));
    expect(latest.merged.costUsd).toBe(13);
    expect(latest.merged.sessions).toBe(2);
    await select("partial");
    expect(latest.merged.costUsd).toBe(7);
    expect(latest.merged.duplicateSources).toEqual([]);
    await select("complete");
    expect(latest.merged.costUsd).toBe(10);
    testState.environments = testState.environments.toReversed();
    await act(() => renderer?.update(<Probe selected={null} />));
    expect(latest.merged.costUsd).toBe(13);
  });

  it("starts with all environments and adds results as they arrive", async () => {
    expect(latest.merged.costUsd).toBe(30);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(true);

    testState.environments = [...testState.environments.slice(0, 2), environment("slow", 40)];
    await act(() => renderer?.update(<Probe selected={null} />));
    expect(latest.merged.costUsd).toBe(70);
    expect(latest.isPartial).toBe(false);
  });

  it("excludes unselected usage and pending environments, then restores all", async () => {
    await select("b");
    expect(latest.merged.costUsd).toBe(20);
    expect(latest.merged.models.map((model) => model.model)).toEqual(["b"]);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);
    expect(latest.environments).toHaveLength(3);

    await act(() => renderer?.update(<Probe selected={null} />));
    expect(latest.merged.costUsd).toBe(30);
    expect(latest.isPartial).toBe(true);
  });

  it("distinguishes a pending selection from an empty or failed selection", async () => {
    await select("slow");
    expect(latest.isPending).toBe(true);
    expect(latest.merged.costUsd).toBe(0);

    await select();
    expect(latest.selectedEnvironments).toHaveLength(0);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);

    testState.environments = [{ ...environment("slow", null), isPending: false, error: "Offline" }];
    await select("slow");
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);
  });

  it("deduplicates within the selection so an excluded owner cannot hide usage", async () => {
    testState.environments = [environment("a", 10, "shared"), environment("b", 20, "shared")];
    await act(() => renderer?.update(<Probe selected={null} />));
    expect(latest.merged.costUsd).toBe(10);

    await select("b");
    expect(latest.merged.costUsd).toBe(20);
    expect(latest.merged.duplicateSources).toEqual([]);
  });

  it("keeps selected cached results visible during a refresh", async () => {
    testState.environments = [
      { ...environment("a", 10), isPending: true },
      environment("slow", null),
    ];
    await select("a");
    expect(latest.merged.costUsd).toBe(10);
    expect(latest.isPending).toBe(false);
    expect(latest.isPartial).toBe(false);
  });
});

describe("mergeAnsweredUsage", () => {
  it("narrows per-source buckets to one model, as the model dialog does", () => {
    const base = environment("a", 1);
    const summary = base.summary!;
    const modelA = summary.buckets[0]!;
    const modelB = { ...modelA, model: "b", costUsd: 5 };
    const status: EnvironmentUsageStatus = {
      ...base,
      summary: {
        ...summary,
        buckets: [modelA, modelB],
        // v7+ servers attribute buckets per source; the merge reads these.
        sources: summary.sources.map((source) => ({ ...source, buckets: [modelA, modelB] })),
      },
    };

    expect(mergeAnsweredUsage([status]).costUsd).toBe(6);
    const onlyA = mergeAnsweredUsage([status], (bucket) => bucket.model === "a");
    expect(onlyA.costUsd).toBe(1);
    expect(onlyA.models.map((model) => model.model)).toEqual(["a"]);
  });
});
