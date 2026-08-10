import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_MODEL_BY_PROVIDER, PROVIDER_DISPLAY_NAMES } from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

describe("Prime Agent model metadata", () => {
  const primeAgent = ProviderDriverKind.make("primeAgent");

  it("uses the synthetic default selection understood by the Prime driver", () => {
    expect(DEFAULT_MODEL_BY_PROVIDER[primeAgent]).toBe("default");
  });

  it("presents the first-party driver with its product name", () => {
    expect(PROVIDER_DISPLAY_NAMES[primeAgent]).toBe("Prime Agent");
  });
});

describe("Jcode model metadata", () => {
  const jcode = ProviderDriverKind.make("jcode");

  it("presents the driver with its product name", () => {
    expect(PROVIDER_DISPLAY_NAMES[jcode]).toBe("Jcode");
  });

  // Jcode's attached session reports the current model and live catalog, so a
  // hardcoded default here would fight the session's own selection.
  it("does not hardcode a default model", () => {
    expect(DEFAULT_MODEL_BY_PROVIDER[jcode]).toBeUndefined();
  });
});
