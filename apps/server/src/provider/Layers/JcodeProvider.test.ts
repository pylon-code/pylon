import { describe, expect, it } from "@effect/vitest";
import { JcodeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { JcodeInstanceProbe } from "../jcode/JcodeInstanceManager.ts";
import {
  buildJcodeProviderSnapshot,
  checkJcodeProviderStatus,
  JCODE_APPROVALS_WARNING,
  JCODE_MIN_RUNTIME_VERSION,
  JCODE_TESTED_RUNTIME_VERSION,
  JCODE_VERSION_PROBE_TIMEOUT_MS,
  JcodeVersionProbeError,
  parseJcodeVersionOutput,
  probeJcodeExecutableVersion,
} from "./JcodeProvider.ts";

const decodeSettings = Schema.decodeSync(JcodeSettings);
const encoder = new TextEncoder();
const CHECKED_AT = "2026-08-10T00:00:00.000Z";

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>> | undefined;
}

function mockProcess(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  /** Models a binary that never answers, so the bounded probe must give up. */
  readonly hang?: boolean;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.hang
      ? Effect.never
      : Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(input.stdout ?? "")),
    stderr: Stream.make(encoder.encode(input.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawner(input: {
  readonly calls: Array<SpawnCall>;
  readonly process?: Parameters<typeof mockProcess>[0];
  /** When set, the spawn itself fails the way a missing executable does. */
  readonly missing?: boolean;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly env?: Readonly<Record<string, string | undefined>> };
      };
      input.calls.push({
        command: childProcess.command,
        args: childProcess.args,
        env: childProcess.options.env,
      });
      return input.missing
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "spawn jcode ENOENT",
            }),
          )
        : Effect.succeed(mockProcess(input.process ?? { stdout: "jcode v0.73.0\n" }));
    }),
  );
}

const enabledSettings = decodeSettings({ enabled: true, binaryPath: "", inheritLogins: true });

/**
 * A healthy manager observation. `server` deliberately reports a version the
 * executable never claimed: the snapshot must never source its version here.
 */
const instanceProbe: JcodeInstanceProbe = {
  server: "jcode 9.9.9",
  protocolVersion: 1,
  capabilities: ["sessions", "files"],
  currentModel: "claude-opus-5",
  models: [
    { model: "claude-opus-5", provider: "anthropic", available: true },
    { model: "gpt-5.6", provider: "openai", available: true },
    { model: "gemini-3-pro", provider: "google", available: false },
  ],
};

const readySnapshot = (
  overrides: {
    readonly version?: string;
    readonly instance?: JcodeInstanceProbe | undefined;
    readonly settings?: JcodeSettings;
  } = {},
) =>
  buildJcodeProviderSnapshot({
    settings: overrides.settings ?? enabledSettings,
    checkedAt: CHECKED_AT,
    executable: { _tag: "Ready", version: overrides.version ?? JCODE_TESTED_RUNTIME_VERSION },
    instance: "instance" in overrides ? overrides.instance : instanceProbe,
  });

describe("parseJcodeVersionOutput", () => {
  it("reads the documented `jcode v0.73.0` and bare `jcode 0.71.1` shapes", () => {
    expect(parseJcodeVersionOutput("jcode v0.73.0\n")).toBe("0.73.0");
    expect(parseJcodeVersionOutput("jcode 0.71.1")).toBe("0.71.1");
  });

  it("returns undefined for output carrying no semantic version", () => {
    expect(parseJcodeVersionOutput("jcode (dev build)")).toBeUndefined();
    expect(parseJcodeVersionOutput("")).toBeUndefined();
    expect(parseJcodeVersionOutput("   \n  ")).toBeUndefined();
  });
});

