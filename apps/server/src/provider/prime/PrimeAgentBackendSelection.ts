import type { ProviderRuntimeFence } from "../ProviderDriver.ts";
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

const NATIVE_ONLY_MESSAGES = {
  launchArgs:
    "Multiple Prime Agent instances are native-only. Remove custom launch arguments; ACP compatibility is disabled while more than one Prime instance is enabled.",
  resolution:
    "Multiple Prime Agent instances are native-only, but Pylon could not resolve this instance's Prime executable. Select an installed Pylon-managed Prime build or reduce the enabled set to one before using ACP compatibility.",
  manager:
    "Multiple Prime Agent instances are native-only, but this instance did not prove the required public SDK, private daemon, and current caller-owned session contract. Update or repair the Pylon-managed Prime build, or reduce the enabled set to one before using ACP compatibility.",
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
    }
  | {
      readonly runtime: "unavailable";
      readonly reason: "launch-args" | "binary-resolution" | "daemon-setup";
      readonly message: string;
    };

export interface PrimeAgentBackendNegotiationInput {
  readonly identity: PrimeAgentMaterializedIdentity;
  readonly runtimeFence?: ProviderRuntimeFence | undefined;
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly recoveryEnabled?: boolean;
  readonly architecture?: string;
  /** Fail closed instead of returning ACP for an enabled multi-instance participant. */
  readonly requireNative?: boolean;
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
      return input.requireNative === true
        ? ({
            runtime: "unavailable",
            reason: "daemon-setup",
            message: NATIVE_ONLY_MESSAGES.manager,
          } as const)
        : ({
            runtime: "acp",
            fallbackCategory: "daemon-setup",
            fallbackMessage: FALLBACK_MESSAGES.manager,
          } as const);
    }

    if (settings.launchArgs.trim().length > 0) {
      return input.requireNative === true
        ? ({
            runtime: "unavailable",
            reason: "launch-args",
            message: NATIVE_ONLY_MESSAGES.launchArgs,
          } as const)
        : ({
            runtime: "acp",
            fallbackCategory: "launch-args",
            fallbackMessage: FALLBACK_MESSAGES.launchArgs,
          } as const);
    }

    const path = yield* Path.Path;
    const resolution = yield* Effect.result(
      dependencies.resolveExecutable(
        settings.binaryPath || "prime-agent",
        input.identity.launchEnv,
      ),
    );
    if (Result.isFailure(resolution)) {
      return input.requireNative === true
        ? ({
            runtime: "unavailable",
            reason: "binary-resolution",
            message: NATIVE_ONLY_MESSAGES.resolution,
          } as const)
        : ({
            runtime: "acp",
            fallbackCategory: "binary-resolution",
            fallbackMessage: FALLBACK_MESSAGES.resolution,
          } as const);
    }

    const manager = yield* Effect.result(
      dependencies.makeManager({
        executablePath: path.resolve(resolution.success),
        identity: input.identity,
        ...(input.runtimeFence === undefined ? {} : { runtimeFence: input.runtimeFence }),
        stateDir: input.stateDir,
        platform: input.platform,
        ...(input.recoveryEnabled === undefined ? {} : { recoveryEnabled: input.recoveryEnabled }),
        ...(input.architecture === undefined ? {} : { architecture: input.architecture }),
      }),
    );
    if (Result.isFailure(manager)) {
      return input.requireNative === true
        ? ({
            runtime: "unavailable",
            reason: "daemon-setup",
            message: NATIVE_ONLY_MESSAGES.manager,
          } as const)
        : ({
            runtime: "acp",
            fallbackCategory: "daemon-setup",
            fallbackMessage: FALLBACK_MESSAGES.manager,
          } as const);
    }

    const prepared = yield* Effect.result(manager.success.prepare());
    if (Result.isFailure(prepared)) {
      return input.requireNative === true
        ? ({
            runtime: "unavailable",
            reason: "daemon-setup",
            message: NATIVE_ONLY_MESSAGES.manager,
          } as const)
        : ({
            runtime: "acp",
            fallbackCategory: "daemon-setup",
            fallbackMessage: FALLBACK_MESSAGES.manager,
          } as const);
    }

    return { runtime: "daemon", manager: manager.success } as const;
  });
}
