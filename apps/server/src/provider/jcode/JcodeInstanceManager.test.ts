// @effect-diagnostics nodeBuiltinImport:off
import { inspect } from "node:util";

import { HarnessError } from "@1jehuang/jcode-sdk";
import type { LaunchOptions, RuntimeInfo, SessionInfo } from "@1jehuang/jcode-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import {
  makeJcodeSdkBridge,
  type JcodeSdkClientLike,
  type JcodeSdkModule,
} from "./JcodeSdkBridge.ts";
import { jcodeHomePath, jcodeProviderRoot } from "./JcodePaths.ts";
import {
  JCODE_INSTANCE_SHUTDOWN_TIMEOUT,
  JCODE_LAUNCH_TIMEOUT,
  makeJcodeInstanceManager,
  type JcodeInstanceManagerError,
} from "./JcodeInstanceManager.ts";

const SECRET = "sk-ant-secret-value-1234";
const NATIVE_SOCKET = "/private/var/folders/jcode-home-abc/api.sock";
const POSIX = process.platform !== "win32";

function sessionInfo(sessionId: string): SessionInfo {
  return { session_id: sessionId, status: "idle" };
}

function runtimeInfo(sessionId: string, model: string): RuntimeInfo {
  return {
    server: "jcode-harness-api-bridge/0.1.0",
    protocolVersion: 1,
    capabilities: ["sessions", "models", "permissions"],
    healthy: true,
    sessionId,
    model,
    providers: ["anthropic"],
    routes: [
      {
        model,
        provider: "anthropic",
        api_method: "messages",
        available: true,
        detail: "",
      },
      {
        model: "gpt-5.5",
        provider: "openai",
        api_method: "responses",
        available: false,
        detail: "no credentials",
      },
    ],
  };
}

interface ClientRecord {
  readonly name: string;
  readonly client: JcodeSdkClientLike;
  closed: number;
  /** Set by a test to make this client's close reject like a broken socket. */
  failClose: boolean;
  readonly attached: string[];
  readonly detached: string[];
}

interface Harness {
  /** Assigned once the closures below can reference the harness itself. */
  sdk: JcodeSdkModule;
  readonly launches: LaunchOptions[];
  readonly clients: ClientRecord[];
  readonly created: string[];
  shutdowns: number;
  readonly events: string[];
  readonly modelCalls: string[];
  readonly runtimeCalls: string[];
  currentModel: string;
  /** Session ids the fake daemon considers live. */
  readonly liveSessions: Set<string>;
}

interface HarnessOptions {
  readonly attachFailure?: (sessionId: string) => unknown;
  /** Raised by `listModels`, which is how a forgotten probe session surfaces. */
  readonly listModelsFailure?: (sessionId: string) => unknown;
  /** Never-resolving gates stand in for a native call that stops answering. */
  readonly launchGate?: Promise<void>;
  readonly shutdownGate?: Promise<void>;
  readonly onLaunchEnter?: () => void;
  readonly onShutdownEnter?: () => void;
  readonly capabilities?: ReadonlyArray<string>;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  let sessionCounter = 0;
  let clientCounter = 0;
  const harness: Harness = {
    sdk: undefined as never,
    launches: [],
    clients: [],
    created: [],
    shutdowns: 0,
    events: [],
    modelCalls: [],
    runtimeCalls: [],
    currentModel: "claude-fable-5",
    liveSessions: new Set<string>(),
  };

