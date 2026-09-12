// @effect-diagnostics nodeBuiltinImport:off - Incremental SHA256, disk-space queries and archive streams need Node APIs.
import {
  compareCuaVersions,
  ComputerSetupError,
  type ComputerInstallation,
  type ComputerPermissions,
  type ComputerRelease,
  type ComputerSetupState,
} from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import {
  HostProcessPlatform,
  HostProcessArchitecture,
  HostProcessEnvironment,
} from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import type * as Duration from "effect/Duration";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { ServerConfig } from "../config.ts";
import { cuaTransportEnvironment } from "./cuaPolicy.ts";
import { cuaReleaseTarget } from "./CuaRelease.ts";
import { extractCuaArchive } from "./cuaArchive.ts";

const SIGNING_REQUIREMENT =
  '=identifier "com.trycua.driver" and anchor apple generic and certificate leaf[subject.OU] = "YCK386LBJ7"';
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";
const Permissions = Schema.Struct({
  accessibility: Schema.optionalKey(Schema.Boolean),
  screen_recording: Schema.optionalKey(Schema.Boolean),
  screen_recording_capturable: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  source: Schema.optionalKey(
    Schema.Struct({
      attribution: Schema.optionalKey(Schema.String),
      bundle_id: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodePermissions = Schema.decodeUnknownEffect(Schema.fromJsonString(Permissions));
const Receipt = Schema.Struct({
  version: Schema.String,
  sha256: Schema.String,
  device: Schema.String,
  inode: Schema.String,
});
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt));
const Identity = Schema.Struct({ device: Schema.String, inode: Schema.String });
const Journal = Schema.Struct({
  previous: Schema.NullOr(Identity),
  next: Identity,
  previousReceipt: Schema.NullOr(Schema.String),
});
const encodeJournal = Schema.encodeEffect(Schema.fromJsonString(Journal));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(Receipt));
const decodeJournal = Schema.decodeUnknownEffect(Schema.fromJsonString(Journal));
const LockOwner = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  token: Schema.String,
});
const encodeLockOwner = Schema.encodeEffect(Schema.fromJsonString(LockOwner));
const decodeLockOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(LockOwner));

export const unknownComputerPermissions: ComputerPermissions = {
  accessibility: "unknown",
  screenRecording: "unknown",
  capture: "unknown",
  message: "Check CuaDriver permissions on this environment's computer.",
};
export type CuaInstallProgress = Pick<ComputerSetupState, "phase" | "message"> &
  Partial<Pick<ComputerSetupState, "downloadedBytes" | "totalBytes">>;
export interface CuaInstallHooks {
  readonly report: (progress: CuaInstallProgress) => Effect.Effect<void>;
  readonly activate: (
    work: Effect.Effect<void, ComputerSetupError>,
  ) => Effect.Effect<void, ComputerSetupError>;
}
interface Backend {
  readonly platform: string;
  readonly architecture: string;
  readonly inspect: (
    configuredPath: string,
  ) => Effect.Effect<ComputerInstallation, ComputerSetupError>;
  readonly resolve: (configuredPath: string) => Effect.Effect<string, ComputerSetupError>;
  readonly permissions: (binary: string) => Effect.Effect<ComputerPermissions, ComputerSetupError>;
  readonly grantPermissions: (
    binary: string,
  ) => Effect.Effect<ComputerPermissions, ComputerSetupError>;
  readonly install: (
    release: ComputerRelease,
    hooks: CuaInstallHooks,
  ) => Effect.Effect<void, ComputerSetupError>;
}
export class CuaDriverBackend extends Context.Service<CuaDriverBackend, Backend>()(
  "t3/computer/CuaDriverBackend",
) {
  static readonly layer = Layer.effect(
    CuaDriverBackend,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return yield* makeCuaDriverBackend({ baseDir: config.baseDir });
    }),
  );
}
const failure = (operation: string, message: string) =>
  new ComputerSetupError({ operation, message });
const isComputerSetupError = Schema.is(ComputerSetupError);
const wrap = (operation: string, message: string) => (error: unknown) =>
  isComputerSetupError(error) ? error : failure(operation, message);

