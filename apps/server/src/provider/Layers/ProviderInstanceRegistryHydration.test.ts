import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("deriveProviderInstanceConfigMap Prime Agent hydration", () => {
  it("hydrates the legacy Prime Agent settings into its default instance", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        primeAgent: {
          ...DEFAULT_SERVER_SETTINGS.providers.primeAgent,
          enabled: false,
          binaryPath: "/opt/prime-agent",
          customModels: ["custom-model"],
        },
      },
    };

    expect(
      deriveProviderInstanceConfigMap(settings)[ProviderInstanceId.make("primeAgent")],
    ).toEqual({
      driver: ProviderDriverKind.make("primeAgent"),
      config: settings.providers.primeAgent,
    });
  });

  it("keeps an explicit Prime Agent instance instead of overwriting it from legacy settings", () => {
    const instanceId = ProviderInstanceId.make("primeAgent");
    const explicit = {
      driver: ProviderDriverKind.make("primeAgent"),
      enabled: false,
      config: { binaryPath: "/explicit/prime-agent" },
    } as const;
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [instanceId]: explicit },
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        primeAgent: {
          ...DEFAULT_SERVER_SETTINGS.providers.primeAgent,
          binaryPath: "/legacy/prime-agent",
        },
      },
    };

    expect(deriveProviderInstanceConfigMap(settings)[instanceId]).toEqual(explicit);
  });
});
