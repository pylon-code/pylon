import { MODEL_MANIFEST_MAX_BYTES, type ModelManifestData } from "./ModelManifest.ts";

/**
 * Publish the validated catalog alongside the feeds older servers accept.
 *
 * Every published reader decodes strictly, so each feed keeps the shape its
 * readers shipped with: `model-manifest.json` for pre-catalog releases,
 * `model-catalog.json` for catalog releases that predate `updatedAt` and
 * provider compatibility policies, and `model-catalog-v2.json` for current
 * releases.
 */
export function serializeModelManifestPublication(manifest: ModelManifestData) {
  const classification = {
    version: manifest.version,
    currentModels: manifest.currentModels,
  };
  const catalog = {
    ...classification,
    ...(manifest.providers ? { providers: manifest.providers } : {}),
  };
  const files = {
    "model-manifest.json": classification,
    "model-catalog.json": catalog,
    "model-catalog-v2.json": {
      ...catalog,
      ...(manifest.updatedAt !== undefined ? { updatedAt: manifest.updatedAt } : {}),
      ...(manifest.compatibility ? { compatibility: manifest.compatibility } : {}),
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
