/**
 * Instance-aware view over the wire `ServerProvider[]`.
 *
 * The wire carries one `ServerProvider` per *configured instance* — the
 * default built-in codex instance, a user-authored `codex_personal`, an
 * unavailable shadow for a fork driver, etc. Legacy UI code collapsed these
 * into a single bucket per built-in driver via `.find((p) => p.driver === kind)`,
 * which silently dropped every custom instance after the first. This module
 * replaces that pattern with `ProviderInstanceEntry[]`, keyed on
 * `ProviderInstanceId`, so the model picker, settings list, and composer
 * can treat built-in and custom instances uniformly.
 *
 * @module providerInstances
 */
import {
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  providerInstancePrioritySortKey,
  resolveProviderInstanceEnabled,
  type ModelSelection,
  type ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
  type ServerProviderState,
} from "@t3tools/contracts";

import { formatProviderDriverKindLabel } from "./providerModels";

/**
 * Local-only placeholder used while a draft has no provider it can safely
 * target. It must never be persisted or dispatched; the composer disables
 * send until a live provider replaces it.
 */
export const NO_PROVIDER_MODEL_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("t3code_no_provider"),
  model: "",
};

/**
 * UI-facing projection of one configured provider instance. Carries the
 * snapshot verbatim for callers that need server-side fields we don't
 * hoist here, plus the precomputed `instanceId` / `driverKind` /
 * `displayName` used by every picker and settings view.
 */
export interface ProviderInstanceEntry {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly continuationGroupKey?: string | undefined;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: ServerProviderState;
  /**
   * True when this entry is the default instance for its driver kind —
   * i.e. its instance id equals `defaultInstanceIdForDriver(driverKind)`.
   * The settings panel and picker sort defaults before customs.
   */
  readonly isDefault: boolean;
  /** True when `availability === "unavailable"` is absent or "available". */
  readonly isAvailable: boolean;
  /**
   * Configured drain order, lower first. Only `applyProviderInstanceSettings`
   * can populate it — priority lives in settings, not on the wire snapshot.
   */
  readonly priority?: number | undefined;
  readonly snapshot: ServerProvider;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

/**
 * Whether an instance can currently contribute models to an interactive picker.
 *
 * Disabling an instance updates `enabled` independently, while its previous
 * `ready` probe status can remain in the streamed snapshot until reconciliation.
 */
export function isProviderInstancePickerReady(entry: ProviderInstanceEntry): boolean {
  return entry.enabled && entry.isAvailable && entry.status === "ready";
}

/** Picker rails contain configured, enabled instances only. */
export function isProviderInstancePickerVisible(entry: ProviderInstanceEntry): boolean {
  return entry.enabled;
}

/**
 * Turn an instance id slug into a human-readable label. Splits on `_` / `-`
 * and camelCase boundaries and title-cases each token, so `codex_personal`
 * becomes "Codex Personal" and `myCustomInstance` becomes "My Custom
 * Instance".
 *
 * This is a fallback used only when the wire snapshot's `displayName`
 * doesn't disambiguate a non-default instance from the default one of the
 * same driver (today every built-in driver hard-codes a single presentation
 * label per kind, so two instances of the same kind arrive with identical
 * display names). When a server/driver later plumbs the user's configured
 * `ProviderInstanceConfig.displayName` through to the snapshot, that value
 * will take precedence over this fallback.
 */
function humanizeInstanceId(instanceId: ProviderInstanceId): string {
  const words: string[] = [];
  for (const token of instanceId
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")) {
    if (token.length === 0) continue;
    words.push(token.charAt(0).toUpperCase() + token.slice(1));
  }
  return words.join(" ");
}

function driverKindLabel(driverKind: ProviderDriverKind): string {
  return PROVIDER_DISPLAY_NAMES[driverKind] ?? formatProviderDriverKindLabel(driverKind);
}

/**
 * Whether an instance's icon carries the account badge: accent color set, or
 * several instances sharing a driver so the brand glyph alone is ambiguous.
 * Shared by the composer trigger, the picker rail, and sidebar rows.
 */
export function shouldShowInstanceBadge(
  entry: ProviderInstanceEntry,
  entries: Iterable<ProviderInstanceEntry>,
): boolean {
  if (entry.accentColor) return true;
  let sharedDriverCount = 0;
  for (const candidate of entries) {
    if (candidate.driverKind === entry.driverKind && ++sharedDriverCount > 1) return true;
  }
  return false;
}

export function normalizeProviderAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}

