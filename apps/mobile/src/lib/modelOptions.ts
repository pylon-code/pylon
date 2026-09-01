import {
  getProviderAdmissionAvailability,
  getProviderUnavailablePresentation,
  type ProviderUnavailablePresentation,
} from "@t3tools/client-runtime/providerAvailability";
import type {
  ModelCapabilities,
  ModelSelection,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";
import {
  getServerProviderSupportedRuntimeModes,
  resolveServerProviderRuntimeMode,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  readonly requiresNewThreadForModelChange?: boolean;
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
};

function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: string;
  readonly instanceId: string;
}): string {
  if (provider.displayName) return provider.displayName;
  if (provider.driver === "codex") return "Codex";
  if (provider.driver === "claudeAgent") return "Claude";
  if (provider.driver === "primeAgent") return "Prime Agent";
  return provider.instanceId;
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  const options = buildProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

/**
 * A stored model selection is only usable when its provider instance is
 * currently enabled, installed, authenticated, and available on the server.
 * Returns the selection unchanged when usable, otherwise `null`. Callers can
 * either fall through or hold an unavailable choice for explicit remediation.
 * A missing config (environment offline) cannot be
 * validated, so stored selections pass through untouched.
 */
export function resolveSelectableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  if (!selection || !config) {
    return selection;
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  return getProviderAdmissionAvailability({
    provider,
    instanceId: String(selection.instanceId),
    providerSnapshotKnown: true,
  }).status === "available"
    ? selection
    : null;
}

/**
 * Like resolveSelectableModelSelection, but additionally rejects legacy
 * models. Used for implicit defaults (stored draft, project last-used): a
 * new thread should never quietly start on a legacy model, so those fall
 * through to the provider's default instead. Explicit picks in the settings
 * sheet are unaffected.
 */
export function resolveDefaultableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  const usable = resolveSelectableModelSelection(config, selection);
  if (!usable || !config) {
    return usable;
  }
  const provider = config.providers.find((candidate) => candidate.instanceId === usable.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === usable.model);
  return model?.isLegacy === true ? null : usable;
}

export function getModelSelectionProvider(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
) {
  return (
    config?.providers.find((provider) => provider.instanceId === selection?.instanceId) ?? null
  );
}

export function getModelSelectionUnavailablePresentation(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
): ProviderUnavailablePresentation | null {
  return getProviderUnavailablePresentation(getModelSelectionProvider(config, selection));
}

/** Keep unavailable provider shadows from reaching turn submission locally. */
export function canSendToModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
): boolean {
  if (!selection) return false;
  return (
    getProviderAdmissionAvailability({
      provider: getModelSelectionProvider(config, selection),
      instanceId: String(selection.instanceId),
      providerSnapshotKnown: config !== null && config !== undefined,
    }).status !== "unavailable"
  );
}

/**
 * Preserve the highest-priority stored choice when its provider is explicitly
 * unavailable. The new-task screen can then show the server's remediation and
 * require a new explicit choice instead of silently switching providers.
 */
export function resolveNewTaskUnavailableProvider(
  config: T3ServerConfig | null | undefined,
  input: {
    readonly draftSelection: ModelSelection | null;
    readonly projectDefaultSelection: ModelSelection | null;
    readonly stickySelection: ModelSelection | null;
  },
): ServerProvider | null {
  const candidates = [
    { selection: input.draftSelection, defaultable: false },
    { selection: input.projectDefaultSelection, defaultable: true },
    { selection: input.stickySelection, defaultable: true },
  ] as const;
  for (const candidate of candidates) {
    if (!candidate.selection) continue;
    const provider = getModelSelectionProvider(config, candidate.selection);
    if (
      provider &&
      getProviderAdmissionAvailability({
        provider,
        instanceId: String(candidate.selection.instanceId),
        providerSnapshotKnown: true,
      }).status === "unavailable"
    ) {
      return provider;
    }
    const usable = candidate.defaultable
      ? resolveDefaultableModelSelection(config, candidate.selection)
      : resolveSelectableModelSelection(config, candidate.selection);
    if (usable) return null;
  }
  return null;
}

export function getModelSelectionSupportedRuntimeModes(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
): ReadonlyArray<RuntimeMode> {
  return getServerProviderSupportedRuntimeModes(getModelSelectionProvider(config, selection));
}

export function resolveModelSelectionRuntimeMode(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
  runtimeMode: RuntimeMode,
): RuntimeMode {
  return resolveServerProviderRuntimeMode(
    getModelSelectionProvider(config, selection),
    runtimeMode,
  );
}

export function showModelSelectionInteractionModeToggle(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
): boolean {
  return getModelSelectionProvider(config, selection)?.showInteractionModeToggle ?? true;
}

export function resolveNewTaskModelSelection(input: {
  readonly draftSelection: ModelSelection | null;
  readonly projectDefaultSelection: ModelSelection | null;
  readonly stickySelection: ModelSelection | null;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly unavailablePreferredProvider?: ServerProvider | null;
}): ModelSelection | null {
  if (
    input.unavailablePreferredProvider &&
    getProviderAdmissionAvailability({
      provider: input.unavailablePreferredProvider,
      instanceId: String(input.unavailablePreferredProvider.instanceId),
      providerSnapshotKnown: true,
    }).status === "unavailable"
  ) {
    return null;
  }
  return (
    input.draftSelection ??
    input.projectDefaultSelection ??
    input.stickySelection ??
    input.modelOptions.find((option) => option.isDefault)?.selection ??
    input.modelOptions[0]?.selection ??
    null
  );
}

export function buildModelOptions(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  for (const provider of config?.providers ?? []) {
    if (
      getProviderAdmissionAvailability({
        provider,
        instanceId: String(provider.instanceId),
        providerSnapshotKnown: true,
      }).status !== "available"
    ) {
      continue;
    }

    const providerLabel = providerDisplayLabel(provider);
    for (const model of provider.models) {
      const key = `${provider.instanceId}:${model.slug}`;
      options.set(key, {
        key,
        label: model.name,
        subtitle: model.subProvider ?? "",
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        supportedRuntimeModes: getServerProviderSupportedRuntimeModes(provider),
        requiresNewThreadForModelChange: provider.requiresNewThreadForModelChange === true,
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
        capabilities: model.capabilities,
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
        ),
      });
    }
  }

  if (fallbackModelSelection) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection: normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const provider = config?.providers.find(
        (candidate) => candidate.instanceId === fallbackModelSelection.instanceId,
      );
      if (
        provider !== undefined &&
        getProviderAdmissionAvailability({
          provider,
          instanceId: String(fallbackModelSelection.instanceId),
          providerSnapshotKnown: true,
        }).status === "available"
      ) {
        const providerLabel = provider
          ? providerDisplayLabel(provider)
          : fallbackModelSelection.instanceId;
        options.set(key, {
          key,
          label: fallbackModelSelection.model,
          subtitle: "",
          providerKey: fallbackModelSelection.instanceId,
          providerLabel,
          providerDriver: provider?.driver ?? fallbackModelSelection.instanceId,
          supportedRuntimeModes: getServerProviderSupportedRuntimeModes(provider),
          requiresNewThreadForModelChange: provider?.requiresNewThreadForModelChange === true,
          isDefault: false,
          isLegacy: false,
          capabilities: null,
          selection: fallbackModelSelection,
        });
      }
    }
  }

  return [...options.values()];
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<string, { providerLabel: string; models: ModelOption[] }>();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    models: group.models,
  }));
}
