import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { getBackgroundActivityPresetSettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import {
  backgroundActivitySharedPolicySettings,
  buildProviderInstanceReorderPatch,
  buildProviderInstanceUpdatePatch,
  formatDiagnosticsDescription,
  getChangedBrowserSettingLabels,
  getChangedTypographySettingLabels,
  isSamePreviewViewport,
  hasChangedBackgroundActivitySettings,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";

describe("typography settings restore", () => {
  it("detects family and size changes by font row", () => {
    expect(getChangedTypographySettingLabels(DEFAULT_UNIFIED_SETTINGS)).toEqual([]);
    expect(
      getChangedTypographySettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        fontSizeInterface: 18,
        fontFamilyCode: "Fira Code",
      }),
    ).toEqual(["Interface font", "Code font"]);
  });
});

describe("background activity settings restore", () => {
  it("detects legacy interval values even when the structured setting is at its default", () => {
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: Duration.seconds(45),
        providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      }),
    ).toBe(true);
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
        providerHealthRefreshInterval: Duration.minutes(7),
      }),
    ).toBe(true);
    expect(hasChangedBackgroundActivitySettings(DEFAULT_UNIFIED_SETTINGS)).toBe(false);
  });

  it("detects a legacy profile override so restoring defaults clears it", () => {
    expect(
      hasChangedBackgroundActivitySettings({
        ...DEFAULT_UNIFIED_SETTINGS,
        backgroundActivityProfile: "performance",
      }),
    ).toBe(true);
  });

  it("shows the effective legacy preset and marks custom legacy intervals as advanced", () => {
    const performance = getBackgroundActivityPresetSettings("performance");
    expect(
      resolveBackgroundActivityProfileOption({
        ...DEFAULT_UNIFIED_SETTINGS,
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: "performance",
        automaticGitFetchInterval: performance.automaticGitFetchInterval,
        providerHealthRefreshInterval: performance.providerHealthRefreshInterval,
      }),
    ).toBe("performance");

    expect(
      resolveBackgroundActivityProfileOption({
        ...DEFAULT_UNIFIED_SETTINGS,
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: "performance",
        automaticGitFetchInterval: Duration.seconds(45),
        providerHealthRefreshInterval: Duration.minutes(7),
      }),
    ).toBe("advanced");
  });

  it("preserves advanced overrides when the shared policy changes", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          backgroundActivity: {
            schemaVersion: 1,
            profile: "custom",
            baseProfile: "balanced",
            overrides: {
              automaticGitFetchInterval,
              pauseWhenOnBattery: true,
            },
          },
        },
        "performance",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval,
        pauseWhenOnBattery: true,
      },
    });
  });

  it("materializes legacy advanced overrides before changing the shared policy", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          automaticGitFetchInterval,
        },
        "battery-saver",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval,
      },
    });
  });
});

describe("project grouping toggle", () => {
  it("enables repository grouping and disables into separate projects", () => {
    expect(isProjectGroupingEnabled("repository")).toBe(true);
    expect(isProjectGroupingEnabled("repository_path")).toBe(true);
    expect(isProjectGroupingEnabled("separate")).toBe(false);
    expect(projectGroupingModeFromToggle(true)).toBe("repository");
    expect(projectGroupingModeFromToggle(false)).toBe("separate");
  });

  it("restores repository path grouping when the toggle is cycled", () => {
    expect(projectGroupingModeFromToggle(false, "repository_path")).toBe("separate");
    expect(projectGroupingModeFromToggle(true, "repository_path")).toBe("repository_path");
  });
});

describe("formatDiagnosticsDescription", () => {
  it("collapses trace and metric URLs that share the same OTEL base path", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      }),
    ).toBe("Local trace file. Exporting OTEL to http://localhost:4318/v1/{traces,metrics}.");
  });

  it("keeps separate trace and metric URLs when their base paths differ", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:9000/v1/metrics",
      }),
    ).toBe(
      "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces and metrics to http://localhost:9000/v1/metrics.",
    );
  });

  it("omits OTEL text when no exporter is enabled", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      }),
    ).toBe("Local trace file.");
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});

