/**
 * ProviderInstanceRegistryLive — runtime implementation of
 * `ProviderInstanceRegistry` plus its sibling mutator.
 *
 * Materializes every entry in a `ProviderInstanceConfigMap`:
 *
 *   - When the entry's `driver` matches a registered driver, the registry
 *     decodes the opaque `config` envelope through `driver.configSchema`
 *     and calls `driver.create()` inside a fresh child scope. The
 *     resulting `ProviderInstance` is stored keyed by instance id,
 *     alongside its scope so the entry can be torn down independently.
 *   - When the entry's `driver` is unknown to this build (fork, rollback,
 *     in-flight PR branch), the registry emits an `"unavailable"` shadow
 *     `ServerProvider` snapshot instead of failing. This is what makes
 *     downgrades and fork-hopping safe per the
 *     `forward/backward compatibility invariant` in
 *     `packages/contracts/src/providerInstance.ts`.
 *   - When the entry's config fails schema decode, the registry logs and
 *     emits a shadow snapshot with the schema detail — same bucket as an
 *     unknown driver.
 *
 * Unlike the pre-Slice-D layer, the registry now holds mutable state
 * (`Ref`s + `PubSub`) and exposes an internal mutator
 * (`ProviderInstanceRegistryMutator`) whose `reconcile` method diffs a
 * fresh config map against the live state, tearing down removed instances
 * and building new ones without disturbing unaffected instances.
 *
 * Every live instance runs inside its own child `Scope`. The registry's
 * own scope owns all child scopes via finalizers, so closing the registry
 * tears every instance down in reverse order; closing a single instance
 * (via `reconcile` removing it) leaves the rest untouched.
 *
 * @module provider/Layers/ProviderInstanceRegistryLive
 */
