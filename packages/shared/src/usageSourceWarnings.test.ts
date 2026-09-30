import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  type UsageSource,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { collectUsageSourceWarnings } from "./usageFormat.ts";

function source(
  status: UsageSource["status"],
  message: string | null,
  provider: UsageSource["fingerprint"]["provider"] = "opencode",
): UsageSource {
  return {
    fingerprint: { hostId: "host", provider, resolvedHomePath: "/source", volumeId: "volume" },
    status,
    scannedFiles: 1,
    skippedFiles: 0,
    malformedRecords: 0,
    distinctSessions: 0,
    message,
  };
}
function environment(
  id: string,
  sources: readonly UsageSource[],
  contractVersion: UsageSummary["contractVersion"] = USAGE_CONTRACT_VERSION,
) {
  const summary: UsageSummary = {
    contractVersion,
    readAt: "2026-08-11T12:37:00Z",
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-08-10"),
    untilDay: UsageDay.make("2026-08-11"),
    buckets: [],
    sources,
    pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
  };
  return { environmentId: EnvironmentId.make(id), label: id, summary };
}
describe("usage source scan warnings", () => {
  it("reports partial and failed history without warning for healthy or absent providers", () => {
    const warnings = collectUsageSourceWarnings([
      environment("desktop", [
        source("ok", "Stale warning"),
        source("missing", "Not installed"),
        source("partial", "File limit reached"),
        source("failed", "Database unavailable"),
      ]),
    ]);
    expect(warnings.map((warning) => warning.message)).toEqual([
      "File limit reached",
      "Database unavailable",
    ]);
    expect(warnings[0]).toMatchObject({
      environmentId: "desktop",
      environmentLabel: "desktop",
      provider: "opencode",
    });
  });
  it("deduplicates repeated source problems within a provider while keeping hosts and providers distinct", () => {
    const repeated = [
      source("partial", "Same problem"),
      source("partial", "Same problem"),
      source("failed", "Same problem", "codex"),
    ];
    const warnings = collectUsageSourceWarnings([
      environment("desktop", repeated),
      environment("remote", repeated),
    ]);
    expect(warnings).toHaveLength(4);
    expect(new Set(warnings.map((warning) => warning.key)).size).toBe(4);
    expect(warnings.map((warning) => warning.environmentLabel)).toEqual([
      "desktop",
      "desktop",
      "remote",
      "remote",
    ]);
  });
  it("honors compatible older summaries and excludes missing or incompatible summaries", () => {
    const sources = [source("partial", "Partial scan")];
    expect(
      collectUsageSourceWarnings([
        environment("compatible", sources, USAGE_MERGE_COMPATIBLE_SINCE),
        environment("old", sources, USAGE_MERGE_COMPATIBLE_SINCE - 1),
        environment("future", sources, USAGE_CONTRACT_VERSION + 1),
        { environmentId: EnvironmentId.make("pending"), label: "pending", summary: null },
      ]).map((warning) => warning.environmentLabel),
    ).toEqual(["compatible"]);
  });
  it("describes failures without details and leaves immutable source data unchanged", () => {
    const sources = Object.freeze([
      Object.freeze(source("partial", null)),
      Object.freeze(source("failed", null)),
    ]);
    const warnings = collectUsageSourceWarnings([environment("desktop", sources)]);
    expect(warnings.map((warning) => warning.message)).toEqual([
      "This history scan is incomplete.",
      "This history scan could not report usage.",
    ]);
    expect(sources.map((source) => source.message)).toEqual([null, null]);
  });
});
