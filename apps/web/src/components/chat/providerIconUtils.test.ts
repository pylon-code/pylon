import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { JcodeIcon, PrimeAgentIcon } from "../Icons";
import { PROVIDER_ICON_BY_PROVIDER, AVAILABLE_PROVIDER_OPTIONS } from "./providerIconUtils";

describe("Prime Agent provider presentation", () => {
  const primeAgent = ProviderDriverKind.make("primeAgent");

  it("is available in the provider picker", () => {
    expect(AVAILABLE_PROVIDER_OPTIONS).toContainEqual({
      value: primeAgent,
      label: "Prime Agent",
      available: true,
      pickerSidebarBadge: "new",
    });
  });

  it("uses the official Prime Agent butterfly mark", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[primeAgent]).toBe(PrimeAgentIcon);
  });
});

describe("Jcode provider presentation", () => {
  const jcode = ProviderDriverKind.make("jcode");

  it("is available in the provider picker", () => {
    expect(AVAILABLE_PROVIDER_OPTIONS).toContainEqual({
      value: jcode,
      label: "Jcode",
      available: true,
      pickerSidebarBadge: "new",
    });
  });

  it("uses the Jcode terminal mark in chat, sidebar, and model presentation", () => {
    // Asserted defined first: a missing export would otherwise make the
    // identity check pass vacuously with `undefined === undefined`.
    expect(typeof JcodeIcon).toBe("function");
    expect(PROVIDER_ICON_BY_PROVIDER[jcode]).toBe(JcodeIcon);
  });

  it("does not borrow another provider's mark", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[jcode]).not.toBe(PrimeAgentIcon);
    expect(PROVIDER_ICON_BY_PROVIDER[jcode]).toBeDefined();
  });
});
