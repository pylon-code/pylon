import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfigModule from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import {
  JcodeInstanceManagerError,
  type JcodeInstanceManager,
} from "../jcode/JcodeInstanceManager.ts";
import { jcodeSdkBridge } from "../jcode/JcodeSdkBridge.ts";
import {
  JcodeDriver,
  buildJcodeInstanceManagerInput,
  jcodeCredentialValuesFromEnvironment,
  makeJcodeDriver,
} from "./JcodeDriver.ts";

const INSTANCE_ID = ProviderInstanceId.make("jcode_local");
const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const encoder = new TextEncoder();

/** Counts every spawn so the "exactly one `--version` probe" claim is testable. */
function makeSpawnerLayer(calls: Array<ReadonlyArray<string>>) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as { readonly args: ReadonlyArray<string> };
      calls.push(childProcess.args);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode("jcode v0.73.0\n")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
}

const BackgroundPolicyLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
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
    shouldRunOpportunisticWork: false,
    updatedAt: TEST_EPOCH,
  }),
});

const driverLayer = (calls: Array<ReadonlyArray<string>>) =>
  Layer.mergeAll(
    NodeServices.layer,
    makeSpawnerLayer(calls),
    BackgroundPolicyLayer,
    ServerSettingsService.layerTest(),
    ServerConfigModule.layerTest(process.cwd(), { prefix: "jcode-driver-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );

const createInput = (overrides: { readonly enabled?: boolean } = {}) => ({
  instanceId: INSTANCE_ID,
  displayName: undefined,
  environment: [] as unknown as ProviderInstanceEnvironment,
  enabled: overrides.enabled ?? true,
  config: JcodeDriver.defaultConfig(),
});

describe("JcodeDriver", () => {
  it("registers one Jcode driver with contract defaults", () => {
    expect(JcodeDriver.driverKind).toBe("jcode");
    expect(JcodeDriver.metadata).toEqual({
      displayName: "Jcode",
      supportsMultipleInstances: true,
    });
    expect(JcodeDriver.defaultConfig()).toEqual({
      enabled: true,
      binaryPath: "jcode",
      inheritLogins: true,
    });
    expect(BUILT_IN_DRIVERS.filter((driver) => driver.driverKind === "jcode")).toEqual([
      JcodeDriver,
    ]);
  });
});

describe("jcodeCredentialValuesFromEnvironment", () => {
  it("derives every sensitive value so redaction cannot miss one", () => {
    const environment: ProviderInstanceEnvironment = [
      { name: "ANTHROPIC_API_KEY", value: "sk-ant-secret", sensitive: true },
      { name: "OPENAI_API_KEY", value: "sk-openai-secret", sensitive: true },
      { name: "PATH", value: "/usr/bin", sensitive: false },
    ];

    expect(jcodeCredentialValuesFromEnvironment(environment)).toEqual([
      "sk-ant-secret",
      "sk-openai-secret",
    ]);
  });

  it("ignores non-sensitive entries even when they look like secrets", () => {
    expect(
      jcodeCredentialValuesFromEnvironment([
        { name: "LOOKS_LIKE_A_KEY", value: "sk-not-marked-sensitive", sensitive: false },
      ]),
    ).toEqual([]);
  });

  it("drops empty and whitespace-only sensitive values", () => {
    // Literal redaction of "" or " " would shred unrelated text out of every
    // later bridge error message.
    expect(
      jcodeCredentialValuesFromEnvironment([
        { name: "EMPTY", value: "", sensitive: true },
        { name: "BLANK", value: "   ", sensitive: true },
        { name: "REAL", value: "sk-real", sensitive: true },
      ]),
    ).toEqual(["sk-real"]);
  });

  it("de-duplicates a value shared by two sensitive names", () => {
    expect(
      jcodeCredentialValuesFromEnvironment([
        { name: "PRIMARY", value: "sk-same", sensitive: true },
        { name: "MIRROR", value: "sk-same", sensitive: true },
      ]),
    ).toEqual(["sk-same"]);
  });

  it("returns nothing for an absent environment", () => {
    expect(jcodeCredentialValuesFromEnvironment(undefined)).toEqual([]);
    expect(jcodeCredentialValuesFromEnvironment([])).toEqual([]);
  });
});

describe("buildJcodeInstanceManagerInput", () => {
  const base = {
    instanceId: INSTANCE_ID,
    stateDir: "/tmp/pylon-state",
    settings: { binaryPath: "jcode", inheritLogins: true },
    environment: [
      { name: "ANTHROPIC_API_KEY", value: "sk-ant-secret", sensitive: true },
      { name: "PATH", value: "/usr/bin", sensitive: false },
    ] satisfies ProviderInstanceEnvironment,
    processEnv: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-secret" },
  } as const;

  it("builds one bridge per provider instance, never the module singleton", () => {
    const first = buildJcodeInstanceManagerInput(base);
    const second = buildJcodeInstanceManagerInput(base);

    // The bridge retains launch credential literals for its whole life, so a
    // shared one would cross-contaminate secrets between provider instances.
    expect(first.bridge).not.toBe(second.bridge);
    expect(first.bridge).not.toBe(jcodeSdkBridge);
    expect(second.bridge).not.toBe(jcodeSdkBridge);
  });

  it("carries the derived credential values and instance identity through", () => {
    const input = buildJcodeInstanceManagerInput(base);

    expect(input.instanceId).toBe(INSTANCE_ID);
    expect(input.stateDir).toBe("/tmp/pylon-state");
    expect(input.settings).toEqual({ binaryPath: "jcode", inheritLogins: true });
    expect(input.credentialValues).toEqual(["sk-ant-secret"]);
    expect(input.environment).toEqual(base.processEnv);
  });
});

describe("JcodeDriver.create", () => {
  it.effect("never launches a private instance for a disabled provider", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      let launches = 0;
      const driver = makeJcodeDriver({
        makeInstanceManager: () =>
          Effect.sync(() => {
            launches += 1;
          }).pipe(Effect.as({} as JcodeInstanceManager)),
      });

      const instance = yield* Effect.scoped(driver.create(createInput({ enabled: false }))).pipe(
        Effect.provide(driverLayer(calls)),
      );

      expect(launches).toBe(0);
      expect(calls).toEqual([]);
      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot.status).toBe("disabled");
      expect(instance.enabled).toBe(false);
    }),
  );

  it.effect("composes snapshot, adapter, text generation, and continuation identity", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const manager: JcodeInstanceManager = {
        probe: Effect.succeed({
          server: "jcode 0.73.0",
          protocolVersion: 1,
          capabilities: ["sessions"],
          models: [{ model: "claude-opus-5", provider: "anthropic", available: true }],
        }),
        connectSessionClient: Effect.die("not used"),
        releaseSessionClient: () => Effect.void,
        shutdown: Effect.void,
      };
      const driver = makeJcodeDriver({ makeInstanceManager: () => Effect.succeed(manager) });

      const instance = yield* Effect.scoped(driver.create(createInput())).pipe(
        Effect.provide(driverLayer(calls)),
      );

      expect(instance.driverKind).toBe("jcode");
      expect(instance.adapter.provider).toBe("jcode");
      expect(instance.continuationIdentity).toEqual({
        driverKind: "jcode",
        continuationKey: `jcode:instance:${INSTANCE_ID}`,
      });
      expect(typeof instance.textGeneration.generateThreadTitle).toBe("function");

      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["claude-opus-5"]);

      // Exactly one bounded `--version` probe at create time.
      expect(calls).toEqual([["--version"]]);
    }),
  );

  it.effect("publishes a non-ready snapshot when the private instance fails to launch", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const driver = makeJcodeDriver({
        makeInstanceManager: () =>
          Effect.fail(
            new JcodeInstanceManagerError({
              operation: "launch",
              detail: "Could not launch the private Jcode instance.",
            }),
          ),
      });

      const instance = yield* Effect.scoped(driver.create(createInput())).pipe(
        Effect.provide(driverLayer(calls)),
      );

      // A launch failure must not be reported as a healthy provider, and must
      // not erase the instance either.
      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot.status).not.toBe("ready");
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBeDefined();
      expect(snapshot.models).toEqual([]);
      expect(instance.adapter.provider).toBe("jcode");
    }),
  );

  it.effect("re-reads the instance probe on refresh instead of pinning one observation", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      let probes = 0;
      const manager: JcodeInstanceManager = {
        probe: Effect.suspend(() => {
          probes += 1;
          return probes === 1
            ? Effect.fail(
                new JcodeInstanceManagerError({ operation: "probe", detail: "not ready yet" }),
              )
            : Effect.succeed({
                server: "jcode 0.73.0",
                protocolVersion: 1,
                capabilities: ["sessions"],
                models: [{ model: "claude-opus-5", provider: "anthropic", available: true }],
              });
        }),
        connectSessionClient: Effect.die("not used"),
        releaseSessionClient: () => Effect.void,
        shutdown: Effect.void,
      };
      const driver = makeJcodeDriver({ makeInstanceManager: () => Effect.succeed(manager) });

      const instance = yield* Effect.scoped(
        Effect.gen(function* () {
          const created = yield* driver.create(createInput());
          const first = yield* created.snapshot.getSnapshot;
          const refreshed = yield* created.snapshot.refresh;
          return { first, refreshed };
        }),
      ).pipe(Effect.provide(driverLayer(calls)));

      expect(instance.first.models).toEqual([]);
      // A daemon that becomes readable later must eventually publish its catalog.
      expect(instance.refreshed.models.map((model) => model.slug)).toEqual(["claude-opus-5"]);
      expect(probes).toBeGreaterThan(1);
    }),
  );
});
