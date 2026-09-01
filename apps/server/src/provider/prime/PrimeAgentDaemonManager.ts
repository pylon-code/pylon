// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type { PrimeAgentSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import { ChildProcess } from "effect/unstable/process";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveProviderHomePath } from "../../pathExpansion.ts";
import type { ProviderRuntimeFence } from "../ProviderDriver.ts";
import type { PrimeAgentMaterializedIdentity } from "./PrimeAgentRuntimeContext.ts";
import {
  loadPrimeAgentDaemonBridge,
  PRIME_AGENT_CALLER_OWNED_SESSION_ENVIRONMENT_CLEANUP_FEATURE,
  PRIME_AGENT_DAEMON_PROTOCOL_NAME,
  PRIME_AGENT_MIN_DAEMON_PROTOCOL_VERSION,
  PRIME_AGENT_NEGOTIATED_DAEMON_SESSION_CAPABILITIES_FEATURE,
  type PrimeAgentDaemonBridge,
  type PrimeAgentDaemonBridgeError,
  type PrimeAgentDaemonClient,
  sanitizePrimeAgentDaemonEnvironment,
} from "./PrimeAgentDaemonBridge.ts";

const PRIME_AGENT_HOME_ENV = "PRIME_AGENT_CODING_AGENT_DIR";
const SOCKET_HASH_LENGTH = 20;

export const PRIME_AGENT_REQUIRED_DAEMON_CAPABILITIES = [
  "attach_snapshot",
  "event_sequence",
  "client_owned_sessions",
  "extension_ui",
  "session_input_admission",
  "prompt_admission_cancellation",
  "caller_owned_session_environment_cleanup_v1",
  "authoritative_owned_session_cleanup_v1",
] as const;

const managerErrorReason = Schema.Literals([
  "state-directory-failed",
  "transport-security-unavailable",
  "spawn-failed",
  "process-status-failed",
  "readiness-failed",
  "incompatible-hello",
  "shutdown-failed",
]);

