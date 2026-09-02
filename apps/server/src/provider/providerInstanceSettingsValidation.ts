import {
  PrimeAgentSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const PRIME_DRIVER = ProviderDriverKind.make("primeAgent");
export const PRIME_AGENT_SUPPORTED_INSTANCE_LIMIT = 4;
export const PRIME_AGENT_DISTINCT_HOME_GUIDANCE =
  "Each enabled Prime Agent instance needs a distinct, non-nested Agent home and a separate Prime sign-in. The home owns that instance's credentials, settings, models, sessions, sockets, checkpoints, and MCP state.";
export const PRIME_AGENT_GLOBAL_MAINTENANCE_GUIDANCE =
  "Pylon manages only its instance-owned Prime processes. OS-user-global Prime update, doctor, shutdown, and stop-all maintenance stays external and is never run for an instance.";
export const NATIVE_WINDOWS_MULTIPLE_INSTANCES_REASON =
  "Multiple Prime Agent instances are unavailable on native Windows. Run the Pylon server and Prime Agent inside WSL2, which uses the supported Linux runtime.";
export const PRIME_AGENT_ACP_ONLY_SETTINGS_REASON =
  "Multiple Prime Agent instances are native-only, but custom Prime launch arguments require ACP compatibility. Remove the launch arguments or reduce the enabled Prime set to one.";
export const PRIME_AGENT_MULTIPLE_INSTANCES_GRADUATION_REASON =
  "Multiple Prime Agent instances remain disabled until the signed-in N=1/2/4 macOS proof and enforced Linux/WSL2 hosted contract prove separate homes, credentials, catalogs, capacity, MCP bearer calls, canonical checkpoints, and conservative resource limits.";

const MULTIPLE_INSTANCE_SUPPORT = new Map<string, boolean>([
  ["codex", true],
  ["claudeAgent", true],
  ["cursor", true],
  ["grok", true],
  ["opencode", true],
]);

export interface ProviderMultipleInstanceSupport {
  readonly supported: boolean;
  readonly reason?: string | undefined;
}

export function getProviderMultipleInstanceSupport(
  driver: string,
  platform: NodeJS.Platform,
): ProviderMultipleInstanceSupport {
  if (driver === PRIME_DRIVER) {
    return {
      supported: false,
      reason:
        platform === "win32"
          ? NATIVE_WINDOWS_MULTIPLE_INSTANCES_REASON
          : PRIME_AGENT_MULTIPLE_INSTANCES_GRADUATION_REASON,
    };
  }
  if (MULTIPLE_INSTANCE_SUPPORT.get(driver) === true) return { supported: true };
  return {
    supported: false,
    reason: `Driver '${driver}' has not proved support for multiple enabled instances.`,
  };
}

function effectiveProviderInstances(settings: ServerSettings): ProviderInstanceConfigMap {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };
  for (const [driver, config] of Object.entries(settings.providers)) {
    const id = ProviderInstanceId.make(driver);
    if (id in merged) continue;
    merged[id] = { driver: ProviderDriverKind.make(driver), config };
  }
  return merged as ProviderInstanceConfigMap;
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const normalized = name.toUpperCase();
  let value: string | undefined;
  for (const [candidate, candidateValue] of Object.entries(environment)) {
    if (candidate.toUpperCase() === normalized) value = candidateValue;
  }
  return value;
}

const canonicalizeHome = Effect.fn("canonicalizeProviderInstanceHome")(function* (
  candidate: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let ancestor = path.normalize(candidate);
  const suffix: string[] = [];
  while (true) {
    const resolved = yield* Effect.result(fileSystem.realPath(ancestor));
    if (Result.isSuccess(resolved)) {
      const info = yield* Effect.result(fileSystem.stat(resolved.success));
      if (Result.isFailure(info) || info.success.type !== "Directory") return null;
      return suffix.length === 0 ? resolved.success : path.join(resolved.success, ...suffix);
    }
    const failure = resolved.failure;
    if (failure._tag !== "PlatformError" || failure.reason._tag !== "NotFound") return null;
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return null;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
});

const resolvePrimeHome = Effect.fn("resolvePrimeProviderInstanceHome")(function* (input: {
  readonly instance: ProviderInstanceConfig;
  readonly config: PrimeAgentSettings;
  readonly hostEnvironment: NodeJS.ProcessEnv;
}) {
  const path = yield* Path.Path;
  const merged: Record<string, string | undefined> = { ...input.hostEnvironment };
  for (const variable of input.instance.environment ?? []) merged[variable.name] = variable.value;
  const effectiveOsHome = environmentValue(merged, "HOME")?.trim();
  const configured = input.config.agentHomePath.trim();
  const fromEnvironment =
    environmentValue(merged, "PRIME_AGENT_CODING_AGENT_DIR")?.trim() ||
    environmentValue(merged, "PRIME_AGENT_HOME")?.trim();
  const candidate =
    configured ||
    fromEnvironment ||
    (effectiveOsHome ? path.join(effectiveOsHome, ".prime", "agent") : "");
  const expanded =
    candidate === "~"
      ? effectiveOsHome
      : candidate.startsWith("~/") && effectiveOsHome
        ? path.join(effectiveOsHome, candidate.slice(2))
        : candidate;
  if (!expanded || !path.isAbsolute(expanded)) return null;
  return yield* canonicalizeHome(expanded);
});

function homesOverlap(
  path: Path.Path,
  left: string,
  right: string,
  caseInsensitive: boolean,
): boolean {
  const a = caseInsensitive ? left.toLowerCase() : left;
  const b = caseInsensitive ? right.toLowerCase() : right;
  const relative = path.relative(a, b);
  if (relative === "") return true;
  if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
    return true;
  }
  const inverse = path.relative(b, a);
  return !path.isAbsolute(inverse) && inverse !== ".." && !inverse.startsWith(`..${path.sep}`);
}

