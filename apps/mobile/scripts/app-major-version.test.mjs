import * as NodeModule from "node:module";
import { describe, expect, it } from "vitest";

import { readAppMajorVersion, readAppMajorVersionFromProject } from "./app-major-version.cjs";

const require = NodeModule.createRequire(import.meta.url);
const mobileRoot = new URL("..", import.meta.url).pathname;

const appConfig = (version) => `const config: ExpoConfig = {
  name: variant.appName,
  version: "${version}",
  runtimeVersion: {
    policy: process.env.MOBILE_VERSION_POLICY ?? "fingerprint",
  },
};`;

describe("app major version", () => {
  it("is stable across minor and patch releases and changes with the major", () => {
    expect(readAppMajorVersion(appConfig("1.0.1"))).toBe("1");
    expect(readAppMajorVersion(appConfig("1.4.0"))).toBe("1");
    expect(readAppMajorVersion(appConfig("1.0.2-beta.1"))).toBe("1");
    expect(readAppMajorVersion(appConfig("2.0.0"))).toBe("2");
    expect(readAppMajorVersion(appConfig("10.3.7"))).toBe("10");
  });

  it("rejects a missing, non-semver or ambiguous version", () => {
    expect(() => readAppMajorVersion("const config = {};")).toThrow(/found 0/);
    expect(() => readAppMajorVersion(appConfig("1.0"))).toThrow(/found 0/);
    expect(() => readAppMajorVersion(`${appConfig("1.0.1")}\n${appConfig("2.0.0")}`)).toThrow(
      /found 2/,
    );
  });

  // The fingerprint loader swallows config errors, so this is what fails CI if
  // app.config.ts stops matching and the major silently leaves the fingerprint.
  it("reads the real app.config.ts and feeds it to the fingerprint config", () => {
    const majorVersion = readAppMajorVersionFromProject(mobileRoot);
    expect(majorVersion).toMatch(/^\d+$/);

    const fingerprintConfig = require("../fingerprint.config.js");
    expect(fingerprintConfig).toEqual({
      extraSources: [{ type: "contents", id: "appMajorVersion", contents: majorVersion }],
    });
  });
});
