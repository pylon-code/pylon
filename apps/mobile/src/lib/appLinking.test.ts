import { describe, expect, it } from "vite-plus/test";

import { shouldHandleAppLink } from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each([
    "pylon-code://",
    "pylon-code:///",
    "pylon-code-dev://",
    "pylon-code-dev:///",
    "pylon-code-preview://",
    "pylon-code-preview:///",
    "PYLON-CODE://",
  ])("keeps the current route for wake-only link %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(false);
  });

  it.each([
    "pylon-code://threads/env-1/thread-1",
    "pylon-code-dev://threads/env-1/thread-1",
    "pylon-code-preview://settings/environments",
    "pylon-code://pair?pairingUrl=https%3A%2F%2Fexample.test",
    "pylon-code://?pairingUrl=https%3A%2F%2Fexample.test",
  ])("preserves navigable and pairing link %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(true);
  });

  it.each([
    "pylon-code-dev://expo-development-client/?url=packager",
    "pylon-code://expo-sharing/anything",
  ])("ignores native lifecycle link %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(false);
  });
});