  function makeClient(name: string): JcodeSdkClientLike {
    const record: ClientRecord = {
      name,
      client: undefined as never,
      closed: 0,
      failClose: false,
      attached: [],
      detached: [],
    };
    const client: JcodeSdkClientLike = {
      server: "jcode-harness-api-bridge/0.1.0",
      capabilities: [...(options.capabilities ?? ["sessions", "models", "permissions"])],
      supports: (capability) =>
        (options.capabilities ?? ["sessions", "models", "permissions"]).includes(capability),
      createSession: async () => {
        sessionCounter += 1;
        const id = `probe-session-${sessionCounter}`;
        harness.created.push(id);
        harness.liveSessions.add(id);
        harness.events.push(`create:${name}:${id}`);
        return sessionInfo(id);
      },
      attachSession: async (sessionId) => {
        record.attached.push(sessionId);
        harness.events.push(`attach:${name}:${sessionId}`);
        const failure = options.attachFailure?.(sessionId);
        if (failure !== undefined) throw failure;
        harness.liveSessions.add(sessionId);
        return sessionInfo(sessionId);
      },
      detachSession: async (sessionId) => {
        record.detached.push(sessionId);
        harness.events.push(`detach:${name}:${sessionId}`);
      },
      listSessions: async () => [...harness.liveSessions].map(sessionInfo),
      listModels: async (sessionId) => {
        harness.modelCalls.push(sessionId);
        const failure = options.listModelsFailure?.(sessionId);
        if (failure !== undefined) throw failure;
        return { models: [harness.currentModel, "gpt-5.5"], current: harness.currentModel };
      },
      getRuntimeInfo: async (sessionId) => {
        harness.runtimeCalls.push(sessionId);
        return runtimeInfo(sessionId, harness.currentModel);
      },
      setModel: async () => {},
      setReasoningEffort: async () => {},
      sendMessage: async () => {},
      cancel: async () => {},
      getHistory: async () => [],
      // eslint-disable-next-line require-yield
      events: async function* () {},
      close: async () => {
        if (record.failClose) {
          harness.events.push(`close-failed:${name}`);
          throw new Error(`close failed at ${NATIVE_SOCKET} for ${SECRET}`);
        }
        record.closed += 1;
        harness.events.push(`close:${name}`);
      },
    };
    (record as { client: JcodeSdkClientLike }).client = client;
    harness.clients.push(record);
    return client;
  }

  harness.sdk = {
    launchInstance: async (launchOptions: LaunchOptions) => {
      options.onLaunchEnter?.();
      if (options.launchGate !== undefined) await options.launchGate;
      harness.launches.push(launchOptions);
      harness.events.push("launch");
      return {
        socketPath: NATIVE_SOCKET,
        jcodeHome: launchOptions.jcodeHome ?? "/private/var/folders/jcode-home-abc",
        shutdown: async () => {
          options.onShutdownEnter?.();
          if (options.shutdownGate !== undefined) await options.shutdownGate;
          harness.shutdowns += 1;
          harness.events.push("instance-shutdown");
        },
      };
    },
    connect: async () => {
      clientCounter += 1;
      return makeClient(`client-${clientCounter}`);
    },
  };

  return harness;
}

interface FixtureInput {
  readonly harness: Harness;
  readonly stateDir: string;
  readonly instanceId?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly credentialValues?: ReadonlyArray<string>;
}

function makeManager(input: FixtureInput) {
  return makeJcodeInstanceManager({
    bridge: makeJcodeSdkBridge(input.harness.sdk),
    instanceId: input.instanceId ?? "instance-a",
    stateDir: input.stateDir,
    settings: { binaryPath: "/usr/local/bin/jcode", inheritLogins: true },
    environment: input.environment ?? { PATH: "/usr/bin", ANTHROPIC_API_KEY: SECRET },
    credentialValues: input.credentialValues ?? [SECRET],
  });
}

/** Runs one scoped scenario against a private temp state directory. */
function runScoped<A, E>(
  body: (input: {
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly stateDir: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "jcode-instance-" });
        return yield* body({ fs, path, stateDir });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

/**
 * The same scenario, but with time under test control so a fixed manager
 * deadline can be reached without waiting on it.
 */
function runScopedWithTestClock<A, E>(
  body: (input: {
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly stateDir: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "jcode-instance-" });
        return yield* body({ fs, path, stateDir });
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer()))),
  );
}

/** A native call that is entered and then never answers. */
function stalledCall(): { readonly entered: Promise<void>; readonly enter: () => void } {
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return { entered, enter: () => enter() };
}

function probePath(stateDir: string, instanceId: string): string {
  return `${jcodeProviderRoot({ stateDir, instanceId })}/probe.json`;
}

