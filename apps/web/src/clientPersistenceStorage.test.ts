import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function getTestWindow(): Window & typeof globalThis {
  const localStorage = createLocalStorageStub();
  const testWindow = {
    localStorage,
  } as Window & typeof globalThis;
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("localStorage", localStorage);
  return testWindow;
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clientPersistenceStorage", () => {
  it("persists client settings in browser storage", async () => {
    getTestWindow();
    const { readBrowserClientSettings, writeBrowserClientSettings } =
      await import("./clientPersistenceStorage");
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "24-hour" as const,
    };

    writeBrowserClientSettings(settings);

    expect(readBrowserClientSettings()).toEqual(settings);
  });

  it.each(["not-json", "[]"])(
    "falls back to defaults for a document that is not settings JSON: %s",
    async (value) => {
      const testWindow = getTestWindow();
      testWindow.localStorage.setItem("t3code:client-settings:v1", value);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

      expect(readBrowserClientSettings()).toBeNull();
      expect(consoleError).toHaveBeenCalledWith(
        "Could not read persisted client settings.",
        ...(value === "not-json"
          ? [
              expect.objectContaining({
                _tag: "LocalStorageOperationError",
                operation: "decode",
                storageKey: "t3code:client-settings:v1",
              }),
            ]
          : []),
      );
      expect(testWindow.localStorage.getItem("t3code:client-settings:v1")).toBe(value);
    },
  );

  // T3 Code served from the same origin writes `confirmQuit` as "hold" | "direct" | "double-click".
  const t3CodeDocument = JSON.stringify({
    confirmQuit: "hold",
    timestampFormat: "12-hour",
    wordWrap: false,
  });

  it("keeps readable settings when another client's value cannot be decoded", async () => {
    const testWindow = getTestWindow();
    testWindow.localStorage.setItem("t3code:client-settings:v1", t3CodeDocument);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const write = vi.spyOn(testWindow.localStorage, "setItem");
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

    expect(readBrowserClientSettings()).toEqual({
      ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "12-hour",
      wordWrap: false,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("hydrates the app and leaves an unread value in place until that setting changes", async () => {
    const testWindow = getTestWindow();
    testWindow.localStorage.setItem("t3code:client-settings:v1", t3CodeDocument);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { ensureClientSettingsHydrated, getClientSettings, persistClientSettingsUpdate } =
      await import("./hooks/useSettings");
    const storedDocument = () =>
      JSON.parse(testWindow.localStorage.getItem("t3code:client-settings:v1") ?? "null");

    await ensureClientSettingsHydrated();
    expect(getClientSettings()).toEqual({
      ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "12-hour",
      wordWrap: false,
    });

    await persistClientSettingsUpdate((current) => ({
      ...current,
      onboardingCompletedAt: "2026-09-10T12:00:00.000Z",
    }));
    expect(storedDocument()).toMatchObject({
      confirmQuit: "hold",
      timestampFormat: "12-hour",
      onboardingCompletedAt: "2026-09-10T12:00:00.000Z",
    });

    await persistClientSettingsUpdate((current) => ({ ...current, confirmQuit: false }));
    expect(storedDocument()).toMatchObject({ confirmQuit: false });
    await persistClientSettingsUpdate((current) => ({ ...current, wordWrap: true }));
    expect(storedDocument()).toMatchObject({ confirmQuit: false, wordWrap: true });
  });

  it("preserves saved settings across a transient read failure", async () => {
    const testWindow = getTestWindow();
    const settings = { ...DEFAULT_CLIENT_SETTINGS, timestampFormat: "12-hour" as const };
    testWindow.localStorage.setItem("t3code:client-settings:v1", JSON.stringify(settings));
    const write = vi.spyOn(testWindow.localStorage, "setItem");
    const failure = new Error("storage unavailable");
    vi.spyOn(testWindow.localStorage, "getItem").mockImplementationOnce(() => {
      throw failure;
    });
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

    expect(() => readBrowserClientSettings()).toThrow(
      expect.objectContaining({
        _tag: "LocalStorageOperationError",
        operation: "read",
        storageKey: "t3code:client-settings:v1",
        cause: failure,
      }),
    );
    expect(readBrowserClientSettings()).toEqual(settings);
    expect(write).not.toHaveBeenCalled();
  });

  it("defaults word wrap on and discards obsolete wrapping preferences", async () => {
    const testWindow = getTestWindow();
    testWindow.localStorage.setItem(
      "t3code:client-settings:v1",
      JSON.stringify({
        chatWordWrap: false,
        diffWordWrap: false,
      }),
    );
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");
    const settings = readBrowserClientSettings();

    expect(settings).toEqual(
      expect.objectContaining({
        wordWrap: true,
      }),
    );
    expect(settings).not.toHaveProperty("chatWordWrap");
    expect(settings).not.toHaveProperty("diffWordWrap");
  });

  it("keeps the diff layout across reloads and defaults it to stacked", async () => {
    const testWindow = getTestWindow();
    const { readBrowserClientSettings, writeBrowserClientSettings } =
      await import("./clientPersistenceStorage");

    expect(readBrowserClientSettings()).toBeNull();
    testWindow.localStorage.setItem("t3code:client-settings:v1", JSON.stringify({}));
    expect(readBrowserClientSettings()?.diffLayout).toBe("stacked");

    writeBrowserClientSettings({ ...DEFAULT_CLIENT_SETTINGS, diffLayout: "split" });
    expect(readBrowserClientSettings()?.diffLayout).toBe("split");
  });
});