/** Paths are injectable only at the service boundary for isolated installer tests, never over RPC. */
export const makeCuaDriverBackend = Effect.fn("CuaDriverBackend.make")(function* (options: {
  baseDir: string;
  applicationsDirectory?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const environment = yield* HostProcessEnvironment;
  const parent =
    platform === "darwin"
      ? (options.applicationsDirectory ?? "/Applications")
      : path.join(options.baseDir, "tools", "cua-driver");
  const target = path.join(parent, platform === "darwin" ? "CuaDriver.app" : "runtime");
  const backup = path.join(parent, ".pylon-cua-backup");
  const journalPath = path.join(parent, ".pylon-cua-transaction.json");
  const receiptPath = path.join(parent, ".pylon-cua-install.json");
  const lockPath = path.join(parent, ".pylon-cua-install.lock");
  const executable = (root: string) =>
    path.join(
      root,
      ...(platform === "darwin"
        ? ["Contents", "MacOS", "cua-driver"]
        : [platform === "win32" ? "cua-driver.exe" : "cua-driver"]),
    );
  const defaultBinary = executable(target);
  const custom = (value: string) => !["", "cua-driver", "cua-driver.exe"].includes(value.trim());

  const command = Effect.fn("CuaDriverBackend.command")(
    function* (
      binary: string,
      args: ReadonlyArray<string>,
      timeout: Duration.Input = "20 seconds",
    ) {
      return yield* Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(binary, args, {
            env: cuaTransportEnvironment(environment),
            extendEnv: false,
          }),
        );
        const collect = (stream: typeof child.stdout) =>
          stream.pipe(
            Stream.decodeText(),
            Stream.runFoldEffect(
              () => "",
              (text, chunk) =>
                text.length + chunk.length > 256 * 1024
                  ? Effect.fail(failure("command", "Cua command output exceeded its limit."))
                  : Effect.succeed(text + chunk),
            ),
          );
        const [stdout, stderr, exit] = yield* Effect.all(
          [collect(child.stdout), collect(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
        return { stdout: stdout.trim(), stderr: stderr.trim(), exit: Number(exit) };
      }).pipe(Effect.scoped, Effect.timeout(timeout));
    },
    Effect.mapError(
      wrap(
        "command",
        "Cua Driver did not respond. Check its executable and desktop session, then retry.",
      ),
    ),
  );
  const requireCommand = Effect.fn("CuaDriverBackend.requireCommand")(function* (
    binary: string,
    args: ReadonlyArray<string>,
    message: string,
  ) {
    const result = yield* command(binary, args);
    if (result.exit !== 0) return yield* failure("verify", message);
    return result;
  });
  const verifyMac = (app: string) =>
    requireCommand(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "-R", SIGNING_REQUIREMENT, app],
      "CuaDriver's signature or publisher identity could not be verified. The existing app was preserved.",
    );
  const readVersion = Effect.fn("CuaDriverBackend.readVersion")(function* (binary: string) {
    const result = yield* requireCommand(
      binary,
      ["--version"],
      "Cua Driver could not report its version. Use Repair or check the custom executable.",
    );
    const version = /^cua-driver\s+(\d+\.\d+\.\d+)(?:\s|$)/u.exec(result.stdout)?.[1];
    if (!version)
      return yield* failure(
        "version",
        "The executable did not identify itself as a supported Cua Driver version.",
      );
    return version;
  });
  const readSmall = Effect.fn("CuaDriverBackend.readSmall")(function* (file: string) {
    if (Number((yield* fs.stat(file)).size) > 16_384)
      return yield* failure("record", "The Cua installation record is invalid.");
    return yield* fs.readFileString(file);
  });
  const resolve = Effect.fn("CuaDriverBackend.resolve")(
    function* (configuredPath: string) {
      if (custom(configuredPath))
        return yield* resolveCommandPath(configuredPath.trim(), { env: environment });
      if (yield* fs.exists(defaultBinary)) return defaultBinary;
      return yield* resolveCommandPath("cua-driver", { env: environment });
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.mapError(
      wrap(
        "resolve",
        "Cua Driver is not installed. Open Settings → Integrations → Computer to set it up.",
      ),
    ),
  );
  const inspect = Effect.fn("CuaDriverBackend.inspect")(
    function* (configuredPath: string) {
      const isCustom = custom(configuredPath);
      const source = isCustom ? "custom" : platform === "darwin" ? "system" : "managed";
      const canManage = !isCustom && cuaReleaseTarget(platform, architecture) !== null;
      const resolved = yield* resolve(configuredPath).pipe(Effect.option);
      if (Option.isNone(resolved))
        return {
          status: "missing",
          source,
          binaryPath: null,
          version: null,
          canManage,
          message: canManage
            ? "Install Cua Driver to use this computer with your agents."
            : "Set a working Cua Driver executable for this environment.",
        } satisfies ComputerInstallation;
      const binary = resolved.value;
      const isSystemApp = platform === "darwin" && path.resolve(binary) === defaultBinary;
      const probe = yield* Effect.gen(function* () {
        if (isSystemApp) yield* verifyMac(target);
        return yield* readVersion(binary);
      }).pipe(Effect.result);
      if (probe._tag === "Failure")
        return {
          status: "broken",
          source,
          binaryPath: binary,
          version: null,
          canManage,
          message: probe.failure.message,
        } satisfies ComputerInstallation;
      const interrupted = !isCustom && (yield* fs.exists(journalPath));
      return {
        status: interrupted ? "broken" : "ready",
        source,
        binaryPath: binary,
        version: probe.success,
        canManage,
        message: interrupted
          ? "An installation was interrupted. Repair will recover the previous driver before retrying."
          : null,
      } satisfies ComputerInstallation;
    },
    Effect.mapError(wrap("inspect", "Could not inspect Cua Driver on this environment.")),
  );
  const permissions = Effect.fn("CuaDriverBackend.permissions")(
    function* (binary: string) {
      if (platform !== "darwin")
        return {
          accessibility: "not-required",
          screenRecording: "not-required",
          capture: "not-required",
          message:
            "Cua requires an interactive desktop. App/window support depends on this platform and its desktop backend.",
        } satisfies ComputerPermissions;
      const response = yield* command(binary, ["permissions", "status", "--json"]);
      if (response.exit !== 0) return unknownComputerPermissions;
      const result = yield* decodePermissions(response.stdout);
      if (
        result.source?.bundle_id !== "com.trycua.driver" ||
        result.source.attribution !== "driver-daemon"
      )
        return {
          ...unknownComputerPermissions,
          message:
            "Open permission setup to launch CuaDriver under its own app identity, then check again.",
        };
      const grant = (value: boolean | undefined) =>
        value === undefined ? "unknown" : value ? "granted" : "missing";
      return {
        accessibility: grant(result.accessibility),
        screenRecording: grant(result.screen_recording),
        capture: result.screen_recording_capturable === true ? "verified" : "unknown",
        message:
          result.accessibility && result.screen_recording
            ? "Accessibility and Screen Recording are enabled for CuaDriver."
            : "Enable CuaDriver in Privacy & Security on this environment's computer, then check again.",
      } satisfies ComputerPermissions;
    },
    Effect.mapError(
      wrap(
        "permissions",
        "Could not read CuaDriver's permission status. Open permission setup on that computer and check again.",
      ),
    ),
  );
  const grantPermissions = Effect.fn("CuaDriverBackend.grantPermissions")(function* (
    binary: string,
  ) {
    if (platform !== "darwin") return yield* permissions(binary);
    const result = yield* command(binary, ["permissions", "grant"], "5 minutes").pipe(
      Effect.mapError(() =>
        failure(
          "permissions",
          "Permission setup did not finish. Enable CuaDriver in Accessibility and Screen & System Audio Recording on this environment’s computer, then Check permissions again.",
        ),
      ),
    );
    const current = yield* permissions(binary);
    if (
      result.exit !== 0 &&
      (current.accessibility !== "granted" || current.screenRecording !== "granted")
    )
      return yield* failure(
        "permissions",
        "Permission setup timed out. Enable CuaDriver in Accessibility and Screen & System Audio Recording on this environment's computer, then Check again.",
      );
    return current;
  });

  const validate = Effect.fn("CuaDriverBackend.validate")(
    function* (root: string, expectedVersion: string) {
      if (platform === "darwin") yield* verifyMac(root);
      if (platform !== "win32") yield* fs.chmod(executable(root), 0o755);
      if ((yield* readVersion(executable(root))) !== expectedVersion)
        return yield* failure(
          "verify",
          "The downloaded driver version did not match the selected release.",
        );
    },
    Effect.mapError(wrap("verify", "Could not validate the downloaded Cua Driver.")),
  );

  const lock = Effect.acquireRelease(
    Effect.gen(function* () {
      const token = NodeCrypto.randomUUID();
      // Never unlink an observed stale lock: another process may have replaced it.
      // A crash is deliberately fail-closed until its owner is checked by an operator.
      yield* fs
        .writeFileString(lockPath, yield* encodeLockOwner({ pid: process.pid, token }), {
          flag: "wx",
          mode: 0o600,
        })
        .pipe(
          Effect.mapError(() =>
            failure(
              "lock",
              `Cua setup is locked or this directory is not writable. Wait for another installer to finish. After a crashed installer, verify no setup is running before removing ${lockPath}.`,
            ),
          ),
        );
      return token;
    }),
    (token) =>
      readSmall(lockPath).pipe(
        Effect.flatMap(decodeLockOwner),
        Effect.flatMap((owner) => (owner.token === token ? fs.remove(lockPath) : Effect.void)),
        Effect.ignore,
      ),
  );

  const stopVerifiedDaemon = Effect.fn("CuaDriverBackend.stopVerifiedDaemon")(
    function* (controlBinary: string) {
      const status = yield* command(controlBinary, ["status"]);
      const pid = /\bpid:\s*(\d+)/u.exec(status.stdout)?.[1];
      if (!pid) {
        if (/not running|no.*daemon/iu.test(status.stdout + status.stderr)) return;
        return yield* failure(
          "stop",
          "Could not determine whether Cua Driver is running. Stop it on this computer and retry.",
        );
      }
      let runningPath: string;
      if (platform === "win32") {
        const found = yield* command("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).Path`,
        ]);
        runningPath = found.stdout;
      } else if (platform === "linux") runningPath = yield* fs.readLink(`/proc/${pid}/exe`);
      else runningPath = (yield* command("/bin/ps", ["-p", pid, "-o", "comm="])).stdout;
      if (path.resolve(runningPath) !== path.resolve(defaultBinary))
        return yield* failure(
          "stop",
          "A Cua daemon from another installation is running. Stop that driver before managing this installation; Pylon will not terminate another executable.",
        );
      const daemonPid = Number(pid);
      if (!Number.isSafeInteger(daemonPid) || daemonPid <= 1 || daemonPid === process.pid)
        return yield* failure("stop", "Cua reported an invalid daemon process.");
      // Signal only the verified PID, never a CLI stop command that resolves a different daemon.
      yield* Effect.try(() => process.kill(daemonPid, "SIGTERM"));
      yield* Effect.sync(() => {
        try {
          process.kill(daemonPid, 0);
          return true;
        } catch (error) {
          return !(error instanceof Error && "code" in error && error.code === "ESRCH");
        }
      }).pipe(
        Effect.repeat({ while: (alive) => alive, schedule: Schedule.spaced("100 millis") }),
        Effect.timeout("10 seconds"),
      );
    },
    Effect.mapError(
      wrap("stop", "Could not stop the verified Cua daemon. The installed files were preserved."),
    ),
  );

  const identity = Effect.fn("CuaDriverBackend.identity")(function* (file: string) {
    const stat = yield* fs.stat(file);
    return {
      device: String(stat.dev),
      inode: Option.isSome(stat.ino) ? String(stat.ino.value) : "",
    };
  });
  const same = (a: typeof Identity.Type, b: typeof Identity.Type) =>
    a.device === b.device && a.inode !== "" && a.inode === b.inode;
  const recover = Effect.fn("CuaDriverBackend.recover")(
    function* () {
      if (!(yield* fs.exists(journalPath))) return;
      const journal = yield* readSmall(journalPath).pipe(Effect.flatMap(decodeJournal));
      // An uncommitted transaction always rolls back, even if the new app validates.
      // Identity checks keep recovery from removing a replacement made by someone else.
      if (yield* fs.exists(target)) {
        const current = yield* identity(target);
        if (same(current, journal.next)) {
          if (
            journal.previous &&
            (!(yield* fs.exists(backup)) || !same(yield* identity(backup), journal.previous))
          )
            return yield* failure(
              "recover",
              "The previous Cua backup could not be verified. The current app and installation records were preserved.",
            );
          yield* fs.remove(target, { recursive: true });
        } else if (!journal.previous || !same(current, journal.previous))
          return yield* failure(
            "recover",
            "The Cua app changed outside this transaction. Its backup was preserved; inspect the installation before retrying.",
          );
      }
      if (journal.previous && !(yield* fs.exists(target))) {
        if (!(yield* fs.exists(backup)) || !same(yield* identity(backup), journal.previous))
          return yield* failure(
            "recover",
            "The previous Cua app could not be identified. Its installation records were preserved.",
          );
        yield* fs.rename(backup, target);
        if (platform === "darwin")
          yield* requireCommand(
            LSREGISTER,
            ["-f", target],
            "The previous Cua app was restored but macOS registration failed. Check again before retrying.",
          );
      }
      if (journal.previousReceipt === null) yield* fs.remove(receiptPath, { force: true });
      else yield* fs.writeFileString(receiptPath, journal.previousReceipt, { mode: 0o600 });
      yield* fs.remove(journalPath);
    },
    Effect.mapError(
      wrap(
        "recover",
        "Could not recover the interrupted Cua installation. Its backup has been preserved.",
      ),
    ),
  );

  const install = Effect.fn("CuaDriverBackend.install")(
    function* (release: ComputerRelease, hooks: CuaInstallHooks) {
      const hostTarget = cuaReleaseTarget(platform, architecture);
      const expectedName = `cua-driver-rs-${release.version}-${hostTarget}.${platform === "win32" ? "zip" : "tar.gz"}`;
      if (
        !Number.isSafeInteger(release.bytes) ||
        release.bytes <= 0 ||
        release.bytes > 512 * 1024 * 1024 ||
        !hostTarget ||
        release.assetName !== expectedName ||
        !/^\d+\.\d+\.\d+$/u.test(release.version) ||
        !/^[a-f0-9]{64}$/u.test(release.sha256)
      )
        return yield* failure("install", "This release does not match the environment platform.");
      yield* fs.makeDirectory(parent, { recursive: true });
      yield* lock;
      const available = yield* Effect.tryPromise(() => NodeFSP.statfs(parent, { bigint: true }));
      if (available.bavail * available.bsize < BigInt(release.bytes * 8 + 64 * 1024 * 1024))
        return yield* failure(
          "install",
          "There is not enough free disk space to stage and verify Cua Driver.",
        );
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: parent,
        prefix: ".pylon-cua-stage-",
      });
      const archive = path.join(staging, "download");
      const unpacked = path.join(staging, "unpacked");
      yield* fs.makeDirectory(unpacked);
      yield* hooks.report({
        phase: "downloading",
        message: `Downloading Cua Driver ${release.version}.`,
        downloadedBytes: 0,
        totalBytes: release.bytes,
      });
      const hash = NodeCrypto.createHash("sha256");
      let bytes = 0;
      let lastReport = 0;
      const response = yield* http
        .execute(
          HttpClientRequest.get(
            `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${release.version}/${release.assetName}`,
          ),
        )
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            bytes += chunk.byteLength;
            if (bytes > release.bytes)
              return yield* failure(
                "download",
                "The Cua download exceeded its verified release size.",
              );
            hash.update(chunk);
            if (bytes - lastReport >= 512 * 1024 || bytes === release.bytes) {
              lastReport = bytes;
              yield* hooks.report({
                phase: "downloading",
                message: `Downloading Cua Driver ${release.version}.`,
                downloadedBytes: bytes,
              });
            }
          }),
        ),
        Stream.run(fs.sink(archive, { flag: "wx", mode: 0o600 })),
        Effect.timeout("15 minutes"),
      );
      if (bytes !== release.bytes || hash.digest("hex") !== release.sha256)
        return yield* failure(
          "download",
          "Cua Driver failed its size or SHA-256 check. Nothing was installed.",
        );
      yield* hooks.report({ phase: "extracting", message: "Extracting the verified download." });
      yield* Effect.tryPromise({
        try: (signal) => extractCuaArchive(archive, unpacked, platform === "win32", signal),
        catch: () =>
          failure(
            "extract",
            "The Cua archive was invalid or unsafe. The installed driver was preserved.",
          ),
      }).pipe(Effect.timeout("2 minutes"));
      const root = path.join(unpacked, `cua-driver-rs-${release.version}-${hostTarget}`);
      const payload = platform === "darwin" ? path.join(root, "CuaDriver.app") : root;
      yield* hooks.report({ phase: "verifying", message: "Verifying the driver and publisher." });
      yield* validate(payload, release.version);
      yield* hooks.report({
        phase: "waiting",
        message: "Waiting for desktop actions to finish before restarting Cua Driver.",
      });
      yield* hooks.activate(
        Effect.gen(function* () {
          yield* stopVerifiedDaemon(executable(payload));
          yield* recover();
          const hadPrevious = yield* fs.exists(target);
          let previousVersion: string | null = null;
          if (hadPrevious && platform === "darwin") {
            const vendor = yield* verifyMac(target).pipe(Effect.option);
            const receipt = yield* readSmall(receiptPath).pipe(
              Effect.flatMap(decodeReceipt),
              Effect.option,
            );
            if (
              Option.isNone(vendor) &&
              (Option.isNone(receipt) || !same(yield* identity(target), receipt.value))
            )
              return yield* failure(
                "install",
                "The existing CuaDriver.app is not a verified Cua installation managed by Pylon. It was preserved; inspect it before reinstalling.",
              );
            previousVersion = Option.isSome(vendor)
              ? yield* readVersion(defaultBinary)
              : Option.isSome(receipt)
                ? receipt.value.version
                : null;
          } else if (hadPrevious)
            previousVersion = yield* readVersion(defaultBinary).pipe(
              Effect.orElseSucceed(() => null),
            );
          if (yield* fs.exists(backup))
            return yield* failure(
              "recover",
              "A previous Cua backup needs inspection before setup can proceed. No files were replaced.",
            );
          if (previousVersion !== null && compareCuaVersions(previousVersion, release.version) > 0)
            return yield* failure(
              "version",
              "A newer Cua Driver was installed since the update check. It was preserved; check again.",
            );
          yield* hooks.report({
            phase: "activating",
            message: "Installing Cua Driver. This step cannot be cancelled.",
          });
          yield* Effect.gen(function* () {
            // The journal and backup live beside the target: a crash between renames is recoverable.
            const previousReceipt = yield* readSmall(receiptPath).pipe(Effect.option);
            yield* fs.writeFileString(
              journalPath,
              yield* encodeJournal({
                previous: hadPrevious ? yield* identity(target) : null,
                next: yield* identity(payload),
                previousReceipt: Option.getOrNull(previousReceipt),
              }),
              { flag: "wx", mode: 0o600 },
            );
            if (hadPrevious) yield* fs.rename(target, backup);
            yield* fs.rename(payload, target);
            yield* validate(target, release.version);
            if (platform === "darwin")
              yield* requireCommand(
                LSREGISTER,
                ["-f", target],
                "Could not register CuaDriver with macOS. The previous app will be restored.",
              );
            yield* fs.writeFileString(
              receiptPath,
              yield* encodeReceipt({
                version: release.version,
                sha256: release.sha256,
                ...(yield* identity(target)),
              }),
              { mode: 0o600 },
            );
            yield* fs.remove(journalPath);
            yield* fs.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore);
            yield* hooks.report({
              phase: "succeeded",
              message: `Cua Driver ${release.version} is installed. Check permissions before using desktop tools.`,
            });
          }).pipe(
            Effect.catchCause((cause) => recover().pipe(Effect.andThen(Effect.failCause(cause)))),
            Effect.uninterruptible,
          );
        }).pipe(
          Effect.mapError(
            wrap(
              "activate",
              "Could not activate Cua Driver. Repair can recover the previous installation.",
            ),
          ),
        ),
      );
    },
    Effect.scoped,
    Effect.mapError(
      wrap(
        "install",
        "Could not install Cua Driver. Check free space and write access to the installation directory, then retry.",
      ),
    ),
  );

  return CuaDriverBackend.of({
    platform,
    architecture,
    inspect,
    resolve,
    permissions,
    grantPermissions,
    install,
  });
});
