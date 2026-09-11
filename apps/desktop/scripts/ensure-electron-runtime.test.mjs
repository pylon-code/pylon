import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  hasCompletedElectronInstall,
  resolvePackagedElectronInstaller,
  verifyElectronArchive,
} from "./ensure-electron-runtime.mjs";

const tempDirs = [];

function makeTempDir() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "electron-runtime-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("electron runtime repair", () => {
  it("prefers the package's checksummed installer when it ships one", () => {
    const seen = [];
    const installer = resolvePackagedElectronInstaller("/repo/node_modules/electron", (path) => {
      seen.push(path);
      return true;
    });

    const expected = NodePath.join("/repo/node_modules/electron", "install.js");
    assert.equal(installer, expected);
    assert.deepEqual(seen, [expected]);
  });

  it("falls back to the direct download when the installer is missing", () => {
    assert.isNull(resolvePackagedElectronInstaller("/repo/node_modules/electron", () => false));
  });
});

describe("electron install completeness", () => {
  const platformPath = "Electron.app/Contents/MacOS/Electron";

  function writeInstall(files) {
    const electronDir = makeTempDir();
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = NodePath.join(electronDir, relativePath);
      NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
      NodeFS.writeFileSync(filePath, contents);
    }
    return electronDir;
  }

  it("accepts a dist whose installer finished for this version", () => {
    const electronDir = writeInstall({ "path.txt": platformPath, "dist/version": "44.1.0" });

    assert.isTrue(hasCompletedElectronInstall(electronDir, platformPath, "44.1.0"));
  });

  it("rejects a half-extracted dist that has no path.txt yet", () => {
    const electronDir = writeInstall({ "dist/version": "44.1.0", [`dist/${platformPath}`]: "" });

    assert.isFalse(hasCompletedElectronInstall(electronDir, platformPath, "44.1.0"));
  });

  it("rejects a dist without its version marker or from another version", () => {
    const unversioned = writeInstall({ "path.txt": platformPath });
    const stale = writeInstall({ "path.txt": platformPath, "dist/version": "v41.5.0" });

    assert.isFalse(hasCompletedElectronInstall(unversioned, platformPath, "44.1.0"));
    assert.isFalse(hasCompletedElectronInstall(stale, platformPath, "44.1.0"));
  });

  it("rejects a path.txt that points at another platform's executable", () => {
    const electronDir = writeInstall({ "path.txt": "electron", "dist/version": "44.1.0" });

    assert.isFalse(hasCompletedElectronInstall(electronDir, platformPath, "44.1.0"));
  });
});

describe("fallback archive verification", () => {
  const artifactName = "electron-v44.1.0-linux-x64.zip";

  function writeArchive(contents) {
    const zipPath = NodePath.join(makeTempDir(), artifactName);
    NodeFS.writeFileSync(zipPath, contents);
    return zipPath;
  }

  const sha256 = (contents) => NodeCrypto.createHash("sha256").update(contents).digest("hex");

  it("accepts an archive that matches the bundled checksum", () => {
    const zipPath = writeArchive("electron archive");

    assert.doesNotThrow(() =>
      verifyElectronArchive(zipPath, artifactName, {
        [artifactName]: sha256("electron archive"),
      }),
    );
  });

  it("refuses an archive that does not match the bundled checksum", () => {
    const zipPath = writeArchive("tampered archive");

    assert.throws(
      () =>
        verifyElectronArchive(zipPath, artifactName, {
          [artifactName]: sha256("electron archive"),
        }),
      /does not match Electron's bundled checksum/,
    );
  });

  it("refuses an archive the bundled checksums do not list", () => {
    const zipPath = writeArchive("electron archive");

    assert.throws(
      () =>
        verifyElectronArchive(zipPath, artifactName, {
          "electron-v44.1.0-darwin-arm64.zip": sha256("electron archive"),
        }),
      /has no entry for electron-v44\.1\.0-linux-x64\.zip/,
    );
  });
});
