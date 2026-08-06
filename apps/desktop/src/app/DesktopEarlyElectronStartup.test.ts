// @effect-diagnostics nodeBuiltinImport:off - tests use POSIX path joining to match the Linux startup boundary.
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  resolveEarlyLinuxElectronOptions,
  resolveEarlyLinuxPasswordStorePreference,
} from "./DesktopEarlyElectronStartup.ts";

const STABLE_VERSION = "0.0.31";
const NIGHTLY_VERSION = "0.0.31-nightly.20260805.1";

describe("DesktopEarlyElectronStartup", () => {
  const joinPath = NodePath.posix.join;

  it("reads the persisted linux password-store preference before Electron is ready", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/home/user/.t3-test" },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: STABLE_VERSION,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3-test/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.equal(preference, "kwallet6");
  });

  it("accepts JSONC in the early desktop settings file", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/home/user/.t3-test" },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: STABLE_VERSION,
      readFileString: () => `{
        // manually edited setting
        "linuxPasswordStore": "gnome-libsecret",
      }`,
    });

    assert.equal(preference, "gnome-libsecret");
  });

  it("falls back to auto when the early settings document is missing or invalid", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {},
      homeDirectory: "/home/user",
      joinPath,
      appVersion: STABLE_VERSION,
      readFileString: () => {
        throw new Error("missing");
      },
    });

    assert.equal(preference, "auto");
  });

  it("preserves absolute root paths when resolving early settings", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/" },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: STABLE_VERSION,
      readFileString: (path) => {
        assert.equal(path, "/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.equal(preference, "kwallet6");
  });

  it("resolves the early linux Electron switches", () => {
    const options = resolveEarlyLinuxElectronOptions({
      env: {
        T3CODE_HOME: "/home/user/.t3-test",
        XDG_CURRENT_DESKTOP: "niri",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: STABLE_VERSION,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3-test/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "auto" });
      },
    });

    assert.deepEqual(options, {
      linuxWmClass: "pylon-code-dev",
      passwordStore: "gnome-libsecret",
    });
  });

  it("keeps implicit development state under ~/.pylon-code/dev when T3CODE_HOME is unset", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: STABLE_VERSION,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.pylon-code/dev/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet" });
      },
    });

    assert.equal(preference, "kwallet");
  });

  // The whole point of the nightly channel: it must not read or write the
  // state the installed stable app is using, and the safe answer has to be the
  // default because nobody sets an override before double-clicking an app.
  it("keeps a nightly build's state out of the stable runtime home", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {},
      homeDirectory: "/home/user",
      joinPath,
      appVersion: NIGHTLY_VERSION,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.pylon-code-nightly/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.equal(preference, "kwallet6");
  });

  it("keeps a stable build on the stable runtime home", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {},
      homeDirectory: "/home/user",
      joinPath,
      appVersion: STABLE_VERSION,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.pylon-code/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.equal(preference, "kwallet6");
  });

  // An explicit home is a deliberate instruction and still outranks the channel.
  it("lets an explicit T3CODE_HOME override the nightly home", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/home/user/.pylon-scratch" },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: NIGHTLY_VERSION,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.pylon-scratch/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.equal(preference, "kwallet6");
  });

  it("gives a nightly build its own window class", () => {
    const options = resolveEarlyLinuxElectronOptions({
      env: { T3CODE_HOME: "/home/user/.t3-test" },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: NIGHTLY_VERSION,
      readFileString: () => JSON.stringify({ linuxPasswordStore: "auto" }),
    });

    assert.equal(options.linuxWmClass, "pylon-code-nightly");
  });

  it("treats whitespace-only T3CODE_HOME as unconfigured in development", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {
        T3CODE_HOME: "   ",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      appVersion: STABLE_VERSION,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.pylon-code/dev/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "gnome-libsecret" });
      },
    });

    assert.equal(preference, "gnome-libsecret");
  });
});
