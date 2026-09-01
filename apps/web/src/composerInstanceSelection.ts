/**
 * Which configured provider instance the composer is currently targeting.
 *
 * Extracted from the composer so the surfaces beside it — the capacity strip
 * in the context bar, for one — can answer the same question the same way.
 * Two answers to "which account will this go to" is how the strip ends up
 * showing one account while the composer sends to another.
 *
 * Priority:
 *   1. The thread's live session binding. Once present it is the only routing
 *      target for this thread.
 *   2. The composer draft's `activeProvider` while the thread is unbound.
 *   3. The thread's persisted model selection.
 *   4. The project default's instance id.
 *   5. First enabled entry matching the current driver kind.
 *   6. First enabled entry overall / default instance for the kind.
 *
 * A draft from another device can outlive the session transition. It is
 * reported as conflicting and ignored; callers clear only that provider-shaped
 * draft state while keeping prompt text and attachments.
 *
 * Any preferred entry that is explicitly unavailable is held as a blocked
 * selection regardless of priority. Availability means the configured driver
 * cannot materialize on this server, so silently routing the turn to another
 * provider or account would violate the stored choice. Ordinary disabled,
 * missing, stale, and temporarily unhealthy preferences keep their existing
 * fallback behavior.
 *
 * @module composerInstanceSelection
 */
import { getProviderAdmissionAvailability } from "@t3tools/client-runtime/providerAvailability";
import { resolveProviderContinuationTransition } from "@t3tools/client-runtime/providerContinuation";
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
   * The preferred entry exists but cannot materialize on this server. The
   * composer must keep showing this entry and reject turns until a user picks
   * another provider or the entry becomes available.
   */
  readonly blockedByUnavailablePreference: boolean;
  /** A device-local draft points at another instance than the live session. */
  readonly draftConflictsWithSessionBinding: boolean;
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
  const sessionInstanceId = input.sessionInstanceId ?? null;
  const providers = entries.map((entry) => entry.snapshot);
  const draftTransition =
    sessionInstanceId !== null &&
    input.draftActiveProvider != null &&
    input.draftActiveProvider !== sessionInstanceId
      ? resolveProviderContinuationTransition({
          providers,
          currentInstanceId: sessionInstanceId,
          targetInstanceId: input.draftActiveProvider,
        })
      : null;
  const draftConflictsWithSessionBinding = draftTransition?.compatible === false;
  const compatibleDraftInstanceId =
    draftTransition?.compatible === true ? (input.draftActiveProvider ?? null) : null;
  const threadProvider =
    sessionInstanceId ?? input.threadInstanceId ?? input.projectInstanceId ?? null;
  const explicitSelectedInstanceId =
    compatibleDraftInstanceId ?? sessionInstanceId ?? input.draftActiveProvider ?? threadProvider;

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
  }> = sessionInstanceId
    ? [
        ...(compatibleDraftInstanceId === null
          ? []
          : [{ instanceId: compatibleDraftInstanceId, pinned: true }]),
        { instanceId: sessionInstanceId, pinned: true },
      ]
    : [
        { instanceId: input.draftActiveProvider, pinned: true },
        { instanceId: input.threadInstanceId, pinned: false },
        { instanceId: input.projectInstanceId, pinned: false },
      ];

  const finish = (
    instanceId: ProviderInstanceId,
    entry: ProviderInstanceEntry | undefined,
    blockedByUnavailablePreference = false,
  ): ComposerInstanceSelection => ({
    instanceId,
    driverKind: entry?.driverKind ?? requestedDriverKind,
    entry,
    requestedDriverKind,
    blockedByUnavailablePreference,
    draftConflictsWithSessionBinding,
    lockedContinuationGroupKey,
  });

  for (const candidate of candidates) {
    if (!candidate.instanceId) continue;
    const match = entries.find((entry) => entry.instanceId === candidate.instanceId);
    if (!match) {
      if (sessionInstanceId && candidate.instanceId === sessionInstanceId) {
        return finish(sessionInstanceId, undefined);
      }
      continue;
    }
    if (sessionInstanceId && candidate.instanceId === sessionInstanceId) {
      return finish(match.instanceId, match, !match.isAvailable);
    }
    // A started thread can select another instance only when both snapshots
    // prove the exact same non-empty continuation identity.
    if (lockedProvider && match.driverKind !== lockedProvider) continue;
    if (
      lockedInstanceId !== null &&
      !resolveProviderContinuationTransition({
        providers,
        currentInstanceId: lockedInstanceId,
        targetInstanceId: match.instanceId,
      }).compatible
    ) {
      continue;
    }
    // Explicit unavailability is a durable materialization barrier, not a
    // transient readiness signal. Preserve the exact requested routing key so
    // the UI can show the server's remediation and require a deliberate pick.
    if (!match.isAvailable) return finish(match.instanceId, match, true);
    if (!match.enabled) continue;
    // Drained and unpinned: defer to the ordered fallback below, which
    // prefers a healthy instance and lands back here only when every instance
    // is drained.
    if (!candidate.pinned && isProviderInstanceDrained(match, nowMs)) continue;
    return finish(match.instanceId, match);
  }

  const compatibleEntries = entries.filter(
    (entry) =>
      (!lockedProvider || entry.driverKind === lockedProvider) &&
      (lockedInstanceId === null ||
        resolveProviderContinuationTransition({
          providers,
          currentInstanceId: lockedInstanceId,
          targetInstanceId: entry.instanceId,
        }).compatible),
  );
  const requestedDriverEntries = compatibleEntries.filter(
    (entry) => entry.driverKind === requestedDriverKind,
  );
  const fallback =
    resolveSelectableProviderInstanceEntry(requestedDriverEntries, undefined, nowMs) ??
    resolveSelectableProviderInstanceEntry(compatibleEntries, undefined, nowMs);
  return finish(fallback?.instanceId ?? NO_PROVIDER_MODEL_SELECTION.instanceId, fallback);
}

/** Whether the resolved routing target may be admitted as a provider turn. */
export function canStartComposerTurn(selection: ComposerInstanceSelection): boolean {
  return (
    selection.entry !== undefined &&
    selection.entry.enabled &&
    selection.entry.isAvailable &&
    getProviderAdmissionAvailability({
      provider: selection.entry.snapshot,
      instanceId: String(selection.entry.instanceId),
      providerSnapshotKnown: true,
    }).status === "available" &&
    !selection.blockedByUnavailablePreference
  );
}
