import { assert, describe, it } from "@effect/vitest";

import { CatalogDependencyResolutionError, resolveCatalogDependencies } from "./resolve-catalog.ts";

it("reports unresolved catalog dependencies with lookup context", () => {
  try {
    resolveCatalogDependencies({ effect: "catalog:runtime" }, {}, "apps/server");
    assert.fail("Expected catalog resolution to fail.");
  } catch (error) {
    assert.instanceOf(error, CatalogDependencyResolutionError);
    assert.equal(error.workspacePackage, "apps/server");
    assert.equal(error.dependencyName, "effect");
    assert.equal(error.catalogSpec, "catalog:runtime");
    assert.equal(error.catalogKey, "runtime");
    assert.equal(
      error.message,
      "Unable to resolve 'catalog:runtime' for apps/server dependency 'effect'. Expected key 'runtime' in root workspace catalog.",
    );
  }
});

const catalog = { effect: "4.0.0-rc.115", "@clerk/backend": "3.18.1", react: "19.2.0" };

describe("resolveCatalogDependencies", () => {
  it("resolves bare, named and override-selector catalog specs like pnpm", () => {
    assert.deepStrictEqual(
      resolveCatalogDependencies(
        {
          "@clerk/backend": "catalog:",
          "react-dom": "catalog:react",
          "@opencode/protocol>effect": "catalog:",
          "dbus-next>usocket": "-",
          lodash: "4.17.21",
        },
        catalog,
        "apps/desktop",
      ),
      {
        "@clerk/backend": "3.18.1",
        "react-dom": "19.2.0",
        "@opencode/protocol>effect": "4.0.0-rc.115",
        "dbus-next>usocket": "-",
        lodash: "4.17.21",
      },
    );
  });

  it("fails on a catalog entry that does not exist", () => {
    assert.throws(
      () => resolveCatalogDependencies({ "a>missing": "catalog:" }, catalog, "apps/desktop"),
      /Expected key 'missing' in root workspace catalog/,
    );
  });
});
