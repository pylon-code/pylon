// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
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

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  makeJcodeSdkBridge,
  type JcodeSdkBridge,
  type JcodeSdkClientLike,
  type JcodeSdkModule,
} from "./JcodeSdkBridge.ts";
import {
  JCODE_MAX_UNIX_SOCKET_PATH,
  jcodeHomePath,
  jcodeLaunchAliasPath,
  jcodeLongestRuntimeSocketPath,
  jcodeProviderRoot,
} from "./JcodePaths.ts";
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
  /** Every explicit credential inheritance the manager asked the SDK to run. */
  readonly inheritCalls: Array<{ readonly fromHome: string; readonly toHome: string }>;
}

/** Stands in for the user's live interactive Jcode home. */
const USER_JCODE_HOME = "/Users/someone/.jcode";

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
  /** Raised by the real SDK when a launch home is a link rather than a directory. */
  readonly inheritFailure?: (toHome: string) => unknown;
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
    inheritCalls: [],
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
    userJcodeHome: () => USER_JCODE_HOME,
    inheritCredentials: (fromHome: string, toHome: string) => {
      harness.inheritCalls.push({ fromHome, toHome });
      harness.events.push("inherit-credentials");
      const failure = options.inheritFailure?.(toHome);
      if (failure !== undefined) throw failure;
      return ["auth.json", "config.toml"];
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
  readonly launchAliasBase?: string;
  readonly inheritLogins?: boolean;
}

function makeManager(input: FixtureInput) {
  return makeJcodeInstanceManager({
    bridge: makeJcodeSdkBridge(input.harness.sdk),
    instanceId: input.instanceId ?? "instance-a",
    stateDir: input.stateDir,
    settings: {
      binaryPath: "/usr/local/bin/jcode",
      inheritLogins: input.inheritLogins ?? true,
    },
    environment: input.environment ?? { PATH: "/usr/bin", ANTHROPIC_API_KEY: SECRET },
    credentialValues: input.credentialValues ?? [SECRET],
    // Always this scenario's own short scoped base, never the production
    // `/tmp/pylon-jcode-<uid>`: a unit test must not write to the path a real
    // instance on this machine is using.
    launchAliasBase: input.launchAliasBase ?? requireAliasBase(),
  });
}

/**
 * A short, unique, self-deleting alias base.
 *
 * Launch aliases exist to stay inside the platform socket limit, so a test that
 * nested one under the system temp directory would spend the whole budget
 * proving nothing. It is deliberately not the production
 * `/tmp/pylon-jcode-<uid>` name, so a test run can never collide with a real
 * instance on the same machine.
 */
const scopedAliasBase = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const base = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "pj-test-" });
  currentAliasBase = base;
  return base;
});

/**
 * The alias base the current scenario is using.
 *
 * Set by the scoped runners so the many `makeManager({ harness, stateDir })`
 * call sites do not each have to thread it through. Reading a fixture-local
 * default is the smaller evil here; the alternative is repeating the same
 * argument in thirty places.
 */
let currentAliasBase: string | undefined;

/**
 * The scenario's alias base, or a loud failure.
 *
 * A literal fallback would silently create and leave that path on a developer's
 * machine the first time a scenario forgot its scoped runner. Failing names the
 * mistake instead of littering.
 */
function requireAliasBase(): string {
  if (currentAliasBase === undefined) {
    throw new Error("no scoped alias base: run this scenario through runScoped");
  }
  return currentAliasBase;
}

