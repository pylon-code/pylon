import {
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
  UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { isModelCostUnknown, mergeUsage, type EnvironmentUsage } from "./usageMerge.ts";

const decodeSummary = Schema.decodeUnknownSync(UsageSummary);
const encodeSummary = Schema.encodeSync(UsageSummary);

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-08-07" as UsageDay,
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    costUsd: 10,
    cacheSavingsUsd: 2,
    costSource: "modelPriced",
    records: 5,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

function summary(
  buckets: readonly UsageBucket[],
  sources: readonly {
    provider: UsageProviderKind;
    hostId: string;
    homePath: string;
    volumeId?: string;
    distinctSessions?: number;
    buckets?: readonly UsageBucket[];
  }[],
  contractVersion: number = USAGE_CONTRACT_VERSION,
): UsageSummary {
  return {
    contractVersion,
    readAt: "2026-08-07T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-31" as UsageDay,
    buckets,
    sources: sources.map((source) => ({
      fingerprint: {
        hostId: source.hostId,
        provider: source.provider,
        resolvedHomePath: source.homePath,
        volumeId: source.volumeId ?? `vol-${source.hostId}`,
      },
      status: "ok" as const,
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: source.distinctSessions ?? 1,
      ...(source.buckets === undefined ? {} : { buckets: source.buckets }),
      message: null,
    })),
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
    scanDurationMs: 1,
  };
}

function environment(id: string, usageSummary: UsageSummary): EnvironmentUsage {
  return { environmentId: id as EnvironmentId, label: id, summary: usageSummary };
}

describe("mergeUsage", () => {
  it("preserves known usage across future provider and pricing variants", () => {
    const known = bucket();
    const current = summary(
      [known],
      [
        {
          provider: "claude",
          hostId: "mac",
          homePath: "/a",
          buckets: [known],
        },
      ],
    );
    const decoded = decodeSummary({
      ...current,
      buckets: [
        known,
        { ...known, provider: "future-provider" },
        { ...known, costSource: "future-pricing" },
      ],
      sources: [
        { ...current.sources[0], buckets: [known, { ...known, provider: "future-provider" }] },
        {
          ...current.sources[0],
          fingerprint: { ...current.sources[0]?.fingerprint, provider: "future-provider" },
        },
      ],
    });
    expect(decoded).toEqual(current);
    expect(mergeUsage([environment("env-a", decoded)], USAGE_CONTRACT_VERSION).costUsd).toBe(10);
    expect(encodeSummary(current)).toEqual(current);
  });

  it("rejects malformed known usage and malformed summary envelopes", () => {
    const known = bucket();
    const current = summary(
      [known],
      [
        {
          provider: "claude",
          hostId: "mac",
          homePath: "/a",
          buckets: [known],
        },
      ],
    );
    expect(() => decodeSummary({ ...current, buckets: [{ ...known, costUsd: "bad" }] })).toThrow();
    expect(() =>
      decodeSummary({ ...current, sources: [{ ...current.sources[0], scannedFiles: "bad" }] }),
    ).toThrow();
    expect(() =>
      decodeSummary({
        ...current,
        sources: [{ ...current.sources[0], buckets: [{ ...known, costUsd: "bad" }] }],
      }),
    ).toThrow();
    expect(() => decodeSummary({ ...current, buckets: null })).toThrow();
  });

  it("excludes a future incompatible contract after decoding its known buckets", () => {
    const current = summary(
      [bucket()],
      [{ provider: "claude", hostId: "mac", homePath: "/a" }],
      USAGE_CONTRACT_VERSION + 1,
    );
    const decoded = decodeSummary(current);
    const merged = mergeUsage([environment("env-a", decoded)], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(0);
    expect(merged.contractMismatches).toEqual([
      {
        environmentId: "env-a",
        direction: "clientBehind",
        contractVersion: USAGE_CONTRACT_VERSION + 1,
      },
    ]);
  });

  it("keeps unique older homes while taking a newer shared-home scan", () => {
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/shared" };
    const old = summary(
      [bucket({ costUsd: 10 })],
      [
        { ...shared, buckets: [bucket({ costUsd: 4 })] },
        { ...shared, homePath: "/unique-a", buckets: [bucket({ costUsd: 6 })] },
      ],
    );
    const latest = summary(
      [bucket({ costUsd: 16 })],
      [
        { ...shared, buckets: [bucket({ costUsd: 5 })] },
        { ...shared, homePath: "/unique-b", buckets: [bucket({ costUsd: 11 })] },
      ],
    );
    const merged = mergeUsage(
      [
        environment("env-a", { ...old, readAt: "2026-08-07T00:00:00.000Z" }),
        environment("env-b", { ...latest, readAt: "2026-08-08T00:00:00.000Z" }),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(22);
    // env-a's unique home is kept while its shared home goes to env-b.
    expect(merged.approximateEnvironments).toEqual(["env-a"]);
  });

  it("counts overlapping Claude homes once while retaining both unique homes", () => {
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/shared" };
    const uniqueA = { provider: "claude" as const, hostId: "mac", homePath: "/unique-a" };
    const uniqueB = { provider: "claude" as const, hostId: "mac", homePath: "/unique-b" };
    const four = bucket({ costUsd: 4, records: 1 });
    const six = bucket({ costUsd: 6, records: 1 });
    const eleven = bucket({ costUsd: 11, records: 1 });
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ costUsd: 10, records: 2 })],
            [
              { ...shared, buckets: [four] },
              { ...uniqueA, buckets: [six] },
            ],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 15, records: 2 })],
            [
              { ...shared, buckets: [four] },
              { ...uniqueB, buckets: [eleven] },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(21);
    expect(merged.records).toBe(3);
    expect(merged.sessions).toBe(3);
    expect(merged.duplicateSources).toHaveLength(1);
    // env-b's unique home is kept while its shared home goes to env-a.
    expect(merged.approximateEnvironments).toEqual(["env-b"]);
  });

  it("does not collapse identical paths on different hosts or filesystems", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/same" };
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket({ costUsd: 4 })], [{ ...source, buckets: [bucket({ costUsd: 4 })] }]),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 6 })],
            [{ ...source, hostId: "other", buckets: [bucket({ costUsd: 6 })] }],
          ),
        ),
        environment(
          "env-c",
          summary(
            [bucket({ costUsd: 11 })],
            [{ ...source, volumeId: "moved-volume", buckets: [bucket({ costUsd: 11 })] }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(21);
    expect(merged.duplicateSources).toEqual([]);
  });

  it("keeps unknown filesystem identities separate and reports uncertain overlap", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/same" };
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ costUsd: 4 })],
            [{ ...source, volumeId: "", buckets: [bucket({ costUsd: 4 })] }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 6 })],
            [{ ...source, volumeId: "vol-mac", buckets: [bucket({ costUsd: 6 })] }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.duplicateSources).toEqual([]);
    expect(merged.approximateEnvironments).toEqual(["env-a", "env-b"]);
  });

  it("marks legacy mixed-home totals approximate without dropping their unique usage", () => {
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/shared" };
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          // A unique home keeps env-b's homes from containing env-a's.
          summary(
            [bucket({ costUsd: 6 })],
            [
              { ...shared, buckets: [bucket({ costUsd: 4 })] },
              { ...shared, homePath: "/unique-a", buckets: [bucket({ costUsd: 2 })] },
            ],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 15 })],
            [shared, { ...shared, homePath: "/unique-b" }],
            USAGE_CONTRACT_VERSION - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(21);
    expect(merged.approximateEnvironments).toEqual(["env-b"]);
    expect(merged.contractMismatches).toEqual([]);
  });

  it("falls back to flat provider totals when a source claims buckets for another provider", () => {
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/shared" };
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          // A unique home keeps env-b's homes from containing env-a's.
          summary(
            [bucket({ costUsd: 6 })],
            [
              { ...shared, buckets: [bucket({ costUsd: 4 })] },
              { ...shared, homePath: "/unique-a", buckets: [bucket({ costUsd: 2 })] },
            ],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 15 })],
            [
              { ...shared, buckets: [bucket({ provider: "codex", costUsd: 4 })] },
              { ...shared, homePath: "/unique-b", buckets: [bucket({ costUsd: 11 })] },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(21);
    expect(merged.providers.map((provider) => provider.provider)).toEqual(["claude"]);
    expect(merged.approximateEnvironments).toEqual(["env-b"]);
  });

  it("sums environments that read different transcript directories", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }]),
        ),
        environment(
          "env-b",
          summary([bucket()], [{ provider: "claude", hostId: "linux", homePath: "/b/.claude" }]),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.records).toBe(10);
    expect(merged.duplicateSources).toHaveLength(0);
  });

  it("counts a shared transcript directory once", () => {
    // Two worktree servers on one machine resolve the same provider home.
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [shared])),
        environment("env-b", summary([bucket()], [shared])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.records).toBe(5);
    expect(merged.sessions).toBe(1);
    expect(merged.duplicateSources).toHaveLength(1);
    expect(merged.contributingEnvironments).toEqual(["env-a"]);
  });

  it("drops only the duplicated provider, keeping the environment's other one", () => {
    const sharedClaude = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/home/theo/.claude",
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [sharedClaude])),
        environment(
          "env-b",
          summary(
            [bucket(), bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 4 })],
            [sharedClaude, { provider: "codex", hostId: "mac", homePath: "/home/theo/.codex" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    // env-b's claude bucket is dropped, its codex bucket survives.
    expect(merged.costUsd).toBe(14);
    expect(merged.providers.map((provider) => provider.provider).sort()).toEqual([
      "claude",
      "codex",
    ]);
    expect(merged.sessions).toBe(2);
    expect(
      Object.fromEntries(
        merged.providers.map((provider) => [provider.provider, provider.sessions]),
      ),
    ).toEqual({ claude: 1, codex: 1 });
  });

  it("uses the newest scan when environments share the same transcript directory", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/home/theo/.claude" };
    const environments = [
      environment("env-a", summary([bucket({ costUsd: 4, records: 2 })], [source])),
      environment("env-b", {
        ...summary([bucket()], [source]),
        readAt: "2026-08-07T01:00:00.000Z",
      }),
    ];

    for (const ordered of [environments, environments.toReversed()]) {
      const merged = mergeUsage(ordered, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(10);
      expect(merged.records).toBe(5);
      expect(merged.sessions).toBe(1);
      expect(merged.contributingEnvironments).toEqual(["env-b"]);
      expect(merged.duplicateSources).toEqual(["env-a: /home/theo/.claude"]);
    }
  });

  it("uses stable environment ids for equal or invalid scan timestamps", () => {
    const source = { provider: "claude" as const, hostId: "mac", homePath: "/shared/.claude" };
    const invalid = environment("env-a", {
      ...summary([bucket({ costUsd: 4 })], [source]),
      readAt: "invalid",
    });
    const equallyNew = [
      environment("env-b", summary([bucket({ costUsd: 10 })], [source])),
      environment("env-c", summary([bucket({ costUsd: 20 })], [source])),
    ];
    for (const ordered of [[invalid, ...equallyNew], [...equallyNew, invalid].toReversed()]) {
      const merged = mergeUsage(ordered, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(10);
      expect(merged.contributingEnvironments).toEqual(["env-b"]);
    }
    const bothInvalid = mergeUsage(
      [
        environment("env-z", { ...summary([bucket({ costUsd: 9 })], [source]), readAt: "bad" }),
        invalid,
      ],
      USAGE_CONTRACT_VERSION,
    );
    expect(bothInvalid.costUsd).toBe(4);
    expect(bothInvalid.contributingEnvironments).toEqual(["env-a"]);
  });

  it("identifies an environment reporting an older contract version", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket()], [{ provider: "claude", hostId: "mac", homePath: "/a" }]),
        ),
        environment(
          "env-b",
          summary(
            [bucket()],
            [{ provider: "claude", hostId: "linux", homePath: "/b" }],
            USAGE_MERGE_COMPATIBLE_SINCE - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.contractMismatches).toEqual([
      {
        environmentId: "env-b",
        direction: "serverBehind",
        contractVersion: USAGE_MERGE_COMPATIBLE_SINCE - 1,
      },
    ]);
  });

  it("merges a v7 summary with an OpenCode v8 summary", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ costUsd: 10, provider: "opencode", model: "openai/gpt-6" })],
            [{ provider: "opencode", hostId: "mac", homePath: "/a" }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 4, provider: "codex", model: "gpt-5.6-sol" })],
            [{ provider: "codex", hostId: "linux", homePath: "/b" }],
            7,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(14);
    expect(merged.contractMismatches).toEqual([]);
  });

  it("derives provider shares and cost quality", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ costUsd: 75 }),
              bucket({ provider: "codex", model: "gpt-5.6-sol", costUsd: 25, unpricedRecords: 5 }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.providers[0]?.provider).toBe("claude");
    expect(merged.providers[0]?.costShare).toBeCloseTo(0.75, 5);
    expect(merged.costQuality.unpricedShare).toBeCloseTo(0.5, 5);
    expect(merged.costQuality.cacheSavingsUsd).toBe(4);
  });

  it("marks a model with no known rates as unpriced rather than free", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ costUsd: 75 }),
              bucket({
                provider: "codex",
                model: "unknown-model",
                costUsd: 0,
                costSource: "unpriced",
                unpricedRecords: 5,
              }),
            ],
            [
              { provider: "claude", hostId: "mac", homePath: "/a/.claude" },
              { provider: "codex", hostId: "mac", homePath: "/a/.codex" },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.models.find((model) => model.model === "unknown-model")?.unpricedRecords).toBe(5);
    expect(merged.models.filter(isModelCostUnknown).map((model) => model.model)).toEqual([
      "unknown-model",
    ]);
  });

  it("keeps two machines apart when hostname and home path collide", () => {
    // Every Mac resolves /Users/theo/.claude, so a hostname clash used to make
    // one machine's usage vanish. Filesystem identity separates them.
    const shape = { provider: "claude" as const, hostId: "mac", homePath: "/Users/theo/.claude" };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [{ ...shape, volumeId: "16777220:1234" }])),
        environment("env-b", summary([bucket()], [{ ...shape, volumeId: "16777221:9999" }])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(20);
    expect(merged.duplicateSources).toHaveLength(0);
  });

  it("still collapses two servers reading the same directory", () => {
    const same = {
      provider: "claude" as const,
      hostId: "mac",
      homePath: "/Users/theo/.claude",
      volumeId: "16777220:1234",
    };
    const merged = mergeUsage(
      [
        environment("env-a", summary([bucket()], [same])),
        environment("env-b", summary([bucket()], [same])),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(10);
    expect(merged.duplicateSources).toHaveLength(1);
  });

  it("totals sessions from per-directory distinct counts, not per-bucket sums", () => {
    // One session that spans two days appears in two buckets. Summing bucket
    // sessions would say 2; the source's distinct count says 1.
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ day: "2026-08-06" as UsageDay }), bucket({ day: "2026-08-07" as UsageDay })],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/a/.claude",
                distinctSessions: 1,
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.sessions).toBe(1);
    expect(merged.providers[0]?.sessions).toBe(1);
  });

  it("returns empty totals with no environments", () => {
    const merged = mergeUsage([], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(0);
    expect(merged.daily).toHaveLength(0);
    expect(merged.hourly).toHaveLength(0);
  });

  it("omits providers with no sessions or usage", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [],
            [
              {
                provider: "claude",
                hostId: "mac",
                homePath: "/a/.claude",
                distinctSessions: 0,
              },
            ],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.providers).toEqual([]);
  });

  it("derives hourly totals without losing the daily rollup", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [
              bucket({ hourStart: "2026-08-07T09:37:00.000Z", costUsd: 3 }),
              bucket({ hourStart: "2026-08-07T10:37:00.000Z", costUsd: 7 }),
            ],
            [{ provider: "claude", hostId: "mac", homePath: "/a/.claude" }],
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.hourly.map((hour) => [hour.hourStart, hour.costUsd])).toEqual([
      ["2026-08-07T09:37:00.000Z", 3],
      ["2026-08-07T10:37:00.000Z", 7],
    ]);
    expect(merged.daily).toHaveLength(1);
    expect(merged.daily[0]?.costUsd).toBe(10);
  });

  it("merges across mixed contract versions compatible back to v4", () => {
    const v4Summary = summary(
      [bucket({ provider: "claude", model: "claude-3-5-sonnet", costUsd: 4 })],
      [{ provider: "claude", hostId: "host-v4", homePath: "/v4/.claude" }],
      4,
    );
    const v5Summary = summary(
      [bucket({ provider: "codex", model: "codex-preview", costUsd: 5 })],
      [{ provider: "codex", hostId: "host-v5", homePath: "/v5/.codex" }],
      5,
    );
    const v6Summary = summary(
      [bucket({ provider: "antigravity", model: "gemini-3.8-flash", costUsd: 6 })],
      [{ provider: "antigravity", hostId: "host-v6", homePath: "/v6/antigravity" }],
      6,
    );

    const merged = mergeUsage(
      [
        environment("env-v4", v4Summary),
        environment("env-v5", v5Summary),
        environment("env-v6", v6Summary),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(15);
    expect(merged.contractMismatches).toEqual([]);
    expect(merged.contributingEnvironments).toEqual(["env-v4", "env-v5", "env-v6"]);
  });
});

