import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { decodeManifestJson } from "../src/provider/ModelManifest.ts";
import { serializeModelManifestPublication } from "../src/provider/modelManifestPublication.ts";

const destination = process.argv[2];
if (!destination) {
  throw new Error("Usage: prepare-model-manifests.ts <output-directory>");
}

Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = yield* path.fromFileUrl(
    new URL("../src/provider/model-manifest.json", import.meta.url),
  );
  const source = yield* fileSystem.readFileString(sourcePath);
  // Reuse runtime validation, including driver bounds and provider adapter metadata,
  // before either public file is written.
  const manifest = yield* decodeManifestJson(source);
  const files = serializeModelManifestPublication(manifest);
  yield* fileSystem.makeDirectory(destination, { recursive: true });
  for (const { name, contents } of files) {
    yield* fileSystem.writeFileString(path.join(destination, name), contents);
  }
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
