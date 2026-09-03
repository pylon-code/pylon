/**
 * ProviderRegistryLive — aggregates per-instance snapshot streams into a
 * single materialized list.
 *
 * Historically this Layer composed four per-kind Live Layers
 * (`CodexProviderLive`, `ClaudeProviderLive`, …) that each exposed a
 * `ServerProviderShape`. Those Lives were deleted during the driver /
 * instance refactor — every driver now carries its `snapshot: ServerProviderShape`
 * bundled onto the `ProviderInstance` the registry produces.
 *
 * Each configured instance (including multi-instance setups like
 * `codex_personal` + `codex_work`) contributes one `ProviderSnapshotSource`,
 * keyed by `instanceId`. Instances whose driver is unavailable or whose
 * config failed to decode are merged from `instanceRegistry.listUnavailable`
 * as shadow snapshots so the UI can render their exact unavailable reason.
 *
 * Cache paths on disk are now keyed by `instanceId`. Because
 * `defaultInstanceIdForDriver(kind) === kind` for built-in kinds, existing
 * `<kind>.json` files remain the on-disk location for that driver's default
 * instance. Identity-less legacy cache contents are ignored and replaced by
 * the first live refresh.
 *
 * @module ProviderRegistryLive
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderBackend,
  type ServerProviderRateLimit,
  type ServerProviderUpdateState,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import {
  accumulatePushedUsageWindows,
  applyPushedUsageWindows,
  type PushedUsageWindow,
} from "../providerUsageLimits.ts";
import { isRetainedUsageFresh, USAGE_RETENTION_MAX_AGE } from "../providerUsageRetention.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import {
  hydrateCachedProvider,
  isCachedProviderCorrelated,
  orderProviderSnapshots,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache.ts";
import {
  capacityRefreshFromProviderBackends,
  type ProviderCapacityRefresh,
  type ProviderInstance,
  type ProviderRuntimeFence,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ProviderSnapshotSource } from "../builtInProviderCatalog.ts";

const loadProviders = (
  providerSources: ReadonlyArray<ProviderSnapshotSource>,
): Effect.Effect<ReadonlyArray<ServerProvider>> =>
  Effect.forEach(
    providerSources,
    (providerSource) =>
      providerSource.getSnapshot.pipe(
        Effect.flatMap((snapshot) => correlateSnapshotWithSource(providerSource, snapshot)),
      ),
    {
      concurrency: "unbounded",
    },
  );

const makeManualProviderMaintenanceCapabilities = (provider: ProviderDriverKind) =>
  makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });

const hasModelCapabilities = (model: ServerProvider["models"][number]): boolean =>
  (model.capabilities?.optionDescriptors?.length ?? 0) > 0;

const shouldRetainMissingProviderModels = (provider: ServerProvider): boolean => {
  if (provider.driver !== ProviderDriverKind.make("opencode")) {
    return true;
  }

  // OpenCode's initial snapshot is deliberately non-authoritative while its
  // first probe is still running. A probe error from an installed CLI/server
  // is likewise partial: it could not establish the current inventory.
  // Conversely, disabled and missing-CLI snapshots are authoritative removals,
  // as are successful ready/warning inventories (including an empty one after
  // logout or plugin removal).
  const isPendingInitialProbe =
    provider.enabled && !provider.installed && provider.status === "warning";
  const didInstalledProviderProbeFail = provider.installed && provider.status === "error";
  return isPendingInitialProbe || didInstalledProviderProbeFail;
};

const shouldRetainMissingOpenCodeMetadata = (provider: ServerProvider): boolean =>
  provider.driver === ProviderDriverKind.make("opencode") &&
  shouldRetainMissingProviderModels(provider);

const mergeProviderModels = (
  provider: ServerProvider,
  previousModels: ReadonlyArray<ServerProvider["models"][number]>,
  nextModels: ReadonlyArray<ServerProvider["models"][number]>,
): ReadonlyArray<ServerProvider["models"][number]> => {
  const shouldRetainMissingModels = shouldRetainMissingProviderModels(provider);
  // Custom rows are derived from settings and every snapshot carries the full
  // current list, so a custom model missing from `nextModels` was removed by
  // the user and must not be resurrected from the previous snapshot.
  const retainablePreviousModels = previousModels.filter((model) => !model.isCustom);

  if (shouldRetainMissingModels && nextModels.length === 0 && retainablePreviousModels.length > 0) {
    return retainablePreviousModels;
  }

  const previousBySlug = new Map(previousModels.map((model) => [model.slug, model] as const));
  const mergedModels = nextModels.map((model) => {
    const previousModel = previousBySlug.get(model.slug);
    if (!previousModel || hasModelCapabilities(model) || !hasModelCapabilities(previousModel)) {
      return model;
    }
    return {
      ...model,
      capabilities: previousModel.capabilities,
    };
  });
  const nextSlugs = new Set(nextModels.map((model) => model.slug));
  return shouldRetainMissingModels
    ? [...mergedModels, ...retainablePreviousModels.filter((model) => !nextSlugs.has(model.slug))]
    : mergedModels;
};

export const mergeProviderSnapshot = (
  previousProvider: ServerProvider | undefined,
  nextProvider: ServerProvider,
): ServerProvider =>
  !previousProvider
    ? nextProvider
    : {
        ...nextProvider,
        models: mergeProviderModels(nextProvider, previousProvider.models, nextProvider.models),
        ...(shouldRetainMissingOpenCodeMetadata(nextProvider)
          ? {
              slashCommands:
                nextProvider.slashCommands.length === 0
                  ? previousProvider.slashCommands
                  : nextProvider.slashCommands,
              skills:
                nextProvider.skills.length === 0 ? previousProvider.skills : nextProvider.skills,
            }
          : {}),
      };

export interface ProviderCapacityOverlayBackend {
  readonly backend: ServerProviderBackend;
  readonly retentionIdentity?: string | undefined;
}

function newestRetainedUsage(
  candidates: ReadonlyArray<ServerProviderBackend["usageLimits"]>,
  nowMs: number,
): ServerProviderBackend["usageLimits"] {
  let newest: ServerProviderBackend["usageLimits"];
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate || !isRetainedUsageFresh({ checkedAt: candidate.checkedAt, nowMs })) continue;
    const checkedAtMs = Date.parse(candidate.checkedAt);
    if (checkedAtMs > newestMs) {
      newest = candidate;
      newestMs = checkedAtMs;
    }
  }
  return newest;
}

/** Keep only the newest same-account capacity across turn and periodic reads. */
export function mergeProviderCapacityRefresh(input: {
  readonly previousBackends: ReadonlyArray<ProviderCapacityOverlayBackend>;
  readonly refresh: ProviderCapacityRefresh;
  readonly nowMs: number;
}): ReadonlyArray<ProviderCapacityOverlayBackend> {
  return input.refresh.backends.map((read) => {
    const overlay = {
      backend: read.backend,
      ...(read.retentionIdentity ? { retentionIdentity: read.retentionIdentity } : {}),
    } satisfies ProviderCapacityOverlayBackend;
    const { usageLimits: sharedUsage, ...withoutUsage } = read.backend;
    if (!read.retentionIdentity) {
      return read.didReadCapacity ? overlay : { ...overlay, backend: withoutUsage };
    }
    const previous = input.previousBackends.find(
      (candidate) =>
        candidate.backend.backend === read.backend.backend &&
        candidate.retentionIdentity === read.retentionIdentity,
    );
    const retained = newestRetainedUsage([sharedUsage, previous?.backend.usageLimits], input.nowMs);
    return {
      ...overlay,
      backend: retained ? { ...withoutUsage, usageLimits: retained } : withoutUsage,
    };
  });
}

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

