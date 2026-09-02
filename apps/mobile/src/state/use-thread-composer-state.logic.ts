import { resolveProviderContinuationTransition } from "@t3tools/client-runtime/providerContinuation";
import type {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ServerProvider,
} from "@t3tools/contracts";

export interface ExistingThreadComposerSettings {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

interface DraftComposerSettings {
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}

/**
 * A persisted provider session owns the continuation identity for an existing
 * thread. Device-local draft settings may use the bound instance or an exact
 * same-driver continuation peer. Every accepted selection stays intact; model
 * and options are never transplanted onto another instance id.
 */
export function resolveExistingThreadComposerSettings(input: {
  readonly thread: ExistingThreadComposerSettings;
  readonly sessionProviderInstanceId?: ModelSelection["instanceId"] | undefined;
  readonly providers?: ReadonlyArray<ServerProvider> | undefined;
  readonly draft?: DraftComposerSettings | null | undefined;
}): Omit<ExistingThreadComposerSettings, "modelSelection"> & {
  readonly modelSelection: ModelSelection | null;
  readonly rejectedDraftProviderSelection: boolean;
  readonly providerBindingMismatch: boolean;
} {
  const boundInstanceId = input.sessionProviderInstanceId;
  const draftSelection = input.draft?.modelSelection;
  const draftTransition =
    boundInstanceId !== undefined &&
    draftSelection !== undefined &&
    draftSelection.instanceId !== boundInstanceId
      ? resolveProviderContinuationTransition({
          providers: input.providers ?? [],
          currentInstanceId: boundInstanceId,
          targetInstanceId: draftSelection.instanceId,
        })
      : null;
  const rejectedDraftProviderSelection = draftTransition?.compatible === false;

  // A conflicting local draft is a durable blocked choice, not a stale seed.
  // Keep its exact model/options/modes visible until the user explicitly picks
  // a compatible continuation peer or moves the content into a new thread.
  const modelSelection = rejectedDraftProviderSelection
    ? (draftSelection ?? null)
    : boundInstanceId === undefined
      ? (draftSelection ?? input.thread.modelSelection)
      : draftSelection !== undefined &&
          (draftSelection.instanceId === boundInstanceId || draftTransition?.compatible === true)
        ? draftSelection
        : input.thread.modelSelection.instanceId === boundInstanceId
          ? input.thread.modelSelection
          : null;

  return {
    modelSelection,
    runtimeMode:
      input.draft?.runtimeMode !== undefined ? input.draft.runtimeMode : input.thread.runtimeMode,
    interactionMode:
      input.draft?.interactionMode !== undefined
        ? input.draft.interactionMode
        : input.thread.interactionMode,
    rejectedDraftProviderSelection,
    providerBindingMismatch:
      rejectedDraftProviderSelection || (boundInstanceId !== undefined && modelSelection === null),
  };
}