export class ProviderInstanceSettingsValidationError extends Schema.TaggedErrorClass<ProviderInstanceSettingsValidationError>()(
  "ProviderInstanceSettingsValidationError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Validate the complete next host configuration before it is persisted. */
export const validateProviderInstanceSettings = Effect.fn("validateProviderInstanceSettings")(
  function* (input: {
    readonly settings: ServerSettings;
    readonly platform: NodeJS.Platform;
    readonly hostEnvironment: NodeJS.ProcessEnv;
  }) {
    const instances = effectiveProviderInstances(input.settings);
    const enabledByDriver = new Map<string, Array<readonly [string, ProviderInstanceConfig]>>();
    for (const [instanceId, instance] of Object.entries(instances)) {
      if (!resolveProviderInstanceEnabled(instance)) continue;
      const entries = enabledByDriver.get(instance.driver) ?? [];
      entries.push([instanceId, instance]);
      enabledByDriver.set(instance.driver, entries);
    }

    const primeEntries = enabledByDriver.get(PRIME_DRIVER) ?? [];
    if (primeEntries.length > PRIME_AGENT_SUPPORTED_INSTANCE_LIMIT) {
      return yield* new ProviderInstanceSettingsValidationError({
        detail: `Prime Agent supports at most ${PRIME_AGENT_SUPPORTED_INSTANCE_LIMIT} enabled instances on one Pylon server.`,
      });
    }
    if (primeEntries.length >= 2) {
      const decodePrime = Schema.decodeUnknownEffect(PrimeAgentSettings);
      const homes: Array<readonly [string, string]> = [];
      for (const [instanceId, instance] of primeEntries) {
        const decoded = yield* decodePrime(instance.config ?? {}).pipe(Effect.result);
        if (Result.isFailure(decoded)) {
          return yield* new ProviderInstanceSettingsValidationError({
            detail: `Prime Agent instance '${instanceId}' has invalid settings.`,
          });
        }
        if (decoded.success.launchArgs.trim().length > 0) {
          return yield* new ProviderInstanceSettingsValidationError({
            detail: `Prime Agent instance '${instanceId}' is explicitly ACP-only. ${PRIME_AGENT_ACP_ONLY_SETTINGS_REASON}`,
          });
        }
        const home = yield* resolvePrimeHome({
          instance,
          config: decoded.success,
          hostEnvironment: input.hostEnvironment,
        });
        if (home === null) {
          return yield* new ProviderInstanceSettingsValidationError({
            detail: `Prime Agent instance '${instanceId}' needs a safe absolute Agent home. ${PRIME_AGENT_DISTINCT_HOME_GUIDANCE}`,
          });
        }
        homes.push([instanceId, home]);
      }

      const path = yield* Path.Path;
      for (let left = 0; left < homes.length; left += 1) {
        for (let right = left + 1; right < homes.length; right += 1) {
          const a = homes[left];
          const b = homes[right];
          if (
            a &&
            b &&
            homesOverlap(
              path,
              a[1],
              b[1],
              input.platform === "darwin" || input.platform === "win32",
            )
          ) {
            return yield* new ProviderInstanceSettingsValidationError({
              detail: `Prime Agent instances '${a[0]}' and '${b[0]}' have equal, nested, or symlink-aliased homes. ${PRIME_AGENT_DISTINCT_HOME_GUIDANCE}`,
            });
          }
        }
      }
    }

    for (const [driver, entries] of enabledByDriver) {
      if (entries.length < 2) continue;
      const support = getProviderMultipleInstanceSupport(driver, input.platform);
      if (!support.supported) {
        return yield* new ProviderInstanceSettingsValidationError({
          detail: support.reason ?? `Driver '${driver}' supports only one enabled instance.`,
        });
      }
    }
  },
);
