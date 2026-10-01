/**
 * Merges per-environment usage summaries into the single view the page renders.
 *
 * Pure, so the de-duplication and derivation rules can be tested without a
 * connected environment.
 *
 * @module usageMerge
 */
import {
  USAGE_MERGE_COMPATIBLE_SINCE,
  type EnvironmentId,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSource,
  type UsageSourceFingerprint,
  type UsageSummary,
} from "@t3tools/contracts";

export interface EnvironmentUsage {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly summary: UsageSummary;
}

export interface ProviderTotals {
  readonly provider: UsageProviderKind;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly sessions: number;
  readonly costShare: number;
  readonly tokenShare: number;
}

export interface ModelTotals {
  readonly model: string;
  readonly provider: UsageProviderKind;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  /**
   * Records whose tokens are counted here but which contributed nothing to
   * `costUsd`. When it equals `records` the cost is unknown, not zero.
   */
  readonly unpricedRecords: number;
  readonly costShare: number;
}

/**
 * A model whose every record lacked rates has an unknown cost, not a zero one.
 * Clients must not present its `costUsd` as a real dollar figure.
 */
export function isModelCostUnknown(model: ModelTotals): boolean {
  return model.records > 0 && model.unpricedRecords >= model.records;
}

export interface DailyTotals {
  readonly day: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>;
}

export interface HourlyTotals {
  readonly day: string;
  readonly hourStart: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>;
}

export interface CostQuality {
  readonly providerReportedShare: number;
  readonly modelPricedShare: number;
  readonly unpricedShare: number;
  readonly cacheSavingsUsd: number;
}

export interface UsageContractMismatch {
  readonly environmentId: EnvironmentId;
  readonly direction: "serverBehind" | "clientBehind";
  readonly contractVersion: number;
}

export interface MergedUsage {
  readonly costUsd: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly sessions: number;
  readonly providers: readonly ProviderTotals[];
  readonly models: readonly ModelTotals[];
  readonly daily: readonly DailyTotals[];
  readonly hourly: readonly HourlyTotals[];
  readonly costQuality: CostQuality;
  /** Environments whose data was dropped as a duplicate of another's. */
  readonly duplicateSources: readonly string[];
  readonly contributingEnvironments: readonly EnvironmentId[];
  readonly contractMismatches: readonly UsageContractMismatch[];
  /** Legacy mixed homes or unknown filesystem identities prevent exact attribution. */
  readonly approximateEnvironments: readonly EnvironmentId[];
}

/**
 * Two sources are the same physical transcript directory only when host,
 * provider, path and filesystem identity all agree.
 *
 * `volumeId` is what stops two machines that happen to share a hostname and a
 * home path, which is every Mac in a fleet, from collapsing into one source and
 * having one of them silently dropped.
 */
function fingerprintKey(fingerprint: UsageSourceFingerprint, environmentId: EnvironmentId): string {
  return JSON.stringify([
    fingerprint.hostId,
    fingerprint.provider,
    fingerprint.resolvedHomePath,
    fingerprint.volumeId,
    // An unreadable filesystem identity cannot prove two remote environments
    // see the same directory, even if their hostnames and paths match.
    fingerprint.volumeId === "" ? environmentId : "",
  ]);
}

/** One environment's scan of every non-missing source for one provider. */
interface ProviderScan {
  readonly environment: EnvironmentUsage;
  readonly provider: UsageProviderKind;
  readonly sources: readonly UsageSource[];
  /**
   * The least complete status among sources another scan also reads: 0 ok,
   * 1 partial, 2 failed. A home no other scan reads cannot be split between
   * owners, so its status does not demote the scan's shared homes.
   */
  readonly rank: number;
  readonly readAt: number;
}

const STATUS_RANK = { ok: 0, partial: 1, failed: 2 } as const;

function hasSourceBuckets(sources: readonly UsageSource[]): boolean {
  return sources.every(
    (source) =>
      source.buckets !== undefined &&
      source.buckets.every((bucket) => bucket.provider === source.fingerprint.provider),
  );
}

