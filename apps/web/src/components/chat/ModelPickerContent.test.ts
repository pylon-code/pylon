import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { shouldIncludeModelPickerOption } from "./ModelPickerContent";

function entry(status: ServerProvider["status"]) {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("opencode_work"),
      driver: ProviderDriverKind.make("opencode"),
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
