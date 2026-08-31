import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { PrimeAgentSettings, ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { FAKE_PUBLIC_SDK } from "./PrimeAgentTextGeneration.test-fixture.ts";
import { makePrimeAgentTextGeneration } from "./PrimeAgentTextGeneration.ts";

const decodeSettings = Schema.decodeSync(PrimeAgentSettings);
const TestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "pylon-prime-platform-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(TestLayer)("PrimeAgentTextGeneration platform subprocess", (it) => {
  it.effect("spawns the selected public ESM SDK with exact instance affinity and cleans up", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostPlatform = yield* HostProcessPlatform;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pylon prime platform with spaces ",
      });
      const packageRoot = path.join(root, "Selected Prime Package With Spaces");
      const binaryName = hostPlatform === "win32" ? "prime-agent.cmd" : "prime-agent";
      const binaryPath = path.join(packageRoot, "bin", binaryName);
      const sdkEntryPath = path.join(packageRoot, "public sdk entry.js");
      const cwd = path.join(root, "Project Working Directory With Spaces");
      const captureDir = path.join(root, "Capture Directory With Spaces");
      const agentDir = path.join(root, "Prime Agent Home With Spaces");
      yield* fileSystem.makeDirectory(path.dirname(binaryPath), { recursive: true });
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.makeDirectory(captureDir, { recursive: true });
      yield* fileSystem.makeDirectory(agentDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(packageRoot, "package.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          name: "prime-agent",
          version: "9.9.9-platform-test",
          type: "module",
          bin: { "prime-agent": `bin/${binaryName}` },
          exports: { ".": { import: "./public sdk entry.js" } },
        }),
      );
      yield* fileSystem.writeFileString(
        binaryPath,
        hostPlatform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/usr/bin/env node\n",
      );
      if (hostPlatform !== "win32") {
        yield* fileSystem.chmod(binaryPath, 0o755);
      }
      yield* fileSystem.writeFileString(sdkEntryPath, FAKE_PUBLIC_SDK);

      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const commands: Array<{
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: {
          readonly cwd?: string;
          readonly env?: NodeJS.ProcessEnv;
          readonly shell?: boolean;
          readonly extendEnv?: boolean;
          readonly killSignal?: string;
          readonly forceKillAfter?: unknown;
        };
      }> = [];
      const trackingSpawner = ChildProcessSpawner.ChildProcessSpawner.of({
        ...realSpawner,
        spawn: (command) => {
          commands.push(command as unknown as (typeof commands)[number]);
          return realSpawner.spawn(command);
        },
      });

      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        PYLON_INSTANCE_SENTINEL: "platform-instance-environment",
        FAKE_PRIME_CAPTURE_DIR: captureDir,
        NODE_OPTIONS: "--require=must-not-load.cjs",
        NODE_PATH: path.join(root, "must not resolve"),
        PYLON_PRIME_SDK_ENTRY: "poison-sdk-entry",
        PYLON_PRIME_AGENT_DIR: "poison-agent-dir",
        PYLON_PRIME_MODEL: "poison/model",
        PYLON_PRIME_THINKING: "poison-thinking",
        PYLON_PRIME_SERVICE_TIER: "poison-tier",
        NoDe_OpTiOnS: "--require=mixed-case-poison.cjs",
        nOdE_pAtH: path.join(root, "mixed poison path"),
        pYlOn_PrImE_mOdEl: "mixed/poison",
        pRiMe_AgEnT_cOdInG_aGeNt_DiR: path.join(root, "mixed prime poison"),
        ELECTRON_RUN_AS_NODE: "1",
      };
      const textGeneration = yield* makePrimeAgentTextGeneration(
        decodeSettings({ binaryPath, agentHomePath: agentDir }),
        environment,
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, trackingSpawner));
      const generated = yield* textGeneration.generateThreadTitle({
        cwd,
        message: "Exercise the platform subprocess",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("primeAgent"),
          "openai-codex/org/models/gpt-5.6",
          [
            { id: "thinkingLevel", value: "xhigh" },
            { id: "serviceTier", value: "priority" },
          ],
        ),
      });
      expect(generated).toEqual({ title: "Prime Background Writing" });
      expect(commands).toHaveLength(1);
      const command = commands[0]!;
      expect(command.command).toBe(process.execPath);
      expect(command.args).toHaveLength(1);
      expect(command.options.cwd).toBe(cwd);
      expect(command.options.shell).toBe(false);
      expect(command.options.extendEnv).toBe(false);
      expect(command.options.killSignal).toBe("SIGTERM");
      expect(command.options.forceKillAfter).toBe("2 seconds");
      expect(command.options.env?.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(command.options.env?.NO_COLOR).toBe("1");
      expect(command.options.env?.FORCE_COLOR).toBeUndefined();
      expect(command.options.env?.CLICOLOR_FORCE).toBeUndefined();

      const captures = (yield* fileSystem.readDirectory(captureDir)).filter((entry) =>
        entry.endsWith(".json"),
      );
      expect(captures).toHaveLength(1);
      const rawCapture = yield* fileSystem.readFileString(path.join(captureDir, captures[0]!));
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const capture = JSON.parse(rawCapture) as Record<string, unknown>;
      const realCwd = yield* fileSystem.realPath(cwd);
      const realSdkEntryPath = yield* fileSystem.realPath(sdkEntryPath);
      expect(capture).toMatchObject({
        execPath: process.execPath,
        cwd: realCwd,
        argv: [],
        instanceEnvironment: "platform-instance-environment",
        helperAgentDirEnvironment: agentDir,
        helperModelEnvironment: "openai-codex/org/models/gpt-5.6",
        helperThinkingEnvironment: "xhigh",
        helperServiceTierEnvironment: "priority",
        requestCount: 1,
        disposed: true,
      });
      expect(typeof capture.sdkEntryPath).toBe("string");
      expect(capture.helperSdkEntryEnvironment).toBe(capture.sdkEntryPath);
      const selectedSdkInfo = yield* fileSystem.stat(realSdkEntryPath);
      const capturedSdkInfo = yield* fileSystem.stat(capture.sdkEntryPath as string);
      expect(capturedSdkInfo.dev).toBe(selectedSdkInfo.dev);
      expect(Option.isSome(selectedSdkInfo.ino)).toBe(true);
      expect(capturedSdkInfo.ino).toEqual(selectedSdkInfo.ino);
      expect(typeof capture.primeHomeEnvironment).toBe("string");
      expect(capture.primeHomeEnvironment).not.toBe(agentDir);
      expect(capture.electronRunAsNodeEnvironment).toBe("1");
      expect(capture.nodeOptionsEnvironment).toBeUndefined();
      expect(capture.nodePathEnvironment).toBeUndefined();
      expect(capture.mixedNodeOptionsEnvironment).toBeUndefined();
      expect(capture.mixedNodePathEnvironment).toBeUndefined();
      expect(capture.controlledEnvironment).toMatchObject({
        PRIME_AGENT_CODING_AGENT_DIR: capture.primeHomeEnvironment,
        PYLON_PRIME_SDK_ENTRY: capture.sdkEntryPath,
        PYLON_PRIME_AGENT_DIR: agentDir,
        PYLON_PRIME_MODEL: "openai-codex/org/models/gpt-5.6",
        PYLON_PRIME_THINKING: "xhigh",
        PYLON_PRIME_SERVICE_TIER: "priority",
      });
      expect(capture.controlledEnvironment).not.toHaveProperty("NODE_OPTIONS");
      expect(capture.controlledEnvironment).not.toHaveProperty("NODE_PATH");
      expect(Object.values(capture.controlledEnvironment as Record<string, unknown>)).not.toContain(
        "mixed/poison",
      );
      expect(capture.fileSettings).toMatchObject({ cwd: realCwd, agentDir });
      expect(capture.sessionAtCreation).toMatchObject({
        model: { provider: "openai-codex", id: "org/models/gpt-5.6" },
        thinkingLevel: "xhigh",
        serviceTier: "priority",
      });
      expect(typeof capture.helperPath).toBe("string");
      expect(command.args[0]).toBe(capture.helperPath);
      expect(yield* fileSystem.exists(capture.helperPath as string)).toBe(false);
      expect(yield* fileSystem.exists(capture.primeHomeEnvironment as string)).toBe(false);
    }).pipe(Effect.scoped),
  );
});
