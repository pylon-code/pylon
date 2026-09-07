import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PrimeAgentIcon } from "../Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";
import { PROVIDER_OPTIONS } from "../../session-logic";

describe("Prime Agent provider presentation", () => {
  const primeAgent = ProviderDriverKind.make("primeAgent");

  it("is available in the provider picker", () => {
    expect(PROVIDER_OPTIONS).toContainEqual({
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
