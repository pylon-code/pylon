// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

import {
  negotiatePrimeAgentBackend,
  type PrimeAgentBackendNegotiationInput,
} from "./PrimeAgentBackendSelection.ts";
import type { PrimeAgentDaemonManagerInput } from "./PrimeAgentDaemonManager.ts";

const testManager = (id: string) => ({
  id,
  prepare: () => Effect.void,
});

const makeInput = (
  settings: Partial<PrimeAgentBackendNegotiationInput["identity"]["settings"]> = {},
  launchEnv: Readonly<Record<string, string>> = { PATH: "/configured/bin" },
): PrimeAgentBackendNegotiationInput => ({
  identity: {
    instanceId: ProviderInstanceId.make("primeAgent"),
    generation: { _tag: "PrimeAgentRuntimeGeneration" },
    configRevision: "test-revision",
    effectiveHome: "/prime/home",
    launchEnv,
    settings: {
      enabled: true,
      binaryPath: "prime-agent",
      launchArgs: "",
      agentHomePath: "/prime/home",
      customModels: [],
      ...settings,
    },
  },
  stateDir: "/pylon/state",
  platform: "linux",
});

const baseInput = makeInput();

it.layer(NodeServices.layer)("negotiatePrimeAgentBackend", (it) => {
  it.effect("selects daemon with a PATH-resolved Prime Agent executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-agent-backend-path-")),
          ),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        );
        const platform = yield* HostProcessPlatform;
        const executableName = platform === "win32" ? "prime-agent.CMD" : "prime-agent";
        const executablePath = NodePath.join(tempDir, executableName);
        yield* Effect.promise(() => NodeFSP.writeFile(executablePath, "", "utf8"));
        if (platform !== "win32") {
          yield* Effect.promise(() => NodeFSP.chmod(executablePath, 0o755));
        }

        const managerCalls: PrimeAgentDaemonManagerInput[] = [];
        const manager = testManager("path-resolved");
        const selected = yield* negotiatePrimeAgentBackend(
          makeInput(
            {},
            {
              PATH: tempDir,
              ...(platform === "win32" ? { PATHEXT: ".CMD" } : {}),
            },
          ),
          {
            resolveExecutable: (command, environment) =>
              resolveCommandPath(command, { env: environment }),
            makeManager: (input) =>
              Effect.sync(() => {
                managerCalls.push(input);
                return manager;
              }),
          },
        );

        expect(selected).toEqual({ runtime: "daemon", manager });
        expect(managerCalls).toHaveLength(1);
        expect(managerCalls[0]?.executablePath).toBe(executablePath);
      }),
    ),
  );

  it.effect(
    "resolves empty-launch-args binaries to absolute paths before one manager attempt",
    () =>
      Effect.gen(function* () {
        const resolutionCalls: Array<{ command: string; environment: NodeJS.ProcessEnv }> = [];
        const managerCalls: PrimeAgentDaemonManagerInput[] = [];
        let prepareAttempts = 0;
        const manager = {
          id: "manager",
          prepare: () =>
            Effect.sync(() => {
              prepareAttempts += 1;
            }),
        } as const;
        const selected = yield* negotiatePrimeAgentBackend(baseInput, {
          resolveExecutable: (command, environment) =>
            Effect.sync(() => {
              resolutionCalls.push({ command, environment });
              return "relative/bin/prime-agent";
            }),
          makeManager: (input) =>
            Effect.sync(() => {
              managerCalls.push(input);
              return manager;
            }),
        });

        expect(selected).toEqual({ runtime: "daemon", manager });
        expect(prepareAttempts).toBe(1);
        expect(resolutionCalls).toEqual([
          { command: "prime-agent", environment: baseInput.identity.launchEnv },
        ]);
        expect(managerCalls).toHaveLength(1);
        expect(NodePath.isAbsolute(managerCalls[0]?.executablePath ?? "")).toBe(true);
        expect(managerCalls[0]?.executablePath).toBe(NodePath.resolve("relative/bin/prime-agent"));
      }),
  );

  it.effect("selects ACP for any nonempty launch arguments without attempting daemon setup", () =>
    Effect.gen(function* () {
      let resolutionAttempts = 0;
      let managerAttempts = 0;
      const selected = yield* negotiatePrimeAgentBackend(
        makeInput({ launchArgs: "  --verbose  " }),
        {
          resolveExecutable: () =>
            Effect.sync(() => {
              resolutionAttempts += 1;
              return "/unused/prime-agent";
            }),
          makeManager: () =>
            Effect.sync(() => {
              managerAttempts += 1;
              return testManager("unused");
            }),
        },
      );

      expect(selected.runtime).toBe("acp");
      expect(selected).toMatchObject({ fallbackCategory: "launch-args" });
      expect(resolutionAttempts).toBe(0);
      expect(managerAttempts).toBe(0);
    }),
  );

  it.effect("turns resolution failures into bounded ACP reasons without raw details", () =>
    Effect.gen(function* () {
      const selected = yield* negotiatePrimeAgentBackend(
        makeInput({ binaryPath: "/secret/configured/prime-agent" }),
        {
          resolveExecutable: () =>
            Effect.fail({
              _tag: "TestResolutionFailure" as const,
              detail: "private resolution cause",
            }),
          makeManager: () => Effect.succeed(testManager("unused")),
        },
      );
      expect(selected).toMatchObject({
        runtime: "acp",
        fallbackCategory: "binary-resolution",
      });
      expect(selected.runtime === "acp" ? selected.fallbackMessage : undefined).not.toContain(
        "/secret/configured/prime-agent",
      );
      expect(selected.runtime === "acp" ? selected.fallbackMessage : undefined).not.toContain(
        "private resolution cause",
      );
    }),
  );

  it.effect("falls back to ACP after exactly one failed daemon prepare attempt", () =>
    Effect.gen(function* () {
      let managerAttempts = 0;
      let prepareAttempts = 0;
      const selected = yield* negotiatePrimeAgentBackend(baseInput, {
        resolveExecutable: () => Effect.succeed("/resolved/prime-agent"),
        makeManager: () =>
          Effect.sync(() => {
            managerAttempts += 1;
            return {
              prepare: () =>
                Effect.gen(function* () {
                  prepareAttempts += 1;
                  return yield* Effect.fail({
                    _tag: "TestPrepareFailure" as const,
                    detail: "private prepare cause",
                  });
                }),
            };
          }),
      });

      expect(selected).toMatchObject({ runtime: "acp", fallbackCategory: "daemon-setup" });
      expect(managerAttempts).toBe(1);
      expect(prepareAttempts).toBe(1);
      expect(selected.runtime === "acp" ? selected.fallbackMessage : undefined).not.toContain(
        "private prepare cause",
      );
    }),
  );

  it.effect("turns manager failures into bounded ACP reasons without raw details", () =>
    Effect.gen(function* () {
      const selected = yield* negotiatePrimeAgentBackend(baseInput, {
        resolveExecutable: () => Effect.succeed("/secret/resolved/prime-agent"),
        makeManager: () =>
          Effect.fail({ _tag: "TestManagerFailure" as const, detail: "private manager cause" }),
      });
      expect(selected).toMatchObject({ runtime: "acp", fallbackCategory: "daemon-setup" });
      expect(selected.runtime === "acp" ? selected.fallbackMessage : undefined).not.toContain(
        "/secret/resolved/prime-agent",
      );
      expect(selected.runtime === "acp" ? selected.fallbackMessage : undefined).not.toContain(
        "private manager cause",
      );
    }),
  );

  it.effect("selects ACP on native Windows without resolving, importing, or starting Prime", () =>
    Effect.gen(function* () {
      let resolutionAttempts = 0;
      let managerAttempts = 0;
      const selected = yield* negotiatePrimeAgentBackend(
        { ...baseInput, platform: "win32" },
        {
          resolveExecutable: () =>
            Effect.sync(() => {
              resolutionAttempts += 1;
              return "/unused/prime-agent";
            }),
          makeManager: () =>
            Effect.sync(() => {
              managerAttempts += 1;
              return testManager("unused");
            }),
        },
      );

      expect(selected).toMatchObject({ runtime: "acp", fallbackCategory: "daemon-setup" });
      expect(resolutionAttempts).toBe(0);
      expect(managerAttempts).toBe(0);
    }),
  );

  it.effect("quietly selects ACP when disabled and skips daemon setup", () =>
    Effect.gen(function* () {
      let resolutionAttempts = 0;
      let managerAttempts = 0;
      const selected = yield* negotiatePrimeAgentBackend(makeInput({ enabled: false }), {
        resolveExecutable: () =>
          Effect.sync(() => {
            resolutionAttempts += 1;
            return "/unused/prime-agent";
          }),
        makeManager: () =>
          Effect.sync(() => {
            managerAttempts += 1;
            return testManager("unused");
          }),
      });

      expect(selected).toEqual({ runtime: "acp" });
      expect(resolutionAttempts).toBe(0);
      expect(managerAttempts).toBe(0);
    }),
  );
});
