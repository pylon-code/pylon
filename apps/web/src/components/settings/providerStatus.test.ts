import { describe, expect, it } from "vite-plus/test";

import { getProviderDistributionLabel } from "./providerStatus";

describe("getProviderDistributionLabel", () => {
  it("keeps stock providers quiet and labels managed, manual, and invalid proof", () => {
    expect(getProviderDistributionLabel(undefined)).toBeNull();
    expect(
      getProviderDistributionLabel({
        classification: "stock-or-custom",
        channel: null,
        buildId: null,
        sequence: null,
        latestBuildId: null,
        latestSequence: null,
        updateAvailable: false,
        checkedAt: null,
        message: null,
      }),
    ).toBeNull();
    expect(
      getProviderDistributionLabel({
        classification: "pylon-managed",
        channel: "preview",
        buildId: "pylon-build-g0123456789ab-r1",
        sequence: 9,
        latestBuildId: "pylon-build-g0123456789ab-r1",
        latestSequence: 9,
        updateAvailable: false,
        checkedAt: null,
        message: null,
      }),
    ).toBe("Pylon managed · preview #9");
    expect(
      getProviderDistributionLabel({
        classification: "pylon-unmanaged",
        channel: null,
        buildId: "pylon-build-g0123456789ab-r1",
        sequence: null,
        latestBuildId: null,
        latestSequence: null,
        updateAvailable: false,
        checkedAt: null,
        message: null,
      }),
    ).toBe("Pylon build · manual");
    expect(
      getProviderDistributionLabel({
        classification: "invalid-receipt",
        channel: null,
        buildId: null,
        sequence: null,
        latestBuildId: null,
        latestSequence: null,
        updateAvailable: false,
        checkedAt: null,
        message: null,
      }),
    ).toBe("Managed receipt invalid");
  });
});
