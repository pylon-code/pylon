import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PiAgentIcon } from "../Icons";
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

  it("uses the existing agent mark", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[primeAgent]).toBe(PiAgentIcon);
  });
});