export class PrimeAgentDaemonManagerError extends Schema.TaggedErrorClass<PrimeAgentDaemonManagerError>()(
  "PrimeAgentDaemonManagerError",
  {
    reason: managerErrorReason,
    detail: Schema.String,
    socket: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Prime Agent daemon manager failed (${this.reason}) at '${this.socket}': ${this.detail}`;
  }
}

export type PrimeAgentDaemonManagerOpenError = PrimeAgentDaemonManagerError;

export interface PrimeAgentDaemonManager {
  readonly bridge: PrimeAgentDaemonBridge;
  readonly identity: PrimeAgentMaterializedIdentity;
  readonly socket: string;
  readonly sessionDir: string;
  /** Starts the daemon and validates its control-plane hello without opening an agent session. */
  readonly prepare: () => Effect.Effect<void, PrimeAgentDaemonManagerOpenError>;
  readonly openClient: () => Effect.Effect<
    PrimeAgentDaemonClient,
    PrimeAgentDaemonManagerOpenError
  >;
  /** Exact caller-owned worker environment captured before any Prime worker launch. */
  readonly launchEnvironment?: Readonly<Record<string, string>>;
  readonly recoveryEnabled?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  /** Keeps the compatible supervisor alive while at least one ledger authority can be adopted. */
  readonly retainForRecovery?: () => () => void;
  /** Directly accepted by DaemonClient.enableAutoReconnect({ recoverDaemon }). */
  readonly recover: () => Promise<void>;
}

export interface PrimeAgentDaemonManagerInput {
  readonly executablePath: string;
  readonly identity: PrimeAgentMaterializedIdentity;
  readonly runtimeFence?: ProviderRuntimeFence | undefined;
  readonly stateDir: string;
  readonly connectTimeoutMs?: number;
  readonly readinessRetryDelay?: Duration.Input;
  readonly readinessRetries?: number;
  readonly shutdownTimeout?: Duration.Input;
  /** Test-only platform injection keeps pipe derivation deterministic on non-Windows CI. */
  readonly platform?: NodeJS.Platform;
  /** Test-only temp-directory injection. */
  readonly tempDir?: string;
  /** Enables retention only after the selected package passed Pylon managed-distribution proof. */
  readonly recoveryEnabled?: boolean;
  readonly architecture?: string;
  /** Tests may supply the already validated public bridge without importing a real installation. */
  readonly bridge?: PrimeAgentDaemonBridge;
  /** Test seam for exact PID/start identity validation before a force signal. */
  readonly inspectProcessIdentity?: (pid: number) => Promise<string | undefined>;
  /** Test seam for a private socket cleanup barrier. */
  readonly removePrivateSocket?: (socket: string) => Promise<void>;
}

interface RunningDaemon {
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Scope;
  /** Captured at spawn and freshly re-read before every signal. */
  readonly startIdentity: string | undefined;
}

const daemonHelloSchema = Schema.Struct({
  type: Schema.Literal("daemon_hello"),
  socketPath: Schema.String,
  protocol: Schema.Struct({
    name: Schema.String,
    version: Schema.Int,
  }),
  schemaRevision: Schema.optional(Schema.Int),
  appVersion: Schema.optional(Schema.String),
  buildId: Schema.optional(Schema.String),
  supervisorGeneration: Schema.optional(Schema.String),
  serverCapabilities: Schema.Array(Schema.String),
});
const decodeDaemonHello = Schema.decodeUnknownOption(daemonHelloSchema);
const daemonSuccessResponseSchema = Schema.Struct({
  type: Schema.Literal("response"),
  success: Schema.Literal(true),
});
const isDaemonSuccessResponse = Schema.is(daemonSuccessResponseSchema);

function stableHash(input: string): string {
  return NodeCrypto.createHash("sha256").update(input).digest("hex").slice(0, SOCKET_HASH_LENGTH);
}

export function derivePrimeAgentDaemonPaths(input: {
  readonly stateDir: string;
  readonly providerInstanceId: ProviderInstanceId | string;
  readonly platform: NodeJS.Platform;
  readonly tempDir?: string;
}): { readonly socket: string; readonly sessionDir: string } {
  const stateDir = NodePath.resolve(input.stateDir);
  const identity = stableHash(`${stateDir}\0${input.providerInstanceId}`);
  const platform = input.platform;
  const tempDir = input.tempDir ?? NodeOS.tmpdir();
  return {
    socket:
      platform === "win32"
        ? `\\\\.\\pipe\\pylon-prime-agent-${identity}`
        : NodePath.join(tempDir, `pylon-prime-agent-${identity}`, "daemon.sock"),
    sessionDir: NodePath.join(stateDir, "provider-sessions", "prime-agent", identity, "sessions"),
  };
}

export function makePrimeAgentDaemonEnvironment(input: {
  readonly settings: Pick<PrimeAgentSettings, "agentHomePath">;
  readonly environment?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const environment = sanitizePrimeAgentDaemonEnvironment(input.environment ?? process.env);
  const agentHomePath = input.settings.agentHomePath.trim();
  return agentHomePath
    ? { ...environment, [PRIME_AGENT_HOME_ENV]: resolveProviderHomePath(agentHomePath) }
    : environment;
}

function managerError(
  socket: string,
  reason: PrimeAgentDaemonManagerError["reason"],
  detail: string,
  cause?: unknown,
): PrimeAgentDaemonManagerError {
  return new PrimeAgentDaemonManagerError({
    socket,
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function validatedHello(
  socket: string,
  hello: unknown,
): Effect.Effect<void, PrimeAgentDaemonManagerError> {
  const decoded = decodeDaemonHello(hello);
  if (Option.isNone(decoded)) {
    return Effect.fail(
      managerError(socket, "incompatible-hello", "The daemon did not send a valid daemon_hello."),
    );
  }
  const value = decoded.value;
  if (
    value.socketPath !== socket ||
    value.protocol.name !== PRIME_AGENT_DAEMON_PROTOCOL_NAME ||
    value.protocol.version < PRIME_AGENT_MIN_DAEMON_PROTOCOL_VERSION
  ) {
    return Effect.fail(
      managerError(
        socket,
        "incompatible-hello",
        `Expected ${PRIME_AGENT_DAEMON_PROTOCOL_NAME} v${PRIME_AGENT_MIN_DAEMON_PROTOCOL_VERSION}+ on the private socket; received '${value.protocol.name}' v${value.protocol.version} on '${value.socketPath}'.`,
      ),
    );
  }
  const missing = PRIME_AGENT_REQUIRED_DAEMON_CAPABILITIES.filter(
    (capability) => !value.serverCapabilities.includes(capability),
  );
  return missing.length === 0
    ? Effect.void
    : Effect.fail(
        managerError(
          socket,
          "incompatible-hello",
          `The daemon is missing required capabilities: ${missing.join(", ")}.`,
        ),
      );
}

function connectClient(input: {
  readonly bridge: PrimeAgentDaemonBridge;
  readonly socket: string;
  readonly timeoutMs: number;
}): Effect.Effect<PrimeAgentDaemonClient, PrimeAgentDaemonManagerError> {
  return Effect.gen(function* () {
    const client = new input.bridge.DaemonClient(input.socket);
    const hello = yield* Effect.tryPromise({
      try: async () => {
        await client.connect(input.timeoutMs);
        return await client.waitForHello(input.timeoutMs);
      },
      catch: (cause) =>
        managerError(
          input.socket,
          "readiness-failed",
          "Could not connect to the Pylon-owned daemon and receive daemon_hello.",
          cause,
        ),
    }).pipe(
      Effect.timeoutOrElse({
        duration: input.timeoutMs,
        orElse: () =>
          managerError(
            input.socket,
            "readiness-failed",
            "Timed out while opening the Pylon-owned daemon control connection.",
          ),
      }),
      Effect.onError(() =>
        Effect.sync(() => {
          client.close();
        }),
      ),
    );
    yield* validatedHello(input.socket, hello).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          client.close();
        }),
      ),
    );
    return client;
  });
}

async function inspectNativeProcessIdentity(
  pid: number,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (platform === "linux") {
    try {
      const stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return undefined;
      const fields = stat
        .slice(commandEnd + 2)
        .trim()
        .split(/\s+/u);
      const startTicks = fields[19];
      return startTicks === undefined ? undefined : `${pid}:${startTicks}`;
    } catch {
      return undefined;
    }
  }
  if (platform !== "darwin") return undefined;
  return await new Promise<string | undefined>((resolve) => {
    NodeChildProcess.execFile(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(pid)],
      { timeout: 1_000, maxBuffer: 1_024, encoding: "utf8" },
      (error, stdout) => {
        const started = stdout.trim();
        resolve(error === null && started.length > 0 ? `${pid}:${started}` : undefined);
      },
    );
  });
}

function drainProcessOutput(
  stream: Stream.Stream<Uint8Array, unknown>,
  streamName: "stdout" | "stderr",
): Effect.Effect<void> {
  // Daemon output may contain prompts, tool arguments, provider errors, or
  // local paths. Drain it to prevent child-process backpressure, but never copy
  // its contents into Pylon logs.
  return stream.pipe(
    Stream.runDrain,
    Effect.catch((cause) =>
      Effect.logWarning("Prime Agent daemon output drain failed.").pipe(
        Effect.annotateLogs({ provider: "primeAgent", daemonStream: streamName, cause }),
      ),
    ),
  );
}

export const makePrimeAgentDaemonManager = Effect.fn("makePrimeAgentDaemonManager")(function* (
  input: PrimeAgentDaemonManagerInput,
): Effect.fn.Return<
  PrimeAgentDaemonManager,
  PrimeAgentDaemonBridgeError | PrimeAgentDaemonManagerError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcessPlatform;
  const platform = input.platform ?? hostPlatform;
  const paths = derivePrimeAgentDaemonPaths({
    stateDir: input.stateDir,
    providerInstanceId: input.identity.instanceId,
    platform,
    ...(input.tempDir === undefined ? {} : { tempDir: input.tempDir }),
  });
  if (platform === "win32") {
    return yield* managerError(
      paths.socket,
      "transport-security-unavailable",
      "Prime Agent daemon mode is disabled on Windows until its named pipe has a verified per-user ACL or authenticated handshake.",
    );
  }
  const bridge = input.bridge ?? (yield* loadPrimeAgentDaemonBridge(input.executablePath));
  if (
    !bridge.sdkFeatures?.includes(PRIME_AGENT_NEGOTIATED_DAEMON_SESSION_CAPABILITIES_FEATURE) ||
    !bridge.sdkFeatures.includes(PRIME_AGENT_CALLER_OWNED_SESSION_ENVIRONMENT_CLEANUP_FEATURE)
  ) {
    return yield* managerError(
      paths.socket,
      "incompatible-hello",
      "The installed Prime Agent SDK does not provide the required caller-owned session contract.",
    );
  }
  const recoveryEnabled =
    input.recoveryEnabled === true && bridge.recoverableOwnedSessionAdoptionAvailable === true;
  const launchEnvironment = input.identity.launchEnv;
  let recoveryRetainers = 0;
  const retainForRecovery = () => {
    recoveryRetainers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      recoveryRetainers = Math.max(0, recoveryRetainers - 1);
    };
  };
  const defaultSocket = bridge.defaultDaemonSocketPath();
  const socket =
    paths.socket === defaultSocket
      ? paths.socket.replace(/\.sock$/, "-pylon-private.sock")
      : paths.socket;
  const sessionDir = paths.sessionDir;
  const timeoutMs = input.connectTimeoutMs ?? 10_000;
  const readinessSchedule = Schedule.max([
    Schedule.spaced(input.readinessRetryDelay ?? Duration.millis(50)),
    Schedule.recurs(input.readinessRetries ?? 20),
  ]);
  const shutdownTimeout = input.shutdownTimeout ?? Duration.seconds(5);
  const shutdownTimeoutMs = Math.max(
    1,
    Duration.toMillis(Duration.fromInputUnsafe(shutdownTimeout)),
  );
  const inspectProcessIdentity =
    input.inspectProcessIdentity ?? ((pid: number) => inspectNativeProcessIdentity(pid, platform));
  const semaphore = yield* Semaphore.make(1);
  let running: RunningDaemon | undefined;
  let starting: RunningDaemon | undefined;
  let retainedExistingDaemon = false;
  let closing = false;

  const isCurrentGeneration = input.runtimeFence?.isCurrent ?? Effect.succeed(true);
  const isStartAllowed = Effect.map(isCurrentGeneration, (current) => current && !closing);
  const removeSocket = () =>
    Effect.gen(function* () {
      // Recheck at unlink, not when cleanup was scheduled: a replacement may now own this path.
      if (!(yield* isCurrentGeneration)) return;
      const cleanup =
        input.removePrivateSocket === undefined
          ? fileSystem
              .remove(socket, { force: true })
              .pipe(
                Effect.mapError((cause) =>
                  managerError(
                    socket,
                    "state-directory-failed",
                    "Could not clean the daemon socket.",
                    cause,
                  ),
                ),
              )
          : Effect.tryPromise({
              try: () => input.removePrivateSocket!(socket),
              catch: (cause) =>
                managerError(
                  socket,
                  "state-directory-failed",
                  "Could not clean the private daemon socket.",
                  cause,
                ),
            });
      yield* cleanup.pipe(
        Effect.timeoutOrElse({
          duration: shutdownTimeout,
          orElse: () =>
            managerError(
              socket,
              "state-directory-failed",
              "Timed out while cleaning the private daemon socket.",
            ),
        }),
      );
    });

  const ensurePrivateSocketDirectory = Effect.fn(
    "PrimeAgentDaemonManager.ensurePrivateSocketDirectory",
  )(function* () {
    const socketDirectory = NodePath.dirname(socket);
    const configuredTempDirectory = input.tempDir ?? NodeOS.tmpdir();
    const resolvedTempDirectory = yield* fileSystem
      .realPath(configuredTempDirectory)
      .pipe(
        Effect.mapError((cause) =>
          managerError(
            socket,
            "state-directory-failed",
            "Could not resolve the configured temporary directory.",
            cause,
          ),
        ),
      );
    const currentUid = process.getuid?.();
    const tempDirectoryInfo = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(resolvedTempDirectory),
      catch: (cause) =>
        managerError(
          socket,
          "state-directory-failed",
          "Could not inspect the configured temporary directory.",
          cause,
        ),
    });
    const tempOwnerIsTrusted =
      currentUid === undefined ||
      tempDirectoryInfo.uid === currentUid ||
      tempDirectoryInfo.uid === 0;
    const sharedWritable = (tempDirectoryInfo.mode & 0o022) !== 0;
    const sticky = (tempDirectoryInfo.mode & 0o1000) !== 0;
    if (
      !tempDirectoryInfo.isDirectory() ||
      tempDirectoryInfo.isSymbolicLink() ||
      !tempOwnerIsTrusted ||
      (sharedWritable && !sticky)
    ) {
      return yield* managerError(
        socket,
        "state-directory-failed",
        "The configured temporary directory does not safely contain private daemon sockets.",
      );
    }
    yield* fileSystem
      .makeDirectory(socketDirectory, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError((cause) =>
          managerError(
            socket,
            "state-directory-failed",
            "Could not create the private daemon socket directory.",
            cause,
          ),
        ),
      );
    const inspectSocketDirectory = Effect.tryPromise({
      try: () => NodeFSP.lstat(socketDirectory),
      catch: (cause) =>
        managerError(
          socket,
          "state-directory-failed",
          "Could not inspect the private daemon socket directory.",
          cause,
        ),
    });
    const before = yield* inspectSocketDirectory;
    if (!before.isDirectory() || before.isSymbolicLink()) {
      return yield* managerError(
        socket,
        "state-directory-failed",
        "The private daemon socket path is not a real directory.",
      );
    }
    if (currentUid !== undefined && before.uid !== currentUid) {
      return yield* managerError(
        socket,
        "state-directory-failed",
        "The private daemon socket directory is owned by another OS user.",
      );
    }
    const resolvedSocketDirectory = yield* fileSystem
      .realPath(socketDirectory)
      .pipe(
        Effect.mapError((cause) =>
          managerError(
            socket,
            "state-directory-failed",
            "Could not verify the private daemon socket directory.",
            cause,
          ),
        ),
      );
    const expectedDirectory = NodePath.join(
      resolvedTempDirectory,
      NodePath.basename(socketDirectory),
    );
    if (resolvedSocketDirectory !== expectedDirectory) {
      return yield* managerError(
        socket,
        "state-directory-failed",
        "The private daemon socket directory resolves outside the configured temporary directory.",
      );
    }
    yield* fileSystem
      .chmod(socketDirectory, 0o700)
      .pipe(
        Effect.mapError((cause) =>
          managerError(
            socket,
            "state-directory-failed",
            "Could not restrict the private daemon socket directory.",
            cause,
          ),
        ),
      );
    const restricted = yield* inspectSocketDirectory;
    if (
      !restricted.isDirectory() ||
      restricted.isSymbolicLink() ||
      restricted.dev !== before.dev ||
      restricted.ino !== before.ino ||
      (currentUid !== undefined && restricted.uid !== currentUid)
    ) {
      return yield* managerError(
        socket,
        "state-directory-failed",
        "The private daemon socket directory changed while it was being secured.",
      );
    }
    if ((restricted.mode & 0o077) !== 0) {
      return yield* managerError(
        socket,
        "state-directory-failed",
        "The private daemon socket directory is accessible to other OS users.",
      );
    }
  });

  const closeProcessScope = (state: RunningDaemon) =>
    Effect.gen(function* () {
      // Scope finalizers are uninterruptible. Await them through a detached fiber so a
      // wedged subprocess/stream finalizer cannot defeat the explicit shutdown bound.
      const closer = yield* Effect.forkDetach(Scope.close(state.scope, Exit.void));
      const result = yield* Fiber.await(closer).pipe(Effect.timeoutOption(shutdownTimeout));
      if (Option.isNone(result)) {
        yield* Effect.logWarning("Prime Agent daemon process scope close timed out.", {
          provider: "primeAgent",
        });
        return false;
      }
      if (Exit.isFailure(result.value)) {
        yield* Effect.logWarning("Prime Agent daemon process scope close failed.", {
          provider: "primeAgent",
        });
        return false;
      }
      return true;
    });

  const awaitCapturedExit = (state: RunningDaemon, phase: "graceful" | "post-kill") =>
    state.handle.exitCode.pipe(
      Effect.timeoutOption(shutdownTimeout),
      Effect.catch((cause) =>
        Effect.logWarning("Could not await Prime Agent daemon exit.").pipe(
          Effect.annotateLogs({ provider: "primeAgent", phase, cause }),
          Effect.as(Option.none()),
        ),
      ),
    );

  const capturedProcessIdentityIsCurrent = (state: RunningDaemon) =>
    state.startIdentity === undefined
      ? Effect.succeed(false)
      : Effect.tryPromise(() => inspectProcessIdentity(state.handle.pid)).pipe(
          Effect.timeoutOption(shutdownTimeout),
          Effect.orElseSucceed(() => Option.none()),
          Effect.map(
            (freshIdentity) =>
              Option.isSome(freshIdentity) && freshIdentity.value === state.startIdentity,
          ),
        );

  const closeProcessScopeSafely = Effect.fn("PrimeAgentDaemonManager.closeProcessScopeSafely")(
    function* (state: RunningDaemon, processExited: boolean) {
      if (!processExited && !(yield* capturedProcessIdentityIsCurrent(state))) {
        yield* Effect.logWarning(
          "Refusing to close a process scope that could signal an unproved Prime Agent daemon identity.",
          { provider: "primeAgent" },
        );
        return false;
      }
      return yield* closeProcessScope(state);
    },
  );

  const forceKillCaptured = Effect.fn("PrimeAgentDaemonManager.forceKillCaptured")(function* (
    state: RunningDaemon,
  ) {
    if (!(yield* capturedProcessIdentityIsCurrent(state))) {
      yield* Effect.logWarning(
        state.startIdentity === undefined
          ? "Refusing to signal a Prime Agent daemon without its captured process start identity."
          : "Refusing to signal a Prime Agent daemon whose process identity is no longer current.",
        { provider: "primeAgent" },
      );
      return false;
    }
    const requested = yield* state.handle.kill({ killSignal: "SIGKILL" }).pipe(
      Effect.timeoutOption(shutdownTimeout),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.logWarning("Prime Agent daemon force-kill request timed out.", {
              provider: "primeAgent",
            }).pipe(Effect.as(false)),
          onSome: () => Effect.succeed(true),
        }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Could not interrupt captured Prime Agent daemon process.").pipe(
          Effect.annotateLogs({ provider: "primeAgent", cause }),
          Effect.as(false),
        ),
      ),
    );
    return requested;
  });

  const stopCapturedDaemonBody = Effect.fn("PrimeAgentDaemonManager.stopCapturedDaemonBody")(
    function* (state: RunningDaemon, controlPlaneReady = true) {
      let controlClient: PrimeAgentDaemonClient | undefined;
      const runningReceipt = yield* state.handle.isRunning.pipe(
        Effect.timeoutOption(shutdownTimeout),
        Effect.catch((cause) => {
          return Effect.logWarning("Could not inspect Prime Agent daemon during shutdown.").pipe(
            Effect.annotateLogs({ provider: "primeAgent", cause }),
            Effect.as(Option.none()),
          );
        }),
      );
      let exited = Option.isSome(runningReceipt) && runningReceipt.value === false;
      const isRunning = !exited;

      if (isRunning && !(yield* isCurrentGeneration)) {
        const killed = yield* forceKillCaptured(state);
        if (killed) exited = Option.isSome(yield* awaitCapturedExit(state, "post-kill"));
        yield* closeProcessScopeSafely(state, exited);
        return;
      }

      if (isRunning) {
        if (controlPlaneReady) {
          controlClient = yield* connectClient({
            bridge,
            socket,
            timeoutMs: shutdownTimeoutMs,
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning(error.message).pipe(
                Effect.annotateLogs({ provider: "primeAgent" }),
                Effect.as(undefined),
              ),
            ),
          );
          if (controlClient && (yield* isCurrentGeneration)) {
            yield* Effect.tryPromise({
              try: async () => {
                const response = await controlClient!.request(
                  { type: "shutdown" },
                  shutdownTimeoutMs,
                );
                if (!isDaemonSuccessResponse(response)) {
                  throw new Error("shutdown response was not a successful public daemon response");
                }
              },
              catch: (cause) =>
                managerError(
                  socket,
                  "shutdown-failed",
                  "The daemon rejected or did not answer its public shutdown command.",
                  cause,
                ),
            }).pipe(
              Effect.timeoutOption(shutdownTimeout),
              Effect.catch((error) =>
                Effect.logWarning(error.message).pipe(
                  Effect.annotateLogs({ provider: "primeAgent" }),
                  Effect.as(Option.none()),
                ),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  controlClient?.close();
                }),
              ),
            );
          } else {
            yield* Effect.sync(() => controlClient?.close());
          }
        }

        const gracefulExit = controlPlaneReady
          ? yield* awaitCapturedExit(state, "graceful")
          : Option.none();
        exited = Option.isSome(gracefulExit);
        if (!exited) {
          const killed = yield* forceKillCaptured(state);
          if (killed) exited = Option.isSome(yield* awaitCapturedExit(state, "post-kill"));
        }
      }

      if (exited) yield* removeSocket().pipe(Effect.ignore);
      yield* closeProcessScopeSafely(state, exited);
    },
  );

  const daemonStopFlights = new WeakMap<RunningDaemon, Deferred.Deferred<void>>();
  const stopCapturedDaemon = Effect.fn("PrimeAgentDaemonManager.stopCapturedDaemon")(function* (
    state: RunningDaemon,
    controlPlaneReady = true,
  ) {
    const existing = daemonStopFlights.get(state);
    if (existing !== undefined) return yield* Deferred.await(existing);
    const completion = yield* Deferred.make<void>();
    daemonStopFlights.set(state, completion);
    return yield* stopCapturedDaemonBody(state, controlPlaneReady).pipe(
      Effect.onExit((exit) =>
        Deferred.done(completion, exit).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (Exit.isFailure(exit)) daemonStopFlights.delete(state);
            }),
          ),
          Effect.ignore,
        ),
      ),
    );
  });

  const probeExistingDaemon = Effect.fn("PrimeAgentDaemonManager.probeExistingDaemon")(
    function* (): Effect.fn.Return<
      Option.Option<PrimeAgentDaemonClient>,
      PrimeAgentDaemonManagerError
    > {
      const client = new bridge.DaemonClient(socket);
      const connected = yield* Effect.promise(() =>
        client.connect(timeoutMs).then(
          () => true,
          () => false,
        ),
      ).pipe(Effect.timeoutOption(timeoutMs));
      if (Option.isNone(connected)) {
        client.close();
        return yield* managerError(
          socket,
          "readiness-failed",
          "Timed out while probing the private daemon socket.",
        );
      }
      if (!connected.value) {
        client.close();
        return Option.none();
      }
      const hello = yield* Effect.tryPromise({
        try: () => client.waitForHello(timeoutMs),
        catch: (cause) =>
          managerError(
            socket,
            "readiness-failed",
            "A process accepted the private daemon socket but did not send daemon_hello; refusing to unlink its live socket.",
            cause,
          ),
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            managerError(
              socket,
              "readiness-failed",
              "Timed out while validating the private daemon socket listener.",
            ),
        }),
        Effect.onError(() => Effect.sync(() => client.close())),
      );
      yield* validatedHello(socket, hello).pipe(
        Effect.onError(() => Effect.sync(() => client.close())),
      );
      return Option.some(client);
    },
  );

  const waitForSocketClosure = Effect.fn("PrimeAgentDaemonManager.waitForSocketClosure")(
    function* () {
      const client = new bridge.DaemonClient(socket);
      const connected = yield* Effect.promise(() =>
        client.connect(timeoutMs).then(
          () => true,
          () => false,
        ),
      ).pipe(Effect.timeoutOption(timeoutMs));
      client.close();
      if (Option.isNone(connected)) {
        return yield* managerError(
          socket,
          "shutdown-failed",
          "Timed out while confirming private daemon socket closure.",
        );
      }
      if (connected.value) {
        return yield* managerError(
          socket,
          "shutdown-failed",
          "The prior Pylon-owned daemon still accepts connections after shutdown.",
        );
      }
    },
  );

  const retireExistingDaemon = Effect.fn("PrimeAgentDaemonManager.retireExistingDaemon")(function* (
    client: PrimeAgentDaemonClient,
  ) {
    if (!(yield* isStartAllowed)) {
      client.close();
      return yield* managerError(
        socket,
        "readiness-failed",
        "This Prime Agent runtime generation was replaced.",
      );
    }
    const response = yield* Effect.tryPromise({
      try: () => client.request({ type: "shutdown" }, timeoutMs),
      catch: (cause) =>
        managerError(
          socket,
          "shutdown-failed",
          "Could not stop the prior Pylon-owned daemon on the stable private socket.",
          cause,
        ),
    }).pipe(
      Effect.timeoutOrElse({
        duration: shutdownTimeout,
        orElse: () =>
          managerError(
            socket,
            "shutdown-failed",
            "Timed out while requesting private daemon shutdown.",
          ),
      }),
      Effect.ensuring(Effect.sync(() => client.close())),
    );
    if (!isDaemonSuccessResponse(response)) {
      return yield* managerError(
        socket,
        "shutdown-failed",
        "The prior daemon did not acknowledge its public shutdown command.",
      );
    }
    yield* waitForSocketClosure();
  });

  const startLocked = Effect.fn("PrimeAgentDaemonManager.startLocked")(function* () {
    if (!(yield* isStartAllowed)) {
      return yield* managerError(
        socket,
        "readiness-failed",
        "This Prime Agent runtime generation was replaced.",
      );
    }
    if (closing) {
      return yield* managerError(
        socket,
        "readiness-failed",
        "The scoped daemon manager is closing.",
      );
    }
    if (running) {
      const current = running;
      const isRunning = yield* current.handle.isRunning.pipe(
        Effect.timeoutOrElse({
          duration: shutdownTimeout,
          orElse: () =>
            managerError(
              socket,
              "process-status-failed",
              "Timed out while inspecting the daemon process.",
            ),
        }),
        Effect.mapError((cause) =>
          managerError(
            socket,
            "process-status-failed",
            "Could not inspect the daemon process.",
            cause,
          ),
        ),
      );
      if (isRunning) {
        const healthClient = yield* connectClient({ bridge, socket, timeoutMs }).pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            error.reason === "readiness-failed"
              ? Effect.succeed(Option.none())
              : Effect.fail(error),
          ),
        );
        if (Option.isSome(healthClient)) {
          if (yield* isStartAllowed) return healthClient.value;
          healthClient.value.close();
          return yield* managerError(
            socket,
            "readiness-failed",
            "This Prime Agent runtime generation was replaced.",
          );
        }
        running = undefined;
        yield* stopCapturedDaemon(current, false);
      } else {
        running = undefined;
        yield* removeSocket();
        yield* closeProcessScopeSafely(current, true);
      }
    }

    yield* ensurePrivateSocketDirectory();
    if (!(yield* isStartAllowed)) {
      return yield* managerError(
        socket,
        "readiness-failed",
        "This Prime Agent runtime generation was replaced.",
      );
    }
    yield* fileSystem.makeDirectory(sessionDir, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(fileSystem.chmod(sessionDir, 0o700)),
      Effect.mapError((cause) =>
        managerError(
          socket,
          "state-directory-failed",
          `Could not create shared Prime Agent session directory '${sessionDir}'.`,
          cause,
        ),
      ),
    );
    const existing = yield* probeExistingDaemon();
    if (Option.isSome(existing)) {
      const hello = decodeDaemonHello(existing.value.hello);
      const recoverable =
        recoveryEnabled &&
        Option.isSome(hello) &&
        (hello.value.schemaRevision ?? 0) >= 30 &&
        typeof hello.value.supervisorGeneration === "string" &&
        hello.value.supervisorGeneration.length > 0 &&
        [
          "daemon_recoverable_owned_session_adoption_v1",
          "caller_owned_session_environment_cleanup_v1",
          "authoritative_owned_session_cleanup_v1",
        ].every((capability) => hello.value.serverCapabilities.includes(capability));
      if (recoverable) {
        if (!(yield* isStartAllowed)) {
          existing.value.close();
          return yield* managerError(
            socket,
            "readiness-failed",
            "This Prime Agent runtime generation was replaced.",
          );
        }
        retainedExistingDaemon = true;
        return existing.value;
      }
      yield* retireExistingDaemon(existing.value);
    }
    retainedExistingDaemon = false;
    yield* removeSocket();

    const processScope = yield* Scope.make("sequential");
    const command = ChildProcess.make(
      input.executablePath,
      ["--mode", "daemon", "--daemon-socket", socket, "--offline", "--session-dir", sessionDir],
      { env: launchEnvironment, extendEnv: false },
    );
    if (!(yield* isStartAllowed)) {
      const closer = yield* Effect.forkDetach(Scope.close(processScope, Exit.void));
      yield* Fiber.await(closer).pipe(Effect.timeoutOption(shutdownTimeout), Effect.ignore);
      return yield* managerError(
        socket,
        "readiness-failed",
        "This Prime Agent runtime generation was replaced.",
      );
    }
    const handle = yield* spawner.spawn(command).pipe(
      Effect.provideService(Scope.Scope, processScope),
      Effect.mapError((cause) =>
        managerError(socket, "spawn-failed", "Could not spawn the Prime Agent daemon.", cause),
      ),
      Effect.onError(() =>
        Effect.logWarning(
          "Prime Agent daemon spawn failed before a process identity could be captured; refusing unproved scope signaling.",
          { provider: "primeAgent" },
        ),
      ),
    );
    const capturedStartIdentity = yield* Effect.tryPromise(() =>
      inspectProcessIdentity(handle.pid),
    ).pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.orElseSucceed(() => Option.none()),
    );
    const state = {
      handle,
      scope: processScope,
      startIdentity: Option.getOrUndefined(capturedStartIdentity),
    } satisfies RunningDaemon;
    starting = state;
    if (state.startIdentity === undefined) {
      starting = undefined;
      yield* handle.unref.pipe(Effect.timeoutOption(shutdownTimeout), Effect.ignore);
      yield* Effect.logError(
        "Prime Agent daemon start identity was unavailable; refusing any unproved process signal.",
        { provider: "primeAgent", pid: handle.pid },
      );
      return yield* managerError(
        socket,
        "process-status-failed",
        "Could not capture the Prime Agent daemon process start identity.",
      );
    }
    yield* Effect.forkIn(drainProcessOutput(handle.stdout, "stdout"), processScope);
    yield* Effect.forkIn(drainProcessOutput(handle.stderr, "stderr"), processScope);

    const readinessClient = yield* connectClient({ bridge, socket, timeoutMs }).pipe(
      Effect.retry({
        while: (error) => error.reason === "readiness-failed",
        schedule: readinessSchedule,
      }),
      Effect.onError(() =>
        stopCapturedDaemon(state, false).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (starting === state) starting = undefined;
            }),
          ),
        ),
      ),
    );
    if (!(yield* isStartAllowed)) {
      readinessClient.close();
      yield* stopCapturedDaemon(state, false);
      return yield* managerError(
        socket,
        "readiness-failed",
        "This Prime Agent runtime generation was replaced.",
      );
    }
    starting = undefined;
    running = state;
    retainedExistingDaemon = false;
    return readinessClient;
  });

  const prepare = () =>
    semaphore.withPermit(
      startLocked().pipe(
        Effect.tap((client) => Effect.sync(() => client.close())),
        Effect.asVoid,
      ),
    );
  const runtimeContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(runtimeContext);

  const openClient = () => semaphore.withPermit(startLocked());

  const shutdownLocked = semaphore.withPermit(
    Effect.gen(function* () {
      const captured = running ?? starting;
      running = undefined;
      starting = undefined;
      if (recoveryRetainers > 0 && (yield* isCurrentGeneration)) {
        // Server shutdown retains exact #84 recovery authority. A material replacement
        // has already retired this generation and must contain only its private daemon.
        return;
      }
      if (captured) {
        yield* stopCapturedDaemon(captured);
        return;
      }
      if (retainedExistingDaemon) {
        // This process did not spawn the compatible supervisor. A competing exact
        // adopter may already own it, so a generic socket is never cleanup authority.
        return;
      }
    }),
  );
  const shutdown = Effect.gen(function* () {
    closing = true;
    const overallTimeoutMs = shutdownTimeoutMs * 8;
    const settled = yield* shutdownLocked.pipe(Effect.timeoutOption(overallTimeoutMs));
    if (Option.isSome(settled)) return;
    yield* Effect.logWarning("Prime Agent daemon shutdown reached its total bound.", {
      provider: "primeAgent",
      timeoutMs: overallTimeoutMs,
    });
    if (recoveryRetainers > 0 && (yield* isCurrentGeneration)) return;
    const captured = running ?? starting;
    running = undefined;
    starting = undefined;
    if (captured !== undefined) yield* stopCapturedDaemon(captured).pipe(Effect.ignore);
  });

  yield* Effect.addFinalizer(() =>
    // Scope finalizers are uninterruptible. A fresh runtime fiber preserves the
    // interruptibility required by each teardown phase timeout.
    Effect.promise(() => runPromise(shutdown).catch(() => undefined)),
  );

  return {
    bridge,
    identity: input.identity,
    socket,
    sessionDir,
    prepare,
    openClient,
    launchEnvironment,
    recoveryEnabled,
    platform,
    architecture: input.architecture ?? "unsupported",
    retainForRecovery,
    recover: () => runPromise(prepare()),
  } satisfies PrimeAgentDaemonManager;
});