function providerScans(environments: readonly EnvironmentUsage[]): ProviderScan[] {
  const readers = new Map<string, number>();
  for (const environment of environments) {
    const keys = new Set(
      environment.summary.sources
        .filter((source) => source.status !== "missing")
        .map((source) => fingerprintKey(source.fingerprint, environment.environmentId)),
    );
    for (const key of keys) readers.set(key, (readers.get(key) ?? 0) + 1);
  }
  const scans: ProviderScan[] = [];
  for (const environment of environments) {
    const sourcesByProvider = new Map<UsageProviderKind, UsageSource[]>();
    for (const source of environment.summary.sources) {
      if (source.status === "missing") continue;
      const sources = sourcesByProvider.get(source.fingerprint.provider) ?? [];
      sources.push(source);
      sourcesByProvider.set(source.fingerprint.provider, sources);
    }
    for (const [provider, sources] of sourcesByProvider) {
      scans.push({
        environment,
        provider,
        sources,
        rank: Math.max(
          0,
          ...sources.map((source) =>
            source.status === "missing" ||
            (readers.get(fingerprintKey(source.fingerprint, environment.environmentId)) ?? 0) < 2
              ? 0
              : STATUS_RANK[source.status],
          ),
        ),
        readAt: Date.parse(environment.summary.readAt),
      });
    }
  }
  return scans;
}

function newestFirst(a: ProviderScan, b: ProviderScan): number {
  return (
    (b.readAt || 0) - (a.readAt || 0) ||
    a.environment.environmentId.localeCompare(b.environment.environmentId)
  );
}

/**
 * Cells reported for `sources` of one provider scan, or undefined when the
 * scan cannot attribute them. A legacy provider-wide list covers all of the
 * provider's sources at once, so it is attributable only as a whole.
 */
function cellsFor(
  scan: ProviderScan,
  sources: readonly UsageSource[],
):
  | readonly {
      readonly sources: readonly UsageSource[];
      readonly buckets: readonly UsageBucket[];
    }[]
  | undefined {
  if (hasSourceBuckets(scan.sources)) {
    return sources.map((source) => ({ sources: [source], buckets: source.buckets ?? [] }));
  }
  if (sources.length !== scan.sources.length) return undefined;
  return [
    {
      sources,
      buckets: scan.environment.summary.buckets.filter(
        (bucket) => bucket.provider === scan.provider,
      ),
    },
  ];
}

/**
 * Identifies a usage cell. Model ids are compared verbatim, so two scans that
 * label one model differently produce distinct cells.
 */
function bucketKey(bucket: UsageBucket) {
  return JSON.stringify([bucket.day, bucket.hourStart ?? null, bucket.provider, bucket.model]);
}

/**
 * Orders ranked scans for claiming. Within a rank, a scan whose homes strictly
 * contain another's claims first, so the nested scan is a whole duplicate
 * rather than a split. Otherwise the ranked order holds. Strict containment
 * is acyclic, so some remaining scan is always uncontained.
 */
function claimOrder(
  scans: readonly ProviderScan[],
  keyOf: (scan: ProviderScan, source: UsageSource) => string,
): ProviderScan[] {
  const keys = new Map(
    scans.map((scan) => [scan, new Set(scan.sources.map((source) => keyOf(scan, source)))]),
  );
  const contains = (outer: ProviderScan, inner: ProviderScan) => {
    const outerKeys = keys.get(outer) ?? new Set<string>();
    const innerKeys = keys.get(inner) ?? new Set<string>();
    return (
      outer.rank === inner.rank &&
      outerKeys.size > innerKeys.size &&
      [...innerKeys].every((key) => outerKeys.has(key))
    );
  };
  const remaining = [...scans];
  const ordered: ProviderScan[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex(
      (scan) => !remaining.some((other) => other !== scan && contains(other, scan)),
    );
    ordered.push(...remaining.splice(Math.max(index, 0), 1));
  }
  return ordered;
}

