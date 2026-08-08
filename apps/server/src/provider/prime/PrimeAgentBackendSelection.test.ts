// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  negotiatePrimeAgentBackend,
  type PrimeAgentBackendNegotiationInput,
} from "./PrimeAgentBackendSelection.ts";
import type { PrimeAgentDaemonManagerInput } from "./PrimeAgentDaemonManager.ts";

const baseInput: PrimeAgentBackendNegotiationInput = {
  enabled: true,
  binaryPath: "prime-agent",
  launchArgs: "",
  settings: { agentHomePath: "" },
  environment: { PATH: "/configured/bin" },
  stateDir: "/pylon/state",
  providerInstanceId: ProviderInstanceId.make("primeAgent"),
};

it.layer(NodeServices.layer)("negotiatePrimeAgentBackend", (it) => {
  it.effect(
    "resolves empty-launch-args binaries to absolute paths before one manager attempt",
    () =>
      Effect.gen(function* () {
        const resolutionCalls: Array<{ command: string; environment: NodeJS.ProcessEnv }> = [];
        const managerCalls: PrimeAgentDaemonManagerInput[] = [];
        const selected = yield* negotiatePrimeAgentBackend(baseInput, {
          resolveExecutable: (command, environment) =>
            Effect.sync(() => {
              resolutionCalls.push({ command, environment });
              return "relative/bin/prime-agent";
            }),
          makeManager: (input) =>
            Effect.sync(() => {
              managerCalls.push(input);
              return { id: "manager" } as const;
            }),
        });

        expect(selected).toEqual({ runtime: "daemon", manager: { id: "manager" } });
        expect(resolutionCalls).toEqual([
          { command: "prime-agent", environment: baseInput.environment },
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
        { ...baseInput, launchArgs: "  --verbose  " },
        {
          resolveExecutable: () =>
            Effect.sync(() => {
              resolutionAttempts += 1;
              return "/unused/prime-agent";
            }),
          makeManager: () =>
            Effect.sync(() => {
              managerAttempts += 1;
              return { id: "unused" } as const;
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
        { ...baseInput, binaryPath: "/secret/configured/prime-agent" },
        {
          resolveExecutable: () =>
            Effect.fail({
              _tag: "TestResolutionFailure" as const,
              detail: "private resolution cause",
            }),
          makeManager: () => Effect.succeed({ id: "unused" } as const),
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

  it.effect("quietly selects ACP when disabled and skips daemon setup", () =>
    Effect.gen(function* () {
      let resolutionAttempts = 0;
      let managerAttempts = 0;
      const selected = yield* negotiatePrimeAgentBackend(
        { ...baseInput, enabled: false },
        {
          resolveExecutable: () =>
            Effect.sync(() => {
              resolutionAttempts += 1;
              return "/unused/prime-agent";
            }),
          makeManager: () =>
            Effect.sync(() => {
              managerAttempts += 1;
              return { id: "unused" } as const;
            }),
        },
      );

      expect(selected).toEqual({ runtime: "acp" });
      expect(resolutionAttempts).toBe(0);
      expect(managerAttempts).toBe(0);
    }),
  );
});