import {
  defaultInstanceIdForDriver,
  providerInstanceConfigEnabledFlag,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { buildUnavailableProviderSnapshot } from "../unavailableProviderSnapshot.ts";
import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../Services/ProviderInstanceRegistry.ts";
import {
  ProviderInstanceRegistryMutator,
  type ProviderInstanceRegistryMutatorShape,
} from "../Services/ProviderInstanceRegistryMutator.ts";
import type {
  AnyProviderDriver,
  ProviderDriverCreateInput,
  ProviderDriverPreflightResult,
  ProviderInstance,
  ProviderRuntimeFence,
} from "../ProviderDriver.ts";

/**
 * Live registry entry: the materialized `ProviderInstance` + the fresh
 * child scope its `create` effect ran in + the original `entry` envelope
 * so `reconcile` can cheaply detect "no-op" updates.
 */
interface LiveEntry {
  readonly instance: ProviderInstance;
  readonly scope: Scope.Closeable;
  readonly entry: ProviderInstanceConfig;
}

/**
 * Internal state shared between the public registry service and the
 * mutator service. Both services are thin shells around these refs.
 */
interface RegistryState {
  readonly entries: Ref.Ref<ReadonlyMap<ProviderInstanceId, LiveEntry>>;
  readonly unavailable: Ref.Ref<ReadonlyMap<ProviderInstanceId, ServerProvider>>;
  readonly generations: Ref.Ref<
    ReadonlyMap<
      ProviderInstanceId,
      { readonly driver: ProviderDriverKind; readonly generation: object }
    >
  >;
  readonly changes: PubSub.PubSub<void>;
  readonly configured: Ref.Ref<ProviderInstanceConfigMap>;
  readonly reconcileSemaphore: Semaphore.Semaphore;
}

/**
 * Structural equality on `ProviderInstanceConfig` envelopes. Used by
 * `reconcile` to skip rebuilds when settings arrive unchanged. Config
 * payloads are opaque `unknown` at the envelope layer; `Equal.equals`
 * falls back to structural equality for plain records, which matches how
 * the schema decode output is constructed.
 */
const entryEqual = (a: ProviderInstanceConfig, b: ProviderInstanceConfig): boolean =>
  Equal.equals(a, b);

/** Labels are presentation-only. They update the snapshot without rematerializing the runtime. */
const materialEntryEqual = (a: ProviderInstanceConfig, b: ProviderInstanceConfig): boolean =>
  Equal.equals(
    {
      driver: a.driver,
      enabled: a.enabled,
      environment: a.environment,
      config: a.config,
    },
    {
      driver: b.driver,
      enabled: b.enabled,
      environment: b.environment,
      config: b.config,
    },
  );

const applyEntryPresentation = (
  provider: ServerProvider,
  entry: ProviderInstanceConfig,
): ServerProvider => {
  const {
    displayName: _displayName,
    accentColor: _accentColor,
    ...providerWithoutPresentation
  } = provider;
  return {
    ...providerWithoutPresentation,
    ...(entry.displayName ? { displayName: entry.displayName } : {}),
    ...(entry.accentColor ? { accentColor: entry.accentColor } : {}),
  };
};

const withEntryPresentation = (
  instance: ProviderInstance,
  entry: ProviderInstanceConfig,
): ProviderInstance => ({
  ...instance,
  displayName: entry.displayName,
  accentColor: entry.accentColor,
  snapshot: {
    maintenanceCapabilities: instance.snapshot.maintenanceCapabilities,
    getSnapshot: instance.snapshot.getSnapshot.pipe(
      Effect.map((provider) => applyEntryPresentation(provider, entry)),
    ),
    refresh: instance.snapshot.refresh.pipe(
      Effect.map((provider) => applyEntryPresentation(provider, entry)),
    ),
    streamChanges: instance.snapshot.streamChanges.pipe(
      Stream.map((provider) => applyEntryPresentation(provider, entry)),
    ),
  },
});

/**
 * Resolve an entry's enabled state. An explicit false on either the
 * envelope or the raw config blob wins (most restrictive) — old settings
 * files can carry both flags with conflicting values, and a user's disable
 * must never be silently undone. Otherwise the envelope flag wins, then the
 * decoded config's flag (which carries the driver schema's default for
 * built-ins and forks alike), then enabled by default.
 */
const resolveEntryEnabled = (entry: ProviderInstanceConfig, typedConfig: unknown): boolean => {
  const rawConfigEnabled = providerInstanceConfigEnabledFlag(entry.config);
  if (entry.enabled === false || rawConfigEnabled === false) {
    return false;
  }
  return entry.enabled ?? providerInstanceConfigEnabledFlag(typedConfig) ?? true;
};

/**
 * Build one live entry from a raw config envelope. Returns either a
 * `LiveEntry` plus undefined unavailable shadow, or a shadow snapshot and
 * undefined entry — callers dispatch to the appropriate Ref bucket.
 */
const buildEntry = <R>(input: {
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
  readonly instanceId: ProviderInstanceId;
  readonly rawInstanceId: string;
  readonly entry: ProviderInstanceConfig;
  readonly generations: RegistryState["generations"];
  readonly preflight?: ReadonlyMap<ProviderInstanceId, ProviderDriverPreflightResult<unknown>>;
}): Effect.Effect<
  | { readonly kind: "live"; readonly live: LiveEntry }
  | { readonly kind: "unavailable"; readonly snapshot: ServerProvider },
  never,
  R
> =>
  Effect.gen(function* () {
    const { driversById, parentScope, instanceId, rawInstanceId, entry, generations, preflight } =
      input;
    const driver = driversById.get(entry.driver);
    if (!driver) {
      return {
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: `Driver '${entry.driver}' is not registered in this build.`,
        }),
      };
    }

    const decoder = Schema.decodeUnknownEffect(driver.configSchema);
    const decodeResult = yield* decoder(entry.config ?? driver.defaultConfig()).pipe(Effect.result);
    if (decodeResult._tag === "Failure") {
      const issue = decodeResult.failure;
      const detail = issue.message ?? String(issue);
      yield* Effect.logError("Failed to decode provider instance config", {
        instanceId: rawInstanceId,
        driver: entry.driver,
        detail,
      });
      return {
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: `Invalid config for instance '${rawInstanceId}': ${detail}`,
        }),
      };
    }

    const typedConfig = decodeResult.success;
    const preparation = preflight?.get(instanceId);
    if (preflight !== undefined && preparation?.kind !== "ready") {
      const detail =
        preparation?.kind === "unavailable"
          ? preparation.error.detail
          : "Provider instance identity preflight did not return a result.";
      return {
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: detail,
        }),
      };
    }

    const runtimeFence: ProviderRuntimeFence | undefined =
      preparation?.kind === "ready" && preparation.generation !== undefined
        ? Object.freeze({
            generation: preparation.generation,
            ...(preparation.configRevision === undefined
              ? {}
              : { configRevision: preparation.configRevision }),
            isCurrent: Ref.get(generations).pipe(
              Effect.map((current) => {
                const published = current.get(instanceId);
                return (
                  published?.driver === entry.driver &&
                  published.generation === preparation.generation
                );
              }),
            ),
          })
        : undefined;
    const createInput = {
      instanceId,
      displayName: entry.displayName,
      accentColor: entry.accentColor,
      environment: entry.environment ?? [],
      enabled: resolveEntryEnabled(entry, typedConfig),
      config: typedConfig,
      ...(runtimeFence === undefined ? {} : { runtimeFence }),
    } satisfies ProviderDriverCreateInput<unknown>;

    const childScope = yield* Scope.make();
    // Attach the child scope to the registry's parent scope: if the
    // registry scope closes, each surviving instance's child scope is
    // closed through this finalizer. `reconcile` manually closes the
    // child scope on remove/replace; subsequent close via the parent's
    // finalizer is a no-op because `Scope.close` is idempotent.
    yield* Scope.addFinalizer(parentScope, Scope.close(childScope, Exit.void).pipe(Effect.ignore));

    const createResult = yield* driver
      .create(createInput, preparation?.kind === "ready" ? preparation.preparation : undefined)
      .pipe(Effect.provideService(Scope.Scope, childScope), Effect.result);
    if (createResult._tag === "Failure") {
      yield* Effect.logError("Failed to create provider instance", {
        instanceId: rawInstanceId,
        driver: entry.driver,
        detail: createResult.failure.detail,
      });
      yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
      return {
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: createResult.failure.detail,
        }),
      };
    }

    return {
      kind: "live" as const,
      live: {
        instance: withEntryPresentation(
          runtimeFence === undefined
            ? createResult.success
            : { ...createResult.success, runtimeFence },
          entry,
        ),
        scope: childScope,
        entry,
      },
    };
  });

