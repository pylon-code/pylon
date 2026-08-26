/**
 * Which accounts' capacity the composer shows, and which one leads.
 *
 * Every configured account for the driver whose capacity applies, not just
 * the one the composer is targeting: Pylon routes threads across several
 * accounts of the same provider, so "how much is left" is a question about
 * all of them, and deciding where the next thread goes needs the comparison.
 *
 * Prime Agent has no capacity of its own — it runs whichever backend the
 * selected model belongs to on that backend's subscription. Its models carry
 * the backend as `subProvider`, so a Prime thread on an Anthropic model shows
 * the Claude accounts' capacity and one on an OpenAI Codex model shows Codex's.
 *
 * @module providerUsageAccounts
 */
import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import { formatProviderDisplayName } from "./lib/contextWindow";
import type { ProviderUsageAccount } from "./components/providerUsage/ProviderUsageAccounts";

const PRIME_AGENT_DRIVER = ProviderDriverKind.make("primeAgent");

/**
 * Prime's backend names, as its model discovery reports them, mapped to the
 * Pylon driver whose accounts hold that backend's subscription. Backends
 * without a Pylon driver (Prime Inference, plain OpenAI keys) have no
 * capacity to show and are left out.
 */
const PRIME_AGENT_BACKEND_DRIVERS: Readonly<Record<string, ProviderDriverKind>> = {
  anthropic: ProviderDriverKind.make("claudeAgent"),
  "openai-codex": ProviderDriverKind.make("codex"),
};

export interface ComposerUsageBackend {
  readonly driver: ProviderDriverKind;
  /** Brand label for the driver, e.g. "Claude". */
  readonly label: string;
  /** Display name of the Prime model the capacity is being shown for. */
  readonly model: string;
}

export interface ComposerUsage {
  /** Accounts the popover compares. Empty when nothing reports capacity. */
  readonly accounts: ReadonlyArray<ProviderUsageAccount>;
  /** The account the strip shows, or null when there is nothing to show. */
  readonly primary: ProviderUsageAccount | null;
  /** Set when the composer targets Prime Agent and capacity comes from its backend. */
  readonly backend: ComposerUsageBackend | null;
}

export const EMPTY_COMPOSER_USAGE: ComposerUsage = { accounts: [], primary: null, backend: null };

function toUsageAccount(provider: ServerProvider, isActive: boolean): ProviderUsageAccount | null {
  if (!provider.usageLimits) return null;
  return {
    instanceId: provider.instanceId,
    displayName: provider.displayName ?? formatProviderDisplayName(provider.instanceId),
    accentColor: provider.accentColor,
    usageLimits: provider.usageLimits,
    isActive,
  };
}

function accountsForDriver(
  providerStatuses: ReadonlyArray<ServerProvider>,
  driver: ProviderDriverKind,
  activeInstanceId: string | null,
): ReadonlyArray<ProviderUsageAccount> {
  return providerStatuses.flatMap((provider) => {
    if (provider.driver !== driver) return [];
    const account = toUsageAccount(provider, provider.instanceId === activeInstanceId);
    return account ? [account] : [];
  });
}

/** The Prime model the composer has selected, when its backend has a Pylon driver. */
function primeAgentBackend(
  prime: ServerProvider,
  selectedModel: string | null | undefined,
): { readonly driver: ProviderDriverKind; readonly model: ServerProviderModel } | null {
  if (!selectedModel) return null;
  const model = prime.models.find((candidate) => candidate.slug === selectedModel);
  const driver = model?.subProvider ? PRIME_AGENT_BACKEND_DRIVERS[model.subProvider] : undefined;
  return model && driver ? { driver, model } : null;
}

export function deriveComposerUsage(input: {
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  /** The instance the composer resolved as its target. */
  readonly selectedInstanceId: string | null | undefined;
  /** The model slug the composer resolved for that instance. */
  readonly selectedModel: string | null | undefined;
  readonly enabled: boolean;
}): ComposerUsage {
  if (!input.enabled || !input.selectedInstanceId) return EMPTY_COMPOSER_USAGE;
  const selected = input.providerStatuses.find(
    (provider) => provider.instanceId === input.selectedInstanceId,
  );
  if (!selected) return EMPTY_COMPOSER_USAGE;

  if (selected.driver === PRIME_AGENT_DRIVER) {
    const backend = primeAgentBackend(selected, input.selectedModel);
    if (!backend) return EMPTY_COMPOSER_USAGE;
    // No account is "this thread's": Prime signs in on its own. The default
    // instance leads the strip because it is the one a user set up first.
    const accounts = accountsForDriver(input.providerStatuses, backend.driver, null);
    const defaultInstanceId = defaultInstanceIdForDriver(backend.driver);
    const primary =
      accounts.find((account) => account.instanceId === defaultInstanceId) ?? accounts[0] ?? null;
    return {
      accounts,
      primary,
      backend: {
        driver: backend.driver,
        label: PROVIDER_DISPLAY_NAMES[backend.driver] ?? backend.driver,
        model: backend.model.shortName ?? backend.model.name,
      },
    };
  }

  const accounts = accountsForDriver(input.providerStatuses, selected.driver, selected.instanceId);
  return {
    accounts,
    primary: accounts.find((account) => account.isActive) ?? null,
    backend: null,
  };
}
