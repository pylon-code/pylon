import type { JcodeSettings, ServerProviderModel } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { sanitizeJcodeLaunchEnvironment } from "../jcode/JcodeEnvironment.ts";
import { makeJcodeFeatureCapabilities } from "../jcode/JcodeFeatureCapabilities.ts";
import type { JcodeInstanceProbe } from "../jcode/JcodeInstanceManager.ts";
import { makeJcodeModelCapabilities } from "../jcode/JcodeModelOptions.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

/** Oldest Jcode build whose API surface Pylon's pinned SDK bridge supports. */
export const JCODE_MIN_RUNTIME_VERSION = "0.71.1";
/** Newest Jcode build Pylon has actually exercised. */
export const JCODE_TESTED_RUNTIME_VERSION = "0.75.2-dev";
/** API protocol major version the pinned SDK speaks. */
export const JCODE_SUPPORTED_PROTOCOL_VERSION = 1;
export const JCODE_VERSION_PROBE_TIMEOUT_MS = 4_000;

export const JCODE_APPROVALS_WARNING =
  "Jcode sessions run with full host access because SDK v1 cannot gate tool approvals.";

const JCODE_PRESENTATION = {
  displayName: "Jcode",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
  supportedRuntimeModes: ["full-access"],
  supportsBackgroundTextGeneration: false,
  supportsConversationRollback: false,
} as const;

export type JcodeVersionProbeReason = "missing" | "nonzero" | "timeout" | "malformed";

export class JcodeVersionProbeError extends Data.TaggedError("JcodeVersionProbeError")<{
  readonly reason: JcodeVersionProbeReason;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

/**
 * What Pylon learned by running the configured executable. Deliberately separate
 * from the instance observation below: the daemon's self-reported build string
 * describes whatever process is already running, not the binary Pylon spawns, so
 * one can never stand in for the other.
 */
export type JcodeExecutableObservation =
  | { readonly _tag: "Ready"; readonly version: string }
  | { readonly _tag: "Failed"; readonly error: JcodeVersionProbeError };

export function parseJcodeVersionOutput(output: string): string | undefined {
  // `jcode --version` prints `jcode v0.73.0`. The shared parser needs a word
  // boundary before the digits, and the `v` prefix removes it, so drop the
  // prefix before delegating.
  return parseGenericCliVersion(output.replace(/\bv(?=\d)/gu, "")) ?? undefined;
}

/**
 * Bounded executable-version observation.
 *
 * Invokes the configured binary with exactly `--version` under the sanitized
 * Jcode environment, so the probe can never inherit the home or socket
 * overrides that belong to a launched instance and report on the wrong process.
 */
export const probeJcodeExecutableVersion = Effect.fn("probeJcodeExecutableVersion")(
  function* (input: {
    readonly settings: JcodeSettings;
    readonly environment?: NodeJS.ProcessEnv;
  }): Effect.fn.Return<string, JcodeVersionProbeError, ChildProcessSpawner.ChildProcessSpawner> {
    const command = input.settings.binaryPath || "jcode";
    const environment = sanitizeJcodeLaunchEnvironment(input.environment ?? process.env);
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });

    const collected = yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    ).pipe(Effect.timeoutOption(JCODE_VERSION_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(collected)) {
      const error = collected.failure;
      const missing = isCommandMissingCause(error);
      return yield* new JcodeVersionProbeError({
        reason: missing ? "missing" : "nonzero",
        detail: missing
          ? `Jcode executable '${command}' is not installed or not on PATH.`
          : `Failed to execute '${command} --version'.`,
        cause: error,
      });
    }

    if (Option.isNone(collected.success)) {
      return yield* new JcodeVersionProbeError({
        reason: "timeout",
        detail: `'${command} --version' did not complete within ${JCODE_VERSION_PROBE_TIMEOUT_MS}ms.`,
      });
    }

    const output = collected.success.value;
    if (output.code !== 0) {
      return yield* new JcodeVersionProbeError({
        reason: "nonzero",
        detail: `'${command} --version' exited with code ${output.code}.`,
      });
    }

    const version = parseJcodeVersionOutput(`${output.stdout}\n${output.stderr}`);
    if (version === undefined) {
      return yield* new JcodeVersionProbeError({
        reason: "malformed",
        detail: `'${command} --version' did not report a parseable version.`,
      });
    }
    return version;
  },
);

/**
 * Jcode model slugs are the daemon's own model ids and sub-providers are the
 * route providers it reports. Routes the daemon marks unavailable (typically
 * missing credentials) are dropped rather than offered as guaranteed failures.
 */
function jcodeServerModelsFromProbe(probe: JcodeInstanceProbe): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const candidate of probe.models) {
    if (!candidate.available) continue;
    const slug = candidate.model.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const subProvider = candidate.provider?.trim();
    models.push({
      slug,
      name: slug,
      ...(subProvider ? { subProvider } : {}),
      isCustom: false,
      capabilities: makeJcodeModelCapabilities(),
    });
  }
  return models;
}