/**
 * Decides which environment owns each physical transcript directory.
 *
 * Several environments on one machine (worktree servers, for instance) resolve
 * the same provider home and would otherwise double count every token.
 *
 * A server attributes a record found in several of its homes to the first one
 * it could read, so two scans of the same homes can attribute one record to
 * different homes. Ownership is therefore ranked per provider scan rather than
 * per home: a scan whose every shared home was read completely claims its
 * homes before any scan with a partial or failed shared home. Within a rank the
 * most recent scan wins, with environment ids breaking ties. Homes already
 * claimed are duplicates; unclaimed ones still go to the next scan. Within a
 * rank, a scan whose homes strictly contain another scan's homes claims first.
 *
 * Scans of identical or nested homes therefore have one owner. Scans of overlapping but
 * unequal homes cannot: keeping each scan's unique homes splits its shared
 * homes from them, and a record in both may be credited twice. Such scans are
 * reported as approximate rather than dropping their unique usage.
 *
 * A newer scan can then add cells absent from a complete scan that owns all of
 * its homes, provided every home of the newer scan is owned by that complete
 * scan or by the newer scan itself.
 */
function claimSources(environments: readonly EnvironmentUsage[]): {
  readonly ownerByFingerprint: ReadonlyMap<string, EnvironmentId>;
  readonly supplementalBucketsByEnvironment: ReadonlyMap<EnvironmentId, readonly UsageBucket[]>;
  readonly sessionsByFingerprint: ReadonlyMap<string, number>;
  readonly duplicates: readonly string[];
  readonly uncertainEnvironments: readonly EnvironmentId[];
} {
  const ownerByFingerprint = new Map<string, EnvironmentId>();
  const ownerScanByFingerprint = new Map<string, ProviderScan>();
  const supplementalBucketsByEnvironment = new Map<EnvironmentId, UsageBucket[]>();
  const sessionsByFingerprint = new Map<string, number>();
  const duplicates: string[] = [];
  const weakMatches = new Map<string, { environmentId: EnvironmentId; volumeId: string }[]>();

  const scans = providerScans(environments).sort((a, b) => a.rank - b.rank || newestFirst(a, b));
  const keyOf = (scan: ProviderScan, source: UsageSource) =>
    fingerprintKey(source.fingerprint, scan.environment.environmentId);

  for (const scan of claimOrder(scans, keyOf)) {
    for (const source of scan.sources) {
      const weakKey = JSON.stringify([
        source.fingerprint.hostId,
        source.fingerprint.provider,
        source.fingerprint.resolvedHomePath,
      ]);
      const matches = weakMatches.get(weakKey) ?? [];
      matches.push({
        environmentId: scan.environment.environmentId,
        volumeId: source.fingerprint.volumeId,
      });
      weakMatches.set(weakKey, matches);
      const key = keyOf(scan, source);
      if (ownerByFingerprint.has(key)) {
        duplicates.push(`${scan.environment.label}: ${source.fingerprint.resolvedHomePath}`);
        continue;
      }
      ownerByFingerprint.set(key, scan.environment.environmentId);
      ownerScanByFingerprint.set(key, scan);
      sessionsByFingerprint.set(key, source.distinctSessions);
    }
  }

  // Aggregates cannot reconcile overlapping records. Retain the complete
  // cells, and add only cells the complete scan never saw in any of its homes,
  // taking each from the newest scan that reports it.
  const seenByOwner = new Map<ProviderScan, Set<string>>();
  for (const scan of [...scans].sort(newestFirst)) {
    const owners = new Set(
      scan.sources.map((source) => ownerScanByFingerprint.get(keyOf(scan, source))),
    );
    owners.delete(scan);
    const [owner] = owners;
    if (owner === undefined || owners.size !== 1) continue;
    if (
      owner.rank !== STATUS_RANK.ok ||
      !Number.isFinite(scan.readAt) ||
      !Number.isFinite(owner.readAt) ||
      scan.readAt <= owner.readAt ||
      owner.sources.some((source) => ownerScanByFingerprint.get(keyOf(owner, source)) !== owner)
    ) {
      continue;
    }
    const ownerCells = cellsFor(owner, owner.sources);
    const cells = cellsFor(
      scan,
      scan.sources.filter(
        (source) =>
          source.status !== "failed" && ownerScanByFingerprint.get(keyOf(scan, source)) === owner,
      ),
    );
    if (ownerCells === undefined || cells === undefined) continue;
    let seen = seenByOwner.get(owner);
    if (seen === undefined) {
      seen = new Set(ownerCells.flatMap(({ buckets }) => buckets.map(bucketKey)));
      seenByOwner.set(owner, seen);
    }
    // One scan never reports a record twice, so its cells are compared only
    // against earlier scans, not against each other.
    const added: UsageBucket[] = [];
    for (const { sources, buckets } of cells) {
      const fresh = buckets.filter((bucket) => !seen.has(bucketKey(bucket)));
      if (fresh.length === 0) continue;
      added.push(...fresh);
      // Per-source session counts do not carry IDs to union. Keep the largest
      // observed count instead of recounting sessions spanning multiple cells.
      for (const source of sources) {
        const key = keyOf(scan, source);
        sessionsByFingerprint.set(
          key,
          Math.max(sessionsByFingerprint.get(key) ?? 0, source.distinctSessions),
        );
      }
    }
    if (added.length === 0) continue;
    for (const bucket of added) seen.add(bucketKey(bucket));
    const environmentId = scan.environment.environmentId;
    supplementalBucketsByEnvironment.set(environmentId, [
      ...(supplementalBucketsByEnvironment.get(environmentId) ?? []),
      ...added,
    ]);
  }

  const uncertainEnvironments = new Set<EnvironmentId>();
  for (const scan of scans) {
    const owners = new Set(
      scan.sources.map((source) => ownerScanByFingerprint.get(keyOf(scan, source))),
    );
    if (owners.size > 1) uncertainEnvironments.add(scan.environment.environmentId);
  }
  for (const matches of weakMatches.values()) {
    if (
      matches.some((match) => match.volumeId === "") &&
      new Set(matches.map((match) => match.environmentId)).size > 1
    ) {
      for (const match of matches) uncertainEnvironments.add(match.environmentId);
    }
  }

  return {
    ownerByFingerprint,
    supplementalBucketsByEnvironment,
    sessionsByFingerprint,
    duplicates,
    uncertainEnvironments: [...uncertainEnvironments],
  };
}

