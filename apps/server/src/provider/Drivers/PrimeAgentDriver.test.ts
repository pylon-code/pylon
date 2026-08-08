import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { PrimeAgentDriver } from "./PrimeAgentDriver.ts";

describe("PrimeAgentDriver", () => {
  it("registers one global Prime Agent driver with contract defaults", () => {
    expect(PrimeAgentDriver.driverKind).toBe("primeAgent");
    expect(PrimeAgentDriver.metadata).toEqual({
      displayName: "Prime Agent",
      supportsMultipleInstances: false,
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
});