describe("JcodeInstanceManager launch", () => {
  it("launches exactly one private instance under the provider-instance home", async () => {
    const harness = makeHarness();
    const observed = await runScoped(({ stateDir }) =>
      Effect.gen(function* () {
        const manager = yield* makeManager({ harness, stateDir });
        // Two consumers must not provoke a second launch.
        yield* manager.probe;
        yield* manager.connectSessionClient;
        return { stateDir };
      }),
    );

    expect(harness.launches).toHaveLength(1);
    const launch = harness.launches[0]!;
    expect(launch.jcodeHome).toBe(
      jcodeHomePath({ stateDir: observed.stateDir, instanceId: "instance-a" }),
    );
    expect(launch.binary).toBe("/usr/local/bin/jcode");
    expect(launch.inheritLogins).toBe(true);
    expect(launch.inheritStderr).toBe(false);
  });

  it("gives two provider instances different private homes and separate instances", async () => {
    const first = makeHarness();
    const second = makeHarness();
    const homes = await runScoped(({ stateDir }) =>
      Effect.gen(function* () {
        yield* makeManager({ harness: first, stateDir, instanceId: "instance-a" });
        yield* makeManager({ harness: second, stateDir, instanceId: "instance-b" });
        return {
          a: jcodeHomePath({ stateDir, instanceId: "instance-a" }),
          b: jcodeHomePath({ stateDir, instanceId: "instance-b" }),
        };
      }),
    );

    expect(first.launches).toHaveLength(1);
    expect(second.launches).toHaveLength(1);
    expect(first.launches[0]!.jcodeHome).toBe(homes.a);
    expect(second.launches[0]!.jcodeHome).toBe(homes.b);
    expect(homes.a).not.toBe(homes.b);
  });

  it("strips reserved Jcode variables even when the caller claims a sanitized environment", async () => {
    const harness = makeHarness();
    await runScoped(({ stateDir }) =>
      Effect.asVoid(
        makeManager({
          harness,
          stateDir,
          environment: {
            PATH: "/usr/bin",
            ANTHROPIC_API_KEY: SECRET,
            JCODE_HOME: "/home/user/.jcode",
            JCODE_RUNTIME_DIR: "/run/user/1000/jcode",
            JCODE_API_SOCKET: "/run/user/1000/jcode/api.sock",
            JCODE_SOCKET: "/run/user/1000/jcode/legacy.sock",
          },
        }),
      ),
    );

    const env = harness.launches[0]!.env!;
    for (const reserved of [
      "JCODE_HOME",
      "JCODE_RUNTIME_DIR",
      "JCODE_API_SOCKET",
      "JCODE_SOCKET",
    ]) {
      expect(Object.keys(env)).not.toContain(reserved);
    }
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_API_KEY).toBe(SECRET);
  });

  it("creates the private instance root and home with owner-only modes", async () => {
    if (!POSIX) return;
    const harness = makeHarness();
    const modes = await runScoped(({ fs, stateDir }) =>
      Effect.gen(function* () {
        yield* makeManager({ harness, stateDir });
        const root = jcodeProviderRoot({ stateDir, instanceId: "instance-a" });
        const home = jcodeHomePath({ stateDir, instanceId: "instance-a" });
        return {
          root: (yield* fs.stat(root)).mode & 0o777,
          home: (yield* fs.stat(home)).mode & 0o777,
        };
      }),
    );

    expect(modes.root).toBe(0o700);
    expect(modes.home).toBe(0o700);
  });

  it("redacts credentials and native paths from a launch failure", async () => {
    const harness = makeHarness();
    const failing: JcodeSdkModule = {
      ...harness.sdk,
      launchInstance: async () => {
        throw new Error(`spawn failed at ${NATIVE_SOCKET} with key ${SECRET}`);
      },
    };
    const error = await runScoped(({ stateDir }) =>
      Effect.flip(
        makeJcodeInstanceManager({
          bridge: makeJcodeSdkBridge(failing),
          instanceId: "instance-a",
          stateDir,
          settings: { binaryPath: "jcode", inheritLogins: false },
          environment: { ANTHROPIC_API_KEY: SECRET },
          credentialValues: [SECRET],
        }),
      ),
    );

    expect(error._tag).toBe("JcodeInstanceManagerError");
    expect(error.operation).toBe("launch");
    const rendered = `${inspect(error, { depth: 10 })}${JSON.stringify(error)}${String(error)}${error.stack ?? ""}`;
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(NATIVE_SOCKET);
    expect(rendered).not.toContain("/private/var/folders");
  });
});

