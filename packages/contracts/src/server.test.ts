import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SERVER_PROVIDER_RUNTIME_MODES,
  getServerProviderSupportedRuntimeModes,
  resolveServerProviderRuntimeMode,
  ServerConfig,
  ServerPrimeManagedInstalledBuild,
  ServerProvider,
  ServerProviders,
  ServerUpsertKeybindingResult,
  supportsServerProviderBackgroundTextGeneration,
  supportsServerProviderConversationRollback,
} from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodePrimeManagedInstalledBuild = Schema.decodeUnknownSync(ServerPrimeManagedInstalledBuild);
const decodeServerProviders = Schema.decodeUnknownSync(ServerProviders);
const decodeUpsertKeybindingResult = Schema.decodeUnknownSync(ServerUpsertKeybindingResult);
const decodeAvailableEditors = Schema.decodeUnknownSync(ServerConfig.fields.availableEditors);

const baseProviderSnapshot = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
};

describe("ServerPrimeManagedInstalledBuild", () => {
  it("never serializes the environment-native managed launcher path", () => {
    const parsed = decodePrimeManagedInstalledBuild({
      buildId: "pylon-build-g123456789abc-r1",
      channel: "preview",
      sequence: 1,
      binaryPath: "/private/environment/provider-tools/prime-agent",
    });

    expect(parsed).toEqual({
      buildId: "pylon-build-g123456789abc-r1",
      channel: "preview",
      sequence: 1,
    });
    expect(JSON.stringify(parsed)).not.toContain("/private/environment");
  });
});

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.distribution).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
    expect(getServerProviderSupportedRuntimeModes(parsed)).toEqual(
      DEFAULT_SERVER_PROVIDER_RUNTIME_MODES,
    );
    expect(supportsServerProviderBackgroundTextGeneration(parsed)).toBe(true);
    expect(supportsServerProviderConversationRollback(parsed)).toBe(false);
    expect(parsed.supportsMultipleInstances).toBeUndefined();
  });

  it("decodes truthful multiple-instance support and its actionable reason", () => {
    const supported = decodeServerProvider({
      ...baseProviderSnapshot,
      supportsMultipleInstances: true,
    });
    const unsupported = decodeServerProvider({
      ...baseProviderSnapshot,
      supportsMultipleInstances: false,
      multipleInstancesUnavailableReason: "Use WSL2 for multiple Prime Agent homes.",
    });

    expect(supported.supportsMultipleInstances).toBe(true);
    expect(unsupported.supportsMultipleInstances).toBe(false);
    expect(unsupported.multipleInstancesUnavailableReason).toContain("WSL2");
  });

  it("decodes provider presentation capability restrictions", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      supportedRuntimeModes: ["full-access"],
      supportsBackgroundTextGeneration: false,
      supportsConversationRollback: false,
    });

    expect(getServerProviderSupportedRuntimeModes(parsed)).toEqual(["full-access"]);
    expect(resolveServerProviderRuntimeMode(parsed, "approval-required")).toBe("full-access");
    expect(supportsServerProviderBackgroundTextGeneration(parsed)).toBe(false);
    expect(supportsServerProviderConversationRollback(parsed)).toBe(false);
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes optional signed distribution identity independently from runtime status", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      driver: "primeAgent",
      distribution: {
        classification: "pylon-managed",
        channel: "preview",
        buildId: "pylon-build-g0123456789ab-r1",
        sequence: 9,
        latestBuildId: "pylon-build-gabcdef012345-r1",
        latestSequence: 10,
        updateAvailable: true,
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "A signed build is available.",
      },
    });

    expect(parsed.status).toBe("ready");
    expect(parsed.distribution).toEqual({
      classification: "pylon-managed",
      channel: "preview",
      buildId: "pylon-build-g0123456789ab-r1",
      sequence: 9,
      latestBuildId: "pylon-build-gabcdef012345-r1",
      latestSequence: 10,
      updateAvailable: true,
      checkedAt: "2026-04-10T00:00:00.000Z",
      message: "A signed build is available.",
    });
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("decodes optional legacy model metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          isLegacy: true,
          capabilities: null,
        },
      ],
    });

    expect(parsed.models[0]?.isLegacy).toBe(true);
  });

  it("decodes optional background-only model capabilities", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      models: [
        {
          slug: "openai-codex/gpt-5.6",
          name: "GPT-5.6",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
          backgroundTextGenerationCapabilities: {
            optionDescriptors: [
              {
                id: "thinkingLevel",
                label: "Thinking",
                type: "select",
                options: [
                  { id: "prime-default", label: "Prime default", isDefault: true },
                  { id: "high", label: "High" },
                ],
                currentValue: "prime-default",
              },
            ],
          },
        },
      ],
    });

    expect(parsed.models[0]?.capabilities?.optionDescriptors).toEqual([]);
    expect(parsed.models[0]?.backgroundTextGenerationCapabilities?.optionDescriptors?.[0]?.id).toBe(
      "thinkingLevel",
    );
  });

  it("decodes dynamic provider usage windows", () => {
    const parsed = decodeServerProvider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: "2.1.218",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-07-22T12:00:00.000Z",
      models: [],
      usageLimits: {
        source: "claudePrint",
        checkedAt: "2026-07-22T12:00:00.000Z",
        windows: [
          { label: "Session", usedPercent: 30, windowDurationMins: 300 },
          { label: "Weekly (Fable)", usedPercent: 26, windowDurationMins: 10_080 },
        ],
      },
    });

    expect(parsed.usageLimits?.windows).toHaveLength(2);
  });

  // An agent that signs in on its own reports each backend separately; a
  // client matches the identity against a configured instance's own.
  it("decodes backend sign-ins and an account identity", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      auth: { status: "authenticated", accountId: "acct_123" },
      backends: [
        { backend: "openai-codex", accountId: "acct_123" },
        {
          backend: "anthropic",
          usageLimits: {
            source: "primeAgentOAuth",
            checkedAt: "2026-07-22T12:00:00.000Z",
            windows: [{ label: "Session", usedPercent: 12, windowDurationMins: 300 }],
          },
        },
      ],
    });

    expect(parsed.auth.accountId).toBe("acct_123");
    expect(parsed.backends?.map((backend) => backend.backend)).toEqual([
      "openai-codex",
      "anthropic",
    ]);
    expect(parsed.backends?.[1]?.usageLimits?.windows).toHaveLength(1);
  });

  it("decodes pushed rate-limit state", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      rateLimit: {
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: "2026-08-04T20:00:00.000Z",
        observedAt: "2026-08-04T18:30:00.000Z",
      },
    });

    expect(parsed.rateLimit?.status).toBe("rejected");
    expect(parsed.rateLimit?.resetsAt).toBe("2026-08-04T20:00:00.000Z");
  });

  // Snapshots produced before this field existed, and providers that never
  // report quota, must decode unchanged.
  it("decodes a snapshot with no rate-limit state", () => {
    expect(decodeServerProvider(baseProviderSnapshot).rateLimit).toBeUndefined();
  });

  // Providers add window kinds on their own schedule; an unfamiliar one must
  // not cost us the whole snapshot.
  it("keeps an unfamiliar rate-limit window kind", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      rateLimit: {
        status: "allowed_warning",
        rateLimitType: "some_future_window",
        observedAt: "2026-08-04T18:30:00.000Z",
      },
    });

    expect(parsed.rateLimit?.rateLimitType).toBe("some_future_window");
  });
});

