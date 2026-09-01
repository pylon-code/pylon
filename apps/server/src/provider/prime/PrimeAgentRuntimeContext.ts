import {
  type PrimeAgentSettings,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ProviderDriverError } from "../Errors.ts";
import type { ProviderRuntimeFence } from "../ProviderDriver.ts";

export const PRIME_AGENT_HOME_ENV = "PRIME_AGENT_CODING_AGENT_DIR" as const;
export const PRIME_AGENT_COMPAT_HOME_ENV = "PRIME_AGENT_HOME" as const;
export const PRIME_AGENT_CALLER_OWNED_SESSION_FEATURE =
  "caller_owned_session_environment_cleanup_v1" as const;
export const PRIME_AGENT_AUTHORITATIVE_CLEANUP_CAPABILITY =
  "authoritative_owned_session_cleanup_v1" as const;
export const PRIME_AGENT_NEGOTIATED_CAPABILITIES_FEATURE =
  "negotiated_daemon_session_capabilities_v1" as const;

const DRIVER_KIND = "primeAgent" as const;
const DISTINCT_HOME_REASON =
  "Prime Agent instances need distinct homes. Configure each enabled instance with a home that is neither equal to nor nested inside another Prime Agent instance home.";
const INVALID_HOME_REASON =
  "Prime Agent needs a safe absolute home. Configure an absolute Agent home path, or set an absolute HOME for the instance.";
const HOME_RESOLUTION_FAILED_REASON =
  "Prime Agent could not safely resolve this instance home. Check the configured home and permissions.";

const reservedPrimeAgentEnvironmentName = (name: string): boolean => {
  const normalized = name.toUpperCase();
  return (
    normalized.startsWith("PRIME_AGENT_INTERNAL_") ||
    normalized.startsWith("RLM_") ||
    normalized === PRIME_AGENT_HOME_ENV ||
    normalized === PRIME_AGENT_COMPAT_HOME_ENV ||
    normalized === "FORCE_COLOR"
  );
};

const freezeStringRecord = (record: Record<string, string>): Readonly<Record<string, string>> =>
  Object.freeze({ ...record });

class PrimeAgentHomeCanonicalizationError extends Schema.TaggedErrorClass<PrimeAgentHomeCanonicalizationError>()(
  "PrimeAgentHomeCanonicalizationError",
  {},
) {}

export interface PrimeAgentRuntimeGeneration {
  readonly _tag: "PrimeAgentRuntimeGeneration";
}

export interface PrimeAgentMaterializedIdentity {
  readonly instanceId: ProviderInstanceId;
  readonly generation: PrimeAgentRuntimeGeneration;
  readonly configRevision: string;
  readonly effectiveHome: string;
  readonly launchEnv: Readonly<Record<string, string>>;
  readonly settings: Readonly<PrimeAgentSettings>;
}

export interface PrimeAgentNativeProofIdentity {
  readonly sdkFeatures: ReadonlyArray<string>;
  readonly requiredServerCapabilities: readonly [
    typeof PRIME_AGENT_CALLER_OWNED_SESSION_FEATURE,
    typeof PRIME_AGENT_AUTHORITATIVE_CLEANUP_CAPABILITY,
  ];
}

export type PrimeAgentRuntimeBackendIdentity =
  | {
      readonly kind: "acp";
      readonly fallbackCategory?: "launch-args" | "binary-resolution" | "daemon-setup";
    }
  | {
      readonly kind: "daemon";
      readonly proof: PrimeAgentNativeProofIdentity;
    };

export interface PrimeAgentRuntimeContext extends PrimeAgentMaterializedIdentity {
  readonly backendKind: PrimeAgentRuntimeBackendIdentity["kind"];
  readonly runtimeFence?: ProviderRuntimeFence | undefined;
  readonly backendIdentity: PrimeAgentRuntimeBackendIdentity;
}

export interface PrimeAgentIdentityInput {
  readonly instanceId: ProviderInstanceId;
  readonly environment: ProviderInstanceEnvironment;
  readonly enabled: boolean;
  readonly config: PrimeAgentSettings;
}

export type PrimeAgentIdentityPreparation =
  | { readonly kind: "ready"; readonly identity: PrimeAgentMaterializedIdentity }
  | { readonly kind: "unavailable"; readonly error: ProviderDriverError };