describe("JcodeInstanceManager probe identity", () => {
  it("persists only the versioned private identity, owner-only, after creating the probe session", async () => {
    const harness = makeHarness();
    const observed = await runScoped(({ fs, stateDir }) =>
      Effect.gen(function* () {
        yield* makeManager({ harness, stateDir });
        const file = probePath(stateDir, "instance-a");
        return {
          source: yield* fs.readFileString(file),
          mode: (yield* fs.stat(file)).mode & 0o777,
          entries: yield* fs.readDirectory(
            jcodeProviderRoot({ stateDir, instanceId: "instance-a" }),
          ),
        };
      }),
    );

    const parsed = JSON.parse(observed.source) as Record<string, unknown>;
    expect(Object.keys(parsed).toSorted()).toEqual(["schemaVersion", "sessionId"]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.sessionId).toBe(harness.created[0]);
    // Nothing native is ever cached alongside the identity.
    for (const leak of [
      SECRET,
      NATIVE_SOCKET,
      "capabilities",
      "protocolVersion",
      "claude-fable-5",
    ]) {
      expect(observed.source).not.toContain(leak);
    }
    if (POSIX) expect(observed.mode).toBe(0o600);
    // Temp residue never survives the atomic write.
    expect(observed.entries.filter((entry) => entry.includes(".tmp"))).toEqual([]);
  });

  it("reattaches the exact recorded session without creating another", async () => {
    const harness = makeHarness();
    const observed = await runScoped(({ stateDir }) =>
      Effect.gen(function* () {
        yield* Effect.scoped(Effect.asVoid(makeManager({ harness, stateDir })));
        const firstSession = harness.created[0]!;
        yield* makeManager({ harness, stateDir });
        return { firstSession };
      }),
    );

    expect(harness.created).toEqual([observed.firstSession]);
    expect(harness.events).toContain(`attach:client-2:${observed.firstSession}`);
  });

  it("replaces a missing identity exactly once", async () => {
    const harness = makeHarness();
    const source = await runScoped(({ fs, stateDir }) =>
      Effect.gen(function* () {
        yield* makeManager({ harness, stateDir });
        return yield* fs.readFileString(probePath(stateDir, "instance-a"));
      }),
    );

    expect(harness.created).toHaveLength(1);
    expect(JSON.parse(source).sessionId).toBe(harness.created[0]);
  });

  it("replaces a malformed identity exactly once and rewrites it atomically", async () => {
    const harness = makeHarness();
    const observed = await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const file = probePath(stateDir, "instance-a");
        yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(file, "{ not json");
        yield* makeManager({ harness, stateDir });
        return {
          source: yield* fs.readFileString(file),
          entries: yield* fs.readDirectory(path.dirname(file)),
        };
      }),
    );

    expect(harness.created).toHaveLength(1);
    expect(JSON.parse(observed.source).sessionId).toBe(harness.created[0]);
    expect(observed.entries.filter((entry) => entry.includes(".tmp"))).toEqual([]);
  });

  it("replaces an authoritative session-not-found identity exactly once", async () => {
    const harness = makeHarness({
      attachFailure: (sessionId) =>
        sessionId === "vanished-session"
          ? new HarnessError("unknown_session", `session ${sessionId} is gone`)
          : undefined,
    });
    const observed = await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const file = probePath(stateDir, "instance-a");
        yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(
          file,
          // @effect-diagnostics-next-line preferSchemaOverJson:off - writes the exact private sidecar bytes under test.
          `${JSON.stringify({ schemaVersion: 1, sessionId: "vanished-session" })}\n`,
        );
        yield* makeManager({ harness, stateDir });
        return { source: yield* fs.readFileString(file) };
      }),
    );

    expect(harness.created).toHaveLength(1);
    expect(JSON.parse(observed.source).sessionId).toBe(harness.created[0]);
    expect(harness.created[0]).not.toBe("vanished-session");
  });

  it("fails closed on an unreadable identity instead of minting a duplicate session", async () => {
    if (!POSIX) return;
    const harness = makeHarness();
    const observed = await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const file = probePath(stateDir, "instance-a");
        yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
        // @effect-diagnostics-next-line preferSchemaOverJson:off - writes the exact private sidecar bytes under test.
        const original = `${JSON.stringify({ schemaVersion: 1, sessionId: "existing-session" })}\n`;
        yield* fs.writeFileString(file, original);
        // An unreadable sidecar is "unknown", not "absent": EACCES must never be
        // mistaken for a fresh instance.
        yield* fs.chmod(file, 0o000);
        const error = yield* Effect.flip(
          Effect.scoped(Effect.asVoid(makeManager({ harness, stateDir }))),
        );
        yield* fs.chmod(file, 0o600);
        return { error, source: yield* fs.readFileString(file), original };
      }),
    );

    expect(observed.error._tag).toBe("JcodeInstanceManagerError");
    expect(observed.error.operation).toBe("attach-probe");
    // No duplicate probe session, and the record of the existing one survives.
    expect(harness.created).toHaveLength(0);
    expect(observed.source).toBe(observed.original);
    // A failed startup still stops the instance it launched.
    expect(harness.shutdowns).toBe(1);
    // The failure names neither the private layout nor the recorded session.
    const rendered = `${inspect(observed.error, { depth: 10 })}${String(observed.error)}`;
    expect(rendered).not.toContain("existing-session");
    expect(rendered).not.toContain("probe.json");
    expect(rendered).not.toContain("b64-");
  });

  it("keeps the identity and fails startup when attach fails transiently", async () => {
    const harness = makeHarness({
      attachFailure: (sessionId) =>
        sessionId === "existing-session" ? new Error("connection reset") : undefined,
    });
    const observed = await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const file = probePath(stateDir, "instance-a");
        yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
        // @effect-diagnostics-next-line preferSchemaOverJson:off - writes the exact private sidecar bytes under test.
        const original = `${JSON.stringify({ schemaVersion: 1, sessionId: "existing-session" })}\n`;
        yield* fs.writeFileString(file, original);
        const error = yield* Effect.flip(
          Effect.scoped(Effect.asVoid(makeManager({ harness, stateDir }))),
        );
        return { error, source: yield* fs.readFileString(file) };
      }),
    );

    expect(observed.error._tag).toBe("JcodeInstanceManagerError");
    expect(observed.error.operation).toBe("attach-probe");
    // A transient failure never deletes the identity nor creates a duplicate.
    expect(JSON.parse(observed.source).sessionId).toBe("existing-session");
    expect(harness.created).toHaveLength(0);
    // A failed startup still stops the instance it launched.
    expect(harness.shutdowns).toBe(1);
  });
});