describe("server config forward compatibility", () => {
  it("drops config issues with kinds this build does not know", () => {
    const parsed = decodeUpsertKeybindingResult({
      keybindings: [],
      issues: [
        { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
        { kind: "keybindings.future-issue", message: "From a newer server" },
      ],
    });

    expect(parsed.issues).toEqual([
      { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
    ]);
  });

  it("drops editor ids this build does not know", () => {
    const parsed = decodeAvailableEditors(["zed", "some-future-editor", "vscode"]);

    expect(parsed).toEqual(["zed", "vscode"]);
  });

  // A provider status this build has never seen (a new ServerProviderState,
  // ServerProviderAuthStatus, etc. member) previously failed the whole
  // `providers` array, taking every other provider down with it and, since
  // `providers` sits inside `ServerConfig`, failing the whole config decode —
  // an older client would drop its connection over one provider it can't
  // render. Dropping just that element keeps every other provider working.
  it("drops providers this build cannot decode instead of failing the whole array", () => {
    const decodedBase = decodeServerProvider(baseProviderSnapshot);

    const parsed = decodeServerProviders([
      baseProviderSnapshot,
      { ...baseProviderSnapshot, instanceId: "future", status: "some-future-status" },
    ]);

    expect(parsed).toEqual([decodedBase]);
  });
});
