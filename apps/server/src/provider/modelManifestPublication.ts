import { MODEL_MANIFEST_MAX_BYTES, type ModelManifestData } from "./ModelManifest.ts";

/** Publish the validated catalog alongside the classification feed older servers accept. */
export function serializeModelManifestPublication(manifest: ModelManifestData) {
  const classification = {
    version: manifest.version,
    currentModels: manifest.currentModels,
  };
  const files = {
    "model-manifest.json": classification,
    "model-catalog.json": {
      ...classification,
      ...(manifest.providers ? { providers: manifest.providers } : {}),
    },
  };

  return Object.entries(files).map(([name, value]) => {
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(contents) > MODEL_MANIFEST_MAX_BYTES) {
      throw new Error(`${name} exceeds the model manifest byte limit`);
    }
    return { name, contents };
  });
}
