import lockfile from "proper-lockfile";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { ensureDeviceHub, isDeviceHubInstalled } from "./DeviceToolchain.ts";

it.effect("failed installation cleans staging and exposes only a safe failure message", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-install-" });
    const result = {
      code: ChildProcessSpawner.ExitCode(1),
      stdout: "",
      stderr: "registry rejected https://private:credential@example.test/package",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    };
    const error = yield* ensureDeviceHub(baseDir).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.succeed(result),
      }),
      Effect.flip,
    );
    expect(error.message).toBe(
      "Installing expo-device-hub failed while running npm install (exit code 1).",
    );
    expect(error.cause).toBe(result);
    expect(yield* isDeviceHubInstalled(baseDir)).toBe(false);
    expect(yield* fs.readDirectory(path.join(baseDir, "tools", "expo-device-hub"))).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("preserves a complete install published by another process holding the lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-device-publish-" });
    const installDir = path.join(baseDir, "tools", "expo-device-hub", "0.9.0");
    yield* fs.makeDirectory(path.dirname(installDir), { recursive: true });
    const release = yield* Effect.acquireRelease(
      Effect.promise(() =>
        lockfile.lock(installDir, { realpath: false, stale: 60_000, update: 10_000 }),
      ),
      (release) => Effect.tryPromise(() => release()).pipe(Effect.ignore),
    );
    const attempted = yield* Deferred.make<void>();
    const originalLock = lockfile.lock;
    const spy = vi.spyOn(lockfile, "lock").mockImplementation((file, options) => {
      Deferred.doneUnsafe(attempted, Effect.void);
      return originalLock(file, options);
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
    const installed = yield* ensureDeviceHub(baseDir).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.die("A concurrent complete install must be reused"),
      }),
      Effect.forkChild,
    );
    yield* Deferred.await(attempted);
    const entryPath = path.join(
      installDir,
      "node_modules",
      "expo-device-hub",
      "dist",
      "server",
      "cli.mjs",
    );
    yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
    yield* fs.writeFileString(entryPath, "published by the other process");
    yield* fs.writeFileString(path.join(installDir, ".install-complete"), "0.9.0");
    yield* Effect.promise(() => release());
    yield* TestClock.adjust("1 second");
    expect((yield* Fiber.join(installed)).entryPath).toBe(entryPath);
    expect(yield* fs.readFileString(entryPath)).toBe("published by the other process");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
