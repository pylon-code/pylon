import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeAntigravityClientTextFile } from "./AntigravityClientFiles.ts";

it.effect("creates nested workspace files through a canonical root alias", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pylon-acp-files-" });
    const workspace = path.join(directory, "workspace");
    const alias = path.join(directory, "alias");
    yield* fileSystem.makeDirectory(workspace);
    yield* fileSystem.symlink(workspace, alias);
    yield* writeAntigravityClientTextFile({
      fileSystem,
      path,
      allowedRoots: [alias],
      request: {
        sessionId: "fixture-session",
        path: path.join(alias, "new", "nested", "file.txt"),
        content: "inside",
      },
    });
    assert.equal(
      yield* fileSystem.readFileString(path.join(workspace, "new", "nested", "file.txt")),
      "inside",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects new nested files below escaping or dangling directory links", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pylon-acp-files-" });
    const workspace = path.join(directory, "workspace");
    const outside = path.join(directory, "outside");
    yield* fileSystem.makeDirectory(workspace);
    yield* fileSystem.makeDirectory(outside);
    yield* fileSystem.symlink(outside, path.join(workspace, "escape"));
    yield* fileSystem.symlink(path.join(outside, "missing"), path.join(workspace, "dangling"));
    for (const link of ["escape", "dangling"]) {
      const result = yield* writeAntigravityClientTextFile({
        fileSystem,
        path,
        allowedRoots: [workspace],
        request: {
          sessionId: "fixture-session",
          path: path.join(workspace, link, "new", "file.txt"),
          content: "outside",
        },
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }
    assert.isFalse(yield* fileSystem.exists(path.join(outside, "new")));
    assert.isFalse(yield* fileSystem.exists(path.join(outside, "missing")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
