import {
  formatModelChangeDisabledReason,
  isPrimeAgentDefaultModelUnavailable,
  PRIME_AGENT_DEFAULT_MODEL_CHANGE_DESCRIPTION,
  STARTED_THREAD_MODEL_CHANGE_DESCRIPTION,
} from "@t3tools/shared/model";
import type { ModelOption } from "../../lib/modelOptions";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { getProviderAdmissionUnavailableReason } from "@t3tools/client-runtime/providerAvailability";
import { resolveProviderContinuationTransition } from "@t3tools/client-runtime/providerContinuation";
import type {
  ModelSelection,
  OrchestrationSession,
  ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";

/** Resolve every composer surface against the persisted session binding first. */
export function resolveThreadComposerAuthority(input: {
  readonly serverConfig: Pick<ServerConfig, "providers"> | null | undefined;
  readonly modelSelection: ModelSelection;
  readonly sessionProviderInstanceId?: ModelSelection["instanceId"] | undefined;
}): {
  readonly modelSelection: ModelSelection | null;
  readonly provider: ServerProvider | null;
  readonly providerAdmissionAvailable: boolean;
  readonly providerAdmissionReason: string | null;
  readonly providerBindingMismatch: boolean;
} {
  const providers = input.serverConfig?.providers ?? [];
  const instanceId = input.modelSelection.instanceId;
  const selectedProvider =
    providers.find((candidate) => candidate.instanceId === instanceId) ?? null;
  const transition = input.sessionProviderInstanceId
    ? resolveProviderContinuationTransition({
        providers,
        currentInstanceId: input.sessionProviderInstanceId,
        targetInstanceId: instanceId,
      })
    : ({ compatible: true } as const);
  const providerBindingMismatch = !transition.compatible;
  const provider = providerBindingMismatch
    ? (providers.find((candidate) => candidate.instanceId === input.sessionProviderInstanceId) ??
      null)
    : selectedProvider;
  const providerAdmissionReason = transition.compatible
    ? getProviderAdmissionUnavailableReason({
        provider,
        instanceId: String(instanceId),
        providerSnapshotKnown: input.serverConfig !== null && input.serverConfig !== undefined,
      })
    : transition.reason;
  return {
    modelSelection: providerBindingMismatch ? null : input.modelSelection,
    provider,
    providerAdmissionAvailable: providerAdmissionReason === null,
    providerAdmissionReason,
    providerBindingMismatch,
  };
}

/** Describe why a turn cannot be admitted immediately, even when it can be saved to the outbox. */
export function resolveThreadComposerAdmissionReason(input: {
  readonly providerReason: string | null;
  readonly projectCwd: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
}): string | null {
  if (input.providerReason !== null) return input.providerReason;
  if (input.projectCwd === null) return "This thread's project workspace is unavailable.";
  if (input.connectionState !== "connected") {
    if (input.connectionState === "connecting" || input.connectionState === "reconnecting") {
      return "The environment is still connecting. This send will remain queued.";
    }
    if (input.connectionState === "error") {
      return "The environment connection failed. This send will remain queued.";
    }
    return "The environment is offline. This send will remain queued.";
  }
  return null;
}

/** Provider unavailability must never remove the active turn's escape hatch. */
export function threadComposerShowsStopAction(
  status: OrchestrationSession["status"] | null | undefined,
): boolean {
  return status === "running" || status === "starting";
}

/** Explain disabled model rows while preserving the session's provider and safety guards. */
export function getThreadComposerModelChangeDisabledReason(input: {
  readonly option: ModelOption;
  readonly currentModelSelection: ModelSelection;
  readonly session: Pick<OrchestrationSession, "providerInstanceId"> | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sessionInputBlocked: boolean | undefined;
  readonly modelChangesLocked: boolean;
}): string | undefined {
  if (input.sessionInputBlocked) {
    return "Provider changes are blocked while this thread has a pending safety operation";
  }
  const boundInstanceId = input.session?.providerInstanceId;
  if (boundInstanceId) {
    const transition = resolveProviderContinuationTransition({
      providers: input.providers,
      currentInstanceId: boundInstanceId,
      targetInstanceId: input.option.selection.instanceId,
    });
    if (!transition.compatible) return transition.reason;
  }
  const isCurrent =
    input.option.selection.instanceId === input.currentModelSelection.instanceId &&
    input.option.selection.model === input.currentModelSelection.model;
  if (isCurrent || input.session == null) return undefined;
  if (
    isPrimeAgentDefaultModelUnavailable({
      providerDriver: input.option.providerDriver,
      nextModel: input.option.selection.model,
      currentModel: input.currentModelSelection.model,
      hasStartedSession: true,
    })
  ) {
    return formatModelChangeDisabledReason(PRIME_AGENT_DEFAULT_MODEL_CHANGE_DESCRIPTION);
  }
  return input.modelChangesLocked || input.option.requiresNewThreadForModelChange
    ? formatModelChangeDisabledReason(STARTED_THREAD_MODEL_CHANGE_DESCRIPTION)
    : undefined;
}