/** Runs one scoped scenario against a private temp state directory. */
function runScoped<A, E>(
  body: (input: {
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly stateDir: string;
    readonly aliasBase: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "jcode-instance-" });
        const aliasBase = yield* scopedAliasBase();
        return yield* body({ fs, path, stateDir, aliasBase });
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
        yield* scopedAliasBase();
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
  it("launches exactly one private instance resolving to the provider-instance home", async () => {
    const harness = makeHarness();
    const observed = await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const manager = yield* makeManager({
          harness,
          stateDir,
          launchAliasBase: path.join(stateDir, "alias"),
        });
        // Two consumers must not provoke a second launch.
        yield* manager.probe;
        yield* manager.connectSessionClient;
        const durableHome = jcodeHomePath({ stateDir, instanceId: "instance-a" });
        return {
          durableHome,
          durableResolved: yield* fs.realPath(durableHome),
          launchResolved: yield* fs.realPath(harness.launches[0]!.jcodeHome!),
        };
      }),
    );

    expect(harness.launches).toHaveLength(1);
    const launch = harness.launches[0]!;
    // The launch home is bounded, but it still resolves to the durable home,
    // so sessions and credentials stay in the provider namespace.
    expect(observed.launchResolved).toBe(observed.durableResolved);
    if (POSIX) {
      expect(launch.jcodeHome).not.toBe(observed.durableHome);
      // Inheritance already ran against the durable directory.
      expect(launch.inheritLogins).toBe(false);
    } else {
      expect(launch.jcodeHome).toBe(observed.durableHome);
      expect(launch.inheritLogins).toBe(true);
    }
    expect(launch.binary).toBe("/usr/local/bin/jcode");
    expect(launch.inheritStderr).toBe(false);
  });

  it("gives two provider instances different private homes and separate instances", async () => {
    const first = makeHarness();
    const second = makeHarness();
    const homes = await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const launchAliasBase = path.join(stateDir, "alias");
        yield* makeManager({ harness: first, stateDir, instanceId: "instance-a", launchAliasBase });
        yield* makeManager({
          harness: second,
          stateDir,
          instanceId: "instance-b",
          launchAliasBase,
        });
        return {
          a: yield* fs.realPath(jcodeHomePath({ stateDir, instanceId: "instance-a" })),
          b: yield* fs.realPath(jcodeHomePath({ stateDir, instanceId: "instance-b" })),
          launchedA: yield* fs.realPath(first.launches[0]!.jcodeHome!),
          launchedB: yield* fs.realPath(second.launches[0]!.jcodeHome!),
        };
      }),
    );

    expect(first.launches).toHaveLength(1);
    expect(second.launches).toHaveLength(1);
    // Distinct instances keep distinct durable homes, and each launch resolves
    // to its own: one alias base must never merge two instances.
    expect(homes.launchedA).toBe(homes.a);
    expect(homes.launchedB).toBe(homes.b);
    expect(homes.a).not.toBe(homes.b);
    expect(first.launches[0]!.jcodeHome).not.toBe(second.launches[0]!.jcodeHome);
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
          launchAliasBase: NodePath.join(stateDir, ".launch-alias"),
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
          launchAliasBase: requireAliasBase(),
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

describe("JcodeInstanceManager cold restart", () => {
  it("reattaches the exact recorded probe session after a clean stop and a fresh manager", async () => {
    // Two harnesses model one surviving daemon across a server restart: the
    // private state directory persists, while the child connection, its event
    // stream, and every counter are new.
    const before = makeHarness();
    const after = makeHarness();
    const observed = await runScoped(({ fs, stateDir }) =>
      Effect.gen(function* () {
        const persisted = yield* Effect.scoped(
          Effect.gen(function* () {
            const manager = yield* makeManager({ harness: before, stateDir });
            yield* manager.connectSessionClient;
            // A clean stop, not an abandoned process: the recorded identity must
            // survive the shutdown that closes the control client.
            yield* manager.shutdown;
            return yield* fs.readFileString(probePath(stateDir, "instance-a"));
          }),
        );
        yield* makeManager({ harness: after, stateDir });
        return { persisted, reread: yield* fs.readFileString(probePath(stateDir, "instance-a")) };
      }),
    );

    const recorded = before.created[0]!;
    expect(before.shutdowns).toBe(1);
    // The restarted manager attaches the exact recorded session and mints none.
    expect(after.created).toEqual([]);
    expect(after.events).toContain(`attach:client-1:${recorded}`);
    expect(after.clients[0]!.attached).toEqual([recorded]);
    // The identity is a durable record, not a cache rewritten on every boot.
    expect(observed.reread).toBe(observed.persisted);
    expect((JSON.parse(observed.reread) as { sessionId: string }).sessionId).toBe(recorded);
    // Reattach reads the sidecar and nothing else: no catalog, no runtime info.
    expect(after.modelCalls).toEqual([]);
    expect(after.runtimeCalls).toEqual([]);
  });
});