function jcodeDraft(input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: "ready" | "warning" | "error";
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly message: string;
}): ServerProviderDraft {
  return {
    ...buildServerProvider({
      presentation: JCODE_PRESENTATION,
      enabled: input.enabled,
      checkedAt: input.checkedAt,
      models: input.models,
      probe: {
        installed: input.installed,
        version: input.version,
        status: input.status,
        auth: { status: "unknown" },
        message: input.message,
      },
    }),
    featureCapabilities: makeJcodeFeatureCapabilities(),
  };
}

function jcodeDisabledSnapshot(checkedAt: string): ServerProviderDraft {
  return jcodeDraft({
    enabled: false,
    checkedAt,
    installed: false,
    version: null,
    // `buildServerProvider` reports `disabled` for a disabled provider; this
    // status only describes what the probe would have said.
    status: "warning",
    models: [],
    message: "Jcode is disabled in Pylon settings.",
  });
}

function executableFailureMessage(error: JcodeVersionProbeError): string {
  switch (error.reason) {
    case "missing":
      return "Jcode is not installed or not on PATH.";
    case "timeout":
      return `Jcode did not respond to \`jcode --version\` within ${JCODE_VERSION_PROBE_TIMEOUT_MS}ms.`;
    case "nonzero":
      return "Jcode is installed but failed to run `jcode --version`.";
    case "malformed":
      return "Jcode ran, but Pylon could not determine its version.";
  }
}

/**
 * Combines the two independent observations into one snapshot.
 *
 * `instance` is absent until a private Jcode instance has been probed; the
 * provider is still usable then, it just has no model catalog to publish yet.
 */
export function buildJcodeProviderSnapshot(input: {
  readonly settings: JcodeSettings;
  readonly checkedAt: string;
  readonly executable: JcodeExecutableObservation;
  readonly instance?: JcodeInstanceProbe | undefined;
}): ServerProviderDraft {
  if (!input.settings.enabled) return jcodeDisabledSnapshot(input.checkedAt);

  const draft = (partial: Omit<Parameters<typeof jcodeDraft>[0], "enabled" | "checkedAt">) =>
    jcodeDraft({ enabled: true, checkedAt: input.checkedAt, ...partial });

  if (input.executable._tag === "Failed") {
    return draft({
      installed: input.executable.error.reason !== "missing",
      version: null,
      status: "error",
      models: [],
      message: executableFailureMessage(input.executable.error),
    });
  }

  const version = input.executable.version;
  if (compareSemverVersions(version, JCODE_MIN_RUNTIME_VERSION) < 0) {
    return draft({
      installed: true,
      version,
      status: "error",
      models: [],
      message: `Jcode ${version} is older than the minimum supported version ${JCODE_MIN_RUNTIME_VERSION}. Update Jcode to use it in Pylon.`,
    });
  }

  const instance = input.instance;
  if (instance !== undefined && instance.protocolVersion !== JCODE_SUPPORTED_PROTOCOL_VERSION) {
    // An incompatible protocol is a harder failure than an untested version, so
    // it replaces the newer-than-tested advisory instead of adding to it.
    return draft({
      installed: true,
      version,
      status: "error",
      models: [],
      message: `Jcode reported API protocol version ${instance.protocolVersion}, but Pylon supports protocol version ${JCODE_SUPPORTED_PROTOCOL_VERSION}.`,
    });
  }

  // Only advise about an untested build once the protocol is known to match;
  // otherwise the version is the least of the caller's problems.
  const untested =
    instance !== undefined && compareSemverVersions(version, JCODE_TESTED_RUNTIME_VERSION) > 0;
  return draft({
    installed: true,
    version,
    status: "ready",
    models: instance === undefined ? [] : jcodeServerModelsFromProbe(instance),
    message: untested
      ? `Jcode ${version} is newer than the ${JCODE_TESTED_RUNTIME_VERSION} build Pylon has tested. ${JCODE_APPROVALS_WARNING}`
      : JCODE_APPROVALS_WARNING,
  });
}

/**
 * Runs the executable observation and folds it together with an already-taken
 * instance observation. A disabled provider spawns nothing.
 */
export const checkJcodeProviderStatus = Effect.fn("checkJcodeProviderStatus")(function* (input: {
  readonly settings: JcodeSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly instance?: JcodeInstanceProbe | undefined;
}): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!input.settings.enabled) return jcodeDisabledSnapshot(checkedAt);

  const probed = yield* probeJcodeExecutableVersion({
    settings: input.settings,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
  }).pipe(Effect.result);

  if (Result.isFailure(probed)) {
    yield* Effect.logWarning("Jcode executable version probe failed.", {
      reason: probed.failure.reason,
    });
  }

  return buildJcodeProviderSnapshot({
    settings: input.settings,
    checkedAt,
    executable: Result.isFailure(probed)
      ? { _tag: "Failed", error: probed.failure }
      : { _tag: "Ready", version: probed.success },
    ...(input.instance === undefined ? {} : { instance: input.instance }),
  });
});
