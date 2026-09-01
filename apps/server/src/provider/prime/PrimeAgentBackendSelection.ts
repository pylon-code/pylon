import type { PrimeAgentMaterializedIdentity } from "./PrimeAgentRuntimeContext.ts";
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

export interface PrimeAgentBackendPreparable<PrepareError> {
  readonly prepare: () => Effect.Effect<void, PrepareError>;
}

export type PrimeAgentBackendSelection<Manager> =
  | { readonly runtime: "daemon"; readonly manager: Manager }
  | {
      readonly runtime: "acp";
      readonly fallbackCategory?: "launch-args" | "binary-resolution" | "daemon-setup";
      readonly fallbackMessage?: string;
    };

export interface PrimeAgentBackendNegotiationInput {
  readonly identity: PrimeAgentMaterializedIdentity;
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly recoveryEnabled?: boolean;
  readonly architecture?: string;
}

export interface PrimeAgentBackendNegotiationDependencies<
  PrepareError,
  Manager extends PrimeAgentBackendPreparable<PrepareError>,
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
  PrepareError,
  Manager extends PrimeAgentBackendPreparable<PrepareError>,
  ResolveError,
  ResolveServices,
  ManagerError,
  ManagerServices,
>(
  input: PrimeAgentBackendNegotiationInput,
  dependencies: PrimeAgentBackendNegotiationDependencies<
    PrepareError,
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
    const settings = input.identity.settings;
    if (!settings.enabled) return { runtime: "acp" } as const;
    if (input.platform === "win32") {
      return {
        runtime: "acp",
        fallbackCategory: "daemon-setup",
        fallbackMessage: FALLBACK_MESSAGES.manager,
      } as const;
    }

    if (settings.launchArgs.trim().length > 0) {
      return {
        runtime: "acp",
        fallbackCategory: "launch-args",
        fallbackMessage: FALLBACK_MESSAGES.launchArgs,
      } as const;
    }

    const path = yield* Path.Path;
    const resolution = yield* Effect.result(
      dependencies.resolveExecutable(
        settings.binaryPath || "prime-agent",
        input.identity.launchEnv,
      ),
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
        identity: input.identity,
        stateDir: input.stateDir,
        platform: input.platform,
        ...(input.recoveryEnabled === undefined ? {} : { recoveryEnabled: input.recoveryEnabled }),
        ...(input.architecture === undefined ? {} : { architecture: input.architecture }),
      }),
    );
    if (Result.isFailure(manager)) {
      return {
        runtime: "acp",
        fallbackCategory: "daemon-setup",
        fallbackMessage: FALLBACK_MESSAGES.manager,
      } as const;
    }

    const prepared = yield* Effect.result(manager.success.prepare());
    if (Result.isFailure(prepared)) {
      return {
        runtime: "acp",
        fallbackCategory: "daemon-setup",
        fallbackMessage: FALLBACK_MESSAGES.manager,
      } as const;
    }

    return { runtime: "daemon", manager: manager.success } as const;
  });
}
