import { ProviderDriverKind } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderInstanceIcon,
  resolveProviderInstanceAcpRegistryIconUrl,
} from "./ProviderInstanceIcon";

describe("ProviderInstanceIcon", () => {
  it("uses the Prime butterfly for built-in and custom Prime instances", () => {
    for (const displayName of ["Prime Agent", "Prime Personal"]) {
      const markup = renderToStaticMarkup(
        createElement(ProviderInstanceIcon, {
          driverKind: ProviderDriverKind.make("primeAgent"),
          displayName,
        }),
      );

      expect(markup).toContain('viewBox="0 0 178 178"');
      expect(markup).toContain("fill-[#0b0f14] dark:fill-white");
      expect(markup).not.toContain(">PA</span>");
      expect(markup).not.toContain(">PP</span>");
    }
  });
});

describe("resolveProviderInstanceAcpRegistryIconUrl", () => {
  it("uses allowlisted catalog metadata and rejects untrusted overrides", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "kilo",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/kilo.svg");
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "generic-agent",
        iconUrl: "https://example.com/not-official.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg");
  });

  it("does not resolve registry icons for other provider drivers", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("codex"),
        agentId: "kilo",
      }),
    ).toBeNull();
  });
});
