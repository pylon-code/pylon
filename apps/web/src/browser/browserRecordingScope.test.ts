import { describe, expect, it } from "vite-plus/test";

import {
  resolveBrowserRecordingStopTarget,
  shouldTransferBrowserRecording,
} from "./browserRecordingScope";

describe("resolveBrowserRecordingStopTarget", () => {
  it("stops the only active recording when the implicit browser target changed", () => {
    expect(resolveBrowserRecordingStopTarget(new Set(["tab-recording"]), "tab-browsing")).toBe(
      "tab-recording",
    );
  });

  it("prefers an implicit target that is actively recording", () => {
    expect(
      resolveBrowserRecordingStopTarget(
        new Set(["tab-recording-a", "tab-recording-b"]),
        "tab-recording-b",
      ),
    ).toBe("tab-recording-b");
  });

  it("does not guess when multiple recordings are active and the implicit target is not one", () => {
    expect(
      resolveBrowserRecordingStopTarget(
        new Set(["tab-recording-a", "tab-recording-b"]),
        "tab-browsing",
      ),
    ).toBeNull();
  });

  it("only stops an explicitly requested tab when that tab is recording", () => {
    const activeTabIds = new Set(["tab-recording"]);
    expect(resolveBrowserRecordingStopTarget(activeTabIds, "tab-browsing", "tab-recording")).toBe(
      "tab-recording",
    );
    expect(resolveBrowserRecordingStopTarget(activeTabIds, "tab-recording", "tab-browsing")).toBe(
      null,
    );
  });

  it("returns null when no matching recording is active", () => {
    expect(resolveBrowserRecordingStopTarget(new Set(), "tab-browsing")).toBeNull();
  });
});

describe("shouldTransferBrowserRecording", () => {
  it("leaves the recording in place for the desktop's own environment", () => {
    expect(
      shouldTransferBrowserRecording({
        transferRequested: true,
        environmentId: "primary",
        primaryEnvironmentId: "primary",
      }),
    ).toBe(false);
  });

  it("transfers to a remote, relay or tunnel environment", () => {
    expect(
      shouldTransferBrowserRecording({
        transferRequested: true,
        environmentId: "remote",
        primaryEnvironmentId: "primary",
      }),
    ).toBe(true);
    expect(
      shouldTransferBrowserRecording({
        transferRequested: true,
        environmentId: "remote",
        primaryEnvironmentId: null,
      }),
    ).toBe(true);
  });

  it("never transfers for a server that did not ask", () => {
    expect(
      shouldTransferBrowserRecording({
        transferRequested: false,
        environmentId: "remote",
        primaryEnvironmentId: "primary",
      }),
    ).toBe(false);
  });
});