/** Sources this environment owns after fingerprint claims, plus their buckets. */
function ownedContribution(
  environment: EnvironmentUsage,
  ownerByFingerprint: ReadonlyMap<string, EnvironmentId>,
  supplementalBuckets: readonly UsageBucket[],
  sessionsByFingerprint: ReadonlyMap<string, number>,
): {
  readonly buckets: readonly UsageBucket[];
  readonly sessionsByProvider: ReadonlyMap<UsageProviderKind, number>;
  readonly approximate: boolean;
} {
  const ownedProviders = new Set<UsageProviderKind>();
  const sessionsByProvider = new Map<UsageProviderKind, number>();
  const sourcesByProvider = new Map<UsageProviderKind, typeof environment.summary.sources>();
  for (const source of environment.summary.sources) {
    if (source.status === "missing") continue;
    const providerSources = sourcesByProvider.get(source.fingerprint.provider) ?? [];
    sourcesByProvider.set(source.fingerprint.provider, [...providerSources, source]);
    const key = fingerprintKey(source.fingerprint, environment.environmentId);
    if (ownerByFingerprint.get(key) === environment.environmentId) {
      const provider = source.fingerprint.provider;
      ownedProviders.add(provider);
      // Distinct within a directory. Summing per-bucket session counts instead
      // would count a session once per day and model it spans.
      sessionsByProvider.set(
        provider,
        (sessionsByProvider.get(provider) ?? 0) +
          (sessionsByFingerprint.get(key) ?? source.distinctSessions),
      );
    }
  }
  const buckets: UsageBucket[] = [];
  let approximate = false;
  for (const [provider, sources] of sourcesByProvider) {
    if (!ownedProviders.has(provider)) continue;
    // Mixed-version peers still have provider-wide buckets. Keep those totals
    // visible, but explicitly report their attribution as approximate when a
    // provider spans both owned and duplicated directories.
    if (hasSourceBuckets(sources)) {
      for (const source of sources) {
        if (
          ownerByFingerprint.get(fingerprintKey(source.fingerprint, environment.environmentId)) ===
          environment.environmentId
        ) {
          buckets.push(...(source.buckets ?? []));
        }
      }
    } else {
      buckets.push(...environment.summary.buckets.filter((bucket) => bucket.provider === provider));
      if (
        sources.some(
          (source) =>
            ownerByFingerprint.get(
              fingerprintKey(source.fingerprint, environment.environmentId),
            ) !== environment.environmentId,
        )
      ) {
        approximate = true;
      }
    }
  }
  return {
    buckets: [...buckets, ...supplementalBuckets],
    sessionsByProvider,
    approximate,
  };
}

