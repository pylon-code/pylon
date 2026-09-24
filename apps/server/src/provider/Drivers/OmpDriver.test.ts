import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { OmpDriver } from "./OmpDriver.ts";

describe("OmpDriver", () => {
  it("registers one multi-instance Oh My Pi driver with instance-owned defaults", () => {
    expect(OmpDriver.driverKind).toBe("omp");
    expect(OmpDriver.metadata).toEqual({
      displayName: "Oh My Pi",
      supportsMultipleInstances: true,
    });
    expect(OmpDriver.defaultConfig()).toEqual({
      binaryPath: "omp",
      profile: "",
      customModels: [],
    });
    expect("enabled" in OmpDriver.defaultConfig()).toBe(false);
    expect(BUILT_IN_DRIVERS.filter((driver) => driver.driverKind === "omp")).toEqual([OmpDriver]);
  });
});
