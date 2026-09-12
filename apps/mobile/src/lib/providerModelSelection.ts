import {
  getProviderAdmissionAvailability,
  type ProviderAdmissionAvailability,
} from "@t3tools/client-runtime/providerAvailability";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

/** Resolve aliases only within the selected account's reported catalog. */
export function resolveProviderCatalogModelSelection(
  provider: ServerProvider | null | undefined,
  selection: ModelSelection,
): ModelSelection {
  if (provider?.driver !== "antigravity" || provider.instanceId !== selection.instanceId)
    return selection;
  const slug = selection.model.trim();
  const model =
    provider.models.find((entry) => entry.slug === slug || entry.aliases?.includes(slug)) ??
    (slug === ANTIGRAVITY_DEFAULT_MODEL
      ? (provider.models.find((entry) => entry.isDefault) ?? provider.models[0])
      : undefined);
  return model && model.slug !== selection.model ? { ...selection, model: model.slug } : selection;
}

/** A queued user request may reload an unresolved account catalog once before admission. */
export function shouldRefreshProviderModelCatalog(
  provider: ServerProvider | null | undefined,
  selection: ModelSelection,
): boolean {
  if (
    provider?.driver !== "antigravity" ||
    provider.instanceId !== selection.instanceId ||
    getProviderAdmissionAvailability({ provider }).status !== "available"
  )
    return false;
  const resolved = resolveProviderCatalogModelSelection(provider, selection);
  return (
    resolved.model.trim() === ANTIGRAVITY_DEFAULT_MODEL ||
    (provider.auth.status !== "unknown" && provider.models.length === 0)
  );
}

/** Catalog validation follows Pylon's provider admission and keeps unchecked saved models usable. */
export function getProviderModelAdmissionAvailability(input: {
  readonly provider: ServerProvider | null | undefined;
  readonly selection: ModelSelection;
  readonly providerSnapshotKnown?: boolean;
}): ProviderAdmissionAvailability {
  const availability = getProviderAdmissionAvailability({
    provider: input.provider,
    instanceId: String(input.selection.instanceId),
    providerSnapshotKnown: input.providerSnapshotKnown,
  });
  if (availability.status !== "available" || input.provider?.driver !== "antigravity")
    return availability;
  const provider = input.provider;
  const selection = resolveProviderCatalogModelSelection(provider, input.selection);
  const slug = selection.model.trim();
  if (!slug || slug === ANTIGRAVITY_DEFAULT_MODEL) {
    return {
      status: "unavailable",
      reason:
        provider.models.length === 0
          ? "Refresh Antigravity models before sending."
          : "Choose an Antigravity model before sending.",
    };
  }
  // Restart snapshots intentionally omit the catalog until saved authentication is checked.
  if (provider.auth.status === "unknown") return availability;
  if (provider.models.length === 0)
    return { status: "unavailable", reason: "Refresh Antigravity models before sending." };
  if (
    provider.status === "ready" &&
    !provider.models.some((entry) => entry.slug === slug || entry.aliases?.includes(slug))
  ) {
    return {
      status: "unavailable",
      reason: "That Antigravity model is no longer available. Choose another model.",
    };
  }
  return availability;
}
