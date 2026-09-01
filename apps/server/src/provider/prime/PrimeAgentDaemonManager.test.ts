// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type PrimeAgentDaemonAgentConnection,
  type PrimeAgentDaemonBridge,
  type PrimeAgentDaemonClient,
} from "./PrimeAgentDaemonBridge.ts";
import {
  derivePrimeAgentDaemonPaths,
  makePrimeAgentDaemonEnvironment,
  makePrimeAgentDaemonManager,
  PRIME_AGENT_REQUIRED_DAEMON_CAPABILITIES,
} from "./PrimeAgentDaemonManager.ts";

interface CapturedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly extendEnv?: boolean;
  };
}

interface FakeProcess {
  handle: ChildProcessSpawner.ChildProcessHandle;
  running: boolean;
  kills: number;
  readonly complete: () => void;
}

function fakeProcess(pid: number): Effect.Effect<FakeProcess> {
  return Effect.sync(() => {
    let exitCompleted = false;
    let exitResume: ((effect: Effect.Effect<ChildProcessSpawner.ExitCode>) => void) | undefined;
    const process: FakeProcess = {
      running: true,
      kills: 0,
      complete: () => {
        process.running = false;
        exitCompleted = true;
        exitResume?.(Effect.succeed(ChildProcessSpawner.ExitCode(0)));
      },
      handle: undefined as never,
    };
    const exitCode = Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      if (exitCompleted) resume(Effect.succeed(ChildProcessSpawner.ExitCode(0)));
      else exitResume = resume;
    });
    process.handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(pid),
      exitCode,
      isRunning: Effect.sync(() => process.running),
      kill: () =>
        Effect.sync(() => {
          process.kills += 1;
          process.complete();
        }),
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
    return process;
  });
}

function fakeBridge(input: {
  readonly socket: string;
  readonly processes: FakeProcess[];
  readonly hello?: unknown;
  readonly failConnect?: boolean;
  readonly connectionAvailable?: { value: boolean };
  readonly shutdownRequests: string[];
  readonly events?: string[];
  readonly existingLive?: { value: boolean };
  readonly readinessFailures?: { value: number };
  readonly calls?: { connect: number; readiness: number; hello: number; prompt: number };
}): PrimeAgentDaemonBridge {
  const hello =
    input.hello ??
    ({
      type: "daemon_hello",
      socketPath: input.socket,
      protocol: { name: "prime-agent.daemon", version: 7 },
      serverCapabilities: [...PRIME_AGENT_REQUIRED_DAEMON_CAPABILITIES],
    } satisfies Record<string, unknown>);

  class FakeClient implements PrimeAgentDaemonClient {
    isConnected = false;
    hello = hello as NonNullable<PrimeAgentDaemonClient["hello"]>;
    readonly socketPath: string;

    constructor(socketPath: string) {
      this.socketPath = socketPath;
    }

    connect(): Promise<void> {
      if (input.calls) input.calls.connect += 1;
      if (input.failConnect || input.connectionAvailable?.value === false) {
        return Promise.reject(new Error("not ready"));
      }
      const spawnedProcessRunning = input.processes.some((process) => process.running);
      if (spawnedProcessRunning && input.calls) input.calls.readiness += 1;
      if (!spawnedProcessRunning && input.existingLive?.value !== true) {
        return Promise.reject(new Error("socket unavailable"));
      }
      if (spawnedProcessRunning && (input.readinessFailures?.value ?? 0) > 0) {
        input.readinessFailures!.value -= 1;
        return Promise.reject(new Error("daemon starting"));
      }
      this.isConnected = true;
      return Promise.resolve();
    }

    waitForHello(): Promise<unknown> {
      if (input.calls) input.calls.hello += 1;
      return Promise.resolve(hello);
    }

    request(command: Readonly<Record<string, unknown>>): Promise<unknown> {
      if (command.type === "shutdown") {
        input.shutdownRequests.push(this.socketPath);
        input.events?.push(input.existingLive?.value === true ? "existing-shutdown" : "shutdown");
        if (input.existingLive) input.existingLive.value = false;
        input.processes.at(-1)?.complete();
      }
      return Promise.resolve({ type: "response", success: true });
    }

    close(): void {
      this.isConnected = false;
    }
  }

  class FakeAgentConnection implements PrimeAgentDaemonAgentConnection {
    static attach(): Promise<PrimeAgentDaemonAgentConnection> {
      return Promise.resolve(new FakeAgentConnection());
    }
    subscribe(): () => void {
      return () => undefined;
    }
    getCommands(): Promise<unknown> {
      return Promise.resolve([]);
    }
    getResourceSnapshot(): Promise<unknown> {
      return Promise.resolve({});
    }
    reload(): Promise<void> {
      return Promise.resolve();
    }
    getSessionStats(): Promise<unknown> {
      return Promise.resolve({ sessionId: "session-1" });
    }
    getInitialSnapshot(): Promise<unknown> {
      return Promise.resolve({});
    }
    promptAndWait(): Promise<void> {
      if (input.calls) input.calls.prompt += 1;
      return Promise.resolve();
    }
    abort(): Promise<void> {
      return Promise.resolve();
    }
    dispose(): Promise<void> {
      return Promise.resolve();
    }
  }

  return {
    packageRoot: "/fake/prime-agent",
    moduleEntryPath: "/fake/prime-agent/dist/index.js",
    version: "0.7.1",
    protocolName: "prime-agent.daemon",
    protocolVersion: 7,
    negotiatedDaemonSessionCapabilitiesAvailable: false,
    sdkFeatures: [],
    recoverableOwnedSessionAdoptionAvailable: false,
    DaemonClient: FakeClient,
    DaemonAgentConnection: FakeAgentConnection,
    defaultDaemonSocketPath: () => "/tmp/user-prime-agent.sock",
  };
}