describe("JcodeInstanceManager cross-provider isolation", () => {
  it("narrows the launched instance so no process handle or sibling manager is reachable", async () => {
    const harness = makeHarness();
    // A raw process handle and a sibling provider's manager, hanging off the
    // object the SDK returns. A passthrough bridge would carry both into Jcode
    // teardown; the assertions below are what prove it does not.
    const sdk: JcodeSdkModule = {
      ...harness.sdk,
      launchInstance: async (options) => ({
        ...(await harness.sdk.launchInstance(options)),
        pid: 4242,
        kill: () => {},
        primeAgentManager: { shutdown: () => {}, kill: () => {} },
      }),
    };

    const observed = await runScoped(({ stateDir }) =>
      Effect.gen(function* () {
        const base = makeJcodeSdkBridge(sdk);
        // Captures the manager's *own* launched value rather than launching a
        // second instance to inspect, so the shutdown count below stays
        // unambiguous.
        let launched: unknown;
        const bridge: JcodeSdkBridge = {
          ...base,
          launchInstance: (options, secrets) =>
            base.launchInstance(options, secrets).pipe(
              Effect.tap((instance) =>
                Effect.sync(() => {
                  launched = instance;
                }),
              ),
            ),
        };
        const manager = yield* makeJcodeInstanceManager({
          bridge,
          instanceId: "instance-a",
          stateDir,
          settings: { binaryPath: "jcode", inheritLogins: true },
          environment: { PATH: "/usr/bin" },
          credentialValues: [SECRET],
          launchAliasBase: requireAliasBase(),
        });
        yield* manager.shutdown;
        return {
          surface: Object.keys(manager).toSorted(),
          launched: Object.keys(launched as object).toSorted(),
        };
      }),
    );

    // Exactly one instance was launched and exactly that instance was stopped.
    expect(harness.launches).toHaveLength(1);
    expect(harness.shutdowns).toBe(1);
    // The bridge is a narrowing boundary rather than a passthrough, so no pid,
    // no kill, and no sibling manager survives into anything Jcode can hold.
    expect(observed.launched).toEqual(["jcodeHome", "shutdown", "socketPath"]);
    expect(observed.surface).toEqual(["connectSessionClient", "probe", "shutdown"]);
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

/**
 * The durable home sits under the Pylon provider namespace, which on a real
 * installation is far longer than a Unix socket path may be. The daemon binds
 * `<home>/run/jcode-debug.sock`, so the launch home the SDK is handed has to be
 * bounded independently of how deep the state directory is.
 */
describe.skipIf(!POSIX)("JcodeInstanceManager launch home", () => {
  /** A state directory as deep as the real one, built inside the test temp dir. */
  const deepLeaf = NodePath.join(
    "a-fairly-long-directory-name",
    "another-long-directory-name",
    "userdata",
  );

  it("launches from a bounded alias while durable state stays in the provider namespace", async () => {
    const harness = makeHarness();
    const observed = await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const deepStateDir = path.join(stateDir, deepLeaf);
        yield* fs.makeDirectory(deepStateDir, { recursive: true });
        const aliasBase = path.join(stateDir, "alias");
        yield* makeManager({ harness, stateDir: deepStateDir, launchAliasBase: aliasBase });

        const launched = harness.launches[0]!.jcodeHome!;
        const durableHome = jcodeHomePath({ stateDir: deepStateDir, instanceId: "instance-a" });
        // Resolved inside the scope: the temp state directory is removed when
        // the scope closes, so a realpath afterwards would fail on ENOENT.
        return {
          launched,
          durableHome,
          resolved: yield* fs.realPath(launched),
          durableResolved: yield* fs.realPath(durableHome),
          durableExists: yield* fs.exists(durableHome),
        };
      }),
    );

    // The SDK is handed the alias, not the durable home.
    expect(observed.launched).not.toBe(observed.durableHome);
    // The longest socket the daemon binds fits the platform limit.
    expect(
      jcodeLongestRuntimeSocketPath({ launchHome: observed.launched }).length,
    ).toBeLessThanOrEqual(JCODE_MAX_UNIX_SOCKET_PATH);
    // The alias resolves to the durable home, so state is not duplicated.
    expect(observed.resolved).toBe(observed.durableResolved);
    expect(observed.durableExists).toBe(true);
    // Durable state still lives under the existing Pylon provider namespace.
    expect(observed.durableHome).toContain(NodePath.join("provider-sessions", "jcode"));
  });

  it("inherits credentials into the durable home and never through the alias", async () => {
    const harness = makeHarness();
    const observed = await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const deepStateDir = path.join(stateDir, deepLeaf);
        yield* fs.makeDirectory(deepStateDir, { recursive: true });
        yield* makeManager({
          harness,
          stateDir: deepStateDir,
          launchAliasBase: path.join(stateDir, "alias"),
        });
        return { durableHome: jcodeHomePath({ stateDir: deepStateDir, instanceId: "instance-a" }) };
      }),
    );

    // The real SDK refuses a symlink as an inheritance target, so Pylon must
    // inherit into the durable directory itself and then launch without asking
    // the SDK to repeat the work.
    expect(harness.inheritCalls).toEqual([
      { fromHome: USER_JCODE_HOME, toHome: observed.durableHome },
    ]);
    expect(harness.launches[0]!.inheritLogins).toBe(false);
    // Inheritance happens before the daemon starts, or the first turn has no
    // credentials to use.
    expect(harness.events.indexOf("inherit-credentials")).toBeLessThan(
      harness.events.indexOf("launch"),
    );
  });

  it("does not inherit credentials when the instance is configured not to", async () => {
    const harness = makeHarness();
    await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const deepStateDir = path.join(stateDir, deepLeaf);
        yield* fs.makeDirectory(deepStateDir, { recursive: true });
        yield* makeManager({
          harness,
          stateDir: deepStateDir,
          launchAliasBase: path.join(stateDir, "alias"),
          inheritLogins: false,
        });
      }),
    );

    expect(harness.inheritCalls).toEqual([]);
    expect(harness.launches[0]!.inheritLogins).toBe(false);
  });

  it("reuses one stable alias across restarts of the same instance", async () => {
    const first = makeHarness();
    const second = makeHarness();
    const observed = await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const deepStateDir = path.join(stateDir, deepLeaf);
        yield* fs.makeDirectory(deepStateDir, { recursive: true });
        const aliasBase = path.join(stateDir, "alias");
        yield* Scope.provide(
          Effect.gen(function* () {
            const manager = yield* makeManager({
              harness: first,
              stateDir: deepStateDir,
              launchAliasBase: aliasBase,
            });
            yield* manager.shutdown;
          }),
          yield* Scope.make(),
        );
        yield* makeManager({ harness: second, stateDir: deepStateDir, launchAliasBase: aliasBase });
        return { entries: yield* fs.readDirectory(aliasBase) };
      }),
    );

    expect(second.launches[0]!.jcodeHome).toBe(first.launches[0]!.jcodeHome);
    // One alias per instance, not one per launch.
    expect(observed.entries).toHaveLength(1);
  });

  it("repoints a stale alias that still targets a previous home", async () => {
    const harness = makeHarness();
    const observed = await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const deepStateDir = path.join(stateDir, deepLeaf);
        yield* fs.makeDirectory(deepStateDir, { recursive: true });
        const aliasBase = path.join(stateDir, "alias");
        const stolen = path.join(stateDir, "somewhere-else");
        yield* fs.makeDirectory(stolen, { recursive: true });
        // Owner-only, as the manager itself would have created it: a looser base
        // is refused rather than tightened.
        yield* fs.makeDirectory(aliasBase, { recursive: true, mode: 0o700 });
        // A leftover link from an older layout must not silently redirect this
        // instance at a home that is not its own.
        const alias = jcodeLaunchAliasPath({
          aliasBase,
          stateDir: deepStateDir,
          instanceId: "instance-a",
        });
        yield* fs.symlink(stolen, alias);

        yield* makeManager({ harness, stateDir: deepStateDir, launchAliasBase: aliasBase });
        const durableHome = jcodeHomePath({ stateDir: deepStateDir, instanceId: "instance-a" });
        return {
          resolved: yield* fs.realPath(harness.launches[0]!.jcodeHome!),
          durableResolved: yield* fs.realPath(durableHome),
          stolenResolved: yield* fs.realPath(stolen),
        };
      }),
    );

    expect(observed.resolved).not.toBe(observed.stolenResolved);
    expect(observed.resolved).toBe(observed.durableResolved);
  });

  it("refuses to launch when the alias name is occupied by a real directory", async () => {
    const harness = makeHarness();
    const error = await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const deepStateDir = path.join(stateDir, deepLeaf);
        yield* fs.makeDirectory(deepStateDir, { recursive: true });
        const aliasBase = path.join(stateDir, "alias");
        const alias = jcodeLaunchAliasPath({
          aliasBase,
          stateDir: deepStateDir,
          instanceId: "instance-a",
        });
        // Not a link this manager made. Replacing it could destroy somebody
        // else's data, so the launch fails closed instead.
        yield* fs.makeDirectory(alias, { recursive: true });
        return yield* Effect.flip(
          makeManager({ harness, stateDir: deepStateDir, launchAliasBase: aliasBase }),
        );
      }),
    );

    expect(error._tag).toBe("JcodeInstanceManagerError");
    expect(error.operation).toBe("launch");
    expect(harness.launches).toHaveLength(0);
    // A native path would name the user's machine in a remote-visible error.
    expect(error.detail).not.toContain("/");
  });

  it("refuses a symlinked alias base instead of hardening whatever it points at", async () => {
    const harness = makeHarness();
    const observed = await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const deepStateDir = path.join(stateDir, deepLeaf);
        yield* fs.makeDirectory(deepStateDir, { recursive: true });
        // The production alias base sits under a world-writable `/tmp`, so
        // another account can plant that name first. A pre-planted link must be
        // refused rather than followed, and nothing may be written through it.
        // This covers the planted case; the manager additionally never rewrites
        // a base it did not just create, so a link raced in mid-flight can only
        // make the launch fail.
        const victim = path.join(stateDir, "someone-elses-directory");
        yield* fs.makeDirectory(victim, { recursive: true, mode: 0o755 });
        const aliasBase = path.join(stateDir, "planted-base");
        yield* fs.symlink(victim, aliasBase);

        const error = yield* Effect.flip(
          makeManager({ harness, stateDir: deepStateDir, launchAliasBase: aliasBase }),
        );
        return { error, mode: (yield* fs.stat(victim)).mode };
      }),
    );

    expect(observed.error._tag).toBe("JcodeInstanceManagerError");
    expect(observed.error.operation).toBe("launch");
    expect(harness.launches).toHaveLength(0);
    expect(observed.error.detail).not.toContain("/");
    // The planted target keeps the permissions it had.
    expect(observed.mode & 0o777).toBe(0o755);
  });

  it("refuses a pre-existing alias base that is not owner-only rather than hardening it", async () => {
    const harness = makeHarness();
    const observed = await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const deepStateDir = path.join(stateDir, deepLeaf);
        yield* fs.makeDirectory(deepStateDir, { recursive: true });
        // A base that already exists with a loose mode is a directory Pylon did
        // not create. Tightening it would be acting on someone else's
        // directory, and the check-then-act window between deciding it is safe
        // and changing it is exactly where a raced symlink would land. Refusing
        // is strictly safer, and it keeps the race able to cause only a launch
        // failure.
        const aliasBase = path.join(stateDir, "loose-base");
        yield* fs.makeDirectory(aliasBase, { recursive: true, mode: 0o777 });
        // Read back rather than assumed: umask trims the requested mode, and
        // what matters is that Pylon leaves it exactly as it found it.
        const modeBefore = (yield* fs.stat(aliasBase)).mode & 0o777;

        const error = yield* Effect.flip(
          makeManager({ harness, stateDir: deepStateDir, launchAliasBase: aliasBase }),
        );
        return {
          error,
          modeBefore,
          modeAfter: (yield* fs.stat(aliasBase)).mode & 0o777,
          entries: yield* fs.readDirectory(aliasBase),
        };
      }),
    );

    expect(observed.error._tag).toBe("JcodeInstanceManagerError");
    expect(observed.error.operation).toBe("launch");
    expect(harness.launches).toHaveLength(0);
    expect(observed.error.detail).not.toContain("/");
    // Left exactly as found: not tightened, and no alias written into it.
    expect(observed.modeAfter).toBe(observed.modeBefore);
    expect(observed.modeAfter).not.toBe(0o700);
    expect(observed.entries).toEqual([]);
  });
});