const correlateSnapshotWithSource = (
  source: ProviderSnapshotSource,
  snapshot: ServerProvider,
): Effect.Effect<ServerProvider> => {
  if (snapshot.instanceId !== source.instanceId) {
    return Effect.die(
      new Error(
        `Provider snapshot instance mismatch: source '${source.instanceId}' emitted '${snapshot.instanceId}'.`,
      ),
    );
  }
  if (snapshot.driver !== source.driverKind) {
    return Effect.die(
      new Error(
        `Provider snapshot driver mismatch for instance '${source.instanceId}': source '${source.driverKind}' emitted '${snapshot.driver}'.`,
      ),
    );
  }
  return Effect.succeed(snapshot);
};

/**
 * Key a snapshot for aggregation and persistence. Snapshot sources
 * must be correlated by instance id before reaching this map; missing
 * identities are defects, not runtime routing fallbacks.
 */
const snapshotInstanceKey = (provider: ServerProvider): ProviderInstanceId => {
  return provider.instanceId;
};

// Project a live `ProviderInstance` into the aggregator's consumption
// shape. Each call re-captures the instance's `snapshot` closures, so
// after `ProviderInstanceRegistry` rebuilds an instance (e.g. because
// its settings changed), a fresh source rides the new PubSub instead
// of a closed one.
type RuntimeProviderSnapshotSource = ProviderSnapshotSource & {
  readonly runtimeFence?: ProviderRuntimeFence | undefined;
};

const buildSnapshotSource = (instance: ProviderInstance): RuntimeProviderSnapshotSource => ({
  instanceId: instance.instanceId,
  driverKind: instance.driverKind,
  getSnapshot: instance.snapshot.getSnapshot,
  refresh: instance.snapshot.refresh,
  streamChanges: instance.snapshot.streamChanges,
  ...(instance.runtimeFence === undefined ? {} : { runtimeFence: instance.runtimeFence }),
});

const sourceIsCurrent = (source: RuntimeProviderSnapshotSource): Effect.Effect<boolean> =>
  source.runtimeFence?.isCurrent ?? Effect.succeed(true);

