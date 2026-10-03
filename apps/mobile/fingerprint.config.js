// @ts-check
const { readAppMajorVersionFromProject } = require("./scripts/app-major-version.cjs");

// Keep each major version's over-the-air updates on its own binaries: a new
// major reaches users only once its store build ships.
//
// Expo SDK 58's fingerprint drops the app version by default, so without this
// source binaries of different majors would share a runtime version whenever
// native code is unchanged. SDK 57 still hashes the full version, which makes
// this redundant (but harmless) until the SDK 58 upgrade.
//
// The fingerprint loader swallows errors thrown here and silently falls back to
// an empty config, so a parse failure cannot fail a build. The unit test in
// scripts/app-major-version.test.mjs is the guard that keeps this readable.
module.exports = {
  extraSources: [
    {
      type: "contents",
      id: "appMajorVersion",
      contents: readAppMajorVersionFromProject(__dirname),
    },
  ],
};