/**
 * Resolve an entry's displayName with a tiered priority:
 *
 *   1. A snapshot `displayName` that differs from the driver-kind label —
 *      the server has explicitly named this instance, trust it.
 *   2. For non-default instances, a humanized `instanceId` — the server
 *      fell back to the driver-level presentation constant (which is the
 *      same for every instance of that kind), so we differentiate at the
 *      UI layer by slug. This is what keeps "Codex" + "Codex Personal"
 *      distinguishable in tooltips and list labels today.
 *   3. The snapshot's `displayName` (if any) — default instance, trust
 *      whatever label the driver stamped.
 *   4. `driverKindLabel(driverKind)` — nothing else on hand, so use the
 *      canonical brand label from contracts (falling back to a generic
 *      title-case of the kind slug).
 */
function resolveInstanceDisplayName(
  snapshot: ServerProvider,
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  isDefault: boolean,
): string {
  const trimmedSnapshotName = snapshot.displayName?.trim();
  const kindLabel = driverKindLabel(driverKind);
  if (trimmedSnapshotName && trimmedSnapshotName !== kindLabel) {
    return trimmedSnapshotName;
  }
  if (!isDefault) {
    const humanized = humanizeInstanceId(instanceId);
    if (humanized.length > 0) return humanized;
  }
  return trimmedSnapshotName || kindLabel;
}

/**
 * Project the wire `ServerProvider[]` into instance entries, one per
 * configured instance. Preserves the server's ordering (which sources
 * from `deriveProviderInstanceConfigMap` — explicit `providerInstances.*`
 * first, synthesized defaults after) so callers that want "default first"
 * should sort with `sortProviderInstanceEntries` below.
 */
