/**
 * ProviderDriver / ProviderInstance — driver SPI as plain values.
 *
 * `ProviderDriver` is a record, not a Context.Service. The thing it produces
 * (`ProviderInstance`) is also a record — three captured closures
 * (`snapshot`, `adapter`, `textGeneration`), an id, and a driver kind. There
 * are intentionally no per-driver Context tags because tags are
 * singleton-per-runtime and we need many instances of the same driver.
 *
 * The only Effect service involved is `ProviderInstanceRegistry`, which
 * owns the live `Map<InstanceId, ProviderInstance>` and is itself a
 * singleton.
 *
 * Driver factories are functions of `(typed config, env)` where:
 *   - `typed config` is decoded once by the registry via `configSchema`,
 *     so drivers never deal with raw `unknown`.
 *   - `env` flows through Effect's R channel. Each driver declares the
 *     subset of infrastructure services it needs (FileSystem,
 *     ChildProcessSpawner, …) on its `create` return type; the registry
 *     layer's R is the union of those, and the runtime layer satisfies it.
 *
 * @module provider/ProviderDriver
 */
import type {
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
  ServerProviderBackend,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { ProviderAdapterError, ProviderDriverError } from "./Errors.ts";
import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

/**
 * Static metadata advertised by a driver. Used for default presentation
 * and (later) settings UI. Doesn't need to be Effect-typed because nothing
 * about it is dynamic — drivers are registered at startup.
 */
export interface ProviderDriverMetadata {
  /** Human-readable name for the driver itself (e.g. "Codex"). */
  readonly displayName: string;
  /**
   * Whether the driver may be instantiated more than once concurrently.
   * Missing is fail-closed. Drivers must publish `true` only after their
   * per-instance process, credential, state, and cleanup boundaries are proved.
   */
  readonly supportsMultipleInstances?: boolean;
  /** Actionable explanation when multiple enabled instances are unavailable. */
  readonly multipleInstancesUnavailableReason?: string | undefined;
}

/**
 * One materialized provider instance. Held by the registry, looked up by
 * `instanceId`, torn down by closing the scope it was created in.
 *
 * The three "shape" fields are captured closures owned by this instance —
 * stopping one instance cannot affect another, and starting a second
 * instance of the same driver does not reach into the first instance's
 * state.
 */
export interface ProviderRuntimeFence {
  /** Opaque process-local identity. It must never cross a public or observability boundary. */
  readonly generation: object;
  /** Private disk-cache correlation only. It must never enter a provider snapshot. */
  readonly configRevision?: string | undefined;
  /** Re-read by every async result immediately before it commits side effects. */
  readonly isCurrent: Effect.Effect<boolean>;
}

export interface ProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly snapshot: ServerProviderShape;
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly textGeneration: TextGeneration.TextGeneration["Service"];
  /**
   * Re-read the backends this instance signs in to on its own, when it has
   * any (see `ServerProvider.backends`). The registry runs it after a turn
   * completes on the instance — the one moment an agent's own credential is
   * guaranteed fresh — and folds the result onto the snapshot. Optional:
   * drivers that use Pylon's configured accounts have nothing to read.
   */
  readonly capacity?: ProviderCapacitySource | undefined;
  /** Server-private replacement fence. Prime is the first fenced driver. */
  readonly runtimeFence?: ProviderRuntimeFence | undefined;
}

export interface ProviderCapacitySource {
  /**
   * `undefined` means the source itself could not be observed, so the registry
   * leaves its previous overlay alone. A present refresh is authoritative for
   * backend identities; each backend says whether capacity was actually read.
   */
  readonly refresh: Effect.Effect<ProviderCapacityRefresh | undefined>;
}

export interface ProviderCapacityRefresh {
  readonly backends: ReadonlyArray<ProviderBackendCapacityRead>;
}

export interface ProviderBackendCapacityRead {
  readonly backend: ServerProviderBackend;
  readonly didReadCapacity: boolean;
  /** Private runtime-revision identity. Never derive this value from account or secret material. */
  readonly retentionIdentity?: string | undefined;
}

const capacityReadByBackend = new WeakMap<ServerProviderBackend, ProviderBackendCapacityRead>();

/**
 * Attach process-local capacity identity to the exact backend objects used by
 * a provider snapshot. The metadata never enters the wire or persisted cache.
 */
export function providerBackendsFromCapacityRefresh(
  refresh: ProviderCapacityRefresh,
): ReadonlyArray<ServerProviderBackend> {
  return refresh.backends.map((read) => {
    capacityReadByBackend.set(read.backend, read);
    return read.backend;
  });
}

/** Recover process-local identity from a live provider snapshot, if present. */
export function capacityRefreshFromProviderBackends(
  backends: ReadonlyArray<ServerProviderBackend> | undefined,
): ProviderCapacityRefresh | undefined {
  if (!backends || backends.length === 0) return undefined;
  const reads: ProviderBackendCapacityRead[] = [];
  for (const backend of backends) {
    const read = capacityReadByBackend.get(backend);
    if (!read) return undefined;
    reads.push(read);
  }
  return { backends: reads };
}

