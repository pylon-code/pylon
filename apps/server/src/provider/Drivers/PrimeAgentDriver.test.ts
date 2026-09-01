import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { isPrimeAgentProviderPlatformSupported, PrimeAgentDriver } from "./PrimeAgentDriver.ts";

describe("PrimeAgentDriver", () => {
  it("registers one global Prime Agent driver with contract defaults", () => {
    expect(PrimeAgentDriver.driverKind).toBe("primeAgent");
    expect(PrimeAgentDriver.metadata).toEqual({
      displayName: "Prime Agent",
      supportsMultipleInstances: false,
      multipleInstancesUnavailableReason: expect.stringContaining("did not pass A/B isolation"),
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

  it("supports macOS, Linux, and WSL2's Linux runtime only", () => {
    expect(isPrimeAgentProviderPlatformSupported("darwin")).toBe(true);
    expect(isPrimeAgentProviderPlatformSupported("linux")).toBe(true);
    expect(isPrimeAgentProviderPlatformSupported("win32")).toBe(false);
    expect(isPrimeAgentProviderPlatformSupported("freebsd")).toBe(false);
  });
});
