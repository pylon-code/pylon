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

describe("deriveProviderInstanceConfigMap Oh My Pi hydration", () => {
  it("preserves two explicit profile instances without synthesizing a legacy default", () => {
    const workId = ProviderInstanceId.make("omp_work");
    const personalId = ProviderInstanceId.make("omp_personal");
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [workId]: {
          driver: ProviderDriverKind.make("omp"),
          displayName: "Oh My Pi Work",
          config: { binaryPath: "/work/omp", profile: "work" },
        },
        [personalId]: {
          driver: ProviderDriverKind.make("omp"),
          displayName: "Oh My Pi Personal",
          environment: [{ name: "OMP_HOME", value: "/profiles/personal", sensitive: false }],
          config: { binaryPath: "/personal/omp", profile: "personal" },
        },
      } as ServerSettings["providerInstances"],
    };

    const hydrated = deriveProviderInstanceConfigMap(settings);
    expect(hydrated[workId]).toEqual(settings.providerInstances[workId]);
    expect(hydrated[personalId]).toEqual(settings.providerInstances[personalId]);
    expect(hydrated[ProviderInstanceId.make("omp")]).toBeUndefined();
  });
});
