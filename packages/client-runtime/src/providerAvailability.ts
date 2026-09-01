import type { ServerProvider } from "@t3tools/contracts";

export interface ProviderUnavailablePresentation {
  readonly headline: "Unavailable";
  readonly detail: string;
}

export type ProviderAdmissionAvailability =
  | { readonly status: "available"; readonly reason: null }
  | { readonly status: "unknown"; readonly reason: null }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * Derive provider-neutral copy for an unavailable server shadow.
 * `unavailableReason` is the actionable contract and outranks probe messages.
 */
export function getProviderUnavailablePresentation(
  provider:
    | Pick<ServerProvider, "availability" | "unavailableReason" | "message">
    | null
    | undefined,
): ProviderUnavailablePresentation | null {
  if (provider?.availability !== "unavailable") return null;
  return {
    headline: "Unavailable",
    detail:
      provider.unavailableReason?.trim() ||
      provider.message?.trim() ||
      "This provider is unavailable in the current environment.",
  };
}

/**
 * Resolve admission without treating a missing cold/offline snapshot as proof
 * that a configured provider disappeared. Warning snapshots remain usable;
 * their message is advisory, not an admission failure.
 */
type ProviderAdmissionSnapshot = Pick<ServerProvider, "instanceId"> &
  Partial<
    Pick<
      ServerProvider,
      | "availability"
      | "unavailableReason"
      | "message"
      | "displayName"
      | "enabled"
      | "installed"
      | "auth"
      | "status"
    >
  >;

export function getProviderAdmissionAvailability(input: {
  readonly provider: ProviderAdmissionSnapshot | null | undefined;
  readonly instanceId?: string | undefined;
  readonly providerSnapshotKnown?: boolean | undefined;
}): ProviderAdmissionAvailability {
  const provider = input.provider;
  if (!provider) {
    if (input.providerSnapshotKnown !== true) {
      return { status: "unknown", reason: null };
    }
    return {
      status: "unavailable",
      reason: input.instanceId
        ? `Provider instance '${input.instanceId}' is not configured on this environment.`
        : "No provider is configured on this environment.",
    };
  }
  const unavailable = getProviderUnavailablePresentation(provider);
  if (unavailable) return { status: "unavailable", reason: unavailable.detail };
  const name = provider.displayName?.trim() || String(provider.instanceId);
  if (provider.enabled === false) {
    return { status: "unavailable", reason: `${name} is disabled in provider settings.` };
  }
  if (provider.installed === false) {
    return { status: "unavailable", reason: `${name} is not installed on this environment.` };
  }
  if (provider.auth?.status === "unauthenticated") {
    return { status: "unavailable", reason: `Sign in to ${name} before sending.` };
  }
  if (provider.status === "error" || provider.status === "disabled") {
    return {
      status: "unavailable",
      reason: provider.message?.trim() || `${name} is not ready to accept a turn.`,
    };
  }
  return { status: "available", reason: null };
}

/** Explain why an exact provider instance cannot accept a new turn. */
export function getProviderAdmissionUnavailableReason(input: {
  readonly provider: ProviderAdmissionSnapshot | null | undefined;
  readonly instanceId?: string | undefined;
  readonly providerSnapshotKnown?: boolean | undefined;
}): string | null {
  return getProviderAdmissionAvailability(input).reason;
}