export const ProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const instanceRegistry = yield* ProviderInstanceRegistry;
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Aggregator PubSub — consumers (WS gateway, etc.) subscribe here for
    // coalesced updates across every instance.
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );

    // Boot-only: hydrate `providersRef` from the on-disk per-instance
    // cache so the UI has something to render during the first refresh.
    // Instances added post-boot skip this path; their first entry in
    // `providersRef` comes from the reactive `syncLiveSources` pass
    // below.
    const bootInstances = yield* instanceRegistry.listInstances;
    const bootSources = bootInstances.map(buildSnapshotSource);
    const fallbackProviders = yield* loadProviders(bootSources);
    const fallbackByInstance = new Map<ProviderInstanceId, ServerProvider>();
    for (let index = 0; index < fallbackProviders.length; index++) {
      const provider = fallbackProviders[index];
      const source = bootSources[index];
      if (provider === undefined || source === undefined) {
        continue;
      }
      fallbackByInstance.set(source.instanceId, provider);
    }

    const cachedProviders = yield* Effect.forEach(
      bootSources,
      (source) =>
        Effect.gen(function* () {
          // One cache file per configured instance. For the default
          // instance of a built-in kind the path equals `<kind>.json` —
          // identical to the legacy filename. We still require the cache
          // payload to carry matching instance id + driver kind; old
          // identity-less payloads are discarded and the awaited refresh
          // below repopulates the cache.
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: source.instanceId,
          }).pipe(Effect.provideService(Path.Path, path));
          const fallbackProvider = fallbackByInstance.get(source.instanceId);
          if (fallbackProvider === undefined) {
            return undefined;
          }
          return yield* readProviderStatusCache(filePath, {
            configRevision: source.runtimeFence?.configRevision,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.flatMap((cachedProvider) => {
              if (cachedProvider === undefined) {
                return Effect.void.pipe(Effect.as(undefined as ServerProvider | undefined));
              }
              const correlation = {
                cachedProvider,
                fallbackProvider,
              } as const;
              if (!isCachedProviderCorrelated(correlation)) {
                return Effect.logWarning("provider status cache identity mismatch, ignoring", {
                  path: filePath,
                  instanceId: source.instanceId,
                  cachedInstanceId: cachedProvider.instanceId ?? null,
                  driver: source.driverKind,
                  cachedDriver: cachedProvider.driver ?? null,
                }).pipe(Effect.as(undefined as ServerProvider | undefined));
              }
              return Effect.succeed(hydrateCachedProvider(correlation));
            }),
          );
        }),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((providers) =>
        orderProviderSnapshots(
          providers.filter((provider): provider is ServerProvider => provider !== undefined),
        ),
      ),
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(cachedProviders);
    const maintenanceActionStatesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, { readonly update?: ServerProviderUpdateState | undefined }>
    >(new Map());
    // Pushed subscription rate-limit state, keyed by instance. Volatile for the
    // same reason maintenance action state is: it describes what a provider is
    // doing right now, not what it is configured to be. A restart re-learns it
    // from the next turn.
    const rateLimitStatesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, ServerProviderRateLimit>
    >(new Map());
    // Usage windows pushed by running sessions, keyed by instance. Volatile
    // for the same reason: a probe rebuilds `usageLimits` from scratch, so
    // every push newer than the probe is re-applied on top of its result.
    const pushedUsageRef = yield* Ref.make<
      ReadonlyMap<
        ProviderInstanceId,
        { readonly source: string; readonly windows: ReadonlyArray<PushedUsageWindow> }
      >
    >(new Map());
    // Backends re-read after a turn on an instance that signs in on its own
    // (see `ProviderInstance.capacity`). Volatile like the other overlays; a
    // probe that ran after the read supersedes it.
    const capacityOverlayRef = yield* Ref.make<
      ReadonlyMap<
        ProviderInstanceId,
        {
          readonly backends: ReadonlyArray<ProviderCapacityOverlayBackend>;
          readonly observedAt: string;
        }
      >
    >(new Map());
    // One capacity read in flight per instance, and no more than one a minute:
    // a burst of short turns must cost the backend one request, not one each.
    const capacityRunsRef = yield* Ref.make<
      ReadonlyMap<
        ProviderInstanceId,
        {
          readonly startedAtMs: number;
          readonly running: boolean;
          readonly generation?: object | undefined;
        }
      >
    >(new Map());
    const registryScope = yield* Effect.scope;

    // Live-source registry — the dynamic counterpart to the boot-time
    // `bootSources`. Keyed by `instanceId`; the stored `ProviderInstance`
    // reference is used for identity equality so "no-op" reconciles
    // (settings unchanged) skip re-subscribing + re-probing.
    const liveSubsRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ProviderInstance>>(
      new Map(),
    );
    const subscriptionFibersRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, Fiber.Fiber<void, never>>
    >(new Map());
    // Serialize `syncLiveSources` so a rapid burst of reconciles doesn't
    // interleave two passes clobbering each other's fiber bookkeeping.
    const syncSemaphore = yield* Semaphore.make(1);

    const getLiveSources: Effect.Effect<ReadonlyArray<RuntimeProviderSnapshotSource>> = Ref.get(
      liveSubsRef,
    ).pipe(Effect.map((map) => Array.from(map.values(), buildSnapshotSource)));

    const persistProvider = (provider: ServerProvider, capturedFence?: ProviderRuntimeFence) =>
      Effect.gen(function* () {
        const key = snapshotInstanceKey(provider);
        const currentInstance = yield* instanceRegistry.getInstance(key);
        if (currentInstance?.driverKind !== provider.driver) return;
        const runtimeFence = capturedFence ?? currentInstance.runtimeFence;
        if (runtimeFence !== undefined && !(yield* runtimeFence.isCurrent)) return;
        const filePath = yield* resolveProviderStatusCachePath({
          cacheDir: config.providerStatusCacheDir,
          instanceId: key,
        }).pipe(Effect.provideService(Path.Path, path));
        yield* writeProviderStatusCache({
          filePath,
          provider,
          ...(runtimeFence?.configRevision === undefined
            ? {}
            : { configRevision: runtimeFence.configRevision }),
          ...(runtimeFence === undefined ? {} : { commitGuard: runtimeFence.isCurrent }),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.tapError(Effect.logError),
          Effect.ignore,
        );
      });

    const applyProviderUpdateState = Effect.fn("applyProviderUpdateState")(function* (
      provider: ServerProvider,
    ) {
      const maintenanceActionStates = yield* Ref.get(maintenanceActionStatesRef);
      const updateState = maintenanceActionStates.get(provider.instanceId)?.update;
      if (!updateState) {
        const { updateState: _updateState, ...providerWithoutUpdateState } = provider;
        return providerWithoutUpdateState;
      }
      return {
        ...provider,
        updateState,
      };
    });

    const applyProviderRateLimit = Effect.fn("applyProviderRateLimit")(function* (
      provider: ServerProvider,
    ) {
      const rateLimitStates = yield* Ref.get(rateLimitStatesRef);
      const rateLimit = rateLimitStates.get(provider.instanceId);
      if (!rateLimit) {
        // Strip rather than pass through: a snapshot rebuilt from the probe
        // must not resurrect state we have since cleared.
        const { rateLimit: _rateLimit, ...providerWithoutRateLimit } = provider;
        return providerWithoutRateLimit;
      }
      return {
        ...provider,
        rateLimit,
      };
    });

    /**
     * Unlike `rateLimit`, `usageLimits` is a legitimate probe field, so a
     * missing overlay leaves the snapshot alone rather than stripping it.
     * Pushes older than the probe, or older than the retention window, fall
     * away inside `applyPushedUsageWindows`.
     */
    const applyProviderUsageLimits = Effect.fn("applyProviderUsageLimits")(function* (
      provider: ServerProvider,
    ) {
      const pushed = (yield* Ref.get(pushedUsageRef)).get(provider.instanceId);
      if (!pushed) return provider;
      const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const usageLimits = applyPushedUsageWindows(provider.usageLimits, pushed.windows, {
        nowMs,
        maxAgeMs: Duration.toMillis(USAGE_RETENTION_MAX_AGE),
        source: pushed.source,
      });
      if (usageLimits === undefined || usageLimits === provider.usageLimits) return provider;
      return { ...provider, usageLimits };
    });

    /**
     * Project every volatile per-instance overlay onto a freshly probed
     * snapshot. Probes rebuild snapshots from scratch, so anything not stored
     * in a Ref has to be re-applied here or it silently disappears.
     */
    const applyProviderCapacity = Effect.fn("applyProviderCapacity")(function* (
      provider: ServerProvider,
    ) {
      const overlay = (yield* Ref.get(capacityOverlayRef)).get(provider.instanceId);
      if (!overlay) return provider;
      const overlayMs = Date.parse(overlay.observedAt);
      const probedMs = Date.parse(provider.checkedAt);
      if (!Number.isFinite(overlayMs)) return provider;
      if (Number.isFinite(probedMs) && overlayMs <= probedMs) {
        const periodicRefresh = capacityRefreshFromProviderBackends(provider.backends);
        if (!periodicRefresh) return provider;
        const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const backends = mergeProviderCapacityRefresh({
          previousBackends: overlay.backends,
          refresh: periodicRefresh,
          nowMs,
        });
        return { ...provider, backends: backends.map((read) => read.backend) };
      }
      return { ...provider, backends: overlay.backends.map((read) => read.backend) };
    });

    const applyVolatileProviderState = Effect.fn("applyVolatileProviderState")(function* (
      provider: ServerProvider,
    ) {
      const withUpdateState = yield* applyProviderUpdateState(provider);
      const withRateLimit = yield* applyProviderRateLimit(withUpdateState);
      const withUsage = yield* applyProviderUsageLimits(withRateLimit);
      return yield* applyProviderCapacity(withUsage);
    });

    const upsertProviders = Effect.fn("upsertProviders")(function* (
      nextProviders: ReadonlyArray<ServerProvider>,
      options?: {
        readonly publish?: boolean;
        readonly persist?: boolean;
        readonly replace?: boolean;
        readonly runtimeFence?: ProviderRuntimeFence | undefined;
      },
    ) {
      const nextProvidersWithUpdateState = yield* Effect.forEach(
        nextProviders,
        applyVolatileProviderState,
        {
          concurrency: "unbounded",
        },
      );
      if (options?.runtimeFence !== undefined && !(yield* options.runtimeFence.isCurrent)) {
        return yield* Ref.get(providersRef);
      }
      const [previousProviders, providers, providersToPersist] = yield* Ref.modify(
        providersRef,
        (previousProviders) => {
          const mergedProviders = new Map(
            previousProviders.map((provider) => [snapshotInstanceKey(provider), provider] as const),
          );
          const updatedKeys = new Set<ProviderInstanceId>();

          for (const provider of nextProvidersWithUpdateState) {
            const key = snapshotInstanceKey(provider);
            updatedKeys.add(key);
            mergedProviders.set(
              key,
              options?.replace === true
                ? provider
                : mergeProviderSnapshot(mergedProviders.get(key), provider),
            );
          }

          const providers = orderProviderSnapshots([...mergedProviders.values()]);
          const providersToPersist = providers.filter((provider) =>
            updatedKeys.has(snapshotInstanceKey(provider)),
          );
          return [[previousProviders, providers, providersToPersist] as const, providers];
        },
      );

      if (options?.runtimeFence !== undefined && !(yield* options.runtimeFence.isCurrent)) {
        yield* Ref.update(providersRef, (current) =>
          current === providers ? previousProviders : current,
        );
        return yield* Ref.get(providersRef);
      }
      if (haveProvidersChanged(previousProviders, providers)) {
        if (options?.persist !== false) {
          yield* Effect.forEach(
            providersToPersist,
            (provider) => persistProvider(provider, options?.runtimeFence),
            {
              concurrency: "unbounded",
              discard: true,
            },
          );
        }
        if (options?.publish !== false) {
          if (options?.runtimeFence === undefined || (yield* options.runtimeFence.isCurrent)) {
            yield* PubSub.publish(changesPubSub, providers);
          }
        }
      }

      return providers;
    });

    const syncProvider = Effect.fn("syncProvider")(function* (
      provider: ServerProvider,
      options?: {
        readonly publish?: boolean;
        readonly replace?: boolean;
        readonly runtimeFence?: ProviderRuntimeFence | undefined;
      },
    ) {
      if (options?.runtimeFence !== undefined && !(yield* options.runtimeFence.isCurrent)) {
        return yield* Ref.get(providersRef);
      }
      return yield* upsertProviders([provider], options);
    });

    const setProviderMaintenanceActionState = Effect.fn("setProviderMaintenanceActionState")(
      function* (input: {
        readonly instanceId: ProviderInstanceId;
        readonly action: "update";
        readonly state: ServerProviderUpdateState | null;
        readonly runtimeFence?: ProviderRuntimeFence | undefined;
      }) {
        if (input.runtimeFence !== undefined && !(yield* input.runtimeFence.isCurrent)) {
          return yield* Ref.get(providersRef);
        }
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const previousActions = previous.get(input.instanceId);
          const nextActions = { ...previousActions };
          if (input.state === null || input.state.status === "idle") {
            delete nextActions[input.action];
          } else {
            nextActions[input.action] = input.state;
          }

          const next = new Map(previous);
          if (Object.keys(nextActions).length === 0) {
            next.delete(input.instanceId);
          } else {
            next.set(input.instanceId, nextActions);
          }
          return next;
        });

        if (input.runtimeFence !== undefined && !(yield* input.runtimeFence.isCurrent)) {
          return yield* Ref.get(providersRef);
        }
        const existingProviders = yield* Ref.get(providersRef);
        const matchingProvider = existingProviders.find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        if (!matchingProvider) {
          return existingProviders;
        }

        const nextProvider = yield* applyVolatileProviderState(matchingProvider);
        return yield* upsertProviders([nextProvider], {
          persist: false,
          runtimeFence: input.runtimeFence,
        });
      },
    );

    const setProviderRateLimitState = Effect.fn("setProviderRateLimitState")(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly state: ServerProviderRateLimit | null;
      readonly runtimeFence?: ProviderRuntimeFence | undefined;
    }) {
      if (input.runtimeFence !== undefined && !(yield* input.runtimeFence.isCurrent)) {
        return yield* Ref.get(providersRef);
      }
      yield* Ref.update(rateLimitStatesRef, (previous) => {
        const next = new Map(previous);
        if (input.state === null) {
          next.delete(input.instanceId);
        } else {
          next.set(input.instanceId, input.state);
        }
        return next;
      });

      if (input.runtimeFence !== undefined && !(yield* input.runtimeFence.isCurrent)) {
        return yield* Ref.get(providersRef);
      }
      const existingProviders = yield* Ref.get(providersRef);
      const matchingProvider = existingProviders.find(
        (candidate) => candidate.instanceId === input.instanceId,
      );
      // Unknown instance is a no-op returning the current list, matching
      // `refreshInstance` so transport layers never special-case unknowns.
      if (!matchingProvider) {
        return existingProviders;
      }

      const nextProvider = yield* applyVolatileProviderState(matchingProvider);
      return yield* upsertProviders([nextProvider], {
        persist: false,
        runtimeFence: input.runtimeFence,
      });
    });

    const mergeProviderUsageWindows = Effect.fn("mergeProviderUsageWindows")(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly source: string;
      readonly observedAt: string;
      readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
      readonly runtimeFence?: ProviderRuntimeFence | undefined;
    }) {
      if (input.runtimeFence !== undefined && !(yield* input.runtimeFence.isCurrent)) {
        return yield* Ref.get(providersRef);
      }
      const pushed = input.windows.map(
        (window): PushedUsageWindow => ({ window, observedAt: input.observedAt }),
      );
      yield* Ref.update(pushedUsageRef, (previous) => {
        const next = new Map(previous);
        next.set(input.instanceId, {
          source: input.source,
          windows: accumulatePushedUsageWindows(
            previous.get(input.instanceId)?.windows ?? [],
            pushed,
          ),
        });
        return next;
      });

      if (input.runtimeFence !== undefined && !(yield* input.runtimeFence.isCurrent)) {
        return yield* Ref.get(providersRef);
      }
      const existingProviders = yield* Ref.get(providersRef);
      const matchingProvider = existingProviders.find(
        (candidate) => candidate.instanceId === input.instanceId,
      );
      if (!matchingProvider) {
        return existingProviders;
      }

      const nextProvider = yield* applyVolatileProviderState(matchingProvider);
      return yield* upsertProviders([nextProvider], {
        persist: false,
        runtimeFence: input.runtimeFence,
      });
    });

    const CAPACITY_REFRESH_FLOOR_MS = 60_000;

    const refreshProviderCapacity = Effect.fn("refreshProviderCapacity")(function* (
      instanceId: ProviderInstanceId,
      capturedFence?: ProviderRuntimeFence,
    ) {
      if (capturedFence !== undefined && !(yield* capturedFence.isCurrent)) return;
      const instance = (yield* Ref.get(liveSubsRef)).get(instanceId);
      const capacity = instance?.capacity;
      if (!capacity) return;
      const runtimeFence = capturedFence ?? instance.runtimeFence;
      if (runtimeFence !== undefined && !(yield* runtimeFence.isCurrent)) return;
      if (
        capturedFence !== undefined &&
        instance.runtimeFence?.generation !== capturedFence.generation
      )
        return;
      const generation = runtimeFence?.generation;
      const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const admitted = yield* Ref.modify(capacityRunsRef, (previous) => {
        const current = previous.get(instanceId);
        if (
          current &&
          current.generation === generation &&
          (current.running || nowMs - current.startedAtMs < CAPACITY_REFRESH_FLOOR_MS)
        ) {
          return [false, previous] as const;
        }
        const next = new Map(previous);
        next.set(instanceId, {
          startedAtMs: nowMs,
          running: true,
          ...(generation === undefined ? {} : { generation }),
        });
        return [true, next] as const;
      });
      if (!admitted) return;

      const settle = Ref.update(capacityRunsRef, (previous) => {
        const current = previous.get(instanceId);
        if (!current || current.generation !== generation) return previous;
        const next = new Map(previous);
        next.set(instanceId, { ...current, running: false });
        return next;
      });
      yield* capacity.refresh.pipe(
        Effect.flatMap((refresh) =>
          refresh === undefined
            ? Effect.void
            : Effect.gen(function* () {
                if (runtimeFence !== undefined && !(yield* runtimeFence.isCurrent)) return;
                const observedAtMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
                const existingProviders = yield* Ref.get(providersRef);
                const matchingProvider = existingProviders.find(
                  (candidate) => candidate.instanceId === instanceId,
                );
                const currentOverlay = (yield* Ref.get(capacityOverlayRef)).get(instanceId);
                const backends = mergeProviderCapacityRefresh({
                  previousBackends: currentOverlay?.backends ?? [],
                  refresh,
                  nowMs: observedAtMs,
                });
                if (runtimeFence !== undefined && !(yield* runtimeFence.isCurrent)) return;
                yield* Ref.update(capacityOverlayRef, (previous) => {
                  const next = new Map(previous);
                  next.set(instanceId, {
                    backends,
                    observedAt: DateTime.formatIso(DateTime.makeUnsafe(observedAtMs)),
                  });
                  return next;
                });
                if (!matchingProvider) return;
                const nextProvider = yield* applyVolatileProviderState(matchingProvider);
                if (runtimeFence !== undefined && !(yield* runtimeFence.isCurrent)) return;
                yield* upsertProviders([nextProvider], {
                  persist: false,
                  runtimeFence,
                });
              }),
        ),
        Effect.ensuring(settle),
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(registryScope),
      );
    });

    const refreshOneSource = Effect.fn("refreshOneSource")(function* (
      providerSource: RuntimeProviderSnapshotSource,
    ) {
      return yield* providerSource.refresh.pipe(
        Effect.flatMap((nextProvider) =>
          sourceIsCurrent(providerSource).pipe(
            Effect.flatMap((current) =>
              current
                ? correlateSnapshotWithSource(providerSource, nextProvider).pipe(
                    Effect.flatMap((provider) =>
                      syncProvider(provider, { runtimeFence: providerSource.runtimeFence }),
                    ),
                  )
                : Ref.get(providersRef),
            ),
          ),
        ),
      );
    });

    const refreshAll = Effect.fn("refreshAll")(function* () {
      const sources = yield* getLiveSources;
      return yield* Effect.forEach(sources, (source) => refreshOneSource(source), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.andThen(Ref.get(providersRef)));
    });

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderDriverKind) {
      if (provider === undefined) {
        return yield* refreshAll();
      }
      // Kind-scoped refreshes target the default instance for that driver.
      const defaultInstanceId = defaultInstanceIdForDriver(provider);
      const sources = yield* getLiveSources;
      const providerSource = sources.find(
        (candidate) => candidate.instanceId === defaultInstanceId,
      );
      if (!providerSource) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(providerSource);
    });

    const refreshInstance = Effect.fn("refreshInstance")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const sources = yield* getLiveSources;
      const providerSource = sources.find((candidate) => candidate.instanceId === instanceId);
      if (!providerSource) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(providerSource);
    });

    const getProviderMaintenanceCapabilitiesForInstance = Effect.fn(
      "getProviderMaintenanceCapabilitiesForInstance",
    )(function* (instanceId: ProviderInstanceId, provider: ProviderDriverKind) {
      const instance = Array.from((yield* Ref.get(liveSubsRef)).values()).find(
        (candidate) => candidate.instanceId === instanceId,
      );
      return (
        instance?.snapshot.maintenanceCapabilities ??
        makeManualProviderMaintenanceCapabilities(provider)
      );
    });

    /**
     * Diff the aggregator's live-source set against the current
     * `ProviderInstanceRegistry` and:
     *   - subscribe to each newly-added or rebuilt instance's
     *     `streamChanges` (so periodic + enrichment refreshes land in
     *     `providersRef`);
     *   - read each newly-added/rebuilt instance's current snapshot after
     *     subscribing, closing the race with its independently-running
     *     background startup probe;
     *   - prune `providersRef` of instances that no longer exist.
     *
     * Provider refreshes are owned by each managed provider and never run
     * on this layer's construction path. Consumers see cached or pending
     * snapshots immediately, then receive live probe results through the
     * already-attached change stream.
     *
     * Per-instance subscription fibers are not tracked explicitly. When
     * a rebuilt instance's old child scope closes, its PubSub shuts
     * down and our `Stream.runForEach` fiber exits naturally.
     */
    const syncLiveSources = syncSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const instances = yield* instanceRegistry.listInstances;
        const unavailableProviders = yield* instanceRegistry.listUnavailable;
        const nextByInstance = new Map<ProviderInstanceId, ProviderInstance>(
          instances.map((instance) => [instance.instanceId, instance] as const),
        );
        const knownInstanceIds = new Set<ProviderInstanceId>(nextByInstance.keys());
        for (const provider of unavailableProviders) {
          knownInstanceIds.add(snapshotInstanceKey(provider));
        }
        const previousSubs = yield* Ref.get(liveSubsRef);

        // Carry over subscriptions for instances whose identity is
        // unchanged (reconcile treated them as no-op). Instances that
        // disappeared, or were rebuilt with a different reference,
        // fall through to the "newly-added" branch below.
        const carriedOver = new Map<ProviderInstanceId, ProviderInstance>();
        for (const [instanceId, previousInstance] of previousSubs) {
          const nextInstance = nextByInstance.get(instanceId);
          if (nextInstance !== undefined && nextInstance === previousInstance) {
            carriedOver.set(instanceId, previousInstance);
          }
        }

        // Collect new/rebuilt instances in `nextByInstance` insertion
        // order (which preserves settings-author order).
        const newlyAdded: Array<readonly [ProviderInstanceId, ProviderInstance]> = [];
        for (const [instanceId, instance] of nextByInstance) {
          if (carriedOver.has(instanceId)) {
            continue;
          }
          newlyAdded.push([instanceId, instance] as const);
        }

        const retiredFencedIds = new Set<ProviderInstanceId>();
        for (const [instanceId, previousInstance] of previousSubs) {
          if (previousInstance.runtimeFence === undefined) continue;
          const nextInstance = nextByInstance.get(instanceId);
          if (nextInstance?.runtimeFence?.generation !== previousInstance.runtimeFence.generation) {
            retiredFencedIds.add(instanceId);
          }
        }
        if (retiredFencedIds.size > 0) {
          const dropRetired = <A>(previous: ReadonlyMap<ProviderInstanceId, A>) => {
            const next = new Map(previous);
            for (const instanceId of retiredFencedIds) next.delete(instanceId);
            return next;
          };
          yield* Effect.all(
            [
              Ref.update(maintenanceActionStatesRef, dropRetired),
              Ref.update(rateLimitStatesRef, dropRetired),
              Ref.update(pushedUsageRef, dropRetired),
              Ref.update(capacityOverlayRef, dropRetired),
              Ref.update(capacityRunsRef, dropRetired),
            ],
            { discard: true },
          );
          const [beforeRetirement, afterRetirement] = yield* Ref.modify(
            providersRef,
            (previous) => {
              const next = previous.filter(
                (provider) => !retiredFencedIds.has(snapshotInstanceKey(provider)),
              );
              return [[previous, next] as const, next];
            },
          );
          if (haveProvidersChanged(beforeRetirement, afterRetirement)) {
            yield* PubSub.publish(changesPubSub, afterRetirement);
          }
        }

        // Fork long-lived subscriptions to each new/rebuilt instance's
        // change stream before reading its current snapshot. If the
        // driver's own initial probe finishes during this sync, either
        // the current read or the active subscriber observes the result.
        for (const [instanceId, instance] of newlyAdded) {
          const previousFiber = (yield* Ref.get(subscriptionFibersRef)).get(instanceId);
          if (previousFiber !== undefined) yield* Fiber.interrupt(previousFiber);
          const source = buildSnapshotSource(instance);
          const fiber = yield* Stream.runForEach(source.streamChanges, (provider) =>
            sourceIsCurrent(source).pipe(
              Effect.flatMap((current) =>
                current
                  ? correlateSnapshotWithSource(source, provider).pipe(
                      Effect.flatMap((correlated) =>
                        syncProvider(correlated, {
                          runtimeFence: source.runtimeFence,
                          replace: retiredFencedIds.has(instanceId),
                        }),
                      ),
                    )
                  : Effect.void,
              ),
            ),
          ).pipe(Effect.forkScoped);
          yield* Ref.update(subscriptionFibersRef, (previous) => {
            const next = new Map(previous);
            next.set(instanceId, fiber);
            return next;
          });
        }
        yield* Effect.yieldNow;

        // Snapshot current state without starting a probe. Managed providers
        // launch their startup refresh independently, so this closes the
        // subscription race without putting external work on the registry
        // or HTTP server construction path.
        yield* Effect.forEach(
          newlyAdded,
          ([, instance]) =>
            Effect.gen(function* () {
              const source = buildSnapshotSource(instance);
              const provider = yield* source.getSnapshot;
              if (!(yield* sourceIsCurrent(source))) return;
              yield* correlateSnapshotWithSource(source, provider).pipe(
                Effect.flatMap((correlated) =>
                  syncProvider(correlated, {
                    runtimeFence: source.runtimeFence,
                    replace: retiredFencedIds.has(instance.instanceId),
                  }),
                ),
              );
            }).pipe(Effect.ignoreCause({ log: true })),
          { concurrency: "unbounded", discard: true },
        );
        yield* upsertProviders(unavailableProviders, {
          persist: false,
          replace: true,
        });

        const nextSubs = new Map(carriedOver);
        for (const [instanceId, instance] of newlyAdded) {
          nextSubs.set(instanceId, instance);
        }
        yield* Ref.set(liveSubsRef, nextSubs);
        const subscriptionFibers = yield* Ref.get(subscriptionFibersRef);
        for (const [instanceId, fiber] of subscriptionFibers) {
          if (nextSubs.has(instanceId)) continue;
          yield* Fiber.interrupt(fiber);
          yield* Ref.update(subscriptionFibersRef, (previous) => {
            const next = new Map(previous);
            if (next.get(instanceId) === fiber) next.delete(instanceId);
            return next;
          });
        }

        // Drop aggregator state for instances that have disappeared —
        // otherwise the UI would keep rendering ghosts.
        const [previousProviders, providers] = yield* Ref.modify(
          providersRef,
          (previousProviders) => {
            const providers = orderProviderSnapshots(
              previousProviders.filter((provider) =>
                knownInstanceIds.has(snapshotInstanceKey(provider)),
              ),
            );
            return [[previousProviders, providers] as const, providers];
          },
        );
        if (haveProvidersChanged(previousProviders, providers)) {
          yield* PubSub.publish(changesPubSub, providers);
        }
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const next = new Map(previous);
          for (const instanceId of previous.keys()) {
            if (!knownInstanceIds.has(instanceId)) {
              next.delete(instanceId);
            }
          }
          return next;
        });
        yield* Ref.update(pushedUsageRef, (previous) => {
          const next = new Map(previous);
          for (const instanceId of previous.keys()) {
            if (!knownInstanceIds.has(instanceId)) {
              next.delete(instanceId);
            }
          }
          return next;
        });
        yield* Ref.update(capacityOverlayRef, (previous) => {
          const next = new Map(previous);
          for (const instanceId of previous.keys()) {
            if (!knownInstanceIds.has(instanceId)) {
              next.delete(instanceId);
            }
          }
          return next;
        });
      }),
    );
    const syncLiveSourcesAndContinue = syncLiveSources.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logError(
          "provider registry instance sync failed; keeping subscription alive",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );

    // Seed `providersRef` with the boot-time fallback snapshots so
    // consumers calling `getProviders` immediately after layer build see
    // a populated list — even before the first `syncLiveSources` refresh
    // resolves. Cached snapshots (already in `providersRef`) merge with
    // these via `upsertProviders` so on-disk state wins where present
    // and pending fallbacks fill the gaps.
    yield* upsertProviders(fallbackProviders, { publish: false });
    // Subscribe to registry mutations BEFORE running the initial sync.
    // `subscribeChanges` acquires the dequeue synchronously in this
    // fibre; the subscription is active the instant this `yield*`
    // returns. Forking the consumer loop later cannot lose a publish
    // because no publish can reach a not-yet-subscribed dequeue.
    //
    // (Contrast with the pre-fix code that did
    // `Stream.runForEach(instanceRegistry.streamChanges, …).pipe(Effect.forkScoped)`.
    // `Stream.fromPubSub` defers `PubSub.subscribe` to stream start,
    // and `forkScoped` only schedules the fibre — so a reconcile that
    // published between "fibre scheduled" and "fibre starts running"
    // was dropped, which made any settings change that replaced an
    // instance never propagate to the aggregator's `providersRef`.)
    // Subscribe to registry mutations BEFORE running the initial sync.
    // `subscribeChanges` acquires the `PubSub.Subscription` synchronously
    // in this fibre; the subscription is registered with the PubSub the
    // instant this `yield*` returns, so any subsequent publish is
    // buffered in the subscription regardless of when the consumer
    // fibre below actually starts running.
    //
    // (Contrast with the pre-fix code that did
    // `Stream.runForEach(instanceRegistry.streamChanges, …).pipe(Effect.forkScoped)`.
    // `instanceRegistry.streamChanges` is `Stream.fromPubSub(changes)`,
    // which defers `PubSub.subscribe` to stream start. `forkScoped` only
    // schedules the consumer fibre — so a reconcile that published
    // between "fibre scheduled" and "fibre starts running + subscribes"
    // was dropped, which made any settings change that replaced an
    // instance never propagate to the aggregator's `providersRef`.)
    const instanceChanges = yield* instanceRegistry.subscribeChanges;
    // Initial sync attaches subscriptions and snapshots current state for
    // every instance present at boot. Provider probes are already running in
    // their managed background fibers and never block this layer.
    yield* syncLiveSources;
    // React to registry mutations — instance added / removed / rebuilt.
    // `Stream.fromSubscription` builds a stream over the pre-acquired
    // subscription rather than subscribing on stream start, which is
    // what closes the race.
    yield* Stream.runForEach(
      Stream.fromSubscription(instanceChanges),
      () => syncLiveSourcesAndContinue,
    ).pipe(Effect.forkScoped);

    const recoverRefreshFailure = Effect.fn("recoverRefreshFailure")(function* (
      cause: Cause.Cause<unknown>,
    ) {
      if (Cause.hasInterruptsOnly(cause)) {
        return yield* Effect.interrupt;
      }
      yield* Effect.logError("provider registry refresh failed; preserving cached providers", {
        cause: Cause.pretty(cause),
      });
      return yield* Ref.get(providersRef);
    });

    return {
      getProviders: Ref.get(providersRef),
      refresh: (provider?: ProviderDriverKind) =>
        refresh(provider).pipe(Effect.catchCause(recoverRefreshFailure)),
      refreshInstance: (instanceId: ProviderInstanceId) =>
        refreshInstance(instanceId).pipe(Effect.catchCause(recoverRefreshFailure)),
      getProviderMaintenanceCapabilitiesForInstance,
      getProviderRuntimeFence: (instanceId: ProviderInstanceId) =>
        instanceRegistry
          .getInstance(instanceId)
          .pipe(Effect.map((instance) => instance?.runtimeFence)),
      setProviderMaintenanceActionState,
      setProviderRateLimitState,
      mergeProviderUsageWindows,
      refreshProviderCapacity,
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
);
