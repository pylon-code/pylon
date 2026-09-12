import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";

import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HttpClient } from "effect/unstable/http";
import * as NetService from "@t3tools/shared/Net";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const diagnose = (files: ReadonlyArray<string>, environment: NodeJS.ProcessEnv) =>
  LocalDeviceHost.__testing.platformReason("android").pipe(
    Effect.provideService(HostProcessEnvironment, environment),
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (file) => Effect.succeed(files.includes(file)),
      }),
    ),
    Effect.provide(NodePath.layer),
  );

describe("Android SDK availability", () => {
  it.effect("explains that adb alone is insufficient to launch an emulator", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(["/sdk/platform-tools/adb"], { ANDROID_HOME: "/sdk" });
      expect(reason).toContain("Android Emulator is missing");
    }),
  );

  it.effect("identifies command-line tools required by the device hub", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(["/sdk/platform-tools/adb", "/sdk/emulator/emulator"], {
        ANDROID_HOME: "/sdk",
      });
      expect(reason).toContain("Command-line Tools (latest)");
    }),
  );

  it.effect("discovers the standard macOS SDK without ANDROID_HOME", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [
          `${root}/platform-tools/adb`,
          `${root}/emulator/emulator`,
          `${root}/cmdline-tools/latest/bin/avdmanager`,
        ],
        { HOME: "/test/home" },
      );
      expect(reason).toBeNull();
    }),
  );

  it.effect("reports an absent SDK without running or installing tools", () =>
    Effect.gen(function* () {
      expect(yield* diagnose([], { HOME: "/test/home" })).toContain("Android SDK was not found");
    }),
  );
});

it.effect("puts detected Android tools on the helper PATH without losing existing commands", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const environment = LocalDeviceHost.__testing.deviceHostEnvironment(
      { PATH: "/usr/bin", HOME: "/test/home" },
      "/sdk",
      "darwin",
      path,
    );
    expect(environment.PATH).toBe("/sdk/platform-tools:/sdk/emulator:/usr/bin");
    expect(environment.ANDROID_HOME).toBe("/sdk");
    expect(environment.HOME).toBe("/test/home");
  }).pipe(Effect.provide(NodePath.layer)),
);

it.effect(
  "constructs and inspects an unconfigured host without installing or starting helpers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-consent-" });
      const host = yield* LocalDeviceHost.make().pipe(
        Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
        Effect.provideService(HostProcessEnvironment, { HOME: baseDir, PATH: "" }),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.die(new Error("Host construction must not spawn processes")),
          ),
        ),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Effect.die(new Error("Host construction must not run commands")),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.die(new Error("Host construction must not make network requests")),
          ),
        ),
      );
      expect(yield* host.current).toBeNull();
      yield* host.stop;
      expect(yield* fs.exists(`${baseDir}/tools`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("closes an owned hub process when readiness is interrupted before publication", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-device-start-" });
    const installDir = path.join(baseDir, "tools", "expo-device-hub", "0.9.0");
    const entryPath = path.join(
      installDir,
      "node_modules",
      "expo-device-hub",
      "dist",
      "server",
      "cli.mjs",
    );
    yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
    yield* fs.writeFileString(entryPath, "");
    yield* fs.writeFileString(path.join(installDir, ".install-complete"), "0.9.0");
    const readinessEntered = yield* Deferred.make<void>();
    const finalized = yield* Ref.make(0);
    const host = yield* LocalDeviceHost.make().pipe(
      Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
      Effect.provideService(HostProcessEnvironment, { HOME: baseDir, PATH: "" }),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Ref.update(finalized, (count) => count + 1));
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(987654321),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            });
          }),
        ),
      ),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.die("unexpected command"),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Deferred.succeed(readinessEntered, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      ),
    );
    const pending = yield* host.ensureReady(() => Effect.void).pipe(Effect.forkChild);
    yield* Deferred.await(readinessEntered);
    yield* Fiber.interrupt(pending);
    expect(yield* Ref.get(finalized)).toBe(1);
    expect(yield* host.current).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