function managerFixture(options?: {
  readonly hello?: unknown;
  readonly failConnect?: boolean;
  readonly existingLive?: boolean;
  readonly readinessFailures?: number;
  readonly restoreConnectionOnSpawn?: boolean;
  readonly tempDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly injectBridge?: boolean;
  readonly recoverable?: boolean;
}) {
  const commands: CapturedCommand[] = [];
  const processes: FakeProcess[] = [];
  const shutdownRequests: string[] = [];
  const events: string[] = [];
  const existingLive = { value: options?.existingLive ?? false };
  const readinessFailures = { value: options?.readinessFailures ?? 0 };
  const connectionAvailable = { value: true };
  const calls = { connect: 0, readiness: 0, hello: 0, prompt: 0 };
  const paths = derivePrimeAgentDaemonPaths({
    stateDir: "/tmp/pylon-state",
    providerInstanceId: ProviderInstanceId.make("prime-work"),
    platform: options?.platform ?? "linux",
    tempDir: options?.tempDir ?? "/tmp",
  });
  const recoveryHello = options?.recoverable
    ? {
        type: "daemon_hello",
        socketPath: paths.socket,
        protocol: { name: "prime-agent.daemon", version: 7 },
        schemaRevision: 30,
        supervisorGeneration: "supervisor-1",
        serverCapabilities: [
          ...PRIME_AGENT_REQUIRED_DAEMON_CAPABILITIES,
          "daemon_recoverable_owned_session_adoption_v1",
          "caller_owned_session_environment_cleanup_v1",
          "authoritative_owned_session_cleanup_v1",
        ],
      }
    : undefined;
  const bridge = fakeBridge({
    socket: paths.socket,
    processes,
    shutdownRequests,
    events,
    existingLive,
    readinessFailures,
    connectionAvailable,
    calls,
    ...(options?.hello === undefined && recoveryHello === undefined
      ? {}
      : { hello: options?.hello ?? recoveryHello }),
    ...(options?.failConnect === undefined ? {} : { failConnect: options.failConnect }),
  });
  if (options?.recoverable) {
    Object.assign(bridge, {
      sdkFeatures: [
        "recoverable_owned_session_adoption_v1",
        "caller_owned_session_environment_cleanup_v1",
      ],
      recoverableOwnedSessionAdoptionAvailable: true,
      createRecoverableOwnedSession: async () => {
        throw new Error("not used by manager test");
      },
      adoptRecoverableOwnedSession: async () => {
        throw new Error("not used by manager test");
      },
      confirmRecoverableOwnedSessionAdoption: async () => undefined,
    });
  }
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        commands.push(command as unknown as CapturedCommand);
        events.push("spawn");
        if (processes.length > 0 && options?.restoreConnectionOnSpawn) {
          connectionAvailable.value = true;
        }
        const process = yield* fakeProcess(processes.length + 1);
        processes.push(process);
        return process.handle;
      }),
    ),
  );
  const make = makePrimeAgentDaemonManager({
    executablePath: "/resolved/bin/prime-agent",
    settings: { agentHomePath: "~/.prime/pylon" },
    environment: {
      PATH: "/usr/bin",
      PRIME_AGENT_INTERNAL_ROLE: "worker",
      PRIME_AGENT_INTERNAL_TOKEN: "secret",
      KEEP_ME: "yes",
    },
    stateDir: "/tmp/pylon-state",
    providerInstanceId: ProviderInstanceId.make("prime-work"),
    platform: options?.platform ?? "linux",
    tempDir: options?.tempDir ?? "/tmp",
    readinessRetryDelay: Duration.zero,
    readinessRetries: 4,
    shutdownTimeout: Duration.zero,
    recoveryEnabled: options?.recoverable === true,
    architecture: "arm64",
    ...(options?.injectBridge === false ? {} : { bridge }),
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, spawner)));
  return {
    make,
    commands,
    processes,
    shutdownRequests,
    events,
    paths,
    connectionAvailable,
    calls,
  };
}

