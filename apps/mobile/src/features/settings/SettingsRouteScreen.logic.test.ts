import { describe, expect, it } from "vite-plus/test";

import {
  resolveAgentAwarenessPlatformPresentation,
  resolveAgentAwarenessSignInMessage,
  resolveAgentAwarenessSubtitle,
} from "./SettingsRouteScreen.logic";

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("supports agent awareness settings on Android", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      supported: true,
      subtitle: undefined,
    });
  });

  it("leaves supported iOS settings unchanged", () => {
    expect(resolveAgentAwarenessPlatformPresentation("ios")).toEqual({
      supported: true,
      subtitle: undefined,
    });
  });
});

describe("resolveAgentAwarenessSubtitle", () => {
  it("says an Android build without Firebase config cannot receive notifications", () => {
    expect(resolveAgentAwarenessSubtitle("android", "push-not-configured")).toBe(
      "This app build can't receive notifications",
    );
  });

  it("asks for a newer build when the native handler is missing", () => {
    expect(resolveAgentAwarenessSubtitle("android", "native-module-missing")).toBe(
      "Install a newer app build to enable notifications",
    );
  });

  it("adds no subtitle when notifications can be delivered", () => {
    expect(resolveAgentAwarenessSubtitle("android", "available")).toBeUndefined();
    expect(resolveAgentAwarenessSubtitle("ios")).toBeUndefined();
    expect(resolveAgentAwarenessSubtitle("web")).toBe("Unavailable on this platform");
  });
});

describe("resolveAgentAwarenessSignInMessage", () => {
  it("names the activity surface each platform actually has", () => {
    expect(resolveAgentAwarenessSignInMessage("android")).toContain("ongoing activity");
    expect(resolveAgentAwarenessSignInMessage("android")).not.toContain("Live Activity");
    expect(resolveAgentAwarenessSignInMessage("ios")).toContain("Live Activity");
  });
});
