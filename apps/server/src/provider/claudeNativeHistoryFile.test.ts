import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { claudeProjectDirectoryName } from "./claudeConversationHistory.ts";
import { readClaudeNativeHistoryFile } from "./claudeNativeHistoryFile.ts";

it.layer(NodeServices.layer)("bounded Claude native history file", (it) => {
  it.effect("rejects replacement, symlinks, unknown file identity, and oversized content", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "pylon-claude-native-reader-" })
        .pipe(Effect.flatMap(fs.realPath));
      const cwd = path.join(root, "workspace");
      yield* fs.makeDirectory(cwd);
      const config = path.join(root, "config");
      const project = path.join(config, "projects", claudeProjectDirectoryName(cwd));
      yield* fs.makeDirectory(project, { recursive: true });
      const id = "550e8400-e29b-41d4-a716-446655440010";
      const filePath = path.join(project, `${id}.jsonl`);
      const otherPath = path.join(root, "other.jsonl");
      yield* fs.writeFileString(filePath, "original");
      yield* fs.writeFileString(otherPath, "replaced");
      const read = readClaudeNativeHistoryFile({
        sessionId: id,
        canonicalCwd: cwd,
        environment: { CLAUDE_CONFIG_DIR: config },
      });
      assert.equal(yield* read, "original");
      const swapped: FileSystem.FileSystem = {
        ...fs,
        open: (candidate, options) =>
          Effect.gen(function* () {
            if (candidate === filePath) yield* fs.rename(otherPath, filePath);
            return yield* fs.open(candidate, options);
          }),
      };
      assert.equal(
        (yield* read.pipe(Effect.provideService(FileSystem.FileSystem, swapped), Effect.result))
          ._tag,
        "Failure",
      );
      const unidentifiable: FileSystem.FileSystem = {
        ...fs,
        stat: (candidate) =>
          fs.stat(candidate).pipe(Effect.map((info) => ({ ...info, ino: Option.none() }))),
      };
      assert.equal(
        (yield* read.pipe(
          Effect.provideService(FileSystem.FileSystem, unidentifiable),
          Effect.result,
        ))._tag,
        "Failure",
      );
      if (symlinksSupported) {
        yield* fs.rename(filePath, otherPath);
        yield* fs.symlink(otherPath, filePath);
        assert.equal((yield* read.pipe(Effect.result))._tag, "Failure");
        yield* fs.remove(filePath);
        yield* fs.rename(otherPath, filePath);
      }
      yield* fs.truncate(filePath, 64 * 1024 * 1024 + 1);
      assert.equal((yield* read.pipe(Effect.result))._tag, "Failure");
    }),
  );
});