/**
 * Reconcile-only implementation of the mutator. Exposed to the hydration
 * layer; never called directly by the rest of the server.
 */
const driverConfigEntries = (
  configMap: ProviderInstanceConfigMap,
  driverKind: ProviderDriverKind,
): ReadonlyArray<readonly [string, ProviderInstanceConfig]> =>
  Object.entries(configMap).filter(([, entry]) => entry.driver === driverKind);

const makeReconcile = <R>(input: {
  readonly state: RegistryState;
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
}): ((configMap: ProviderInstanceConfigMap) => Effect.Effect<void, never, R>) => {
  const { state, driversById, parentScope } = input;
  return (configMap: ProviderInstanceConfigMap) =>
    state.reconcileSemaphore.withPermit(
      Effect.gen(function* () {
        const previousEntries = yield* Ref.get(state.entries);
        const previousUnavailable = yield* Ref.get(state.unavailable);
        const previousConfigMap = yield* Ref.get(state.configured);
        const nextRaw = Object.entries(configMap);
        const nextKeys = new Set<ProviderInstanceId>(
          nextRaw.map(([raw]) => ProviderInstanceId.make(raw)),
        );
        const changedPreflightDrivers = new Set<ProviderDriverKind>();
        const preflightByDriver = new Map<
          ProviderDriverKind,
          ReadonlyMap<ProviderInstanceId, ProviderDriverPreflightResult<unknown>>
        >();

        // Preflight the complete desired set before closing an old instance or
        // starting a new one. An unchanged live instance is retained unless the
        // set-wide result makes that instance unavailable.
        for (const [driverKind, driver] of driversById) {
          if (driver.preflight === undefined) continue;
          const previousDriverEntries = driverConfigEntries(previousConfigMap, driverKind);
          const nextDriverEntries = driverConfigEntries(configMap, driverKind);
          const materialEntries = (
            entries: ReadonlyArray<readonly [string, ProviderInstanceConfig]>,
          ) =>
            entries.map(
              ([id, entry]) =>
                [
                  id,
                  {
                    driver: entry.driver,
                    enabled: entry.enabled,
                    environment: entry.environment,
                    config: entry.config,
                  },
                ] as const,
            );
          if (
            Equal.equals(materialEntries(previousDriverEntries), materialEntries(nextDriverEntries))
          ) {
            continue;
          }
          changedPreflightDrivers.add(driverKind);

          const decoder = Schema.decodeUnknownEffect(driver.configSchema);
          const decodedInputs: Array<ProviderDriverCreateInput<unknown>> = [];
          for (const [rawInstanceId, entry] of nextDriverEntries) {
            const decoded = yield* decoder(entry.config ?? driver.defaultConfig()).pipe(
              Effect.result,
            );
            if (decoded._tag === "Failure") continue;
            decodedInputs.push({
              instanceId: ProviderInstanceId.make(rawInstanceId),
              displayName: entry.displayName,
              accentColor: entry.accentColor,
              environment: entry.environment ?? [],
              enabled: resolveEntryEnabled(entry, decoded.success),
              config: decoded.success,
            });
          }
          preflightByDriver.set(driverKind, yield* driver.preflight(decodedInputs));
        }

        // 1. Identify instances whose material runtime changed. Their generations
        //    are retired before replacement construction, but their scopes close only
        //    after the exact replacement is published.
        const removedIds: Array<ProviderInstanceId> = [];
        const replacedIds = new Set<ProviderInstanceId>();
        const presentationChangedIds = new Set<ProviderInstanceId>();
        for (const [instanceId, live] of previousEntries) {
          if (!nextKeys.has(instanceId)) {
            removedIds.push(instanceId);
            continue;
          }
          const nextEntry = configMap[instanceId];
          const preflightResult = preflightByDriver.get(live.instance.driverKind)?.get(instanceId);
          if (
            (nextEntry !== undefined && !materialEntryEqual(live.entry, nextEntry)) ||
            preflightResult?.kind === "unavailable"
          ) {
            replacedIds.add(instanceId);
          } else if (nextEntry !== undefined && !entryEqual(live.entry, nextEntry)) {
            presentationChangedIds.add(instanceId);
          }
        }

        // Publish the replacement generation before old fibers and scopes begin cleanup.
        // An old callback becomes stale at this single atomic Ref update even if it runs late.
        yield* Ref.update(state.generations, (previous) => {
          const next = new Map(previous);
          for (const id of [...removedIds, ...replacedIds]) next.delete(id);
          for (const [rawInstanceId, entry] of nextRaw) {
            const instanceId = ProviderInstanceId.make(rawInstanceId);
            if (previousEntries.has(instanceId) && !replacedIds.has(instanceId)) continue;
            const preparation = preflightByDriver.get(entry.driver)?.get(instanceId);
            if (preparation?.kind === "ready" && preparation.generation !== undefined) {
              next.set(instanceId, { driver: entry.driver, generation: preparation.generation });
            }
          }
          return next;
        });

        // 2. Build additions and replacements while retired scopes remain alive but fenced.
        // This avoids an observable registry gap and makes all late old callbacks inert. Walk `nextRaw` so the final
        //    entry order follows settings-author order.
        const builtEntries = new Map<ProviderInstanceId, LiveEntry>();
        const builtUnavailable = new Map<ProviderInstanceId, ServerProvider>();
        let orderChanged = false;
        const previousOrder = [...previousEntries.keys()];
        const nextOrder: Array<ProviderInstanceId> = [];

        for (const [rawInstanceId, entry] of nextRaw) {
          const instanceId = ProviderInstanceId.make(rawInstanceId);
          nextOrder.push(instanceId);

          const existing = previousEntries.get(instanceId);
          if (existing !== undefined && !replacedIds.has(instanceId)) {
            // Presentation-only changes keep the exact runtime, generation, and config revision.
            builtEntries.set(
              instanceId,
              presentationChangedIds.has(instanceId)
                ? { ...existing, instance: withEntryPresentation(existing.instance, entry), entry }
                : existing,
            );
            continue;
          }
          const driver = driversById.get(entry.driver);
          const previousShadow = previousUnavailable.get(instanceId);
          if (
            previousShadow !== undefined &&
            driver?.preflight !== undefined &&
            !changedPreflightDrivers.has(entry.driver)
          ) {
            builtUnavailable.set(instanceId, previousShadow);
            continue;
          }

          const result = yield* buildEntry({
            driversById,
            parentScope,
            instanceId,
            rawInstanceId,
            entry,
            generations: state.generations,
            ...(preflightByDriver.has(entry.driver)
              ? { preflight: preflightByDriver.get(entry.driver)! }
              : {}),
          });
          if (result.kind === "live") {
            builtEntries.set(instanceId, result.live);
          } else {
            builtUnavailable.set(instanceId, result.snapshot);
          }
        }

        if (previousOrder.length === nextOrder.length) {
          for (let i = 0; i < previousOrder.length; i++) {
            if (previousOrder[i] !== nextOrder[i]) {
              orderChanged = true;
              break;
            }
          }
        } else {
          orderChanged = true;
        }

        const entriesChanged =
          orderChanged ||
          removedIds.length > 0 ||
          replacedIds.size > 0 ||
          presentationChangedIds.size > 0 ||
          builtEntries.size !== previousEntries.size;
        const unavailableChanged =
          builtUnavailable.size !== previousUnavailable.size ||
          [...builtUnavailable].some(([id, snapshot]) => {
            const prev = previousUnavailable.get(id);
            return prev === undefined || !Equal.equals(prev, snapshot);
          }) ||
          [...previousUnavailable].some(([id]) => !builtUnavailable.has(id));

        // Publish the exact replacement before closing its predecessor. Consumers either see
        // the old fenced instance or the new current instance, never a missing middle state.
        yield* Ref.set(state.entries, builtEntries);
        yield* Ref.set(state.unavailable, builtUnavailable);
        yield* Ref.set(state.configured, configMap);

        for (const id of [...removedIds, ...replacedIds]) {
          const live = previousEntries.get(id);
          if (live) yield* Scope.close(live.scope, Exit.void).pipe(Effect.ignore);
        }

        if (entriesChanged || unavailableChanged) {
          yield* PubSub.publish(state.changes, undefined);
        }
      }),
    );
};

