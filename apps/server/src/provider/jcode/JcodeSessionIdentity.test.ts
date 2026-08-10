// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import {
  decodeJcodeSessionIdentity,
  encodeJcodeSessionIdentity,
  readJcodeSessionIdentity,
  writeJcodeSessionIdentity,
} from "./JcodeSessionIdentity.ts";

const POSIX = NodeOS.platform() !== "win32";
const WORKING_DIR = POSIX ? "/Users/someone/project" : "C:\\Users\\someone\\project";

/** Runs one scoped filesystem scenario against the real platform services. */
function runScoped<A, E>(
  body: (input: {
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly root: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "jcode-identity-" });
        return yield* body({ fs, path, root });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

describe("JcodeSessionIdentity", () => {
  it("round trips a bounded session id and an absolute working directory", () => {
    const source = encodeJcodeSessionIdentity({
      sessionId: "019fe511-5776-71ae-b907-9a33f0cd9a8d",
      workingDir: WORKING_DIR,
    });
    expect(source).toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        sessionId: "019fe511-5776-71ae-b907-9a33f0cd9a8d",
        workingDir: WORKING_DIR,
      })}\n`,
    );
    expect(decodeJcodeSessionIdentity(source!)).toEqual({
      sessionId: "019fe511-5776-71ae-b907-9a33f0cd9a8d",
      workingDir: WORKING_DIR,
    });
  });

  it("refuses to encode identities outside the private bounds", () => {
    for (const input of [
      { sessionId: "", workingDir: WORKING_DIR },
      { sessionId: "   ", workingDir: WORKING_DIR },
      { sessionId: "a".repeat(257), workingDir: WORKING_DIR },
      { sessionId: "session/1", workingDir: WORKING_DIR },
      { sessionId: "session 1", workingDir: WORKING_DIR },
      { sessionId: "../secret", workingDir: WORKING_DIR },
      { sessionId: "session\u00001", workingDir: WORKING_DIR },
      { sessionId: "session-1", workingDir: "" },
      { sessionId: "session-1", workingDir: "relative/dir" },
      { sessionId: "session-1", workingDir: "./relative" },
      { sessionId: "session-1", workingDir: `${WORKING_DIR}\u0000/etc` },
      { sessionId: "session-1", workingDir: "x".repeat(8193) },
    ]) {
      expect(encodeJcodeSessionIdentity(input), JSON.stringify(input)).toBe(undefined);
    }
  });

  it("fails closed on malformed, extended, and foreign sidecar payloads", () => {
    for (const source of [
      "not json",
      "{",
      "null",
      "[]",
      '"session-1"',
      "{}",
      JSON.stringify({ schemaVersion: 1, sessionId: "session-1" }),
      JSON.stringify({ schemaVersion: 1, workingDir: WORKING_DIR }),
      JSON.stringify({ schemaVersion: 2, sessionId: "session-1", workingDir: WORKING_DIR }),
      JSON.stringify({ schemaVersion: "1", sessionId: "session-1", workingDir: WORKING_DIR }),
      JSON.stringify({ schemaVersion: 1, sessionId: 1, workingDir: WORKING_DIR }),
      JSON.stringify({ schemaVersion: 1, sessionId: "session-1", workingDir: 1 }),
      JSON.stringify({ schemaVersion: 1, sessionId: "", workingDir: WORKING_DIR }),
      JSON.stringify({ schemaVersion: 1, sessionId: "a".repeat(257), workingDir: WORKING_DIR }),
      JSON.stringify({ schemaVersion: 1, sessionId: "session-1", workingDir: "relative" }),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "session-1",
        workingDir: WORKING_DIR,
        socketPath: "/private/var/folders/jcode/api.sock",
      }),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "session-1",
        workingDir: WORKING_DIR,
        jcodeHome: "/state/provider-sessions/jcode/b64-abc/home",
      }),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "session-1",
        workingDir: WORKING_DIR,
        apiKey: "sk-ant-secret-value-1234",
      }),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "session-1",
        workingDir: WORKING_DIR,
        events: [{ type: "assistant.delta", text: "secret" }],
      }),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "session-1",
        workingDir: WORKING_DIR,
        model: "claude-opus-5",
      }),
    ]) {
      expect(decodeJcodeSessionIdentity(source), source).toBe(undefined);
    }
  });

  it("persists nothing beyond the private schema", () => {
    const source = encodeJcodeSessionIdentity({
      sessionId: "session-1",
      workingDir: WORKING_DIR,
      // Extra native detail a careless caller might pass through.
      socketPath: "/private/var/folders/jcode/api.sock",
      jcodeHome: "/state/provider-sessions/jcode/b64-abc/home",
      apiKey: "sk-ant-secret-value-1234",
      capabilities: ["sessions", "models"],
    } as never);
    expect(source).toBeDefined();
    const parsed = JSON.parse(source!) as Record<string, unknown>;
    expect(Object.keys(parsed).toSorted()).toEqual(["schemaVersion", "sessionId", "workingDir"]);
    for (const leak of ["api.sock", "b64-abc", "sk-ant-secret-value-1234", "capabilities"]) {
      expect(source!).not.toContain(leak);
    }
  });

  it("writes atomically and protects the private sidecar", async () => {
    const observed = await runScoped(({ fs, path, root }) =>
      Effect.gen(function* () {
        const filePath = path.join(root, "threads", "b64-dGhyZWFkLTE.json");
        yield* writeJcodeSessionIdentity({
          filePath,
          sessionId: "session-1",
          workingDir: WORKING_DIR,
        });
        return {
          identity: yield* readJcodeSessionIdentity(filePath),
          entries: yield* fs.readDirectory(path.dirname(filePath)),
          directoryMode: (yield* fs.stat(path.dirname(filePath))).mode & 0o777,
          fileMode: (yield* fs.stat(filePath)).mode & 0o777,
        };
      }),
    );

    expect(observed.identity).toEqual({ sessionId: "session-1", workingDir: WORKING_DIR });
    // No temp residue survives a successful write.
    expect(observed.entries).toEqual(["b64-dGhyZWFkLTE.json"]);
    if (POSIX) {
      expect(observed.directoryMode).toBe(0o700);
      expect(observed.fileMode).toBe(0o600);
    }
  });

  it("keeps an existing valid sidecar intact when a write is rejected", async () => {
    const observed = await runScoped(({ fs, path, root }) =>
      Effect.gen(function* () {
        const filePath = path.join(root, "b64-dGhyZWFkLTE.json");
        yield* writeJcodeSessionIdentity({
          filePath,
          sessionId: "session-1",
          workingDir: WORKING_DIR,
        });
        const failure = yield* writeJcodeSessionIdentity({
          filePath,
          sessionId: "../secret",
          workingDir: WORKING_DIR,
        }).pipe(Effect.flip);
        return {
          failureTag: failure._tag,
          identity: yield* readJcodeSessionIdentity(filePath),
          entries: yield* fs.readDirectory(root),
        };
      }),
    );

    expect(observed.failureTag).toBe("JcodeSessionIdentityError");
    expect(observed.identity).toEqual({ sessionId: "session-1", workingDir: WORKING_DIR });
    expect(observed.entries).toEqual(["b64-dGhyZWFkLTE.json"]);
  });

  it("resolves repeated concurrent writes to one readable identity", async () => {
    const sessionIds = ["session-1", "session-2", "session-3", "session-4"];
    const observed = await runScoped(({ fs, path, root }) =>
      Effect.gen(function* () {
        const filePath = path.join(root, "b64-dGhyZWFkLTE.json");
        yield* Effect.all(
          sessionIds.map((sessionId) =>
            writeJcodeSessionIdentity({ filePath, sessionId, workingDir: WORKING_DIR }),
          ),
          { concurrency: "unbounded" },
        );
        return {
          identity: yield* readJcodeSessionIdentity(filePath),
          entries: yield* fs.readDirectory(root),
        };
      }),
    );

    expect(observed.identity).toBeDefined();
    expect(sessionIds).toContain(observed.identity!.sessionId);
    expect(observed.identity!.workingDir).toBe(WORKING_DIR);
    expect(observed.entries).toEqual(["b64-dGhyZWFkLTE.json"]);
  });

  it("reads a missing or corrupt sidecar as absent rather than failing", async () => {
    const observed = await runScoped(({ fs, path, root }) =>
      Effect.gen(function* () {
        const missing = path.join(root, "missing.json");
        const corrupt = path.join(root, "corrupt.json");
        yield* fs.writeFileString(corrupt, "{ not json");
        return {
          missing: yield* readJcodeSessionIdentity(missing),
          corrupt: yield* readJcodeSessionIdentity(corrupt),
        };
      }),
    );

    expect(observed.missing).toBe(undefined);
    expect(observed.corrupt).toBe(undefined);
  });
});