describe("probeJcodeExecutableVersion", () => {
  it.effect("invokes the configured binary with exactly `--version`", () =>
    Effect.gen(function* () {
      const calls: Array<SpawnCall> = [];
      const version = yield* probeJcodeExecutableVersion({
        settings: decodeSettings({
          enabled: true,
          binaryPath: "/opt/jcode/bin/jcode",
          inheritLogins: true,
        }),
        environment: { PATH: "/usr/bin" },
      }).pipe(Effect.provide(mockSpawner({ calls })));

      expect(version).toBe("0.73.0");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toBe("/opt/jcode/bin/jcode");
      expect(calls[0]?.args).toEqual(["--version"]);
    }),
  );

  it.effect("falls back to `jcode` on PATH when no binary path is configured", () =>
    Effect.gen(function* () {
      const calls: Array<SpawnCall> = [];
      yield* probeJcodeExecutableVersion({
        settings: enabledSettings,
        environment: { PATH: "/usr/bin" },
      }).pipe(Effect.provide(mockSpawner({ calls })));

      expect(calls[0]?.command).toBe("jcode");
      expect(calls[0]?.args).toEqual(["--version"]);
    }),
  );

  it.effect("probes under the sanitized environment so it cannot read a foreign instance", () =>
    Effect.gen(function* () {
      const calls: Array<SpawnCall> = [];
      yield* probeJcodeExecutableVersion({
        settings: enabledSettings,
        environment: {
          PATH: "/usr/bin",
          ANTHROPIC_API_KEY: "sk-test",
          JCODE_HOME: "/home/user/.jcode",
          JCODE_RUNTIME_DIR: "/run/jcode",
          JCODE_API_SOCKET: "/run/jcode/api.sock",
          JCODE_SOCKET: "/run/jcode/jcode.sock",
        },
      }).pipe(Effect.provide(mockSpawner({ calls })));

      const env = calls[0]?.env ?? {};
      expect(env.PATH).toBe("/usr/bin");
      expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
      for (const reserved of [
        "JCODE_HOME",
        "JCODE_RUNTIME_DIR",
        "JCODE_API_SOCKET",
        "JCODE_SOCKET",
      ] as const) {
        expect(env, `${reserved} must not reach the probe`).not.toHaveProperty(reserved);
      }
    }),
  );

  it.effect("classifies a missing executable", () =>
    Effect.gen(function* () {
      const calls: Array<SpawnCall> = [];
      const result = yield* probeJcodeExecutableVersion({
        settings: enabledSettings,
        environment: {},
      }).pipe(Effect.provide(mockSpawner({ calls, missing: true })), Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("JcodeVersionProbeError");
        expect(result.failure.reason).toBe("missing");
      }
    }),
  );

  it.effect("classifies a nonzero exit", () =>
    Effect.gen(function* () {
      const calls: Array<SpawnCall> = [];
      const result = yield* probeJcodeExecutableVersion({
        settings: enabledSettings,
        environment: {},
      }).pipe(
        Effect.provide(
          mockSpawner({ calls, process: { stderr: "boom", exitCode: 1, stdout: "" } }),
        ),
        Effect.result,
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.reason).toBe("nonzero");
    }),
  );

  it.effect("classifies unparseable output", () =>
    Effect.gen(function* () {
      const calls: Array<SpawnCall> = [];
      const result = yield* probeJcodeExecutableVersion({
        settings: enabledSettings,
        environment: {},
      }).pipe(
        Effect.provide(mockSpawner({ calls, process: { stdout: "jcode (dev build)\n" } })),
        Effect.result,
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.reason).toBe("malformed");
    }),
  );

  it.effect("gives up on a hung executable after the bounded timeout", () =>
    Effect.gen(function* () {
      expect(JCODE_VERSION_PROBE_TIMEOUT_MS).toBe(4_000);

      const calls: Array<SpawnCall> = [];
      const fiber = yield* probeJcodeExecutableVersion({
        settings: enabledSettings,
        environment: {},
      }).pipe(
        Effect.provide(mockSpawner({ calls, process: { hang: true } })),
        Effect.result,
        Effect.forkChild,
      );

      yield* TestClock.adjust(`${JCODE_VERSION_PROBE_TIMEOUT_MS} millis`);
      const result = yield* Fiber.join(fiber);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.reason).toBe("timeout");
    }),
  );
});

