// @ts-check
const fs = require("node:fs");
const path = require("node:path");

// The app version is the top-level `version: "X.Y.Z"` property of the Expo
// config. app.config.ts is TypeScript, which the fingerprint loader cannot
// require, so it is read as text. Exactly one match is required: a second
// two-space `version:` line would make the source of truth ambiguous.
const APP_VERSION_PATTERN = /^ {2}version: "(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?",?$/gm;

/**
 * @param {string} appConfigSource Contents of app.config.ts.
 * @returns {string} The app's major version, such as "1".
 */
function readAppMajorVersion(appConfigSource) {
  const matches = [...appConfigSource.matchAll(APP_VERSION_PATTERN)];
  const majorVersion = matches.length === 1 ? matches[0]?.[1] : undefined;
  if (!majorVersion) {
    throw new Error(
      `Expected exactly one top-level semver \`version: "X.Y.Z"\` in app.config.ts, found ${matches.length}.`,
    );
  }
  return majorVersion;
}

/**
 * @param {string} mobileRoot Directory containing app.config.ts.
 * @returns {string}
 */
function readAppMajorVersionFromProject(mobileRoot) {
  return readAppMajorVersion(fs.readFileSync(path.join(mobileRoot, "app.config.ts"), "utf8"));
}

module.exports = { readAppMajorVersion, readAppMajorVersionFromProject };