describe("complete and partial usage scans", () => {
  const shared = { provider: "claude" as const, hostId: "mac", homePath: "/shared" };
  function scan(
    id: string,
    buckets: readonly UsageBucket[],
    status: "ok" | "partial" | "failed",
    readAt: string,
    attributed = true,
    distinctSessions = 1,
  ) {
    const reading = summary(buckets, [
      { ...shared, distinctSessions, ...(attributed ? { buckets } : {}) },
    ]);
    return environment(id, {
      ...reading,
      readAt,
      sources: reading.sources.map((source) => ({ ...source, status })),
    });
  }
  const oldTime = "2026-08-07T00:00:00.000Z";
  const newTime = "2026-08-08T00:00:00.000Z";
  function orders(...readings: EnvironmentUsage[]) {
    return [readings, readings.toReversed()];
  }
  it.each([false, true])(
    "retains complete cells over a newer partial or failed scan (attributed=%s)",
    (attributed) => {
      const complete = scan("old", [bucket()], "ok", oldTime, attributed);
      for (const status of ["partial", "failed"] as const) {
        const incomplete = scan(
          "new",
          [bucket({ costUsd: 4, records: 6 })],
          status,
          newTime,
          attributed,
          2,
        );
        for (const readings of orders(complete, incomplete)) {
          const merged = mergeUsage(readings, USAGE_CONTRACT_VERSION);
          expect(merged.costUsd).toBe(10);
          expect(merged.records).toBe(5);
          expect(merged.totalTokens).toBe(1160);
          expect(merged.sessions).toBe(1);
          expect(merged.contributingEnvironments).toEqual(["old"]);
          expect(merged.duplicateSources).toEqual(["new: /shared"]);
        }
      }
    },
  );
  it.each([false, true])(
    "adds only new day, hour and model cells from newer partial scans (attributed=%s)",
    (attributed) => {
      const original = bucket({ hourStart: "2026-08-07T00:00:00.000Z" });
      const day = bucket({
        day: "2026-08-08" as UsageDay,
        hourStart: "2026-08-08T00:00:00.000Z",
        costUsd: 3,
        records: 1,
      });
      const hour = bucket({ hourStart: "2026-08-07T01:00:00.000Z", costUsd: 2, records: 1 });
      const model = bucket({
        hourStart: original.hourStart,
        model: "claude-other",
        costUsd: 1,
        records: 1,
      });
      const complete = scan("old", [original], "ok", oldTime, attributed);
      const partial = scan(
        "new",
        [{ ...original, costUsd: 4 }, day, hour, model],
        "partial",
        newTime,
        attributed,
        3,
      );
      for (const readings of orders(complete, partial)) {
        const merged = mergeUsage(readings, USAGE_CONTRACT_VERSION);
        expect(merged.costUsd).toBe(16);
        expect(merged.records).toBe(8);
        expect(merged.sessions).toBe(3);
        expect(merged.providers[0]?.sessions).toBe(3);
        expect(merged.daily.map(({ day, costUsd }) => [day, costUsd])).toEqual([
          ["2026-08-07", 13],
          ["2026-08-08", 3],
        ]);
        expect(merged.hourly.map(({ hourStart, costUsd }) => [hourStart, costUsd])).toEqual([
          [original.hourStart, 11],
          [hour.hourStart, 2],
          [day.hourStart, 3],
        ]);
        expect(merged.contributingEnvironments).toEqual(
          readings.map(({ environmentId }) => environmentId),
        );
        expect(merged.duplicateSources).toEqual(["new: /shared"]);
      }
    },
  );
  it("retains complete priority without supplementing when its scan time is unknown", () => {
    const complete = scan("complete", [bucket()], "ok", "invalid");
    const partial = scan(
      "partial",
      [bucket({ day: "2026-08-08" as UsageDay, costUsd: 3 })],
      "partial",
      newTime,
    );
    for (const readings of orders(complete, partial)) {
      expect(mergeUsage(readings, USAGE_CONTRACT_VERSION).costUsd).toBe(10);
    }
  });
  it("takes each supplemental cell from the newest partial scan once", () => {
    const old = scan("old", [bucket()], "ok", oldTime);
    const cell = bucket({ day: "2026-08-08" as UsageDay, costUsd: 3, records: 1 });
    const middle = scan("middle", [cell], "partial", "2026-08-08T00:00:00.000Z", true, 2);
    const newest = scan(
      "newest",
      [{ ...cell, costUsd: 5 }],
      "partial",
      "2026-08-08T01:00:00.000Z",
      true,
      3,
    );
    for (const readings of orders(old, middle, newest)) {
      const merged = mergeUsage(readings, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(15);
      expect(merged.sessions).toBe(3);
      expect(merged.contributingEnvironments).toEqual(
        readings.filter((entry) => entry !== middle).map(({ environmentId }) => environmentId),
      );
    }
  });
  it.each([
    { status: "partial" as const, time: oldTime },
    { status: "partial" as const, time: "2026-08-06T00:00:00.000Z" },
    { status: "partial" as const, time: "invalid" },
    { status: "failed" as const, time: newTime },
  ])("does not supplement unproven new usage from $status at $time", ({ status, time }) => {
    const complete = scan("complete", [bucket()], "ok", oldTime);
    const other = scan(
      "other",
      [bucket({ day: "2026-08-08" as UsageDay, costUsd: 3 })],
      status,
      time,
      true,
      2,
    );
    for (const readings of orders(complete, other)) {
      expect(mergeUsage(readings, USAGE_CONTRACT_VERSION).costUsd).toBe(10);
      expect(mergeUsage(readings, USAGE_CONTRACT_VERSION).sessions).toBe(1);
    }
  });
  it("retains a partial scan when no complete scan is available and restores complete priority later", () => {
    const partial = scan("partial", [bucket({ costUsd: 4 })], "partial", oldTime);
    const failed = scan("failed", [], "failed", newTime);
    const complete = scan("complete", [bucket()], "ok", newTime);
    expect(mergeUsage([partial], USAGE_CONTRACT_VERSION).costUsd).toBe(4);
    expect(mergeUsage([failed, partial], USAGE_CONTRACT_VERSION).costUsd).toBe(4);
    expect(mergeUsage([failed, partial, complete], USAGE_CONTRACT_VERSION).costUsd).toBe(10);
    expect(mergeUsage([failed], USAGE_CONTRACT_VERSION).costUsd).toBe(0);
  });
  it("supplements the shared home while retaining each host's unique attributed home", () => {
    const original = bucket();
    const extra = bucket({ day: "2026-08-08" as UsageDay, costUsd: 3, records: 1 });
    const first = summary(
      [bucket({ costUsd: 12 })],
      [
        { ...shared, buckets: [original] },
        { ...shared, homePath: "/unique-a", buckets: [bucket({ costUsd: 2 })] },
      ],
    );
    const second = summary(
      [bucket({ costUsd: 9 })],
      [
        { ...shared, distinctSessions: 2, buckets: [{ ...original, costUsd: 1 }, extra] },
        { ...shared, homePath: "/unique-b", buckets: [bucket({ costUsd: 5 })] },
      ],
    );
    const complete = environment("a", { ...first, readAt: oldTime });
    const partial = environment("b", {
      ...second,
      readAt: newTime,
      sources: second.sources.map((source) => ({ ...source, status: "partial" as const })),
    });
    for (const readings of orders(complete, partial)) {
      const merged = mergeUsage(readings, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(20);
      expect(merged.sessions).toBe(4);
      // b's unique home is kept while its shared home goes to a.
      expect(merged.approximateEnvironments).toEqual(["b"]);
    }
  });
  it("does not invent source attribution for legacy multi-home totals", () => {
    const complete = scan("old", [bucket()], "ok", oldTime);
    const reading = summary(
      [bucket({ day: "2026-08-08" as UsageDay, costUsd: 3 })],
      [shared, { ...shared, homePath: "/unique-b" }],
      USAGE_MERGE_COMPATIBLE_SINCE,
    );
    const legacy = environment("legacy", {
      ...reading,
      readAt: newTime,
      sources: reading.sources.map((source) => ({ ...source, status: "partial" as const })),
    });
    const merged = mergeUsage([complete, legacy], USAGE_CONTRACT_VERSION);
    expect(merged.costUsd).toBe(13);
    expect(merged.approximateEnvironments).toEqual(["legacy"]);
    expect(merged.sessions).toBe(2);
  });
  it("keeps one owner for a provider's homes when a newer scan attributes a record elsewhere", () => {
    // Both servers dedupe one record found in D1 and D2. The complete scan
    // attributes it to D1; the newer scan could not read D1 and attributes it
    // to D2. Splitting D1 and D2 between them would count it twice.
    const record = bucket();
    const later = bucket({ day: "2026-08-08" as UsageDay, costUsd: 3, records: 1 });
    const complete = summary(
      [record],
      [
        { ...shared, homePath: "/d1", buckets: [record] },
        { ...shared, homePath: "/d2", buckets: [] },
      ],
    );
    const newer = summary(
      [record, later],
      [
        { ...shared, homePath: "/d1", buckets: [] },
        { ...shared, homePath: "/d2", distinctSessions: 2, buckets: [record, later] },
      ],
    );
    const readings = orders(
      environment("complete", { ...complete, readAt: oldTime }),
      environment("newer", {
        ...newer,
        readAt: newTime,
        sources: newer.sources.map((source) =>
          source.fingerprint.resolvedHomePath === "/d1"
            ? { ...source, status: "partial" as const }
            : source,
        ),
      }),
    );
    for (const environments of readings) {
      const merged = mergeUsage(environments, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(13);
      expect(merged.records).toBe(6);
      expect(merged.daily.map(({ day, costUsd }) => [day, costUsd])).toEqual([
        ["2026-08-07", 10],
        ["2026-08-08", 3],
      ]);
      expect(merged.approximateEnvironments).toEqual([]);
      expect(merged.duplicateSources).toEqual(["newer: /d1", "newer: /d2"]);
    }
  });
  it("keeps a legacy complete multi-home total exact against a newer partial scan", () => {
    const legacy = summary(
      [bucket({ costUsd: 15 })],
      [
        { ...shared, homePath: "/d1" },
        { ...shared, homePath: "/d2" },
      ],
      USAGE_MERGE_COMPATIBLE_SINCE,
    );
    const current = summary(
      [bucket({ costUsd: 15 })],
      [
        { ...shared, homePath: "/d1", buckets: [bucket({ costUsd: 10 })] },
        { ...shared, homePath: "/d2", buckets: [bucket({ costUsd: 5 })] },
      ],
    );
    for (const environments of orders(
      environment("legacy", { ...legacy, readAt: oldTime }),
      environment("current", {
        ...current,
        readAt: newTime,
        sources: current.sources.map((source) =>
          source.fingerprint.resolvedHomePath === "/d1"
            ? { ...source, status: "partial" as const }
            : source,
        ),
      }),
    )) {
      const merged = mergeUsage(environments, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(15);
      expect(merged.approximateEnvironments).toEqual([]);
      expect(merged.contributingEnvironments).toEqual(["legacy"]);
    }
  });
  it("does not let an unshared failed home demote a scan's shared homes", () => {
    const complete = summary(
      [bucket({ costUsd: 15 })],
      [
        { ...shared, homePath: "/d1", buckets: [bucket({ costUsd: 10 })] },
        { ...shared, homePath: "/d2", buckets: [bucket({ costUsd: 5 })] },
        { ...shared, homePath: "/d3", buckets: [] },
      ],
    );
    const partial = summary(
      [bucket({ costUsd: 4 })],
      [{ ...shared, homePath: "/d1", buckets: [bucket({ costUsd: 4 })] }],
    );
    for (const [completeAt, partialAt] of [
      [newTime, oldTime],
      [oldTime, newTime],
    ] as const) {
      for (const environments of orders(
        environment("a", {
          ...complete,
          readAt: completeAt,
          sources: complete.sources.map((source) =>
            source.fingerprint.resolvedHomePath === "/d3"
              ? { ...source, status: "failed" as const }
              : source,
          ),
        }),
        environment("b", {
          ...partial,
          readAt: partialAt,
          sources: partial.sources.map((source) => ({ ...source, status: "partial" as const })),
        }),
      )) {
        const merged = mergeUsage(environments, USAGE_CONTRACT_VERSION);
        expect(merged.costUsd).toBe(15);
        expect(merged.contributingEnvironments).toEqual(["a"]);
        expect(merged.approximateEnvironments).toEqual([]);
      }
    }
  });
  it("flags scans whose homes are split between owners", () => {
    const record = bucket();
    const d1 = { ...shared, homePath: "/d1" };
    const d2 = { ...shared, homePath: "/d2" };
    const d3 = { ...shared, homePath: "/d3" };
    // Record R exists in D1 and D3; each server credits it to a different home.
    const a = environment("a", {
      ...summary(
        [record],
        [
          { ...d1, buckets: [record] },
          { ...d2, buckets: [] },
        ],
      ),
      readAt: "2026-08-09T00:00:00.000Z",
    });
    const b = environment("b", {
      ...summary(
        [record],
        [
          { ...d2, buckets: [] },
          { ...d3, buckets: [record] },
        ],
      ),
      readAt: newTime,
    });
    const c = environment("c", {
      ...summary(
        [record],
        [
          { ...d1, buckets: [record] },
          { ...d3, buckets: [] },
        ],
      ),
      readAt: oldTime,
    });
    for (const environments of orders(a, b, c)) {
      const merged = mergeUsage(environments, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(20);
      expect([...merged.approximateEnvironments].sort()).toEqual(["b", "c"]);
    }
    for (const environments of orders(a, b)) {
      const merged = mergeUsage(environments, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(20);
      expect(merged.approximateEnvironments).toEqual(["b"]);
    }
  });
  it("lets a scan of a superset of homes own them all regardless of scan order", () => {
    const desktop = summary([bucket()], [{ ...shared, homePath: "/.claude", buckets: [bucket()] }]);
    const dev = summary(
      [bucket({ costUsd: 13 })],
      [
        { ...shared, homePath: "/.claude", buckets: [bucket()] },
        { ...shared, homePath: "/.claude-alt", buckets: [bucket({ costUsd: 3 })] },
      ],
    );
    for (const [desktopAt, devAt] of [
      [newTime, oldTime],
      [oldTime, newTime],
    ] as const) {
      for (const environments of orders(
        environment("desktop", { ...desktop, readAt: desktopAt }),
        environment("dev", { ...dev, readAt: devAt }),
      )) {
        const merged = mergeUsage(environments, USAGE_CONTRACT_VERSION);
        expect(merged.costUsd).toBe(13);
        expect(merged.contributingEnvironments).toEqual(["dev"]);
        expect(merged.duplicateSources).toEqual(["desktop: /.claude"]);
        expect(merged.approximateEnvironments).toEqual([]);
      }
    }
    // A legacy provider-wide total over a superset of homes stays exact.
    const legacy = summary(
      [bucket({ costUsd: 13 })],
      [
        { ...shared, homePath: "/.claude" },
        { ...shared, homePath: "/.claude-alt" },
      ],
      USAGE_MERGE_COMPATIBLE_SINCE,
    );
    for (const environments of orders(
      environment("desktop", { ...desktop, readAt: newTime }),
      environment("legacy", { ...legacy, readAt: oldTime }),
    )) {
      const merged = mergeUsage(environments, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(13);
      expect(merged.approximateEnvironments).toEqual([]);
    }
    // Neither home set contains the other, so the split stays flagged.
    const other = summary(
      [bucket({ costUsd: 12 })],
      [
        { ...shared, homePath: "/.claude", buckets: [bucket()] },
        { ...shared, homePath: "/.claude-other", buckets: [bucket({ costUsd: 2 })] },
      ],
    );
    for (const environments of orders(
      environment("other", { ...other, readAt: newTime }),
      environment("dev", { ...dev, readAt: oldTime }),
    )) {
      const merged = mergeUsage(environments, USAGE_CONTRACT_VERSION);
      expect(merged.costUsd).toBe(15);
      expect(merged.approximateEnvironments).toEqual(["dev"]);
    }
  });
});