describe("buildProviderInstanceReorderPatch", () => {
  const claude = ProviderDriverKind.make("claudeAgent");
  const defaultId = ProviderInstanceId.make("claudeAgent");
  const customId = ProviderInstanceId.make("claude_personal");
  const thirdId = ProviderInstanceId.make("claude_spare");

  const row = (instanceId: ProviderInstanceId, isDefault = false) => ({
    instanceId,
    instance: { driver: claude, enabled: true } satisfies ProviderInstanceConfig,
    isDefault,
  });

  const settingsWith = (...ids: ReadonlyArray<ProviderInstanceId>) => ({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: Object.fromEntries(
      ids.map((id) => [id, { driver: claude, enabled: true } satisfies ProviderInstanceConfig]),
    ),
  });

  it("writes a dense priority across the whole driver group", () => {
    const patch = buildProviderInstanceReorderPatch({
      settings: settingsWith(defaultId, customId, thirdId),
      driver: claude,
      rows: [row(defaultId, true), row(customId), row(thirdId)],
      instanceId: thirdId,
      direction: "up",
    });

    expect(patch?.providerInstances?.[defaultId]?.priority).toBe(0);
    expect(patch?.providerInstances?.[thirdId]?.priority).toBe(1);
    expect(patch?.providerInstances?.[customId]?.priority).toBe(2);
  });

  it("moves an account later", () => {
    const patch = buildProviderInstanceReorderPatch({
      settings: settingsWith(defaultId, customId),
      driver: claude,
      rows: [row(defaultId, true), row(customId)],
      instanceId: defaultId,
      direction: "down",
    });

    expect(patch?.providerInstances?.[customId]?.priority).toBe(0);
    expect(patch?.providerInstances?.[defaultId]?.priority).toBe(1);
  });

  it("leaves other drivers' instances untouched", () => {
    const codexId = ProviderInstanceId.make("codex");
    const patch = buildProviderInstanceReorderPatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [codexId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
          [defaultId]: { driver: claude, enabled: true },
          [customId]: { driver: claude, enabled: true },
        },
      },
      driver: claude,
      rows: [row(defaultId, true), row(customId)],
      instanceId: customId,
      direction: "up",
    });

    expect(patch?.providerInstances?.[codexId]?.priority).toBeUndefined();
  });

  // Writing a priority onto a synthesized default slot promotes it, which
  // moves its config into the envelope — the legacy block has to reset too.
  it("resets the legacy provider block when it promotes a default slot", () => {
    const patch = buildProviderInstanceReorderPatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          claudeAgent: {
            ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
            binaryPath: "/legacy/claude",
          },
        },
        providerInstances: { [customId]: { driver: claude, enabled: true } },
      },
      driver: claude,
      rows: [row(defaultId, true), row(customId)],
      instanceId: customId,
      direction: "up",
    });

    expect(patch?.providers?.claudeAgent).toEqual(DEFAULT_SERVER_SETTINGS.providers.claudeAgent);
  });

  it("leaves the legacy provider block alone when every slot is already explicit", () => {
    const patch = buildProviderInstanceReorderPatch({
      settings: settingsWith(defaultId, customId),
      driver: claude,
      rows: [row(defaultId, true), row(customId)],
      instanceId: customId,
      direction: "up",
    });

    expect(patch?.providers).toBeUndefined();
  });

  // The caller disables the button on a null patch rather than writing a
  // no-op settings update.
  it.each([
    ["up past the front", defaultId, "up" as const],
    ["down past the back", customId, "down" as const],
  ])("returns null when moving %s", (_label, instanceId, direction) => {
    expect(
      buildProviderInstanceReorderPatch({
        settings: settingsWith(defaultId, customId),
        driver: claude,
        rows: [row(defaultId, true), row(customId)],
        instanceId,
        direction,
      }),
    ).toBeNull();
  });

  it("returns null for an instance that is not in the group", () => {
    expect(
      buildProviderInstanceReorderPatch({
        settings: settingsWith(defaultId, customId),
        driver: claude,
        rows: [row(defaultId, true), row(customId)],
        instanceId: ProviderInstanceId.make("claude_missing"),
        direction: "up",
      }),
    ).toBeNull();
  });
});

describe("getChangedBrowserSettingLabels", () => {
  it("reports nothing for the defaults", () => {
    expect(getChangedBrowserSettingLabels(DEFAULT_UNIFIED_SETTINGS)).toEqual([]);
  });

  it("treats a structurally equal viewport as unchanged", () => {
    // The viewport is a tagged union, so identity comparison would report a
    // freshly decoded copy of the default as dirty and offer to "restore" it.
    expect(
      getChangedBrowserSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        browserDefaultViewport: { ...DEFAULT_UNIFIED_SETTINGS.browserDefaultViewport },
      }),
    ).toEqual([]);
  });

  it("labels each browser default that differs", () => {
    expect(
      getChangedBrowserSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        browserDefaultViewport: { _tag: "freeform", width: 900, height: 600 },
        browserDefaultZoomFactor: 1.5,
        browserDefaultAppearance: "dark",
        browserRecordingFrameRate: 60,
        browserAutoShowFloatingPreview: !DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview,
      }),
    ).toEqual([
      "Browser viewport",
      "Browser zoom",
      "Browser appearance",
      "Recording frame rate",
      "Floating preview",
    ]);
  });
});

describe("isSamePreviewViewport", () => {
  it("separates presets that share a size", () => {
    // Two presets can agree on width and height and still be different
    // entries in the picker, so the id has to take part in the comparison.
    expect(
      isSamePreviewViewport(
        { _tag: "preset", width: 390, height: 844, presetId: "iphone-12-pro" },
        { _tag: "preset", width: 390, height: 844, presetId: "ipad-mini" },
      ),
    ).toBe(false);
  });

  it("separates a freeform viewport from a preset of the same size", () => {
    expect(
      isSamePreviewViewport(
        { _tag: "freeform", width: 390, height: 844 },
        { _tag: "preset", width: 390, height: 844, presetId: "iphone-12-pro" },
      ),
    ).toBe(false);
  });
});
