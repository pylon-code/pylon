import type { PrimeAgentSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import type { PrimeAgentDaemonManagerInput } from "./PrimeAgentDaemonManager.ts";

const FALLBACK_MESSAGES = {
  launchArgs:
    "Prime Agent daemon mode does not support custom launch arguments; using ACP compatibility mode.",
  resolution:
    "Prime Agent daemon mode could not resolve the configured CLI; using ACP compatibility mode.",
  manager: "Prime Agent daemon integration is unavailable; using ACP compatibility mode.",
} as const;

export type PrimeAgentBackendSelection<Manager> =
  | { readonly runtime: "daemon"; readonly manager: Manager }
  | {
      readonly runtime: "acp";
      readonly fallbackCategory?: "launch-args" | "binary-resolution" | "daemon-setup";
      readonly fallbackMessage?: string;
    };

export interface PrimeAgentBackendNegotiationInput {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly launchArgs: string;
  readonly settings: Pick<PrimeAgentSettings, "agentHomePath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly stateDir: string;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface PrimeAgentBackendNegotiationDependencies<
  Manager,
  ResolveError,
  ResolveServices,
  ManagerError,
  ManagerServices,
> {
  readonly resolveExecutable: (
    command: string,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<string, ResolveError, ResolveServices>;
  readonly makeManager: (
    input: PrimeAgentDaemonManagerInput,
  ) => Effect.Effect<Manager, ManagerError, ManagerServices>;
}

/** Selects one backend before session adapter construction. It never exposes setup errors to users. */
export function negotiatePrimeAgentBackend<
  Manager,
  ResolveError,
  ResolveServices,
  ManagerError,
  ManagerServices,
>(
  input: PrimeAgentBackendNegotiationInput,
  dependencies: PrimeAgentBackendNegotiationDependencies<
    Manager,
    ResolveError,
    ResolveServices,
    ManagerError,
    ManagerServices
  >,
): Effect.Effect<
  PrimeAgentBackendSelection<Manager>,
  never,
  Path.Path | ResolveServices | ManagerServices
> {
  return Effect.gen(function* () {
    if (!input.enabled) return { runtime: "acp" } as const;

    if (input.launchArgs.trim().length > 0) {
      return {
        runtime: "acp",
        fallbackCategory: "launch-args",
        fallbackMessage: FALLBACK_MESSAGES.launchArgs,
      } as const;
    }

    const path = yield* Path.Path;
    const resolution = yield* Effect.result(
      dependencies.resolveExecutable(input.binaryPath || "prime-agent", input.environment),
    );
    if (Result.isFailure(resolution)) {
      return {
        runtime: "acp",
        fallbackCategory: "binary-resolution",
        fallbackMessage: FALLBACK_MESSAGES.resolution,
      } as const;
    }

    const manager = yield* Effect.result(
      dependencies.makeManager({
        executablePath: path.resolve(resolution.success),
        settings: input.settings,
        environment: input.environment,
        stateDir: input.stateDir,
        providerInstanceId: input.providerInstanceId,
      }),
    );
    if (Result.isFailure(manager)) {
      return {
        runtime: "acp",
        fallbackCategory: "daemon-setup",
        fallbackMessage: FALLBACK_MESSAGES.manager,
      } as const;
    }

    return { runtime: "daemon", manager: manager.success } as const;
  });
}
