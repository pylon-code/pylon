/**
 * Multi-instance validation slices for `ProviderInstanceRegistryLive`.
 *
 * Two axes of the driver/registry refactor are exercised here:
 *
 *  1. **Same driver, many instances** — the "multi-instance codex slice"
 *     describe block below configures two independent `codex` instances and
 *     asserts each gets its own closures and identity. This is the
 *     multi-codex capability the refactor exists to unlock.
 *
 *  2. **Many drivers, one registry** — the "all drivers slice" describe
 *     block below configures one instance of every shipped driver
 *     (`codex`, `claudeAgent`, `cursor`, `grok`, `opencode`) in a single
 *     `ProviderInstanceConfigMap` and asserts the registry boots them all
 *     without cross-contamination. This proves the driver SPI is uniform
 *     across every provider — any driver plugs into the registry through
 *     the same `ProviderDriver` value contract.
 *
 *  3. **Same driver, many *private daemons*** — the "multi-instance jcode
 *     slice" describe block configures two *enabled* `jcode` instances, each
 *     backed by its own fake SDK module behind the real
 *     `makeJcodeInstanceManager`. Unlike the slices below it, this one has to
 *     run enabled: a private-daemon provider only has a home, a socket, a
 *     control client, and a catalog once its instance is actually up, and those
 *     are exactly the things that must not be shared between instances.
 *
 * Every instance in the codex and all-drivers slices is configured with
 * `enabled: false` so the
 * provider-status checks short-circuit to pending/disabled snapshots
 * without trying to spawn real `codex` / `claude` / `agent` / `grok` / `opencode`
 * binaries. That keeps the assertions focused on registry routing
 * behaviour rather than the runtime details of each provider.
 */
import type { LaunchOptions, RuntimeInfo, SessionInfo } from "@1jehuang/jcode-sdk";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ClaudeSettings,
  type CodexSettings,
  type CursorSettings,
  type GrokSettings,
  type JcodeSettings,
  type OpenCodeSettings,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ClaudeDriver } from "../Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../Drivers/CodexDriver.ts";
import { CursorDriver } from "../Drivers/CursorDriver.ts";
import { GrokDriver } from "../Drivers/GrokDriver.ts";
import { makeJcodeDriver } from "../Drivers/JcodeDriver.ts";
import { OpenCodeDriver } from "../Drivers/OpenCodeDriver.ts";
import { makeJcodeInstanceManager } from "../jcode/JcodeInstanceManager.ts";
import { jcodeHomePath } from "../jcode/JcodePaths.ts";
import { makeJcodeSdkBridge, type JcodeSdkClientLike } from "../jcode/JcodeSdkBridge.ts";
import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  enabled: false,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
  ...overrides,
});

const makeCursorConfig = (overrides: Partial<CursorSettings>): CursorSettings => ({
  enabled: false,
  binaryPath: "cursor-agent",
  apiEndpoint: "",
  customModels: [],
  ...overrides,
});

const makeGrokConfig = (overrides: Partial<GrokSettings>): GrokSettings => ({
  enabled: false,
  binaryPath: "grok",
  customModels: [],
  ...overrides,
});

const makeOpenCodeConfig = (overrides: Partial<OpenCodeSettings>): OpenCodeSettings => ({
  enabled: false,
  binaryPath: "opencode",
  serverUrl: "",
  serverPassword: "",
  customModels: [],
  ...overrides,
});

const makeJcodeConfig = (overrides: Partial<JcodeSettings>): JcodeSettings => ({
  enabled: true,
  binaryPath: "jcode",
  inheritLogins: true,
  ...overrides,
});

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Records every spawn so each instance's executable probe stays attributable.
 *
 * The count is deliberately not asserted: `makeManagedServerProvider` may
 * re-check a provider whenever settings or background policy say it should, so
 * a fixed spawn count would be a scheduling assertion rather than an isolation
 * one. What must hold per instance is *which binary* was probed.
 */