function bucketTokens(bucket: UsageBucket): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    bucket.totals.uncachedInputTokens +
    bucket.totals.cachedInputTokens +
    bucket.totals.cacheCreationTokens +
    bucket.totals.outputTokens
  );
}

export function isCompatibleUsageContractVersion(version: number, expected: number): boolean {
  return version >= USAGE_MERGE_COMPATIBLE_SINCE && version <= expected;
}

const EMPTY_MERGED: MergedUsage = {
  costUsd: 0,
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  records: 0,
  sessions: 0,
  providers: [],
  models: [],
  daily: [],
  hourly: [],
  costQuality: {
    providerReportedShare: 0,
    modelPricedShare: 0,
    unpricedShare: 0,
    cacheSavingsUsd: 0,
  },
  duplicateSources: [],
  contributingEnvironments: [],
  contractMismatches: [],
  approximateEnvironments: [],
};

/**
 * Merges every connected environment's summary.
 *
 * `expectedContractVersion` guards against incompatible server code: rather
 * than blocking the page, its data is excluded and the mismatch direction is
 * reported so the UI can identify which side needs updating. Versions in
 * [{@link USAGE_MERGE_COMPATIBLE_SINCE}, expected] still merge, so an additive
 * provider expansion does not drop Claude/Codex totals from older servers.
 */