function driverError(instanceId: ProviderInstanceId, detail: string): ProviderDriverError {
  return new ProviderDriverError({ driver: DRIVER_KIND, instanceId, detail });
}

function mergeEnvironment(
  hostEnvironment: NodeJS.ProcessEnv,
  overrides: ProviderInstanceEnvironment,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...hostEnvironment };
  for (const variable of overrides) merged[variable.name] = variable.value;
  return merged;
}

function readEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const normalizedName = name.toUpperCase();
  let result: string | undefined;
  for (const [candidate, value] of Object.entries(environment)) {
    if (candidate.toUpperCase() === normalizedName) result = value;
  }
  return result;
}

function expandHomeCandidate(input: {
  readonly configured: string;
  readonly effectiveOsHome: string | undefined;
  readonly path: Path.Path;
}): string | undefined {
  const configured = input.configured.trim();
  if (configured.length === 0) return undefined;
  const expanded =
    configured === "~"
      ? input.effectiveOsHome
      : configured.startsWith("~/")
        ? input.effectiveOsHome === undefined
          ? undefined
          : input.path.join(input.effectiveOsHome, configured.slice(2))
        : configured;
  return expanded !== undefined && input.path.isAbsolute(expanded)
    ? input.path.normalize(expanded)
    : undefined;
}