const jcodeSpawnerLayer = (calls: Array<SpawnCall>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      calls.push({ command: childProcess.command, args: childProcess.args });
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode("jcode v0.73.0\n")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

/**
 * One fake Jcode daemon per provider instance.
 *
 * Only the SDK module is faked: each instance still runs the real
 * `makeJcodeInstanceManager`, so its private home, its control connection, its
 * hidden probe session, and its server-reported catalog are all production code
 * paths observable per instance.
 */
function makeJcodeDaemonDouble(input: { readonly socketPath: string; readonly model: string }) {
  const launches: LaunchOptions[] = [];
  const connects: Array<{ readonly socketPath: string; readonly clientName: string }> = [];
  const clients: JcodeSdkClientLike[] = [];
  /** Durable homes this instance was asked to share the user's logins with. */
  const inherits: string[] = [];
  const state = { shutdowns: 0 };

  const sessionInfo = (sessionId: string): SessionInfo => ({
    session_id: sessionId,
    status: "idle",
  });
  const runtimeInfo = (sessionId: string): RuntimeInfo => ({
    server: "jcode-harness-api-bridge/0.1.0",
    protocolVersion: 1,
    capabilities: ["sessions", "models"],
    healthy: true,
    sessionId,
    model: input.model,
    providers: ["anthropic"],
    routes: [
      {
        model: input.model,
        provider: "anthropic",
        api_method: "messages",
        available: true,
        detail: "",
      },
    ],
  });

  const sdk = {
    launchInstance: async (options: LaunchOptions) => {
      launches.push(options);
      return {
        socketPath: input.socketPath,
        jcodeHome: options.jcodeHome ?? input.socketPath,
        shutdown: async () => {
          state.shutdowns += 1;
        },
      };
    },
    userJcodeHome: () => "/Users/someone/.jcode",
    inheritCredentials: (_fromHome: string, toHome: string) => {
      inherits.push(toHome);
      return ["auth.json"];
    },
    connect: async (options: { readonly socketPath: string; readonly clientName: string }) => {
      connects.push(options);
      const client: JcodeSdkClientLike = {
        server: "jcode-harness-api-bridge/0.1.0",
        capabilities: ["sessions", "models"],
        supports: () => true,
        createSession: async () => sessionInfo(`probe-session-${clients.length + 1}`),
        attachSession: async (sessionId) => sessionInfo(sessionId),
        detachSession: async () => {},
        listSessions: async () => [],
        listModels: async () => ({ models: [input.model], current: input.model }),
        getRuntimeInfo: async (sessionId) => runtimeInfo(sessionId),
        setModel: async () => {},
        setReasoningEffort: async () => {},
        sendMessage: async () => {},
        cancel: async () => {},
        getHistory: async () => [],
        // eslint-disable-next-line require-yield
        events: async function* () {},
        close: async () => {},
      };
      clients.push(client);
      return client;
    },
  };

  return {
    sdk,
    launches,
    connects,
    clients,
    inherits,
    socketPath: input.socketPath,
    shutdowns: () => state.shutdowns,
  };
}

describe("ProviderInstanceRegistryLive — multi-instance jcode slice", () => {
  const testLayer = (calls: Array<SpawnCall>) =>
    Layer.mergeAll(
      NodeServices.layer,
      jcodeSpawnerLayer(calls),
      BackgroundPolicyAlwaysRunLayer,
      ServerSettingsService.layerTest(),
      TestHttpClientLive,
      Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
      ServerConfig.layerTest(process.cwd(), {
        prefix: "provider-instance-registry-jcode-test",
      }).pipe(Layer.provide(NodeServices.layer)),
    );

  const PERSONAL_SECRET = "sk-jcode-personal-9999";
  const WORK_SECRET = "sk-jcode-work-1111";

  it.live("gives two private Jcode instances their own daemon, home, and catalog", () => {
    const calls: Array<SpawnCall> = [];
    const personalId = ProviderInstanceId.make("jcode_personal");
    const workId = ProviderInstanceId.make("jcode_work");
    const jcodeDriverKind = ProviderDriverKind.make("jcode");
    const daemons = new Map([
      [
        String(personalId),
        makeJcodeDaemonDouble({
          socketPath: "/tmp/jcode-personal/api.sock",
          model: "claude-opus-5",
        }),
      ],
      [
        String(workId),
        makeJcodeDaemonDouble({ socketPath: "/tmp/jcode-work/api.sock", model: "gpt-5.5-work" }),
      ],
    ]);
    const personal = daemons.get(String(personalId))!;
    const work = daemons.get(String(workId))!;

    const personalEntry = {
      driver: jcodeDriverKind,
      displayName: "Jcode (personal)",
      enabled: true,
      environment: [{ name: "PYLON_TEST_PERSONAL_KEY", value: PERSONAL_SECRET, sensitive: true }],
      config: makeJcodeConfig({
        binaryPath: "/opt/jcode-personal/bin/jcode",
        inheritLogins: true,
      }),
    };
    const workEntry = {
      driver: jcodeDriverKind,
      displayName: "Jcode (work)",
      enabled: true,
      environment: [{ name: "PYLON_TEST_WORK_KEY", value: WORK_SECRET, sensitive: true }],
      config: makeJcodeConfig({
        binaryPath: "/opt/jcode-work/bin/jcode",
        inheritLogins: false,
      }),
    };
    const configMap: ProviderInstanceConfigMap = {
      [personalId]: personalEntry,
      [workId]: workEntry,
    };

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfig;
      const homes = {
        personal: jcodeHomePath({ stateDir: serverConfig.stateDir, instanceId: personalId }),
        work: jcodeHomePath({ stateDir: serverConfig.stateDir, instanceId: workId }),
      };

      yield* Effect.scoped(
        Effect.gen(function* () {
          // Short like the production default and unique per run, so the bounded
          // launch alias is exercised without two runs sharing machine state.
          // Rooting it under the deep test state directory would trip the very
          // socket-length guard this fix adds. Acquired inside the scope so it
          // is removed even if the body throws before the registry is built.
          const aliasBase = yield* fs.makeTempDirectoryScoped({
            directory: "/tmp",
            prefix: "pj-",
          });
          // The real instance manager, pointed at this instance's own fake daemon.
          const driver = makeJcodeDriver({
            makeInstanceManager: (managerInput) =>
              makeJcodeInstanceManager({
                ...managerInput,
                bridge: makeJcodeSdkBridge(daemons.get(String(managerInput.instanceId))!.sdk),
                launchAliasBase: aliasBase,
              }),
          });
          const { registry, mutator } = yield* makeProviderInstanceRegistry({
            drivers: [driver],
            configMap,
          });

          const instances = yield* registry.listInstances;
          expect(instances).toHaveLength(2);
          expect(yield* registry.listUnavailable).toEqual([]);

          // One private daemon per instance, each under its own JCODE_HOME.
          expect(personal.launches).toHaveLength(1);
          expect(work.launches).toHaveLength(1);
          expect(homes.personal).not.toBe(homes.work);
          // Each instance launches from its own bounded alias, and each alias
          // resolves to that instance's own durable home, so the daemons stay
          // separate whether or not the launch path is the durable one.
          expect(personal.launches[0]!.jcodeHome).not.toBe(work.launches[0]!.jcodeHome);
          expect(yield* fs.realPath(personal.launches[0]!.jcodeHome!)).toBe(
            yield* fs.realPath(homes.personal),
          );
          expect(yield* fs.realPath(work.launches[0]!.jcodeHome!)).toBe(
            yield* fs.realPath(homes.work),
          );
          expect(yield* fs.exists(homes.personal)).toBe(true);
          expect(yield* fs.exists(homes.work)).toBe(true);

          // Each instance's configured binary and credential mode reach its own
          // launch, and neither launch carries the other's secret.
          expect(personal.launches[0]!.binary).toBe("/opt/jcode-personal/bin/jcode");
          expect(work.launches[0]!.binary).toBe("/opt/jcode-work/bin/jcode");
          // On Unix the SDK is never asked to inherit: the launch home is a
          // link and the SDK refuses one. The configured credential mode shows
          // up as an explicit inheritance into the durable home instead, so
          // "personal shares logins, work does not" still holds per instance.
          expect(personal.launches[0]!.inheritLogins).toBe(false);
          expect(work.launches[0]!.inheritLogins).toBe(false);
          expect(personal.inherits).toEqual([homes.personal]);
          expect(work.inherits).toEqual([]);
          const personalEnv = Object.values(personal.launches[0]!.env ?? {});
          const workEnv = Object.values(work.launches[0]!.env ?? {});
          expect(personalEnv).toContain(PERSONAL_SECRET);
          expect(personalEnv).not.toContain(WORK_SECRET);
          expect(workEnv).toContain(WORK_SECRET);
          expect(workEnv).not.toContain(PERSONAL_SECRET);

          // One control client each, on its own private socket, and never the
          // sibling's.
          expect(personal.socketPath).not.toBe(work.socketPath);
          expect(personal.connects).toEqual([
            { socketPath: personal.socketPath, clientName: "pylon-jcode-control/1" },
          ]);
          expect(work.connects).toEqual([
            { socketPath: work.socketPath, clientName: "pylon-jcode-control/1" },
          ]);
          expect(personal.clients[0]).not.toBe(work.clients[0]);

          // Server-reported catalogs stay per instance.
          const personalInstance = yield* registry.getInstance(personalId);
          const workInstance = yield* registry.getInstance(workId);
          expect(personalInstance!.adapter).not.toBe(workInstance!.adapter);
          expect(personalInstance!.snapshot).not.toBe(workInstance!.snapshot);
          const personalSnapshot = yield* personalInstance!.snapshot.getSnapshot;
          const workSnapshot = yield* workInstance!.snapshot.getSnapshot;
          expect(personalSnapshot.instanceId).toBe(personalId);
          expect(personalSnapshot.driver).toBe(jcodeDriverKind);
          expect(personalSnapshot.status).toBe("ready");
          expect(personalSnapshot.models.map((model) => model.slug)).toEqual(["claude-opus-5"]);
          expect(workSnapshot.models.map((model) => model.slug)).toEqual(["gpt-5.5-work"]);
          // @effect-diagnostics-next-line preferSchemaOverJson:off - cross-instance leak assertion.
          expect(JSON.stringify(workSnapshot)).not.toContain("claude-opus-5");
          // Each instance probed its own configured executable, and the probe
          // is always exactly `--version`.
          expect(calls.every((call) => call.args.length === 1)).toBe(true);
          expect(new Set(calls.flatMap((call) => call.args))).toEqual(new Set(["--version"]));
          expect(new Set(calls.map((call) => call.command))).toEqual(
            new Set(["/opt/jcode-personal/bin/jcode", "/opt/jcode-work/bin/jcode"]),
          );

          // Removing one instance closes only that instance's scope: its daemon
          // stops, and the survivor keeps serving from its own.
          yield* mutator.reconcile({ [workId]: workEntry });
          expect(personal.shutdowns()).toBe(1);
          expect(work.shutdowns()).toBe(0);
          expect(yield* registry.getInstance(personalId)).toBeUndefined();
          const survivor = yield* registry.getInstance(workId);
          expect(survivor).toBeDefined();
          const refreshed = yield* survivor!.snapshot.refresh;
          expect(refreshed.models.map((model) => model.slug)).toEqual(["gpt-5.5-work"]);
          // The survivor was never rebuilt, so it never launched a second daemon.
          expect(work.launches).toHaveLength(1);
        }),
      );

      // The registry scope owns every surviving instance scope.
      expect(work.shutdowns()).toBe(1);
      expect(personal.shutdowns()).toBe(1);
    }).pipe(Effect.provide(testLayer(calls)));
  });
});

