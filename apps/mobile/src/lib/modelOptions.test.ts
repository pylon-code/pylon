import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import {
  buildModelMenuActions,
  buildModelOptions,
  getModelSelectionSupportedRuntimeModes,
  groupByProvider,
  resolveModelSelectionRuntimeMode,
  resolveSelectableModelSelection,
  showModelSelectionInteractionModeToggle,
} from "./modelOptions";

describe("mobile model options", () => {
  it("presents the default Prime Agent instance with its product name", () => {
    const config = {
      providers: [
        {
          instanceId: "primeAgent",
          driver: "primeAgent",
          enabled: true,
          installed: true,
          auth: { status: "unknown" },
          models: [
            {
              slug: "default",
              name: "Prime Agent Default",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(buildModelOptions(config, null)).toMatchObject([
      {
        providerLabel: "Prime Agent",
        providerDriver: "primeAgent",
        label: "Prime Agent Default",
      },
    ]);
  });

  it("honors provider runtime and interaction presentation capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "primeAgent",
          driver: "primeAgent",
          enabled: true,
          installed: true,
          auth: { status: "unknown" },
          supportedRuntimeModes: ["full-access"],
          showInteractionModeToggle: false,
          models: [],
        },
      ],
    } as unknown as ServerConfig;
    const selection = {
      instanceId: ProviderInstanceId.make("primeAgent"),
      model: "default",
    };

    expect(getModelSelectionSupportedRuntimeModes(config, selection)).toEqual(["full-access"]);
    expect(resolveModelSelectionRuntimeMode(config, selection, "approval-required")).toBe(
      "full-access",
    );
    expect(showModelSelectionInteractionModeToggle(config, selection)).toBe(false);
  });

  it("folds legacy models into a provider-scoped menu", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const actions = buildModelMenuActions(groupByProvider(buildModelOptions(config, null)), null);

    expect(actions).toMatchObject([
      {
        title: "Codex",
        subactions: [{ id: "model:codex:gpt-5.6-sol", title: "GPT-5.6 Sol" }],
      },
      {
        id: "legacy-models:codex",
        title: "Codex legacy models",
        subactions: [{ id: "model:codex:gpt-5.4", title: "GPT-5.4" }],
      },
    ]);
  });

  it("disables existing-thread model choices with an explanation", () => {
    const config = {
      providers: [
        {
          instanceId: "primeAgent",
          driver: "primeAgent",
          displayName: "Prime Agent",
          enabled: true,
          installed: true,
          auth: { status: "unknown" },
          models: [
            { slug: "default", name: "Default", isCustom: false, capabilities: null },
            { slug: "anthropic/fable", name: "Fable", isCustom: false, capabilities: null },
          ],
        },
      ],
    } as unknown as ServerConfig;
    const selection = {
      instanceId: ProviderInstanceId.make("primeAgent"),
      model: "default",
    };
    const actions = buildModelMenuActions(
      groupByProvider(buildModelOptions(config, selection)),
      selection,
      (option) => (option.selection.model === "default" ? undefined : "Start a new task"),
    );

    expect(actions[0]?.subactions?.[1]).toMatchObject({
      subtitle: "Start a new task",
      attributes: { disabled: true },
    });
  });

  it("omits an empty provider menu when every model is legacy", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(
      buildModelMenuActions(groupByProvider(buildModelOptions(config, null)), null),
    ).toMatchObject([
      {
        id: "legacy-models:codex",
        title: "Codex legacy models",
        subactions: [{ id: "model:codex:gpt-5.4" }],
      },
    ]);
  });

  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });

  it("rejects stored selections whose provider is not usable", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: false,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
      ],
    } as unknown as ServerConfig;

    const usable = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };
    const disabled = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const removed = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.6-sol",
    };

    expect(resolveSelectableModelSelection(config, usable)).toBe(usable);
    expect(resolveSelectableModelSelection(config, disabled)).toBeNull();
    expect(resolveSelectableModelSelection(config, removed)).toBeNull();
    // No config (environment offline) — nothing to validate against.
    expect(resolveSelectableModelSelection(null, disabled)).toBe(disabled);
  });
});
