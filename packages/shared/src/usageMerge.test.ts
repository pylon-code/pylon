import {
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isModelCostUnknown, mergeUsage, type EnvironmentUsage } from "./usageMerge.ts";

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
    expect(merged.approximateEnvironments).toEqual([]);
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
    expect(merged.approximateEnvironments).toEqual([]);
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
          summary([bucket({ costUsd: 4 })], [{ ...shared, buckets: [bucket({ costUsd: 4 })] }]),
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

    expect(merged.costUsd).toBe(19);
    expect(merged.approximateEnvironments).toEqual(["env-b"]);
    expect(merged.staleEnvironments).toEqual([]);
  });

  it("falls back to flat provider totals when a source claims buckets for another provider", () => {
    const shared = { provider: "claude" as const, hostId: "mac", homePath: "/shared" };
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary([bucket({ costUsd: 4 })], [{ ...shared, buckets: [bucket({ costUsd: 4 })] }]),
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

    expect(merged.costUsd).toBe(19);
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

  it("excludes an environment reporting an older contract version", () => {
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
    expect(merged.staleEnvironments).toEqual(["env-b"]);
  });

  it("keeps the previous compatible contract version so additive provider expansions still merge", () => {
    const merged = mergeUsage(
      [
        environment(
          "env-a",
          summary(
            [bucket({ costUsd: 10 })],
            [{ provider: "claude", hostId: "mac", homePath: "/a" }],
          ),
        ),
        environment(
          "env-b",
          summary(
            [bucket({ costUsd: 4, provider: "codex", model: "gpt-5.6-sol" })],
            [{ provider: "codex", hostId: "linux", homePath: "/b" }],
            USAGE_CONTRACT_VERSION - 1,
          ),
        ),
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(merged.costUsd).toBe(14);
    expect(merged.staleEnvironments).toEqual([]);
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
    expect(merged.staleEnvironments).toEqual([]);
    expect(merged.contributingEnvironments).toEqual(["env-v4", "env-v5", "env-v6"]);
  });
});