describe("ProviderInstanceRegistryLive — multi-instance codex slice", () => {
  // `ServerConfig.layerTest` needs `FileSystem` to materialize its scratch
  // directory. `Layer.merge` just unions requirements, so we have to push
  // `NodeServices.layer` through `Layer.provideMerge` to satisfy that
  // dependency while still surfacing NodeServices to the test body (the
  // codex driver's `create` yields `ChildProcessSpawner` directly).
  const testLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-test",
  }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  );

  it.live("boots two independent codex instances from a ProviderInstanceConfigMap", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const workId = ProviderInstanceId.make("codex_work");
      const codexDriverKind = ProviderDriverKind.make("codex");

      const configMap: ProviderInstanceConfigMap = {
        [personalId]: {
          driver: codexDriverKind,
          displayName: "Codex (personal)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-personal/bin/codex",
            homePath: "/home/julius/.codex_personal",
            customModels: ["personal-preview"],
          }),
        },
        [workId]: {
          driver: codexDriverKind,
          displayName: "Codex (work)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-work/bin/codex",
            homePath: "/home/julius/.codex",
            customModels: ["work-preview"],
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
      });

      const instances = yield* registry.listInstances;
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [personalId, workId].toSorted(),
      );
      expect(instances.every((instance) => instance.driverKind === codexDriverKind)).toBe(true);
      expect(instances.map((instance) => instance.displayName).toSorted()).toEqual(
        ["Codex (personal)", "Codex (work)"].toSorted(),
      );

      // Each instance must be retrievable by id and carry its *own* closures.
      const personal = yield* registry.getInstance(personalId);
      const work = yield* registry.getInstance(workId);
      expect(personal).toBeDefined();
      expect(work).toBeDefined();
      expect(personal!.adapter).not.toBe(work!.adapter);
      expect(personal!.textGeneration).not.toBe(work!.textGeneration);
      expect(personal!.snapshot).not.toBe(work!.snapshot);

      // Snapshots identify themselves by instanceId + driver — this is
      // what makes per-instance routing distinguishable downstream.
      const personalSnapshot = yield* personal!.snapshot.getSnapshot;
      expect(personalSnapshot.instanceId).toBe(personalId);
      expect(personalSnapshot.driver).toBe(codexDriverKind);
      expect(personalSnapshot.enabled).toBe(false);
      expect(personalSnapshot.continuation?.groupKey).toBe(
        "codex:home:/home/julius/.codex_personal",
      );

      const workSnapshot = yield* work!.snapshot.getSnapshot;
      expect(workSnapshot.instanceId).toBe(workId);
      expect(workSnapshot.driver).toBe(codexDriverKind);
      expect(workSnapshot.enabled).toBe(false);
      expect(workSnapshot.continuation?.groupKey).toBe("codex:home:/home/julius/.codex");

      // Nothing goes to the unavailable bucket — both drivers are registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "shadows instances whose driver is not registered in this build without failing boot",
    () =>
      Effect.gen(function* () {
        const codexId = ProviderInstanceId.make("codex_main");
        const ghostId = ProviderInstanceId.make("ghost_main");

        const configMap: ProviderInstanceConfigMap = {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: makeCodexConfig({}),
          },
          [ghostId]: {
            driver: ProviderDriverKind.make("ghostDriver"),
            displayName: "A fork-only driver we don't ship",
            enabled: false,
            config: { arbitrary: "payload", preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [CodexDriver],
          configMap,
        });

        const instances = yield* registry.listInstances;
        expect(instances).toHaveLength(1);
        expect(instances[0]!.instanceId).toBe(codexId);

        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        const ghost = unavailable[0]!;
        expect(ghost.instanceId).toBe(ghostId);
        expect(ghost.driver).toBe("ghostDriver");
        expect(ghost.availability).toBe("unavailable");
        expect(ghost.unavailableReason).toMatch(/ghostDriver/);
      }).pipe(Effect.provide(testLayer)),
  );
});

