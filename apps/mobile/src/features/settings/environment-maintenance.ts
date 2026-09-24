import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

export function canMaintainEnvironment(session: AuthSessionState | null, connected: boolean) {
  return (
    connected &&
    session?.authenticated === true &&
    session.scopes?.includes(AuthOrchestrationOperateScope) === true
  );
}

export function providerUpdateOutcome(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): { readonly kind: "success" | "error" | "notice"; readonly message: string } | null {
  const state = providers.find((provider) => provider.instanceId === instanceId)?.updateState;
  if (!state) return null;
  if (state.status === "failed") {
    return { kind: "error", message: state.message ?? "Provider update failed." };
  }
  if (state.status === "unchanged") {
    return { kind: "notice", message: state.message ?? "Provider version is unchanged." };
  }
  if (state.status === "succeeded") {
    return { kind: "success", message: state.message ?? "Provider updated." };
  }
  return null;
}

export function canUpdateEnvironmentProvider(provider: ServerProvider) {
  return (
    provider.installed &&
    provider.enabled &&
    provider.availability !== "unavailable" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate &&
    provider.versionAdvisory.updateCommand !== null &&
    provider.versionAdvisory.latestVersion !== null &&
    provider.updateState?.status !== "running" &&
    provider.updateState?.status !== "queued"
  );
}
