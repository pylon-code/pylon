/**
 * Which configured provider instance the composer is currently targeting.
 *
 * Extracted from the composer so the surfaces beside it — the capacity strip
 * in the context bar, for one — can answer the same question the same way.
 * Two answers to "which account will this go to" is how the strip ends up
 * showing one account while the composer sends to another.
 *
 * Priority:
 *   1. The composer draft's `activeProvider` — the user's unsaved pick from
 *      the model picker (must win, otherwise the UI appears to ignore picker
 *      selections).
 *   2. The thread's live session binding (server-side saved selection).
 *   3. The thread's persisted model selection.
 *   4. The project default's instance id.
 *   5. First enabled entry matching the current driver kind.
 *   6. First enabled entry overall / default instance for the kind.
 *
 * Candidates 1 and 2 are pinned: an explicit picker choice and a thread's
 * live session binding are honored even when that account is spent, so an
 * existing thread never migrates off the account it started on. Everything
 * below them has not bound to a session yet and is free to route around a
 * drained account, in configured priority order.
 *
 * @module composerInstanceSelection
 */
import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";

import {
  isProviderInstanceDrained,
  NO_PROVIDER_MODEL_SELECTION,
  resolveProviderDriverKindForInstanceSelection,
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "./providerInstances";

export interface ComposerInstanceSelectionInput {
  /** Instance entries with settings applied, in picker order. */
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  /** The composer draft's unsaved pick from the model picker. */
  readonly draftActiveProvider: ProviderInstanceId | null | undefined;
  /** The instance the thread's live session is bound to, once it has one. */
  readonly sessionInstanceId: ProviderInstanceId | null | undefined;
  /** The thread's persisted model selection. */
  readonly threadInstanceId: ProviderInstanceId | null | undefined;
  /** The project's default model selection. */
  readonly projectInstanceId: ProviderInstanceId | null | undefined;
  /** Driver kind a started thread is locked to, or null while unlocked. */
  readonly lockedProvider: ProviderDriverKind | null;
  /**
   * Drain windows run for hours, so callers read `Date.now()` once per
   * recompute rather than ticking; the composer already recomputes on every
   * provider snapshot and thread change.
   */
  readonly nowMs: number;
}

export interface ComposerInstanceSelection {
  readonly instanceId: ProviderInstanceId;
  /** Driver kind of the instance that will actually run the turn. */
  readonly driverKind: ProviderDriverKind;
  readonly entry: ProviderInstanceEntry | undefined;
  /**
   * Driver kind the selection asked for before availability was applied. It
   * can differ from `driverKind` when the persisted selection is disabled and
   * no instance of that kind is available.
   */
  readonly requestedDriverKind: ProviderDriverKind;
  /**
   * Continuation group a locked thread must stay inside, or null while the
   * thread is unlocked or its instance has no group.
   */
  readonly lockedContinuationGroupKey: string | null;
}

export function resolveComposerInstanceSelection(
  input: ComposerInstanceSelectionInput,
): ComposerInstanceSelection {
  const { entries, lockedProvider, nowMs } = input;
  const threadProvider =
    input.sessionInstanceId ?? input.threadInstanceId ?? input.projectInstanceId ?? null;
  const explicitSelectedInstanceId = input.draftActiveProvider ?? threadProvider;

  const unlockedSelectedProvider =
    resolveProviderDriverKindForInstanceSelection(entries, [], explicitSelectedInstanceId) ??
    entries[0]?.driverKind ??
    ProviderDriverKind.make("unconfigured");
  const requestedDriverKind: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;

  const lockedInstanceId = lockedProvider
    ? (input.sessionInstanceId ?? input.threadInstanceId ?? null)
    : null;
  const lockedContinuationGroupKey = lockedInstanceId
    ? (entries.find((entry) => entry.instanceId === lockedInstanceId)?.continuationGroupKey ?? null)
    : null;

  const candidates: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId | null | undefined;
    readonly pinned: boolean;
  }> = [
    { instanceId: input.draftActiveProvider, pinned: true },
    { instanceId: input.sessionInstanceId, pinned: true },
    { instanceId: input.threadInstanceId, pinned: false },
    { instanceId: input.projectInstanceId, pinned: false },
  ];

  const finish = (
    instanceId: ProviderInstanceId,
    entry: ProviderInstanceEntry | undefined,
  ): ComposerInstanceSelection => ({
    instanceId,
    driverKind: entry?.driverKind ?? requestedDriverKind,
    entry,
    requestedDriverKind,
    lockedContinuationGroupKey,
  });

  for (const candidate of candidates) {
    if (!candidate.instanceId) continue;
    const match = entries.find(
      (entry) => entry.instanceId === candidate.instanceId && entry.enabled && entry.isAvailable,
    );
    if (!match) continue;
    // When locked to a specific driver kind, ignore persisted instance ids
    // from a different kind or continuation group.
    if (lockedProvider && match.driverKind !== lockedProvider) continue;
    if (lockedContinuationGroupKey && match.continuationGroupKey !== lockedContinuationGroupKey) {
      continue;
    }
    // Drained and unpinned: defer to the ordered fallback below, which
    // prefers a healthy instance and lands back here only when every instance
    // is drained.
    if (!candidate.pinned && isProviderInstanceDrained(match, nowMs)) continue;
    return finish(match.instanceId, match);
  }

  const compatibleEntries = entries.filter(
    (entry) =>
      (!lockedProvider || entry.driverKind === lockedProvider) &&
      (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey),
  );
  const requestedDriverEntries = compatibleEntries.filter(
    (entry) => entry.driverKind === requestedDriverKind,
  );
  const fallback =
    resolveSelectableProviderInstanceEntry(requestedDriverEntries, undefined, nowMs) ??
    resolveSelectableProviderInstanceEntry(compatibleEntries, undefined, nowMs);
  return finish(fallback?.instanceId ?? NO_PROVIDER_MODEL_SELECTION.instanceId, fallback);
}