describe("JcodeInstanceManager probe", () => {
  it("reads fresh model and runtime data on every call and never persists it", async () => {
    const harness = makeHarness();
    const observed = await runScoped(({ fs, stateDir }) =>
      Effect.gen(function* () {
        const manager = yield* makeManager({ harness, stateDir });
        const first = yield* manager.probe;
        harness.currentModel = "claude-fable-6";
        const second = yield* manager.probe;
        return {
          first,
          second,
          source: yield* fs.readFileString(probePath(stateDir, "instance-a")),
        };
      }),
    );

    expect(observed.first.currentModel).toBe("claude-fable-5");
    expect(observed.second.currentModel).toBe("claude-fable-6");
    expect(observed.first.server).toBe("jcode-harness-api-bridge/0.1.0");
    expect(observed.first.protocolVersion).toBe(1);
    expect(observed.second.models.map((model) => model.model)).toContain("claude-fable-6");
    expect(harness.modelCalls).toHaveLength(2);
    expect(harness.runtimeCalls).toHaveLength(2);
    // Fresh results never leak into the private identity.
    expect(Object.keys(JSON.parse(observed.source)).toSorted()).toEqual([
      "schemaVersion",
      "sessionId",
    ]);
  });

  it("keeps the native probe session id out of every surface of a not-found probe failure", async () => {
    // The daemon forgetting the probe session is the live route to a nested
    // `JcodeSessionNotFoundError`, which carries the native id as an own
    // enumerable property of a real `Error`.
    const harness = makeHarness({
      listModelsFailure: (sessionId) =>
        new HarnessError("unknown_session", `session ${sessionId} is gone`),
    });
    const observed = await runScoped(({ stateDir }) =>
      Effect.gen(function* () {
        const manager = yield* makeManager({ harness, stateDir });
        return yield* Effect.flip(manager.probe);
      }),
    );

    const probeSession = harness.created[0]!;
    expect(observed._tag).toBe("JcodeInstanceManagerError");
    expect(observed.operation).toBe("probe");
    // Everything a logger, crash printer, or serializer can realistically see.
    const rendered = [
      inspect(observed, { depth: 10 }),
      JSON.stringify(observed),
      JSON.stringify({ error: observed }),
      String(observed),
      observed.stack ?? "",
    ].join("\n");
    expect(rendered).not.toContain(probeSession);
    expect(rendered).not.toContain("probe-session-");
    // The typed detail still says what happened, without naming the session.
    expect(observed.detail).toContain("no longer known");
  });

  it("records advertised permissions as a capability without entering supervised mode", async () => {
    const harness = makeHarness();
    const probe = await runScoped(({ stateDir }) =>
      Effect.gen(function* () {
        const manager = yield* makeManager({ harness, stateDir });
        return yield* manager.probe;
      }),
    );

    expect(probe.capabilities).toContain("permissions");
    // Early Access never answers a permission prompt, so the manager exposes no
    // way to send one and never registers an approval-required surface.
    const surface = Object.keys(probe).concat(harness.events);
    expect(surface.join(" ")).not.toContain("respondToPermission");
    expect(surface.join(" ")).not.toContain("autoApprove");
  });
});

