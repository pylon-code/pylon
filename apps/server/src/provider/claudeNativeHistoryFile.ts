import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  claudeProjectDirectoryName,
  validClaudeProjectDirectoryOverride,
} from "./claudeConversationHistory.ts";

export class ClaudeNativeHistoryUnavailable extends Schema.TaggedError<ClaudeNativeHistoryUnavailable>()(
  "ClaudeNativeHistoryUnavailable",
  {},
) {}
const MAX_NATIVE_HISTORY_BYTES = 64 * 1024 * 1024;

/** Read one current, regular provider-owned transcript through a bounded scoped handle. */
export const readClaudeNativeHistoryFile = Effect.fn("readClaudeNativeHistoryFile")(
  function* (input: {
    readonly sessionId: string;
    readonly canonicalCwd: string;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!/^[0-9a-f-]{36}$/i.test(input.sessionId))
      return yield* new ClaudeNativeHistoryUnavailable();
    const configDir =
      input.environment.CLAUDE_CONFIG_DIR ??
      path.join(
        input.environment.HOME ?? input.environment.USERPROFILE ?? NodeOS.homedir(),
        ".claude",
      );
    if (!path.isAbsolute(configDir)) return yield* new ClaudeNativeHistoryUnavailable();
    const root = yield* fs.realPath(path.join(configDir.normalize("NFC"), "projects"));
    const keys = new Set([claudeProjectDirectoryName(input.canonicalCwd)]);
    const override = input.environment.CLAUDE_CONFIG_DIR
      ? validClaudeProjectDirectoryOverride(input.environment.CLAUDE_CODE_PROJECT_DIR_NAME)
      : undefined;
    if (override) keys.add(override);
    const files: string[] = [];
    for (const key of keys) {
      const candidate = path.join(root, key, `${input.sessionId}.jsonl`);
      if (!(yield* fs.exists(candidate))) continue;
      const resolved = yield* fs.realPath(candidate);
      if (resolved !== candidate) return yield* new ClaudeNativeHistoryUnavailable();
      files.push(candidate);
    }
    if (files.length !== 1) return yield* new ClaudeNativeHistoryUnavailable();
    return yield* Effect.gen(function* () {
      const filePath = files[0]!;
      const pathnameBefore = yield* fs.stat(filePath);
      const file = yield* fs.open(filePath, { flag: "r" });
      const before = yield* file.stat;
      if (
        Option.isNone(pathnameBefore.ino) ||
        Option.isNone(before.ino) ||
        pathnameBefore.dev !== before.dev ||
        pathnameBefore.ino.value !== before.ino.value
      )
        return yield* new ClaudeNativeHistoryUnavailable();
      if (
        before.type !== "File" ||
        before.size <= 0 ||
        before.size > MAX_NATIVE_HISTORY_BYTES ||
        Option.isNone(before.mtime)
      )
        return yield* new ClaudeNativeHistoryUnavailable();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = yield* file.readAlloc(
          Math.min(64 * 1024, MAX_NATIVE_HISTORY_BYTES - size + 1),
        );
        if (Option.isNone(chunk)) break;
        size += chunk.value.length;
        if (size > MAX_NATIVE_HISTORY_BYTES) return yield* new ClaudeNativeHistoryUnavailable();
        chunks.push(chunk.value);
      }
      const after = yield* file.stat;
      const pathnameAfter = yield* fs.stat(filePath);
      if (
        (yield* fs.realPath(filePath)) !== filePath ||
        Option.isNone(pathnameAfter.ino) ||
        pathnameAfter.dev !== before.dev ||
        pathnameAfter.ino.value !== before.ino.value
      )
        return yield* new ClaudeNativeHistoryUnavailable();
      if (
        BigInt(size) !== before.size ||
        after.size !== before.size ||
        Option.isNone(after.mtime) ||
        after.mtime.value.getTime() !== before.mtime.value.getTime()
      )
        return yield* new ClaudeNativeHistoryUnavailable();
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => new ClaudeNativeHistoryUnavailable(),
      });
    }).pipe(Effect.scoped);
  },
);
