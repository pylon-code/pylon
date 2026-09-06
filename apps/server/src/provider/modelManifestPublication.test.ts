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