/**
 * Build the registry's runtime state from a concrete configMap. Returns a
 * record containing:
 *
 *   - `registry`: the read-only `ProviderInstanceRegistryShape` to expose
 *     under `ProviderInstanceRegistry`.
 *   - `mutator`: the `ProviderInstanceRegistryMutatorShape` to expose
 *     under `ProviderInstanceRegistryMutator`.
 *   - `reconcile`: the raw reconcile function, provided for convenience so
 *     boot-time layers can hydrate an initial map before publishing the
 *     services.
 *
 * The scope that this effect runs in owns every per-instance child scope
 * created during `reconcile`. Closing that scope closes every live
 * instance.
 */
export const makeProviderInstanceRegistry = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Effect.Effect<
  {
    readonly registry: ProviderInstanceRegistryShape;
    readonly mutator: ProviderInstanceRegistryMutatorShape;
  },
  never,
  R | Scope.Scope
> =>
  Effect.gen(function* () {
    const driversById = new Map<ProviderDriverKind, AnyProviderDriver<R>>(
      input.drivers.map((driver) => [driver.driverKind, driver]),
    );

    // Capture the enclosing scope so per-instance child scopes can be
    // attached to it at `reconcile` time. Without this, `reconcile`
    // called later (e.g. from the hydration layer) would attach child
    // scopes to the *caller's* scope instead of the registry's.
    const parentScope = yield* Scope.Scope;

    // Capture the driver R context at construction time so `reconcile`
    // can be invoked later without re-providing driver dependencies.
    // The service tag's declared `reconcile: Effect<void>` hides R from
    // consumers — we materialize that here.
    const driverContext = yield* Effect.context<R>();

    const entries = yield* Ref.make<ReadonlyMap<ProviderInstanceId, LiveEntry>>(new Map());
    const unavailable = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ServerProvider>>(new Map());
    const generations = yield* Ref.make<
      ReadonlyMap<
        ProviderInstanceId,
        { readonly driver: ProviderDriverKind; readonly generation: object }
      >
    >(new Map());
    const configured = yield* Ref.make<ProviderInstanceConfigMap>({});
    const changes = yield* PubSub.unbounded<void>();
    const reconcileSemaphore = yield* Semaphore.make(1);
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

    const state: RegistryState = {
      entries,
      unavailable,
      generations,
      changes,
      configured,
      reconcileSemaphore,
    };
    const reconcileWithR = makeReconcile({ state, driversById, parentScope });
    const reconcile: ProviderInstanceRegistryMutatorShape["reconcile"] = (configMap) =>
      reconcileWithR(configMap).pipe(Effect.provideContext(driverContext));

    // Hydrate the initial configMap synchronously so callers can read
    // `listInstances` immediately after this effect completes.
    yield* reconcile(input.configMap);

    const registry: ProviderInstanceRegistryShape = {
      getInstance: (id) => Ref.get(entries).pipe(Effect.map((map) => map.get(id)?.instance)),
      listInstances: Ref.get(entries).pipe(
        Effect.map(
          (map) =>
            Array.from(map.values(), (live) => live.instance) as ReadonlyArray<ProviderInstance>,
        ),
      ),
      listUnavailable: Ref.get(unavailable).pipe(
        Effect.map((map) => Array.from(map.values()) as ReadonlyArray<ServerProvider>),
      ),
      // Getters: each read constructs a fresh Stream / Effect descriptor
      // so multiple consumers don't share a single already-started
      // Channel or subscription. Matches the pattern `ProviderRegistry`
      // uses for its own `streamChanges`.
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      // Synchronous subscribe — callers that need to consume changes
      // from a forked fibre must acquire the subscription in their own
      // fibre first (via `yield* registry.subscribeChanges`) and only
      // then fork a consumer loop on `Stream.fromSubscription(...)` /
      // `PubSub.take(...)`. See the shape docs for the race this avoids.
      get subscribeChanges() {
        return PubSub.subscribe(changes);
      },
    };

    const mutator: ProviderInstanceRegistryMutatorShape = { reconcile };

    return { registry, mutator };
  });

