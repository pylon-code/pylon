/**
 * Which accounts' capacity to show alongside a thread.
 *
 * Every configured account for the thread's driver, not just the one the
 * thread is bound to: Pylon routes threads across several accounts of the same
 * provider, so "how much is left" is a question about all of them, and
 * deciding where the next thread goes needs the comparison.
 *
 * @module providerUsageAccounts
 */
import type { ServerProvider } from "@t3tools/contracts";

import { formatProviderDisplayName } from "./lib/contextWindow";
import type { ProviderUsageAccount } from "./components/providerUsage/ProviderUsageAccounts";

export function deriveProviderUsageAccounts(input: {
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly activeInstanceId: string | undefined;
  readonly enabled: boolean;
}): ReadonlyArray<ProviderUsageAccount> {
  if (!input.enabled || !input.activeInstanceId) return [];
  const activeProvider = input.providerStatuses.find(
    (provider) => provider.instanceId === input.activeInstanceId,
  );
  if (!activeProvider) return [];
  return input.providerStatuses
    .filter((provider) => provider.driver === activeProvider.driver && provider.usageLimits)
    .map((provider) => ({
      instanceId: provider.instanceId,
      displayName: provider.displayName ?? formatProviderDisplayName(provider.instanceId),
      accentColor: provider.accentColor,
      // Narrowed by the `provider.usageLimits` filter above.
      usageLimits: provider.usageLimits as NonNullable<typeof provider.usageLimits>,
      isActive: provider.instanceId === input.activeInstanceId,
    }));
}