describe("ProviderInstanceRegistryLive — all drivers slice", () => {
  // All drivers need `NodeServices` (ChildProcessSpawner + FileSystem +
  // Path). `OpenCodeDriver.create` additionally yields `OpenCodeRuntime`
  // at construction time, so we wire `OpenCodeRuntimeLive` into the stack.
  // `OpenCodeRuntimeLive` bundles its own `NetService.layer` via
  // `Layer.provide`, so the only external requirement it still exposes is
  // `ChildProcessSpawner` — resolved here by piping it through
  // `provideMerge(NodeServices.layer)`.
  //
  // The nested `provideMerge`s read bottom-up: `NodeServices.layer`
  // provides `OpenCodeRuntimeLive`'s deps while keeping its own outputs
  // surfaced; that merged layer then provides `ServerConfig.layerTest`'s
  // `FileSystem` dep while keeping everything else surfaced to the test.
  const infraLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));
  const testLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-all-drivers-test",
  }).pipe(
    Layer.provideMerge(infraLayer),
    Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  );

  it.live("boots one instance of every shipped driver from a single config map", () =>
    Effect.gen(function* () {
      const codexId = ProviderInstanceId.make("codex_default");
      const claudeId = ProviderInstanceId.make("claude_default");
      const cursorId = ProviderInstanceId.make("cursor_default");
      const grokId = ProviderInstanceId.make("grok_default");
      const openCodeId = ProviderInstanceId.make("opencode_default");

      const codexDriverKind = ProviderDriverKind.make("codex");
      const claudeDriverKind = ProviderDriverKind.make("claudeAgent");
      const cursorDriverKind = ProviderDriverKind.make("cursor");
      const grokDriverKind = ProviderDriverKind.make("grok");
      const openCodeDriverKind = ProviderDriverKind.make("opencode");

      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: codexDriverKind,
          displayName: "Codex",
          enabled: false,
          config: makeCodexConfig({ homePath: "/home/julius/.codex" }),
        },
        [claudeId]: {
          driver: claudeDriverKind,
          displayName: "Claude",
          enabled: false,
          config: makeClaudeConfig({
            homePath: "/home/julius/.claude-work",
            launchArgs: "--verbose",
          }),
        },
        [cursorId]: {
          driver: cursorDriverKind,
          displayName: "Cursor",
          enabled: false,
          config: makeCursorConfig({}),
        },
        [grokId]: {
          driver: grokDriverKind,
          displayName: "Grok",
          enabled: false,
          config: makeGrokConfig({}),
        },
        [openCodeId]: {
          driver: openCodeDriverKind,
          displayName: "OpenCode",
          enabled: false,
          config: makeOpenCodeConfig({}),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver, ClaudeDriver, CursorDriver, GrokDriver, OpenCodeDriver],
        configMap,
      });

      // Every configured instance must materialize — none downgraded to a
      // shadow snapshot, because every driver in the map is registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);

      const instances = yield* registry.listInstances;
      expect(instances).toHaveLength(5);
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [codexId, claudeId, cursorId, grokId, openCodeId].toSorted(),
      );

      // Instance lookup by id resolves each instance to its own bundle —
      // this is how rest-of-server routes turn/session calls in the new
      // model. Each driver's bundle carries its advertised `driverKind`.
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      const cursor = yield* registry.getInstance(cursorId);
      const grok = yield* registry.getInstance(grokId);
      const openCode = yield* registry.getInstance(openCodeId);
      expect(codex?.driverKind).toBe(codexDriverKind);
      expect(claude?.driverKind).toBe(claudeDriverKind);
      expect(cursor?.driverKind).toBe(cursorDriverKind);
      expect(grok?.driverKind).toBe(grokDriverKind);
      expect(openCode?.driverKind).toBe(openCodeDriverKind);
      expect(codex?.displayName).toBe("Codex");
      expect(claude?.displayName).toBe("Claude");
      expect(cursor?.displayName).toBe("Cursor");
      expect(grok?.displayName).toBe("Grok");
      expect(openCode?.displayName).toBe("OpenCode");

      // Every instance owns its own set of closures — no sharing across
      // drivers. `adapter` / `textGeneration` / `snapshot` are all
      // distinct references even when two instances happen to share a
      // trait (e.g. Cursor + others all use a stub-or-real
      // `textGeneration`; they must still be different object values).
      const adapters = [
        codex!.adapter,
        claude!.adapter,
        cursor!.adapter,
        grok!.adapter,
        openCode!.adapter,
      ];
      expect(new Set(adapters).size).toBe(adapters.length);
      const textGenerations = [
        codex!.textGeneration,
        claude!.textGeneration,
        cursor!.textGeneration,
        grok!.textGeneration,
        openCode!.textGeneration,
      ];
      expect(new Set(textGenerations).size).toBe(textGenerations.length);
      const snapshots = [
        codex!.snapshot,
        claude!.snapshot,
        cursor!.snapshot,
        grok!.snapshot,
        openCode!.snapshot,
      ];
      expect(new Set(snapshots).size).toBe(snapshots.length);

      // Snapshots identify themselves by `instanceId` + `driver` so
      // downstream aggregation in `ProviderRegistry` can tell instances
      // apart even when two share a driver. With `enabled: false`, the
      // check short-circuits and we get a disabled/pending snapshot back
      // — that's enough signal to validate the stamping wrapper without
      // spawning real binaries.
      const codexSnapshot = yield* codex!.snapshot.getSnapshot;
      expect(codexSnapshot.instanceId).toBe(codexId);
      expect(codexSnapshot.driver).toBe(codexDriverKind);
      expect(codexSnapshot.enabled).toBe(false);
      expect(codexSnapshot.continuation?.groupKey).toBe("codex:home:/home/julius/.codex");

      const claudeSnapshot = yield* claude!.snapshot.getSnapshot;
      expect(claudeSnapshot.instanceId).toBe(claudeId);
      expect(claudeSnapshot.driver).toBe(claudeDriverKind);
      expect(claudeSnapshot.enabled).toBe(false);
      expect(claudeSnapshot.continuation?.groupKey).toBe("claude:home:/home/julius/.claude-work");

      const cursorSnapshot = yield* cursor!.snapshot.getSnapshot;
      expect(cursorSnapshot.instanceId).toBe(cursorId);
      expect(cursorSnapshot.driver).toBe(cursorDriverKind);
      expect(cursorSnapshot.enabled).toBe(false);
      expect(cursorSnapshot.continuation?.groupKey).toBe(
        `${cursorDriverKind}:instance:${cursorId}`,
      );

      const grokSnapshot = yield* grok!.snapshot.getSnapshot;
      expect(grokSnapshot.instanceId).toBe(grokId);
      expect(grokSnapshot.driver).toBe(grokDriverKind);
      expect(grokSnapshot.enabled).toBe(false);
      expect(grokSnapshot.continuation?.groupKey).toBe(`${grokDriverKind}:instance:${grokId}`);

      const openCodeSnapshot = yield* openCode!.snapshot.getSnapshot;
      expect(openCodeSnapshot.instanceId).toBe(openCodeId);
      expect(openCodeSnapshot.driver).toBe(openCodeDriverKind);
      expect(openCodeSnapshot.enabled).toBe(false);
      expect(openCodeSnapshot.continuation?.groupKey).toBe(
        `${openCodeDriverKind}:instance:${openCodeId}`,
      );
    }).pipe(Effect.provide(testLayer)),
  );
});
