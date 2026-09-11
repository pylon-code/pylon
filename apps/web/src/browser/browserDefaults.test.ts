import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_BROWSER_PROFILE_ID, INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";

import { ensureClientSettingsHydrated } from "~/hooks/useSettings";

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => settings.current,
  useClientSettings: () => undefined,
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
}));

const { resolveBrowserDefaults } = await import("./browserDefaults");

const withDefaultProfile = (browserDefaultProfileId: string) => {
  settings.current = {
    browserDefaultViewport: { _tag: "fill" },
    browserDefaultZoomFactor: 1,
    browserDefaultAppearance: "system",
    browserAutoShowFloatingPreview: true,
    browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
    browserDefaultProfileId,
  };
  return resolveBrowserDefaults();
};

describe("getBrowserDefaults profile resolution", () => {
  it("keeps a configured persistent profile", async () => {
    expect((await withDefaultProfile("work")).profileId).toBe("work");
  });

  it("falls back for an unknown profile", async () => {
    expect((await withDefaultProfile("deleted")).profileId).toBe(DEFAULT_BROWSER_PROFILE_ID);
  });

  it("refuses incognito as the default", async () => {
    // A stored incognito default would open every new tab into storage that is
    // discarded on close, and the settings list no longer offers it — so the
    // row badged "Default" must be the one tabs actually open under.
    expect((await withDefaultProfile(INCOGNITO_BROWSER_PROFILE_ID)).profileId).toBe(
      DEFAULT_BROWSER_PROFILE_ID,
    );
  });
});

describe("resolveBrowserDefaults", () => {
  it("rejects failed reads and uses the saved profile after a successful retry", async () => {
    await withDefaultProfile("work");
    settings.current.browserDefaultZoomFactor = 1.25;
    settings.current.browserDefaultAppearance = "dark";
    const failure = new Error("Settings read failed");
    vi.mocked(ensureClientSettingsHydrated).mockRejectedValueOnce(failure);

    await expect(resolveBrowserDefaults()).rejects.toBe(failure);
    await expect(resolveBrowserDefaults()).resolves.toMatchObject({
      viewport: { _tag: "fill" },
      zoomFactor: 1.25,
      appearance: "dark",
      autoShowFloatingPreview: true,
      profileId: "work",
    });
  });
});