describe("PrimeAgentDaemonManager paths and environment", () => {
  it("derives stable short Unix sockets and Windows private pipes", () => {
    const input = {
      stateDir: "/a/very/long/pylon/state/directory/that/must/not/appear/in/the/socket",
      providerInstanceId: "work-prime",
      tempDir: "/tmp",
    } as const;
    const unix = derivePrimeAgentDaemonPaths({ ...input, platform: "linux" });
    const windows = derivePrimeAgentDaemonPaths({ ...input, platform: "win32" });

    expect(unix.socket).toMatch(/^\/tmp\/pylon-prime-agent-[a-f0-9]{20}\/daemon\.sock$/);
    expect(unix.socket.length).toBeLessThan(80);
    expect(windows.socket).toMatch(/^\\\\\.\\pipe\\pylon-prime-agent-[a-f0-9]{20}$/);
    expect(windows.sessionDir).toBe(unix.sessionDir);
    expect(derivePrimeAgentDaemonPaths({ ...input, platform: "linux" })).toEqual(unix);
  });

  it("strips every inherited internal variable and applies the configured agent home", () => {
    const environment = makePrimeAgentDaemonEnvironment({
      settings: { agentHomePath: "/private/pylon-prime-home" },
      environment: {
        PRIME_AGENT_INTERNAL_ROLE: "daemon-worker",
        PRIME_AGENT_INTERNAL_NEW_FIELD: "future-private-value",
        PRIME_AGENT_CODING_AGENT_DIR: "/ambient/home",
        KEEP: "yes",
      },
    });

    expect(environment).toEqual({
      PRIME_AGENT_CODING_AGENT_DIR: "/private/pylon-prime-home",
      KEEP: "yes",
    });
  });
});

