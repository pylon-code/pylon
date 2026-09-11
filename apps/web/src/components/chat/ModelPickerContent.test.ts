import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { shouldIncludeModelPickerOption, shouldOfferModelPickerSetup } from "./ModelPickerContent";

function entry(status: ServerProvider["status"], driver = "opencode") {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make(`${driver}_work`),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ])[0]!;
}

describe("shouldIncludeModelPickerOption", () => {
  it("keeps only the active synthetic OpenCode row when the provider status is error", () => {
    const providerEntry = entry("error");
    const activeInstanceId = ProviderInstanceId.make("opencode_work");
    const activeModel = "openrouter/kimi-k3";

    expect(
      shouldIncludeModelPickerOption({
        entry: providerEntry,
        option: {
          slug: activeModel,
          name: activeModel,
          isUnavailable: true,
        },
        activeInstanceId,
        activeModel,
      }),
    ).toBe(true);
    expect(
      shouldIncludeModelPickerOption({
        entry: providerEntry,
        option: { slug: "stale/model", name: "Stale model" },
        activeInstanceId,
        activeModel,
      }),
    ).toBe(false);
    expect(
      shouldIncludeModelPickerOption({
        entry: providerEntry,
        option: {
          slug: "other/missing",
          name: "Other missing",
          isUnavailable: true,
        },
        activeInstanceId,
        activeModel,
      }),
    ).toBe(false);
  });

  it("keeps warning provider models selectable", () => {
    const providerEntry = entry("warning");
    const activeInstanceId = ProviderInstanceId.make("opencode_work");
    const activeModel = "openrouter/kimi-k3";

    for (const option of [
      { slug: activeModel, name: activeModel, isUnavailable: true },
      { slug: "stale/model", name: "Stale model" },
      { slug: "other/missing", name: "Other missing", isUnavailable: true },
    ]) {
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option,
          activeInstanceId,
          activeModel,
        }),
      ).toBe(true);
    }
  });
});

describe("shouldOfferModelPickerSetup", () => {
  const availableModel = { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" };

  it("offers setup before an Antigravity account has models", () => {
    expect(shouldOfferModelPickerSetup(entry("error", "antigravity"), [])).toBe(true);
  });

  it("offers setup after sign-out even if a model remains cached", () => {
    const providerEntry = entry("ready", "antigravity");
    expect(
      shouldOfferModelPickerSetup(
        {
          ...providerEntry,
          snapshot: { ...providerEntry.snapshot, auth: { status: "unauthenticated" } },
        },
        [availableModel],
      ),
    ).toBe(true);
  });

  it("offers setup when the only model is an unavailable saved selection", () => {
    expect(
      shouldOfferModelPickerSetup(entry("ready", "antigravity"), [
        { ...availableModel, isUnavailable: true },
      ]),
    ).toBe(true);
  });

  it("does not offer setup for a ready account with available models", () => {
    expect(shouldOfferModelPickerSetup(entry("ready", "antigravity"), [availableModel])).toBe(
      false,
    );
  });

  it("does not restore a disabled provider while its status snapshot is stale", () => {
    expect(
      shouldOfferModelPickerSetup({ ...entry("error", "antigravity"), enabled: false }, []),
    ).toBe(false);
  });

  it("keeps providers without integrated setup on their existing path", () => {
    expect(shouldOfferModelPickerSetup(entry("error", "codex"), [])).toBe(false);
  });

  it("uses the environment's setup capability for other drivers", () => {
    const providerEntry = entry("error", "custom_driver");
    expect(
      shouldOfferModelPickerSetup(
        {
          ...providerEntry,
          snapshot: {
            ...providerEntry.snapshot,
            setup: { canAuthenticate: true, canInstall: false },
          },
        },
        [],
      ),
    ).toBe(true);
  });
});