describe("JcodeInstanceManager launch home on Windows", () => {
  it("launches from the durable home without needing a symlink", async () => {
    const harness = makeHarness();
    const observed = await runScoped(({ fs, path, stateDir }) =>
      Effect.gen(function* () {
        const deepStateDir = path.join(stateDir, "a-long-directory-name", "userdata");
        yield* fs.makeDirectory(deepStateDir, { recursive: true });
        yield* makeManager({
          harness,
          stateDir: deepStateDir,
          // Present but unused: Windows must not depend on it.
          launchAliasBase: path.join(stateDir, "alias"),
        }).pipe(Effect.provideService(HostProcessPlatform, "win32"));
        return {
          durableHome: jcodeHomePath({ stateDir: deepStateDir, instanceId: "instance-a" }),
          aliasBaseExists: yield* fs.exists(path.join(stateDir, "alias")),
        };
      }),
    );

    // No alias, no symlink, and therefore no privileged Windows operation.
    expect(harness.launches[0]!.jcodeHome).toBe(observed.durableHome);
    expect(observed.aliasBaseExists).toBe(false);
    // Windows keeps the SDK's own inheritance, which needs no link there.
    expect(harness.launches[0]!.inheritLogins).toBe(true);
    expect(harness.inheritCalls).toEqual([]);
  });
});