export interface ProviderContinuationIdentity {
  readonly driverKind: ProviderDriverKind;
  readonly continuationKey: string;
}

export function defaultProviderContinuationIdentity(input: {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
}): ProviderContinuationIdentity {
  return {
    driverKind: input.driverKind,
    continuationKey: `${input.driverKind}:instance:${input.instanceId}`,
  };
}

/**
 * Inputs the registry passes to a driver's `create` function.
 *
 * `config` is the typed payload — already decoded by the registry through
 * `driver.configSchema`. Drivers never decode their own raw envelope.
 */
export interface ProviderDriverCreateInput<Config> {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly environment: ProviderInstanceEnvironment;
  readonly enabled: boolean;
  readonly config: Config;
  /** Present only when preflight published a process-local replacement generation. */
  readonly runtimeFence?: ProviderRuntimeFence | undefined;
}

/**
 * Driver SPI — registered as a plain value, not a Layer.
 *
 * `Config` is whatever the driver decoded from
 * `ProviderInstanceConfig.config`. `R` is the union of infrastructure
 * services the driver depends on; the registry layer aggregates `R` across
 * all registered drivers and the runtime supplies them.
 *
 * `create` is responsible for *all* per-instance state — process handles,
 * pubsub topics, refs, file watchers — and must release them when its
 * scope closes. Two calls to `create` with different `instanceId` /
 * `config` MUST yield instances with no shared mutable state.
 */
export type ProviderDriverPreflightResult<Preparation> =
  | {
      readonly kind: "ready";
      readonly preparation: Preparation;
      /** Opaque process-local identity, published before an old scope is closed. */
      readonly generation?: object | undefined;
      /** Random server-owned correlation for private disk caches only. */
      readonly configRevision?: string | undefined;
    }
  | { readonly kind: "unavailable"; readonly error: ProviderDriverError };

export interface ProviderDriver<Config, R = never, Preparation = unknown> {
  readonly driverKind: ProviderDriverKind;
  readonly metadata: ProviderDriverMetadata;
  /**
   * Decoder for the opaque `ProviderInstanceConfig.config` envelope. The
   * registry runs this exactly once per (re)load of an instance; a decode
   * failure is surfaced as `ProviderDriverError` and downgraded to an
   * unavailable shadow snapshot.
   *
   * The `Encoded` parameter is intentionally left as `unknown` (not
   * `Config`) so schemas with `withDecodingDefault` / transformations — where
   * the encoded shape differs from the decoded shape — satisfy the SPI
   * without casts. The registry only ever decodes `unknown` envelopes here,
   * so the precise encoded type is irrelevant at this boundary.
   *
   * Using `Codec` rather than `Schema` pins `DecodingServices = never` — if
   * we used `Schema<Config>`, the erased `any` in `AnyProviderDriver` would
   * widen `DecodingServices` to `unknown` and poison the R channel of every
   * caller of `decodeUnknownEffect`.
   */
  readonly configSchema: Schema.Codec<Config, unknown>;
  /**
   * Default config payload used when the legacy
   * `ServerSettings.providers.<kind>` entry is empty or when the driver
   * is auto-bootstrapped without user configuration. Returning a typed
   * default keeps the migration path simple — no special-casing needed
   * to construct a "blank" instance.
   */
  readonly defaultConfig: () => Config;
  /**
   * Optional driver-wide identity preflight. The registry runs this for the
   * complete driver set before it closes or creates any affected instance.
   * The registry must apply unavailable set-wide results to already-live
   * participants before it starts replacements or additions.
   */
  readonly preflight?: (
    inputs: ReadonlyArray<ProviderDriverCreateInput<Config>>,
  ) => Effect.Effect<
    ReadonlyMap<ProviderInstanceId, ProviderDriverPreflightResult<Preparation>>,
    never,
    R
  >;
  /**
   * Materialize one instance. The returned effect runs in a scope owned
   * by the registry; closing that scope releases every resource the
   * driver opened. Failures become unavailable shadow snapshots — the
   * driver MUST NOT throw defects.
   */
  readonly create: {
    bivarianceHack(
      input: ProviderDriverCreateInput<Config>,
      preparation?: Preparation,
    ): Effect.Effect<ProviderInstance, ProviderDriverError, R | Scope.Scope>;
  }["bivarianceHack"];
}

/**
 * Heterogeneous-array convenience: the registry stores drivers as
 * `ReadonlyArray<AnyProviderDriver<R>>` where `R` is the union of all
 * registered drivers' env requirements.
 */
// `any` here intentionally erases the per-driver Config; the registry
// already decoded it before invoking `create`, so downstream code never
// needs the original `Config` type. Using `unknown` instead would force
// `create` callers into casts since `unknown` is not assignable to a
// concrete `Config` from inside the driver body.
export type AnyProviderDriver<R = never> = ProviderDriver<any, R, unknown>;
