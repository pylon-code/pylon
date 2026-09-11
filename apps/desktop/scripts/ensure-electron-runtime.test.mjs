import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import { resolvePackagedElectronInstaller } from "./ensure-electron-runtime.mjs";

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
