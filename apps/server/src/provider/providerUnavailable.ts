import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

/** Exact configured shadow lookup shared by interactive and background routing. */
export function findUnavailableProviderInstance(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): ServerProvider | undefined {
  return providers.find(
    (provider) => provider.instanceId === instanceId && provider.availability === "unavailable",
  );
}

/** Client-neutral remediation carried by an unavailable provider shadow. */
export function providerUnavailableDetail(provider: ServerProvider): string {
  return (
    provider.unavailableReason?.trim() ||
    provider.message?.trim() ||
    `Provider instance '${provider.instanceId}' is unavailable in this environment.`
  );
}
