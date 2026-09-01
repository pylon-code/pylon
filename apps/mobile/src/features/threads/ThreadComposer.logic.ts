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
