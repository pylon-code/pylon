import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  getProviderModelAdmissionAvailability,
  resolveProviderCatalogModelSelection,
  shouldRefreshProviderModelCatalog,
} from "./providerModelSelection";

function account(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("antigravity_work"),
    driver: ProviderDriverKind.make("antigravity"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-12T12:00:00.000Z",
    models: [
      {
        slug: "work-model",
        name: "Work Model",
        isCustom: false,
        capabilities: null,
        isDefault: true,
      },
    ],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const selection = (model = ANTIGRAVITY_DEFAULT_MODEL): ModelSelection => ({
  instanceId: ProviderInstanceId.make("antigravity_work"),
  model,
  options: [{ id: "thinking", value: "high" }],
});

describe("mobile Antigravity model admission", () => {
  it("resolves account aliases before its default, then first catalog model, preserving options", () => {
    const provider = account({
      models: [
        { slug: "first", name: "First", isCustom: false, capabilities: null },
        {
          slug: "declared-default",
          name: "Default",
          isCustom: false,
          capabilities: null,
          isDefault: true,
        },
        {
          slug: "alias-default",
          name: "Alias",
          isCustom: false,
          capabilities: null,
          aliases: [ANTIGRAVITY_DEFAULT_MODEL, "old-name"],
        },
      ],
    });
    expect(resolveProviderCatalogModelSelection(provider, selection())).toEqual({
      ...selection(),
      model: "alias-default",
    });
    expect(resolveProviderCatalogModelSelection(provider, selection("old-name"))).toEqual({
      ...selection(),
      model: "alias-default",
    });
    expect(
      resolveProviderCatalogModelSelection(
        { ...provider, models: provider.models.slice(0, 2) },
        selection(),
      ).model,
    ).toBe("declared-default");
    expect(
      resolveProviderCatalogModelSelection(
        { ...provider, models: provider.models.slice(0, 1) },
        selection(),
      ).model,
    ).toBe("first");
  });

  it("keeps unresolved and vanished choices in their original account without static fallback", () => {
    const marker = selection();
    expect(resolveProviderCatalogModelSelection(account({ models: [] }), marker)).toBe(marker);
    expect(
      resolveProviderCatalogModelSelection(
        account({ instanceId: ProviderInstanceId.make("antigravity_personal") }),
        marker,
      ),
    ).toBe(marker);
    const vanished = selection("removed-model");
    expect(resolveProviderCatalogModelSelection(account(), vanished)).toBe(vanished);
    expect(
      getProviderModelAdmissionAvailability({ provider: account(), selection: vanished }),
    ).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("no longer available"),
    });
  });

  it("allows concrete saved models after restart but never sends the unresolved marker", () => {
    const provider = account({ auth: { status: "unknown" }, models: [] });
    expect(
      getProviderModelAdmissionAvailability({ provider, selection: selection("saved-model") })
        .status,
    ).toBe("available");
    expect(shouldRefreshProviderModelCatalog(provider, selection("saved-model"))).toBe(false);
    expect(getProviderModelAdmissionAvailability({ provider, selection: selection() }).status).toBe(
      "unavailable",
    );
    expect(shouldRefreshProviderModelCatalog(provider, selection())).toBe(true);
  });

  it("holds checked empty catalogs and refreshes only the selected account", () => {
    const provider = account({ models: [] });
    expect(
      getProviderModelAdmissionAvailability({ provider, selection: selection("saved-model") })
        .status,
    ).toBe("unavailable");
    expect(shouldRefreshProviderModelCatalog(provider, selection("saved-model"))).toBe(true);
    expect(
      shouldRefreshProviderModelCatalog(
        { ...provider, instanceId: ProviderInstanceId.make("antigravity_personal") },
        selection(),
      ),
    ).toBe(false);
    expect(shouldRefreshProviderModelCatalog(account(), selection("removed-model"))).toBe(false);
  });

  it.each([
    { enabled: false },
    { installed: false },
    { auth: { status: "unauthenticated" as const } },
    { status: "error" as const },
    { status: "disabled" as const },
    { availability: "unavailable" as const, unavailableReason: "Account is unavailable." },
  ])("preserves shared provider admission before catalog discovery: %j", (overrides) => {
    const provider = account({ ...overrides, models: [] });
    expect(
      getProviderModelAdmissionAvailability({ provider, selection: selection("saved-model") })
        .status,
    ).toBe("unavailable");
    expect(shouldRefreshProviderModelCatalog(provider, selection())).toBe(false);
  });

  it("keeps warning retry and other providers compatible while rejecting blank models", () => {
    expect(
      getProviderModelAdmissionAvailability({
        provider: account({ status: "warning" }),
        selection: selection("saved-model"),
      }).status,
    ).toBe("available");
    expect(
      getProviderModelAdmissionAvailability({ provider: account(), selection: selection("  ") })
        .status,
    ).toBe("unavailable");
    const prime = account({ driver: ProviderDriverKind.make("primeAgent"), models: [] });
    expect(
      getProviderModelAdmissionAvailability({ provider: prime, selection: selection("default") })
        .status,
    ).toBe("available");
    expect(shouldRefreshProviderModelCatalog(prime, selection())).toBe(false);
    expect(
      getProviderModelAdmissionAvailability({
        provider: undefined,
        selection: selection(),
        providerSnapshotKnown: false,
      }).status,
    ).toBe("unknown");
  });
});
