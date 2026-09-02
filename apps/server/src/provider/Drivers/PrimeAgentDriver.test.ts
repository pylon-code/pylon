import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import {
  getPrimeAgentMultipleInstanceCapability,
  isPrimeAgentProviderPlatformSupported,
  primeAgentAcpFallbackHasNativeTeardownProof,
  PrimeAgentDriver,
} from "./PrimeAgentDriver.ts";

describe("PrimeAgentDriver", () => {
  it("registers one global Prime Agent driver with contract defaults", () => {
    expect(PrimeAgentDriver.driverKind).toBe("primeAgent");
    expect(PrimeAgentDriver.metadata).toMatchObject({
      displayName: "Prime Agent",
      supportsMultipleInstances: false,
      multipleInstancesUnavailableReason: expect.stringMatching(/N=1\/2\/4/u),
    });
    expect(PrimeAgentDriver.defaultConfig()).toEqual({
      enabled: true,
      binaryPath: "prime-agent",
      agentHomePath: "",
      launchArgs: "",
      customModels: [],
    });
    expect(BUILT_IN_DRIVERS.filter((driver) => driver.driverKind === "primeAgent")).toEqual([
      PrimeAgentDriver,
    ]);
  });

  it("keeps multiple instances disabled until the graduation proof passes", () => {
    for (const input of [
      { runtime: "daemon" as const, managedArtifactProved: true },
      { runtime: "daemon" as const, managedArtifactProved: false },
      { runtime: "acp" as const, managedArtifactProved: true },
    ]) {
      const capability = getPrimeAgentMultipleInstanceCapability(input);
      expect(capability.supportsMultipleInstances).toBe(false);
      expect(capability.multipleInstancesUnavailableReason).toMatch(/N=1\/2\/4|managed|ACP/u);
      expect(capability.multipleInstancesUnavailableReason).not.toContain("/private/");
    }
  });

  it("allows N=1 ACP only after native ownership teardown is empty", () => {
    expect(
      primeAgentAcpFallbackHasNativeTeardownProof({
        receipts: [],
        quarantinedHomes: [],
        quarantinedHomeDigests: [],
        corrupt: false,
      }),
    ).toBe(true);
    expect(
      primeAgentAcpFallbackHasNativeTeardownProof({
        receipts: [],
        quarantinedHomes: [],
        quarantinedHomeDigests: [],
        corrupt: true,
      }),
    ).toBe(false);
    expect(
      primeAgentAcpFallbackHasNativeTeardownProof({
        corrupt: false,
        quarantinedHomes: [],
        quarantinedHomeDigests: [],
        receipts: [
          {
            version: 1,
            state: "pending",
            attemptId: "opaque-attempt",
            instanceId: "primeAgent",
            creationConfigRevision: "old",
            currentConfigRevision: "old",
            effectiveHome: "/private/home",
            ownerProcessId: "opaque-owner",
          },
        ],
      }),
    ).toBe(false);
  });

  it("supports macOS, Linux, and WSL2's Linux runtime only", () => {
    expect(isPrimeAgentProviderPlatformSupported("darwin")).toBe(true);
    expect(isPrimeAgentProviderPlatformSupported("linux")).toBe(true);
    expect(isPrimeAgentProviderPlatformSupported("win32")).toBe(false);
    expect(isPrimeAgentProviderPlatformSupported("freebsd")).toBe(false);
  });
});
