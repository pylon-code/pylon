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

describe("Oh My Pi model metadata", () => {
  const omp = ProviderDriverKind.make("omp");

  it("uses the profile default selection understood by the Oh My Pi driver", () => {
    expect(DEFAULT_MODEL_BY_PROVIDER[omp]).toBe("default");
  });

  it("presents the first-party driver with its product name", () => {
    expect(PROVIDER_DISPLAY_NAMES[omp]).toBe("Oh My Pi");
  });
});
