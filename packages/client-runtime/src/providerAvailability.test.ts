import { describe, expect, it } from "vite-plus/test";

import { getProviderUnavailablePresentation } from "./providerAvailability.ts";

describe("getProviderUnavailablePresentation", () => {
  it("prefers the actionable unavailable reason over a probe message", () => {
    expect(
      getProviderUnavailablePresentation({
        availability: "unavailable",
        unavailableReason: "Run the Pylon server and this provider in WSL2.",
        message: "Disabled",
      }),
    ).toEqual({
      headline: "Unavailable",
      detail: "Run the Pylon server and this provider in WSL2.",
    });
  });

  it("falls back from an empty reason to the probe message", () => {
    expect(
      getProviderUnavailablePresentation({
        availability: "unavailable",
        unavailableReason: "  ",
        message: "This provider cannot run here.",
      }),
    ).toEqual({ headline: "Unavailable", detail: "This provider cannot run here." });
  });

  it("uses provider-neutral copy when the server has no detail", () => {
    expect(getProviderUnavailablePresentation({ availability: "unavailable" })).toEqual({
      headline: "Unavailable",
      detail: "This provider is unavailable in the current environment.",
    });
  });

  it("does not replace ordinary disabled presentation", () => {
    expect(getProviderUnavailablePresentation({ message: "Disabled" })).toBeNull();
  });
});