describe("buildJcodeProviderSnapshot", () => {
  it("publishes an Early Access, full-access-only healthy snapshot", () => {
    const snapshot = readySnapshot();

    expect(snapshot).toMatchObject({
      displayName: "Jcode",
      badgeLabel: "Early Access",
      enabled: true,
      installed: true,
      status: "ready",
      version: JCODE_TESTED_RUNTIME_VERSION,
      checkedAt: CHECKED_AT,
      supportsBackgroundTextGeneration: false,
      supportsConversationRollback: false,
    });
    expect(snapshot.supportedRuntimeModes).toEqual(["full-access"]);
    expect(snapshot.featureCapabilities?.executionPolicy?.runtimeModes).toEqual(["full-access"]);
    expect(snapshot.auth).toEqual({ status: "unknown" });
  });

  it("warns that Pylon cannot gate Jcode approvals", () => {
    expect(readySnapshot().message).toContain(JCODE_APPROVALS_WARNING);
  });

  it("publishes the models the instance reported, skipping unavailable routes", () => {
    const snapshot = readySnapshot();

    expect(snapshot.models.map((model) => model.slug)).toEqual(["claude-opus-5", "gpt-5.6"]);
    expect(snapshot.models.map((model) => model.subProvider)).toEqual(["anthropic", "openai"]);
    expect(snapshot.models.every((model) => model.isCustom === false)).toBe(true);
    expect(snapshot.models[0]?.capabilities?.optionDescriptors?.[0]?.id).toBe("reasoningEffort");
  });

  it("never sources the executable version from the instance's reported server", () => {
    const snapshot = readySnapshot({ version: "0.73.0" });

    expect(snapshot.version).toBe("0.73.0");
    expect(JSON.stringify(snapshot)).not.toContain("9.9.9");
  });

  it("accepts the minimum supported runtime version", () => {
    const snapshot = readySnapshot({ version: JCODE_MIN_RUNTIME_VERSION });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.version).toBe(JCODE_MIN_RUNTIME_VERSION);
  });

  it("rejects a runtime older than the minimum supported version", () => {
    const snapshot = readySnapshot({ version: "0.70.0" });

    expect(snapshot.status).toBe("error");
    expect(snapshot.installed).toBe(true);
    expect(snapshot.version).toBe("0.70.0");
    expect(snapshot.message).toContain(JCODE_MIN_RUNTIME_VERSION);
  });

  it("does not warn for real output from the runtime exercised by the compatibility matrix", () => {
    const version = parseJcodeVersionOutput("jcode v0.75.2-dev (d218d84fe)\n");
    if (version === undefined) throw new Error("Expected the exercised Jcode version to parse.");
    expect(version).toBe("0.75.2");

    const snapshot = readySnapshot({ version });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.version).toBe("0.75.2");
    expect(snapshot.message).toBe(JCODE_APPROVALS_WARNING);
  });

  it("advises about an untested newer runtime while protocol 1 still applies", () => {
    const snapshot = readySnapshot({ version: "0.76.0" });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.message).toContain("0.76.0");
    expect(snapshot.message).toContain(JCODE_TESTED_RUNTIME_VERSION);
    expect(snapshot.message).toContain(JCODE_APPROVALS_WARNING);
  });

  it("stays quiet about a newer runtime when the instance speaks another protocol", () => {
    const snapshot = readySnapshot({
      version: "0.74.0",
      instance: { ...instanceProbe, protocolVersion: 2 },
    });

    expect(snapshot.message).not.toContain(JCODE_TESTED_RUNTIME_VERSION);
  });

  it("publishes no models before the instance reports its catalog", () => {
    const snapshot = readySnapshot({ instance: undefined });

    expect(snapshot.models).toEqual([]);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.message).toContain(JCODE_APPROVALS_WARNING);
  });

  it("reports a disabled instance without probing anything", () => {
    const snapshot = buildJcodeProviderSnapshot({
      settings: decodeSettings({ enabled: false, binaryPath: "", inheritLogins: true }),
      checkedAt: CHECKED_AT,
      executable: { _tag: "Ready", version: JCODE_TESTED_RUNTIME_VERSION },
      instance: instanceProbe,
    });

    expect(snapshot).toMatchObject({ enabled: false, status: "disabled", installed: false });
    expect(snapshot.version).toBeNull();
    expect(snapshot.models).toEqual([]);
  });

  it.each([
    { reason: "missing" as const, installed: false, needle: "not installed" },
    { reason: "timeout" as const, installed: true, needle: "did not respond" },
    { reason: "nonzero" as const, installed: true, needle: "failed" },
    { reason: "malformed" as const, installed: true, needle: "could not determine" },
  ])("reports a $reason executable probe as an error state", (probeCase) => {
    const snapshot = buildJcodeProviderSnapshot({
      settings: enabledSettings,
      checkedAt: CHECKED_AT,
      executable: {
        _tag: "Failed",
        error: new JcodeVersionProbeError({ reason: probeCase.reason, detail: "probe detail" }),
      },
      instance: instanceProbe,
    });

    expect(snapshot.status).toBe("error");
    expect(snapshot.installed).toBe(probeCase.installed);
    expect(snapshot.version).toBeNull();
    expect(snapshot.message?.toLowerCase()).toContain(probeCase.needle);
  });
});

describe("checkJcodeProviderStatus", () => {
  it.effect("combines the executable probe with the instance observation", () =>
    Effect.gen(function* () {
      const calls: Array<SpawnCall> = [];
      const snapshot = yield* checkJcodeProviderStatus({
        settings: enabledSettings,
        environment: { PATH: "/usr/bin" },
        instance: instanceProbe,
      }).pipe(Effect.provide(mockSpawner({ calls })));

      expect(calls[0]?.args).toEqual(["--version"]);
      expect(snapshot).toMatchObject({ status: "ready", version: "0.73.0", installed: true });
      expect(snapshot.models.map((model) => model.slug)).toEqual(["claude-opus-5", "gpt-5.6"]);
      expect(snapshot.message).toContain(JCODE_APPROVALS_WARNING);
    }),
  );

  it.effect("reports a missing executable without consulting the instance", () =>
    Effect.gen(function* () {
      const calls: Array<SpawnCall> = [];
      const snapshot = yield* checkJcodeProviderStatus({
        settings: enabledSettings,
        environment: {},
        instance: instanceProbe,
      }).pipe(Effect.provide(mockSpawner({ calls, missing: true })));

      expect(snapshot).toMatchObject({ status: "error", installed: false });
      expect(snapshot.models).toEqual([]);
    }),
  );

  it.effect("never spawns anything for a disabled instance", () =>
    Effect.gen(function* () {
      const calls: Array<SpawnCall> = [];
      const snapshot = yield* checkJcodeProviderStatus({
        settings: decodeSettings({ enabled: false, binaryPath: "", inheritLogins: true }),
        environment: {},
      }).pipe(Effect.provide(mockSpawner({ calls })));

      expect(calls).toEqual([]);
      expect(snapshot.status).toBe("disabled");
    }),
  );
});