describe("JcodeInstanceManager session clients", () => {
  it("connects independent clients to the same private socket", async () => {
    const harness = makeHarness();
    const observed = await runScoped(({ stateDir }) =>
      Effect.gen(function* () {
        const manager = yield* makeManager({ harness, stateDir });
        const first = yield* manager.connectSessionClient;
        const second = yield* manager.connectSessionClient;
        yield* Effect.promise(() => first.attachSession("thread-1"));
        yield* Effect.promise(() => second.attachSession("thread-2"));
        return { same: first === second };
      }),
    );

    expect(observed.same).toBe(false);
    // One control client plus two session clients, all on the private socket.
    expect(harness.clients).toHaveLength(3);
    expect(harness.clients[1]!.attached).toEqual(["thread-1"]);
    expect(harness.clients[2]!.attached).toEqual(["thread-2"]);
  });

  it("closes children before the control client, then shuts the instance down once", async () => {
    const harness = makeHarness();
    await runScoped(({ stateDir }) =>
      Effect.gen(function* () {
        const manager = yield* makeManager({ harness, stateDir });
        yield* manager.connectSessionClient;
        yield* manager.connectSessionClient;
        yield* manager.shutdown;
        // Idempotent: a second shutdown and later scope finalization add nothing.
        yield* manager.shutdown;
      }),
    );

    const order = harness.events.filter(
      (event) => event.startsWith("close:") || event === "instance-shutdown",
    );
    expect(order).toEqual([
      "close:client-2",
      "close:client-3",
      "close:client-1",
      "instance-shutdown",
    ]);
    expect(harness.shutdowns).toBe(1);
    expect(harness.events.filter((event) => event === "instance-shutdown")).toHaveLength(1);
  });

  it("detaches the hidden probe session during shutdown", async () => {
    const harness = makeHarness();
    await runScoped(({ stateDir }) => Effect.asVoid(makeManager({ harness, stateDir })));

    const probeSession = harness.created[0]!;
    expect(harness.clients[0]!.detached).toEqual([probeSession]);
    expect(harness.events.indexOf(`detach:client-1:${probeSession}`)).toBeLessThan(
      harness.events.indexOf("close:client-1"),
    );
  });

  it("shuts down only its own instance and leaves a sibling manager running", async () => {
    const first = makeHarness();
    const second = makeHarness();
    await runScoped(({ stateDir }) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const firstManager = yield* Scope.provide(
          makeManager({ harness: first, stateDir, instanceId: "instance-a" }),
          scope,
        );
        const secondManager = yield* makeManager({
          harness: second,
          stateDir,
          instanceId: "instance-b",
        });
        yield* secondManager.connectSessionClient;
        yield* firstManager.shutdown;
        yield* Scope.close(scope, Exit.void);
        // The sibling is untouched by the first manager's shutdown.
        expect(second.shutdowns).toBe(0);
        expect(second.clients.every((record) => record.closed === 0)).toBe(true);
        yield* secondManager.probe;
      }),
    );

    expect(first.shutdowns).toBe(1);
    expect(second.shutdowns).toBe(1);
  });

  it("keeps launch credentials from crossing between manager-scoped bridges", async () => {
    const other = "sk-other-instance-secret-9999";
    const harness = makeHarness();
    const failing: JcodeSdkModule = {
      ...harness.sdk,
      connect: async () => {
        throw new Error(`connect refused; env had ${other} and ${SECRET}`);
      },
    };
    const error = await runScoped(({ stateDir }) =>
      Effect.flip(
        makeJcodeInstanceManager({
          bridge: makeJcodeSdkBridge(failing),
          instanceId: "instance-b",
          stateDir,
          settings: { binaryPath: "jcode", inheritLogins: true },
          environment: { ANTHROPIC_API_KEY: SECRET },
          // Only this manager's own credential is known to its own bridge.
          credentialValues: [SECRET],
        }),
      ),
    );

    expect(error.operation).toBe("connect-control");
    const rendered = `${inspect(error, { depth: 10 })}${JSON.stringify(error)}`;
    expect(rendered).not.toContain(SECRET);
    // A sibling manager's secret was never handed to this bridge, which is
    // exactly why bridges must not be shared across provider instances.
    expect(rendered).toContain("<redacted>");
  });

  it("continues cleanup after a child close fails and surfaces one redacted error", async () => {
    const harness = makeHarness();
    const observed = await runScoped(({ stateDir }) =>
      Effect.gen(function* () {
        const manager = yield* makeManager({ harness, stateDir });
        yield* manager.connectSessionClient;
        // The bridge hands out a wrapped client, so the break is applied to the
        // underlying fake the manager will actually close.
        harness.clients[1]!.failClose = true;
        return yield* Effect.flip(manager.shutdown);
      }),
    );

    expect(observed.operation).toBe("shutdown");
    const rendered = `${inspect(observed, { depth: 10 })}${JSON.stringify(observed)}${String(observed)}`;
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(NATIVE_SOCKET);
    // Best-effort cleanup continued past the failure.
    expect(harness.events).toContain("close-failed:client-2");
    expect(harness.events).toContain("close:client-1");
    expect(harness.shutdowns).toBe(1);
  });
});