describe("PrimeAgentDaemonManager lifecycle", () => {
  it.effect("fails closed on Windows before loading Prime or spawning a named-pipe daemon", () => {
    const fixture = managerFixture({ platform: "win32", injectBridge: false });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(fixture.make);
      expect(error).toMatchObject({
        socket: fixture.paths.socket,
        reason: "transport-security-unavailable",
        detail: expect.stringContaining("verified per-user ACL or authenticated handshake"),
      });
      expect(fixture.commands).toHaveLength(0);
    });
  });

  it.effect("does not touch a stable socket when the lazy manager was never opened", () => {
    const fixture = managerFixture({ existingLive: true });
    return Effect.scoped(Effect.asVoid(fixture.make)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          expect(fixture.commands).toHaveLength(0);
          expect(fixture.shutdownRequests).toHaveLength(0);
        }),
      ),
    );
  });

  it.effect(
    "prepares with one control-plane hello, never prompts, and avoids duplicate open handshakes",
    () => {
      const fixture = managerFixture();
      return Effect.gen(function* () {
        const manager = yield* fixture.make;

        yield* manager.prepare();
        expect(fixture.commands).toHaveLength(1);
        expect(fixture.calls.readiness).toBe(1);
        expect(fixture.calls.hello).toBe(1);
        expect(fixture.calls.prompt).toBe(0);

        const client = yield* manager.openClient();
        client.close();
        expect(fixture.commands).toHaveLength(1);
        expect(fixture.calls.readiness).toBe(2);
        expect(fixture.calls.hello).toBe(2);
        expect(fixture.calls.prompt).toBe(0);
      }).pipe(Effect.scoped);
    },
  );

  it.effect(
    "serializes concurrent opens, spawns once, and uses the isolated daemon command",
    () => {
      const fixture = managerFixture();
      return Effect.gen(function* () {
        const manager = yield* fixture.make;
        const clients = yield* Effect.all(
          [manager.openClient(), manager.openClient(), manager.openClient()],
          { concurrency: "unbounded" },
        );
        for (const client of clients) client.close();

        expect(fixture.commands).toHaveLength(1);
        const command = fixture.commands[0]!;
        expect(command.command).toBe("/resolved/bin/prime-agent");
        expect(command.args).toEqual([
          "--mode",
          "daemon",
          "--daemon-socket",
          manager.socket,
          "--offline",
          "--session-dir",
          manager.sessionDir,
        ]);
        expect(command.options.extendEnv).toBe(false);
        expect(command.options.env).toMatchObject({
          PATH: "/usr/bin",
          KEEP_ME: "yes",
          PRIME_AGENT_CODING_AGENT_DIR: NodePath.resolve(process.env.HOME!, ".prime/pylon"),
        });
        expect(command.options.env).not.toHaveProperty("PRIME_AGENT_INTERNAL_ROLE");
        expect(command.options.env).not.toHaveProperty("PRIME_AGENT_INTERNAL_TOKEN");
        const socketDirectory = yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.dirname(manager.socket)),
        );
        expect(socketDirectory.isDirectory()).toBe(true);
        expect(socketDirectory.mode & 0o777).toBe(0o700);
      }).pipe(Effect.scoped);
    },
  );

  it.effect("rejects a shared non-sticky temporary directory without spawning", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-prime-unsafe-"))),
      (tempDir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => NodeFSP.chmod(tempDir, 0o777));
          const fixture = managerFixture({ tempDir });
          const manager = yield* fixture.make;
          const error = yield* Effect.flip(manager.openClient());

          expect(error.reason).toBe("state-directory-failed");
          expect(error.detail).toContain("does not safely contain");
          expect(fixture.commands).toHaveLength(0);
          yield* Effect.promise(() =>
            NodeFSP.access(NodePath.dirname(manager.socket)).then(
              () => Promise.reject(new Error("socket directory should not be created")),
              () => undefined,
            ),
          );
        }).pipe(Effect.scoped),
      (tempDir) => Effect.promise(() => NodeFSP.rm(tempDir, { recursive: true, force: true })),
    ),
  );

  it.effect("rejects a pre-existing socket-directory symlink without spawning", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-prime-socket-"))),
      (tempDir) =>
        Effect.gen(function* () {
          const fixture = managerFixture({ tempDir });
          const socketDirectory = NodePath.dirname(fixture.paths.socket);
          const attackerDirectory = NodePath.join(tempDir, "attacker-owned");
          yield* Effect.promise(() => NodeFSP.mkdir(attackerDirectory, { mode: 0o700 }));
          yield* Effect.promise(() => NodeFSP.symlink(attackerDirectory, socketDirectory));

          const manager = yield* fixture.make;
          const error = yield* Effect.flip(manager.openClient());

          expect(error.reason).toBe("state-directory-failed");
          expect(error.detail).toContain("not a real directory");
          expect(fixture.commands).toHaveLength(0);
        }).pipe(Effect.scoped),
      (tempDir) => Effect.promise(() => NodeFSP.rm(tempDir, { recursive: true, force: true })),
    ),
  );

  it.effect(
    "fails readiness without publishing a daemon and interrupts only its captured handle",
    () => {
      const fixture = managerFixture({ failConnect: true });
      return Effect.gen(function* () {
        const manager = yield* fixture.make;
        const error = yield* Effect.flip(manager.openClient());
        expect(error.reason).toBe("readiness-failed");
        expect(fixture.commands).toHaveLength(1);
        expect(fixture.processes[0]!.kills).toBe(1);
      }).pipe(Effect.scoped);
    },
  );

  it.effect("rejects an incompatible daemon_hello before readiness", () => {
    const fixture = managerFixture({
      hello: {
        type: "daemon_hello",
        socketPath: derivePrimeAgentDaemonPaths({
          stateDir: "/tmp/pylon-state",
          providerInstanceId: "prime-work",
          platform: "linux",
          tempDir: "/tmp",
        }).socket,
        protocol: { name: "prime-agent.daemon", version: 6 },
        serverCapabilities: [...PRIME_AGENT_REQUIRED_DAEMON_CAPABILITIES],
      },
    });
    return Effect.gen(function* () {
      const manager = yield* fixture.make;
      const error = yield* Effect.flip(manager.prepare());
      expect(error.reason).toBe("incompatible-hello");
      expect(error.detail).toContain("v7+");
      expect(fixture.calls.readiness).toBe(1);
      expect(fixture.calls.hello).toBe(1);
      expect(fixture.calls.prompt).toBe(0);
    }).pipe(Effect.scoped);
  });

  it.effect("retries only transient control-plane readiness failures", () => {
    const fixture = managerFixture({ readinessFailures: 2 });
    return Effect.gen(function* () {
      const manager = yield* fixture.make;
      yield* manager.prepare();
      expect(fixture.commands).toHaveLength(1);
      expect(fixture.calls.readiness).toBe(3);
      expect(fixture.calls.hello).toBe(1);
      expect(fixture.calls.prompt).toBe(0);
    }).pipe(Effect.scoped);
  });

  it.effect("does not unlink or replace an incompatible live socket listener", () => {
    const paths = derivePrimeAgentDaemonPaths({
      stateDir: "/tmp/pylon-state",
      providerInstanceId: "prime-work",
      platform: "linux",
      tempDir: "/tmp",
    });
    const fixture = managerFixture({
      existingLive: true,
      hello: {
        type: "daemon_hello",
        socketPath: paths.socket,
        protocol: { name: "other-daemon", version: 7 },
        serverCapabilities: [...PRIME_AGENT_REQUIRED_DAEMON_CAPABILITIES],
      },
    });
    return Effect.gen(function* () {
      const manager = yield* fixture.make;
      const error = yield* Effect.flip(manager.openClient());
      expect(error.reason).toBe("incompatible-hello");
      expect(fixture.commands).toHaveLength(0);
      expect(fixture.shutdownRequests).toHaveLength(0);
    }).pipe(Effect.scoped);
  });

  it.effect(
    "retires a compatible daemon on the live stable socket before unlinking and spawning",
    () => {
      const fixture = managerFixture({ existingLive: true });
      return Effect.gen(function* () {
        const manager = yield* fixture.make;
        const client = yield* manager.openClient();
        client.close();
        expect(fixture.events.slice(0, 2)).toEqual(["existing-shutdown", "spawn"]);
        expect(fixture.commands).toHaveLength(1);
      }).pipe(Effect.scoped);
    },
  );

  it.effect("restarts an exited captured daemon through the recovery callback", () => {
    const fixture = managerFixture();
    return Effect.gen(function* () {
      const manager = yield* fixture.make;
      const client = yield* manager.openClient();
      client.close();
      fixture.processes[0]!.complete();

      yield* Effect.promise(() => manager.recover());
      expect(fixture.commands).toHaveLength(2);
      expect(fixture.processes[0]!.kills).toBe(0);
    }).pipe(Effect.scoped);
  });

  it.effect("restarts a captured daemon that is alive but no longer reachable", () => {
    const fixture = managerFixture({ restoreConnectionOnSpawn: true });
    return Effect.gen(function* () {
      const manager = yield* fixture.make;
      const client = yield* manager.openClient();
      client.close();
      fixture.connectionAvailable.value = false;

      yield* Effect.promise(() => manager.recover());
      expect(fixture.commands).toHaveLength(2);
      expect(fixture.processes[0]!.kills).toBe(1);
    }).pipe(Effect.scoped);
  });

  it.effect(
    "requests public graceful shutdown and awaits the captured child without killing it",
    () => {
      const fixture = managerFixture();
      return Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* fixture.make;
          const client = yield* manager.openClient();
          client.close();
        }),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            expect(fixture.shutdownRequests).toEqual([fixture.paths.socket]);
            expect(fixture.processes).toHaveLength(1);
            expect(fixture.processes[0]!.running).toBe(false);
            expect(fixture.processes[0]!.kills).toBe(0);
          }),
        ),
      );
    },
  );

  it.effect("never shuts down a compatible recovery supervisor retained by another process", () => {
    const fixture = managerFixture({ existingLive: true, recoverable: true });
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* fixture.make;
        const client = yield* manager.openClient();
        client.close();
        expect(fixture.shutdownRequests).toEqual([]);
        expect(fixture.commands).toHaveLength(0);
      }),
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          expect(fixture.shutdownRequests).toEqual([]);
          expect(fixture.commands).toHaveLength(0);
        }),
      ),
    );
  });
});