export function mergeUsage(
  environments: readonly EnvironmentUsage[],
  expectedContractVersion: number,
): MergedUsage {
  if (environments.length === 0) return EMPTY_MERGED;

  const current: EnvironmentUsage[] = [];
  const contractMismatches: UsageContractMismatch[] = [];
  for (const environment of environments) {
    if (
      isCompatibleUsageContractVersion(environment.summary.contractVersion, expectedContractVersion)
    ) {
      current.push(environment);
    } else {
      contractMismatches.push({
        environmentId: environment.environmentId,
        direction:
          environment.summary.contractVersion < expectedContractVersion
            ? "serverBehind"
            : "clientBehind",
        contractVersion: environment.summary.contractVersion,
      });
    }
  }

  const {
    ownerByFingerprint,
    supplementalBucketsByEnvironment,
    sessionsByFingerprint,
    duplicates,
    uncertainEnvironments,
  } = claimSources(current);

  let costUsd = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let records = 0;
  let sessions = 0;
  let cacheSavingsUsd = 0;
  let providerReportedRecords = 0;
  let unpricedRecords = 0;

  const providerAccumulator = new Map<
    UsageProviderKind,
    { costUsd: number; totalTokens: number; records: number; sessions: number }
  >();
  const modelAccumulator = new Map<
    string,
    {
      provider: UsageProviderKind;
      costUsd: number;
      totalTokens: number;
      records: number;
      unpricedRecords: number;
    }
  >();
  const dailyAccumulator = new Map<
    string,
    {
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  const hourlyAccumulator = new Map<
    string,
    {
      day: string;
      hourStart: string;
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  const contributingEnvironments: EnvironmentId[] = [];
  const approximateEnvironments = new Set<EnvironmentId>(uncertainEnvironments);

  for (const environment of current) {
    const { buckets, sessionsByProvider, approximate } = ownedContribution(
      environment,
      ownerByFingerprint,
      supplementalBucketsByEnvironment.get(environment.environmentId) ?? [],
      sessionsByFingerprint,
    );
    if (approximate) approximateEnvironments.add(environment.environmentId);
    if (buckets.length > 0) contributingEnvironments.push(environment.environmentId);

    for (const [providerKind, providerSessions] of sessionsByProvider) {
      sessions += providerSessions;
      if (providerSessions === 0) continue;
      const provider = providerAccumulator.get(providerKind) ?? {
        costUsd: 0,
        totalTokens: 0,
        records: 0,
        sessions: 0,
      };
      provider.sessions += providerSessions;
      providerAccumulator.set(providerKind, provider);
    }

    for (const bucket of buckets) {
      const tokens = bucketTokens(bucket);

      costUsd += bucket.costUsd;
      cacheSavingsUsd += bucket.cacheSavingsUsd;
      uncachedInputTokens += bucket.totals.uncachedInputTokens;
      cachedInputTokens += bucket.totals.cachedInputTokens;
      cacheCreationTokens += bucket.totals.cacheCreationTokens;
      outputTokens += bucket.totals.outputTokens;
      reasoningTokens += bucket.totals.reasoningTokens;
      records += bucket.records;
      unpricedRecords += bucket.unpricedRecords;
      if (bucket.costSource === "providerReported") providerReportedRecords += bucket.records;

      const provider = providerAccumulator.get(bucket.provider) ?? {
        costUsd: 0,
        totalTokens: 0,
        records: 0,
        sessions: 0,
      };
      provider.costUsd += bucket.costUsd;
      provider.totalTokens += tokens;
      provider.records += bucket.records;
      providerAccumulator.set(bucket.provider, provider);

      const modelKey = `${bucket.provider} ${bucket.model}`;
      const model = modelAccumulator.get(modelKey) ?? {
        provider: bucket.provider,
        costUsd: 0,
        totalTokens: 0,
        records: 0,
        unpricedRecords: 0,
      };
      model.costUsd += bucket.costUsd;
      model.totalTokens += tokens;
      model.records += bucket.records;
      model.unpricedRecords += bucket.unpricedRecords;
      modelAccumulator.set(modelKey, model);

      const day = dailyAccumulator.get(bucket.day) ?? {
        costUsd: 0,
        totalTokens: 0,
        byProvider: new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
      };
      day.costUsd += bucket.costUsd;
      day.totalTokens += tokens;
      const dayProvider = day.byProvider.get(bucket.provider) ?? { costUsd: 0, totalTokens: 0 };
      dayProvider.costUsd += bucket.costUsd;
      dayProvider.totalTokens += tokens;
      day.byProvider.set(bucket.provider, dayProvider);
      dailyAccumulator.set(bucket.day, day);

      if (bucket.hourStart !== undefined) {
        const hour = hourlyAccumulator.get(bucket.hourStart) ?? {
          day: bucket.day,
          hourStart: bucket.hourStart,
          costUsd: 0,
          totalTokens: 0,
          byProvider: new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
        };
        hour.costUsd += bucket.costUsd;
        hour.totalTokens += tokens;
        const hourProvider = hour.byProvider.get(bucket.provider) ?? {
          costUsd: 0,
          totalTokens: 0,
        };
        hourProvider.costUsd += bucket.costUsd;
        hourProvider.totalTokens += tokens;
        hour.byProvider.set(bucket.provider, hourProvider);
        hourlyAccumulator.set(bucket.hourStart, hour);
      }
    }
  }

  const totalTokens = uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens;

  const providers: ProviderTotals[] = [...providerAccumulator.entries()]
    .map(([provider, totals]) => ({
      provider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      records: totals.records,
      sessions: totals.sessions,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      tokenShare: totalTokens === 0 ? 0 : totals.totalTokens / totalTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const models: ModelTotals[] = [...modelAccumulator.entries()]
    .map(([key, totals]) => ({
      model: key.slice(key.indexOf(" ") + 1),
      provider: totals.provider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      records: totals.records,
      unpricedRecords: totals.unpricedRecords,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const daily: DailyTotals[] = [...dailyAccumulator.entries()]
    .map(([day, totals]) => ({
      day,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      byProvider: totals.byProvider,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const hourly: HourlyTotals[] = [...hourlyAccumulator.values()].sort((a, b) =>
    a.hourStart.localeCompare(b.hourStart),
  );

  return {
    costUsd,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    records,
    sessions,
    providers,
    models,
    daily,
    hourly,
    costQuality: {
      providerReportedShare: records === 0 ? 0 : providerReportedRecords / records,
      unpricedShare: records === 0 ? 0 : unpricedRecords / records,
      modelPricedShare:
        records === 0 ? 0 : (records - providerReportedRecords - unpricedRecords) / records,
      cacheSavingsUsd,
    },
    duplicateSources: duplicates,
    contributingEnvironments,
    contractMismatches,
    approximateEnvironments: [...approximateEnvironments],
  };
}
