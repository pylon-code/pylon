import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { type ModelManifestData, MODEL_MANIFEST_MAX_BYTES } from "./ModelManifest.ts";
import { serializeModelManifestPublication } from "./modelManifestPublication.ts";

const manifest: ModelManifestData = {
  version: 1,
  currentModels: { codex: ["current-model"] },
  providers: {
    claudeAgent: {
      profiles: {},
      models: [{ slug: "catalog-model", name: "Catalog Model", status: "current" }],
    },
  },
};

describe("model manifest publication", () => {
  it("keeps the classification feed compatible with strict pre-catalog readers", () => {
    const files = serializeModelManifestPublication(manifest);
    const classification = JSON.parse(
      files.find((file) => file.name === "model-manifest.json")!.contents,
    );
    const legacySchema = Schema.Struct({
      version: Schema.Literal(1),
      currentModels: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    }).annotate({ parseOptions: { onExcessProperty: "error" } });

    assert.deepStrictEqual(Schema.decodeUnknownSync(legacySchema)(classification), {
      version: 1,
      currentModels: manifest.currentModels,
    });
    assert.deepStrictEqual(
      JSON.parse(files.find((file) => file.name === "model-catalog.json")!.contents),
      manifest,
    );
  });

  it("publishes updatedAt and compatibility only in the current catalog feed", () => {
    const withPolicy: ModelManifestData = {
      ...manifest,
      updatedAt: "2026-10-03T00:00:00Z",
      compatibility: [
        {
          driver: "opencode",
          t3CodeRange: ">=0.0.31",
          recommendedRange: ">=2.0.0",
          ranges: [{ range: ">=2.0.0", status: "supported" }],
        },
      ],
    };
    const files = serializeModelManifestPublication(withPolicy);
    const parse = (name: string) =>
      JSON.parse(files.find((file) => file.name === name)!.contents) as Record<string, unknown>;
    assert.deepStrictEqual(
      files.map((file) => file.name),
      ["model-manifest.json", "model-catalog.json", "model-catalog-v2.json"],
    );
    // Catalog readers released before these fields decode with onExcessProperty: "error".
    assert.deepStrictEqual(Object.keys(parse("model-catalog.json")).toSorted(), [
      "currentModels",
      "providers",
      "version",
    ]);
    assert.deepStrictEqual(Object.keys(parse("model-manifest.json")).toSorted(), [
      "currentModels",
      "version",
    ]);
    assert.deepStrictEqual(parse("model-catalog-v2.json"), withPolicy);
  });

  it("rejects oversized catalog metadata before producing any files", () => {
    const oversized = {
      ...manifest,
      providers: {
        claudeAgent: {
          profiles: {},
          models: [
            {
              slug: "large-model",
              name: "x".repeat(MODEL_MANIFEST_MAX_BYTES),
              status: "current" as const,
            },
          ],
        },
      },
    };
    assert.throws(() => serializeModelManifestPublication(oversized), /model-catalog.json exceeds/);
  });
});
