import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

export type ProviderContinuationTransition =
  | { readonly compatible: true }
  | { readonly compatible: false; readonly reason: string };

function continuationGroupKey(provider: ServerProvider | undefined): string | null {
  const key = provider?.continuation?.groupKey?.trim();
  return key && key.length > 0 ? key : null;
}

/**
 * Existing sessions may move only between exact provider continuation peers.
 * Same-instance selection is always valid; cross-instance selection needs the
 * same driver and the same explicit, non-empty continuation group.
 */
export function resolveProviderContinuationTransition(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly currentInstanceId: ProviderInstanceId;
  readonly targetInstanceId: ProviderInstanceId;
}): ProviderContinuationTransition {
  if (input.currentInstanceId === input.targetInstanceId) {
    return { compatible: true };
  }
  const current = input.providers.find(
    (provider) => provider.instanceId === input.currentInstanceId,
  );
  if (!current) {
    return {
      compatible: false,
      reason: `The thread binding '${input.currentInstanceId}' cannot be resolved on this environment.`,
    };
  }
  const target = input.providers.find((provider) => provider.instanceId === input.targetInstanceId);
  if (!target) {
    return {
      compatible: false,
      reason: `Provider instance '${input.targetInstanceId}' is not configured on this environment.`,
    };
  }
  if (current.driver !== target.driver) {
    return {
      compatible: false,
      reason: `This thread uses ${current.displayName ?? current.driver}. Start a new thread to change providers.`,
    };
  }
  const currentGroup = continuationGroupKey(current);
  const targetGroup = continuationGroupKey(target);
  if (currentGroup === null || targetGroup === null) {
    return {
      compatible: false,
      reason:
        "This provider does not prove a shared continuation identity. Start a new thread to use this account.",
    };
  }
  if (currentGroup !== targetGroup) {
    return {
      compatible: false,
      reason:
        "This account does not share the thread's provider continuation identity. Start a new thread to use it.",
    };
  }
  return { compatible: true };
}