describe("JcodeInstanceManager deadlines", () => {
  it("fails launch with a typed error when the instance never becomes available", async () => {
    const stalled = stalledCall();
    const harness = makeHarness({
      launchGate: new Promise<void>(() => undefined),
      onLaunchEnter: stalled.enter,
    });
    const error: JcodeInstanceManagerError = await runScopedWithTestClock(({ stateDir }) =>
      Effect.gen(function* () {
        const started = yield* Effect.forkChild(
          Effect.flip(Effect.scoped(Effect.asVoid(makeManager({ harness, stateDir })))),
        );
        yield* Effect.promise(() => stalled.entered);
        yield* TestClock.adjust(JCODE_LAUNCH_TIMEOUT);
        return yield* Fiber.join(started);
      }),
    );

    expect(error._tag).toBe("JcodeInstanceManagerError");
    expect(error.operation).toBe("launch");
    expect(harness.launches).toHaveLength(0);
  });

  it("bounds instance shutdown and still reports one typed shutdown error", async () => {
    const stalled = stalledCall();
    const harness = makeHarness({
      shutdownGate: new Promise<void>(() => undefined),
      onShutdownEnter: stalled.enter,
    });
    const error = await runScopedWithTestClock(({ stateDir }) =>
      Effect.gen(function* () {
        const manager = yield* makeManager({ harness, stateDir });
        const stopping = yield* Effect.forkChild(Effect.flip(manager.shutdown));
        yield* Effect.promise(() => stalled.entered);
        yield* TestClock.adjust(JCODE_INSTANCE_SHUTDOWN_TIMEOUT);
        return yield* Fiber.join(stopping);
      }),
    );

    expect(error._tag).toBe("JcodeInstanceManagerError");
    expect(error.operation).toBe("shutdown");
    // The bounded shutdown never reported a completed native stop.
    expect(harness.shutdowns).toBe(0);
  });
});