export function deriveProviderInstanceEntries(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderInstanceEntry> {
  return providers.map((snapshot) => {
    const instanceId = snapshot.instanceId;
    const driverKind = snapshot.driver;
    const defaultId = defaultInstanceIdForDriver(driverKind);
    const isDefault = instanceId === defaultId;
    const displayName = resolveInstanceDisplayName(snapshot, instanceId, driverKind, isDefault);
    return {
      instanceId,
      driverKind,
      displayName,
      accentColor: normalizeProviderAccentColor(snapshot.accentColor),
      continuationGroupKey: snapshot.continuation?.groupKey,
      enabled: snapshot.enabled,
      installed: snapshot.installed,
      status: snapshot.status,
      isDefault,
      isAvailable: snapshot.availability !== "unavailable",
      snapshot,
      models: snapshot.models,
    } satisfies ProviderInstanceEntry;
  });
}

/**
 * Project several environments' `ServerProvider[]` into a nested
 * `environmentId → instanceId → entry` lookup.
 *
 * Instance ids are per-environment routing keys, and `defaultInstanceIdForDriver`
 * makes the default id literally the driver slug, so every environment running
 * the same driver reports the same id. Flattening across environments would
 * clobber entries and mis-resolve accent colors; lookups must stay scoped to
 * the thread's own environment.
 */
export function deriveProviderEntriesByEnvironment(
  providersByEnvironment: Iterable<readonly [string, ReadonlyArray<ServerProvider>]>,
): ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>> {
  const byEnvironment = new Map<string, ReadonlyMap<string, ProviderInstanceEntry>>();
  for (const [environmentId, providers] of providersByEnvironment) {
    byEnvironment.set(
      environmentId,
      new Map(
        deriveProviderInstanceEntries(providers).map(
          (entry) => [entry.instanceId as string, entry] as const,
        ),
      ),
    );
  }
  return byEnvironment;
}

/**
 * Overlay the current settings configuration onto streamed provider snapshots.
 * Provider probes can briefly retain their previous `enabled` value after a
 * settings write, so picker visibility must follow settings rather than waiting
 * for probe reconciliation.
 *
 * Non-default instances only exist through `providerInstances`; if one is
 * absent there, its streamed snapshot is stale (for example immediately after
 * deletion) and is treated as disabled.
 */
export function applyProviderInstanceSettings(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  settings: Pick<ServerSettings, "providerInstances" | "providers">,
): ReadonlyArray<ProviderInstanceEntry> {
  const legacyProviders = settings.providers as Readonly<
    Record<string, { readonly enabled?: boolean } | undefined>
  >;

  return entries.map((entry) => {
    const explicitInstance = settings.providerInstances?.[entry.instanceId];
    const enabled = explicitInstance
      ? resolveProviderInstanceEnabled(explicitInstance)
      : entry.isDefault
        ? (legacyProviders[entry.driverKind]?.enabled ?? entry.enabled)
        : false;
    const priority = explicitInstance?.priority;
    if (enabled === entry.enabled && priority === entry.priority) return entry;
    return { ...entry, enabled, priority };
  });
}

/**
 * Whether an instance is currently refusing turns because its subscription
 * window is spent, as of `nowMs`.
 *
 * A `rejected` verdict without a `resetsAt` does not count. Without a reset
 * time there is nothing to expire, and routing permanently away from an
 * account on a signal that never clears is worse than trying it and letting
 * the provider report the real error — every verdict Claude actually sends
 * carries a reset time.
 */
export function isProviderInstanceDrained(entry: ProviderInstanceEntry, nowMs: number): boolean {
  const rateLimit = entry.snapshot.rateLimit;
  if (rateLimit?.status !== "rejected" || rateLimit.resetsAt === undefined) return false;
  const resetsAtMs = Date.parse(rateLimit.resetsAt);
  return Number.isFinite(resetsAtMs) && resetsAtMs > nowMs;
}

/**
 * Order instances for automatic routing: instances that can serve a turn now
 * before drained ones, then by configured `priority`, then by the caller's
 * existing order.
 *
 * Drained instances are pushed to the back rather than dropped, so a caller
 * that finds every instance drained still resolves one. Attempting a turn and
 * surfacing the provider's own error beats a composer that refuses to send.
 */
export function sortProviderInstancesForRouting(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  nowMs: number,
): ReadonlyArray<ProviderInstanceEntry> {
  return [...entries].sort((left, right) => {
    const drainedDelta =
      Number(isProviderInstanceDrained(left, nowMs)) -
      Number(isProviderInstanceDrained(right, nowMs));
    if (drainedDelta !== 0) return drainedDelta;
    return providerInstancePrioritySortKey(left) - providerInstancePrioritySortKey(right);
  });
}

/**
 * Sort instance entries so the default instance of each driver kind appears
 * before any custom instances of the same kind. Within a kind, custom
 * instances keep their settings-author order (which is how the server
 * emits them). Stable across kinds: entries retain the server's
 * cross-driver ordering.
 */
export function sortProviderInstanceEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<ProviderInstanceEntry> {
  // Group by driver kind preserving first-appearance order, then emit
  // default-first within each kind. Using a Map keeps the "first-seen"
  // semantics for kinds whose default instance is absent (unusual but
  // possible during the migration).
  const byKind = new Map<ProviderDriverKind, ProviderInstanceEntry[]>();
  for (const entry of entries) {
    const bucket = byKind.get(entry.driverKind);
    if (bucket) {
      bucket.push(entry);
    } else {
      byKind.set(entry.driverKind, [entry]);
    }
  }
  const sorted: ProviderInstanceEntry[] = [];
  for (const bucket of byKind.values()) {
    const defaults = bucket.filter((entry) => entry.isDefault);
    const customs = bucket.filter((entry) => !entry.isDefault);
    sorted.push(...defaults, ...customs);
  }
  return sorted;
}

/**
 * Look up a single instance entry by exact `instanceId`. Missing snapshots
 * are not inferred from driver kind in UI routing code.
 */
export function getProviderInstanceEntry(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): ProviderInstanceEntry | undefined {
  return deriveProviderInstanceEntries(providers).find((entry) => entry.instanceId === instanceId);
}

/**
 * Model list for a specific instance. Returns `[]` when the instance isn't
 * present so callers don't have to thread optionality through render code.
 */
export function getProviderInstanceModels(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): ReadonlyArray<ServerProviderModel> {
  return getProviderInstanceEntry(providers, instanceId)?.models ?? [];
}

/**
 * Default model slug for a specific instance: its declared built-in default,
 * then its first built-in model, then any model it reports, then the driver-level default. Custom
 * instances can serve a different model list than the default instance of
 * the same driver kind, so the lookup must be instance-scoped rather than
 * kind-scoped.
 */
export function getDefaultProviderInstanceModel(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): string | undefined {
  const entry = getProviderInstanceEntry(providers, instanceId);
  if (!entry) return undefined;
  return (
    entry.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    entry.models.find((model) => !model.isCustom)?.slug ??
    entry.models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[entry.driverKind]
  );
}

const isSelectableProviderInstanceEntry = (entry: ProviderInstanceEntry): boolean =>
  entry.enabled && entry.isAvailable;

/**
 * Resolve an exact stored instance when it remains enabled and available.
 * Otherwise choose a deterministic fallback that can plausibly start now:
 * ready first, then a non-error probe result. An errored provider is retained
 * only when it was explicitly requested; it is never invented as a new-user
 * default.
 *
 * Only the fallback consults drain state, and it does so through
 * {@link sortProviderInstancesForRouting} — an explicitly requested instance is
 * honored even while it is spent, because that request came from a user's pick
 * or a thread's existing binding. Every caller that lands here without a
 * request (new projects, new threads, a selection whose instance was deleted)
 * gets drain-and-priority ordering without having to know it exists.
 */
export function resolveSelectableProviderInstanceEntry(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  instanceId: ProviderInstanceId | undefined,
  nowMs: number = Date.now(),
): ProviderInstanceEntry | undefined {
  if (instanceId !== undefined) {
    const requested = entries.find((entry) => entry.instanceId === instanceId);
    if (requested && isSelectableProviderInstanceEntry(requested)) {
      return requested;
    }
  }
  const ordered = sortProviderInstancesForRouting(entries, nowMs);
  return (
    ordered.find(isProviderInstancePickerReady) ??
    ordered.find((entry) => isSelectableProviderInstanceEntry(entry) && entry.status !== "error")
  );
}

/**
 * Resolve the routing key for a selection that may reference an instance
 * id that no longer exists (e.g. a persisted thread selection after the
 * user deleted the custom instance). Returns a ready or non-error fallback,
 * or `undefined` when no provider can safely become a new selection.
 *
 * Drain state rides the wire snapshot, so the fallback avoids a spent account
 * here as it does everywhere. Configured `priority` does not: it lives in
 * settings and only reaches an entry through
 * {@link applyProviderInstanceSettings}, which callers holding raw snapshots
 * (project creation against a remote environment, for one) have not applied.
 * Those callers are choosing a stored default rather than routing a turn, and
 * the composer re-resolves with full priority knowledge before anything runs.
 */
export function resolveSelectableProviderInstance(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId | undefined,
  nowMs: number = Date.now(),
): ProviderInstanceId | undefined {
  const entries = deriveProviderInstanceEntries(providers);
  return resolveSelectableProviderInstanceEntry(entries, instanceId, nowMs)?.instanceId;
}

/**
 * Resolve the model selection persisted for a project or new thread. A valid
 * stored selection is preserved byte-for-byte. Falling back to another
 * instance also resets the model to that instance's own default, avoiding
 * cross-provider instance/model pairs.
 */
export function resolveDefaultProviderModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection | null | undefined,
  nowMs: number = Date.now(),
): ModelSelection | null {
  const instanceId = resolveSelectableProviderInstance(providers, selection?.instanceId, nowMs);
  if (instanceId === undefined) return null;
  if (selection?.instanceId === instanceId) return selection;
  const model = getDefaultProviderInstanceModel(providers, instanceId);
  return model ? { instanceId, model } : null;
}

/**
 * Resolve an open model-selection routing key back to a driver kind.
 * Custom instance ids such as `claude_openrouter` are not themselves
 * driver-kind slugs, but the composer still needs the owning driver kind
 * for capabilities, options, icons, and turn dispatch metadata.
 */
export function resolveProviderDriverKindForInstanceSelection(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  providers: ReadonlyArray<ServerProvider>,
  selection: ProviderInstanceId | ProviderDriverKind | null | undefined,
): ProviderDriverKind | undefined {
  const matchedEntry = entries.find((entry) => entry.instanceId === selection);
  if (matchedEntry) {
    return matchedEntry.driverKind;
  }
  return undefined;
}
