import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";
import * as Tar from "tar";
import { makeCuaDriverBackend } from "./CuaDriverBackend.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-cua-installer-test-" });
  const applications = path.join(dir, "Applications");
  yield* fs.makeDirectory(applications);
  const root = "cua-driver-rs-0.28.1-darwin-universal";
  const source = path.join(dir, root, "CuaDriver.app", "Contents", "MacOS");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.writeFileString(path.join(source, "cua-driver"), "new driver", { mode: 0o755 });
  const archivePath = path.join(dir, "archive.tar.gz");
  yield* Effect.tryPromise(() => Tar.c({ cwd: dir, file: archivePath, gzip: true }, [root]));
  const archive = yield* fs.readFile(archivePath);
  const target = path.join(applications, "CuaDriver.app");
  const binary = path.join(target, "Contents", "MacOS", "cua-driver");
  const release = {
    version: "0.28.1",
    releaseUrl: "https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.1",
    assetName: `${root}.tar.gz`,
    sha256: NodeCrypto.createHash("sha256").update(archive).digest("hex"),
    bytes: archive.length,
  };
  let installedVersionReads = 0;
  let installedVersion = "0.28.1";
  let registerFails = false;
  let signatureFails = false;
  let installedSignatureFails = false;
  let requests = 0;
  const spawner = ChildProcessSpawner.make((cmd) =>
    Effect.gen(function* () {
      if (cmd._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipe");
      if (cmd.command === binary && cmd.args[0] === "--version") installedVersionReads++;
      const output =
        cmd.args[0] === "--version"
          ? `cua-driver ${cmd.command === binary ? installedVersion : "0.28.1"}`
          : cmd.args[0] === "status"
            ? "daemon not running"
            : "";
      const exit =
        (cmd.command.endsWith("codesign") &&
          (signatureFails || (installedSignatureFails && cmd.args.at(-1) === target))) ||
        (cmd.command.endsWith("lsregister") && registerFails)
          ? 1
          : 0;
      // Fail once so rollback's registration of the old app can succeed.
      if (cmd.command.endsWith("codesign") && installedSignatureFails && cmd.args.at(-1) === target)
        installedSignatureFails = false;
      if (cmd.command.endsWith("lsregister")) registerFails = false;
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exit)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(output)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const backend = yield* makeCuaDriverBackend({
    baseDir: dir,
    applicationsDirectory: applications,
  }).pipe(
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provideService(HostProcessArchitecture, "arm64"),
    Effect.provideService(HostProcessEnvironment, { PATH: "" }),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests++;
          return HttpClientResponse.fromWeb(request, new Response(archive));
        }),
      ),
    ),
  );
  const phases: string[] = [];
  const install = (selected = release) =>
    backend.install(selected, {
      report: (p) =>
        Effect.sync(() => {
          phases.push(p.phase);
        }),
      activate: (work) => work,
    });
  const previous = fs
    .makeDirectory(path.dirname(binary), { recursive: true })
    .pipe(Effect.andThen(fs.writeFileString(binary, "old driver")));
  return {
    fs,
    path,
    dir,
    applications,
    target,
    binary,
    release,
    backend,
    install,
    previous,
    phases,
    requests: () => requests,
    versionReads: () => installedVersionReads,
    setInstalledVersion: (version: string) =>
      Effect.sync(() => {
        installedVersion = version;
      }),
    failRegistration: Effect.sync(() => {
      registerFails = true;
    }),
    failInstalledSignature: Effect.sync(() => {
      installedSignatureFails = true;
    }),
    failSignature: Effect.sync(() => {
      signatureFails = true;
    }),
  };
});
const provide = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  work.pipe(Effect.provide(NodeServices.layer), Effect.scoped);
it.effect("stages a verified archive and installs only its signed app bundle", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.install();
      expect(yield* f.fs.readFileString(f.binary)).toBe("new driver");
      expect(f.phases).toContain("succeeded");
      expect(yield* f.fs.readDirectory(f.applications)).toEqual(
        expect.arrayContaining(["CuaDriver.app", ".pylon-cua-install.json"]),
      );
      expect(
        (yield* f.fs.readDirectory(f.applications)).some(
          (name) =>
            name.includes("stage") ||
            name.includes("lock") ||
            name.includes("backup") ||
            name.includes("transaction"),
        ),
      ).toBe(false);
    }),
  ),
);
it.effect("hash and publisher failures preserve the previous driver", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.previous;
      expect(
        (yield* f.install({ ...f.release, sha256: "0".repeat(64) }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* f.failSignature;
      expect((yield* f.install().pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* f.fs.readFileString(f.binary)).toBe("old driver");
    }),
  ),
);
it.effect("rolls back after activation failure even when the new app validates", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.previous;
      yield* f.failRegistration;
      expect((yield* f.install().pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* f.fs.readFileString(f.binary)).toBe("old driver");
      expect(yield* f.fs.exists(f.path.join(f.applications, ".pylon-cua-transaction.json"))).toBe(
        false,
      );
      expect(f.phases).not.toContain("succeeded");
    }),
  ),
);
it.effect("does not reclaim or delete another installer's lock", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      const lock = f.path.join(f.applications, ".pylon-cua-install.lock");
      yield* f.fs.writeFileString(lock, "other owner");
      expect((yield* f.install().pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* f.fs.readFileString(lock)).toBe("other owner");
      expect(f.requests()).toBe(0);
    }),
  ),
);

it.effect("rejects a downgrade when another updater changed the installed version", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.previous;
      yield* f.setInstalledVersion("0.29.0");
      const result = yield* f.install().pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain("newer");
      expect(yield* f.fs.readFileString(f.binary)).toBe("old driver");
    }),
  ),
);
it.effect("preserves a recoverable target when the previous backup is missing", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.previous;
      const stat = yield* f.fs.stat(f.target);
      const journal = f.path.join(f.applications, ".pylon-cua-transaction.json");
      yield* f.fs.writeFileString(
        journal,
        encodeJson({
          previous: { device: "missing", inode: "missing" },
          next: { device: String(stat.dev), inode: String(Option.getOrThrow(stat.ino)) },
          previousReceipt: null,
        }),
      );
      expect((yield* f.install().pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* f.fs.readFileString(f.binary)).toBe("old driver");
      expect(yield* f.fs.exists(journal)).toBe(true);
    }),
  ),
);

it.effect("repairs a damaged managed app without executing its unverified binary", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.install();
      // A signature failure only for the current target, not the freshly downloaded app.
      yield* f.failInstalledSignature;
      yield* f.install();
      expect(f.versionReads()).toBe(2); // installed validation for each successful install only
    }),
  ),
);