const canonicalizePrimeAgentHome = Effect.fn("canonicalizePrimeAgentHome")(function* (
  candidate: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let ancestor = path.normalize(candidate);
  const suffix: string[] = [];

  while (true) {
    const resolved = yield* Effect.result(fileSystem.realPath(ancestor));
    if (Result.isSuccess(resolved)) {
      const info = yield* fileSystem.stat(resolved.success);
      if (info.type !== "Directory") {
        return yield* new PrimeAgentHomeCanonicalizationError();
      }
      return suffix.length === 0 ? resolved.success : path.join(resolved.success, ...suffix);
    }
    const failure = resolved.failure;
    if (failure._tag !== "PlatformError" || failure.reason._tag !== "NotFound") {
      return yield* failure;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return yield* failure;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
});

function homesOverlap(
  path: Path.Path,
  left: string,
  right: string,
  caseInsensitive: boolean,
): boolean {
  const normalizedLeft = caseInsensitive ? left.toLowerCase() : left;
  const normalizedRight = caseInsensitive ? right.toLowerCase() : right;
  const relative = path.relative(normalizedLeft, normalizedRight);
  if (relative === "") return true;
  const rightInsideLeft =
    !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  if (rightInsideLeft) return true;
  const inverse = path.relative(normalizedRight, normalizedLeft);
  return !path.isAbsolute(inverse) && inverse !== ".." && !inverse.startsWith(`..${path.sep}`);
}

/**
 * Materialize every Prime identity in one pass before any Prime process, import,
 * network request, or probe. Explicit settings win over the merged environment;
 * the merged environment wins over the default derived from its effective HOME.
 */
export const materializePrimeAgentIdentities = Effect.fn("materializePrimeAgentIdentities")(
  function* (
    inputs: ReadonlyArray<PrimeAgentIdentityInput>,
  ): Effect.fn.Return<
    ReadonlyMap<ProviderInstanceId, PrimeAgentIdentityPreparation>,
    never,
    Crypto.Crypto | FileSystem.FileSystem | Path.Path
  > {
    const hostEnvironment = { ...(yield* HostProcessEnvironment) };
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const prepared = new Map<ProviderInstanceId, PrimeAgentIdentityPreparation>();
    const ready = new Map<ProviderInstanceId, PrimeAgentMaterializedIdentity>();

    for (const input of inputs) {
      const merged = mergeEnvironment(hostEnvironment, input.environment);
      const environmentAgentHome =
        readEnvironmentValue(merged, PRIME_AGENT_HOME_ENV)?.trim() ||
        readEnvironmentValue(merged, PRIME_AGENT_COMPAT_HOME_ENV)?.trim();
      const effectiveOsHome = expandHomeCandidate({
        configured: readEnvironmentValue(merged, "HOME")?.trim() ?? "",
        effectiveOsHome: undefined,
        path,
      });
      const configured =
        input.config.agentHomePath.trim() ||
        environmentAgentHome ||
        (effectiveOsHome === undefined ? "" : path.join(effectiveOsHome, ".prime", "agent"));
      const candidate = expandHomeCandidate({ configured, effectiveOsHome, path });
      if (candidate === undefined) {
        prepared.set(input.instanceId, {
          kind: "unavailable",
          error: driverError(input.instanceId, INVALID_HOME_REASON),
        });
        continue;
      }

      const canonical = yield* Effect.result(canonicalizePrimeAgentHome(candidate));
      if (Result.isFailure(canonical)) {
        prepared.set(input.instanceId, {
          kind: "unavailable",
          error: driverError(input.instanceId, HOME_RESOLUTION_FAILED_REASON),
        });
        continue;
      }

      const launchEnv: Record<string, string> = {};
      for (const [name, value] of Object.entries(merged)) {
        if (typeof value === "string" && !reservedPrimeAgentEnvironmentName(name)) {
          launchEnv[name] = value;
        }
      }
      launchEnv[PRIME_AGENT_HOME_ENV] = canonical.success;
      launchEnv[PRIME_AGENT_COMPAT_HOME_ENV] = canonical.success;
      const configRevision = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const identity = Object.freeze({
        instanceId: input.instanceId,
        generation: Object.freeze({ _tag: "PrimeAgentRuntimeGeneration" as const }),
        configRevision,
        effectiveHome: canonical.success,
        launchEnv: freezeStringRecord(launchEnv),
        settings: Object.freeze({
          ...input.config,
          enabled: input.enabled,
          agentHomePath: canonical.success,
          customModels: Object.freeze([...input.config.customModels]),
        }),
      }) satisfies PrimeAgentMaterializedIdentity;
      ready.set(input.instanceId, identity);
      prepared.set(input.instanceId, { kind: "ready", identity });
    }

    const overlapping = new Set<ProviderInstanceId>();
    const enabled = inputs.filter((input) => input.enabled);
    for (let leftIndex = 0; leftIndex < enabled.length; leftIndex += 1) {
      const leftInput = enabled[leftIndex];
      if (leftInput === undefined) continue;
      const left = ready.get(leftInput.instanceId);
      if (left === undefined) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < enabled.length; rightIndex += 1) {
        const rightInput = enabled[rightIndex];
        if (rightInput === undefined) continue;
        const right = ready.get(rightInput.instanceId);
        if (
          right !== undefined &&
          homesOverlap(
            path,
            left.effectiveHome,
            right.effectiveHome,
            platform === "darwin" || platform === "win32",
          )
        ) {
          overlapping.add(left.instanceId);
          overlapping.add(right.instanceId);
        }
      }
    }
    for (const instanceId of overlapping) {
      prepared.set(instanceId, {
        kind: "unavailable",
        error: driverError(instanceId, DISTINCT_HOME_REASON),
      });
    }
    return prepared;
  },
);

export function bindPrimeAgentRuntimeContext(
  identity: PrimeAgentMaterializedIdentity,
  backendIdentity: PrimeAgentRuntimeBackendIdentity,
  runtimeFence?: ProviderRuntimeFence,
): PrimeAgentRuntimeContext {
  if (runtimeFence !== undefined && runtimeFence.generation !== identity.generation) {
    throw new Error("Prime Agent runtime fence does not match its materialized generation.");
  }
  const immutableBackendIdentity: PrimeAgentRuntimeBackendIdentity =
    backendIdentity.kind === "daemon"
      ? Object.freeze({
          kind: "daemon",
          proof: Object.freeze({
            sdkFeatures: Object.freeze([...backendIdentity.proof.sdkFeatures]),
            requiredServerCapabilities: Object.freeze([
              ...backendIdentity.proof.requiredServerCapabilities,
            ]) as PrimeAgentNativeProofIdentity["requiredServerCapabilities"],
          }),
        })
      : Object.freeze({
          kind: "acp",
          ...(backendIdentity.fallbackCategory === undefined
            ? {}
            : { fallbackCategory: backendIdentity.fallbackCategory }),
        });
  return Object.freeze({
    ...identity,
    ...(runtimeFence === undefined ? {} : { runtimeFence }),
    backendKind: immutableBackendIdentity.kind,
    backendIdentity: immutableBackendIdentity,
  });
}