/**
 * Assemble a `ProviderInstanceRegistry` Layer bound to a fixed set of
 * drivers and a pre-resolved `ProviderInstanceConfigMap`. Used by tests
 * that want explicit control over the registry's source-of-truth without
 * wiring up the settings watcher.
 *
 * Only exposes the public registry tag — hot-reload consumers should use
 * `ProviderInstanceRegistryMutableLayer` (below) or the hydration layer.
 */
export const ProviderInstanceRegistryLayer = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Layer.Layer<ProviderInstanceRegistry, never, R> =>
  Layer.effect(
    ProviderInstanceRegistry,
    makeProviderInstanceRegistry(input).pipe(Effect.map((built) => built.registry)),
  ) as Layer.Layer<ProviderInstanceRegistry, never, R>;

/**
 * Layer variant that also exposes the mutator tag. Consumed by
 * `ProviderInstanceRegistryHydrationLive` to reconcile on settings
 * changes. Tests that exercise the mutator directly can pair this Layer
 * with a test-local `ServerSettingsService`.
 */
export const ProviderInstanceRegistryMutableLayer = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Layer.Layer<ProviderInstanceRegistry | ProviderInstanceRegistryMutator, never, R> =>
  Layer.effectContext(
    makeProviderInstanceRegistry(input).pipe(
      Effect.map(({ registry, mutator }) =>
        Context.make(ProviderInstanceRegistry, registry).pipe(
          Context.add(ProviderInstanceRegistryMutator, mutator),
        ),
      ),
    ),
  ) as Layer.Layer<ProviderInstanceRegistry | ProviderInstanceRegistryMutator, never, R>;

export { defaultInstanceIdForDriver };
