import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  hydrate: vi.fn<() => Promise<void>>(),
  settings: { browserLinkTarget: "app" as "app" | "system" },
  supportsPreview: true,
  openPreview: vi.fn(),
  openUrl: vi.fn(),
  openExternal: vi.fn(),
  recordVisit: vi.fn(),
}));
vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: mocks.hydrate,
  getClientSettings: () => mocks.settings,
}));
vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => mocks.supportsPreview,
}));
vi.mock("~/browserHistoryStore", () => ({ recordVisitForThread: mocks.recordVisit }));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: mocks.openExternal } }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.openPreview }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("./openFileInPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openFileInPreview")>()),
  openUrlInPreview: mocks.openUrl,
}));

import { BrowserSettingsReadError } from "./openFileInPreview";
import { useOpenLink } from "./useOpenLink";

const threadRef = { environmentId: "local", threadId: "thread-1" } as ScopedThreadRef;
const url = "https://example.com/docs";
function opener(ref?: ScopedThreadRef) {
  let open!: ReturnType<typeof useOpenLink>;
  function Harness() {
    open = useOpenLink(ref);
    return null;
  }
  renderToStaticMarkup(<Harness />);
  return open;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings.browserLinkTarget = "app";
  mocks.supportsPreview = true;
  mocks.hydrate.mockResolvedValue();
  mocks.openUrl.mockResolvedValue(AsyncResult.success(undefined));
  mocks.openExternal.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("useOpenLink", () => {
  it("waits for settings hydration and records the successful visit beside the target thread", async () => {
    let finishHydration!: () => void;
    const hydration = new Promise<void>((resolve) => {
      finishHydration = resolve;
    });
    mocks.settings.browserLinkTarget = "system";
    mocks.hydrate.mockReturnValue(hydration);
    const target = { ...threadRef, threadId: "thread-2" } as ScopedThreadRef;
    const opening = opener()(url, { threadRef: target });
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
    mocks.settings.browserLinkTarget = "app";
    finishHydration();
    await opening;
    expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith({
      threadRef: target,
      url,
      openPreview: mocks.openPreview,
    });
    expect(mocks.recordVisit).toHaveBeenCalledExactlyOnceWith(target, url);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
  it.each(["system", "web", "no-thread", "modifier", "non-web"])(
    "uses the external browser for %s",
    async (kind) => {
      if (kind === "system") mocks.settings.browserLinkTarget = "system";
      if (kind === "web") mocks.supportsPreview = false;
      const targetUrl = kind === "non-web" ? "mailto:hello@example.com" : url;
      await opener(kind === "no-thread" ? undefined : threadRef)(targetUrl, {
        event: { metaKey: kind === "modifier", ctrlKey: false },
      });
      expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(targetUrl);
      expect(mocks.openUrl).not.toHaveBeenCalled();
      expect(mocks.recordVisit).not.toHaveBeenCalled();
    },
  );
  it.each(["failure", "rejection"])(
    "falls back on preview %s without recording a visit",
    async (kind) => {
      const error = new Error("bridge unavailable");
      if (kind === "failure")
        mocks.openUrl.mockResolvedValue(AsyncResult.failure(Cause.fail(error)));
      else mocks.openUrl.mockRejectedValue(error);
      await opener(threadRef)(url);
      expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(url);
      expect(mocks.recordVisit).not.toHaveBeenCalled();
    },
  );
  it.each(["failure", "rejection"])(
    "rejects a settings read %s without opening either browser",
    async (kind) => {
      const error = new BrowserSettingsReadError({ cause: new Error("storage unavailable") });
      if (kind === "failure")
        mocks.openUrl.mockResolvedValue(AsyncResult.failure(Cause.fail(error)));
      else mocks.openUrl.mockRejectedValue(error);
      await expect(opener(threadRef)(url)).rejects.toBe(error);
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expect(mocks.recordVisit).not.toHaveBeenCalled();
    },
  );
  it("leaves interrupted opens alone", async () => {
    mocks.openUrl.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));
    await opener(threadRef)(url);
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.recordVisit).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
  it("propagates a failed external fallback for the caller's visible error", async () => {
    mocks.openUrl.mockRejectedValue(new Error("preview unavailable"));
    const error = new Error("shell unavailable: https://example.com/?token=secret");
    mocks.openExternal.mockRejectedValue(error);
    await expect(opener(threadRef)(url)).rejects.toMatchObject({
      message: "Unable to open link.",
      cause: error,
    });
  });
});
