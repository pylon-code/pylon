import {
  type ModelCapabilities,
  type PrimeAgentSettings,
  type ServerProvider,
  type ServerProviderDistribution,
  type ServerProviderModel,
  type ServerProviderBackend,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makePrimeAgentEnvironment } from "../acp/PrimeAgentAcpSupport.ts";
import { makePrimeAgentFeatureCapabilities } from "../prime/PrimeAgentFeatureCapabilities.ts";
import { makePrimeAgentModelCapabilities } from "../prime/PrimeAgentModelOptions.ts";
import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const PRIME_AGENT_PRESENTATION = {
  displayName: "Prime Agent",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
  supportedRuntimeModes: ["full-access"],
  supportsBackgroundTextGeneration: true,
  supportsConversationRollback: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const MODEL_DISCOVERY_REQUEST_ID = "pylon-prime-agent-models";

export function stampPrimeAgentBackendSnapshot(
  snapshot: ServerProviderDraft,
  backend:
    | {
        readonly runtime: "daemon";
        readonly inputQueue: boolean;
        readonly inputQueueModes: boolean;
        readonly inputQueueMutation: boolean;
        readonly agentCancel: boolean;
        readonly agentMessage: boolean;
        readonly agentLiveActivity?: boolean;
        readonly compaction: boolean;
        readonly refinement: boolean;
        readonly autoCompaction: boolean;
        readonly goals: boolean;
        readonly sideQuestions: boolean;
      }
    | { readonly runtime: "acp"; readonly fallbackMessage?: string },
): ServerProviderDraft {
  const fallbackMessage = backend.runtime === "acp" ? backend.fallbackMessage?.trim() : undefined;
  const message = [snapshot.message, fallbackMessage].filter(Boolean).join(" ");
  return {
    ...snapshot,
    featureCapabilities: makePrimeAgentFeatureCapabilities({
      runtime: backend.runtime,
      sessionUi: backend.runtime === "daemon",
      inputQueue: backend.runtime === "daemon" && backend.inputQueue,
      inputQueueModes: backend.runtime === "daemon" && backend.inputQueueModes,
      inputQueueMutation: backend.runtime === "daemon" && backend.inputQueueMutation,
      agentCancel: backend.runtime === "daemon" && backend.agentCancel,
      agentMessage: backend.runtime === "daemon" && backend.agentMessage,
      agentLiveActivity: backend.runtime === "daemon" && (backend.agentLiveActivity ?? false),
      compaction: backend.runtime === "daemon" && backend.compaction,
      refinement: backend.runtime === "daemon" && backend.refinement,
      autoCompaction: backend.runtime === "daemon" && backend.autoCompaction,
      goals: backend.runtime === "daemon" && backend.goals,
      sideQuestions: backend.runtime === "daemon" && backend.sideQuestions,
    }),
    models:
      backend.runtime === "daemon"
        ? snapshot.models
        : snapshot.models.map((model) => ({
            ...model,
            backgroundTextGenerationCapabilities: model.capabilities,
            capabilities: EMPTY_CAPABILITIES,
          })),
    requiresNewThreadForModelChange: backend.runtime === "acp",
    supportedRuntimeModes:
      backend.runtime === "daemon"
        ? (["approval-required", "full-access"] as const)
        : (["full-access"] as const),
    ...(message.length > 0 ? { message } : {}),
  };
}

const PRIME_AGENT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Prime Agent Default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

const PrimeAgentRpcModel = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  name: Schema.String,
  api: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  thinkingLevelMap: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  contextWindow: Schema.optional(Schema.Number),
});

const PrimeAgentModelDiscoveryRequest = Schema.Struct({
  id: Schema.Literal(MODEL_DISCOVERY_REQUEST_ID),
  type: Schema.Literal("get_available_models"),
});

const PrimeAgentModelDiscoveryResponse = Schema.Struct({
  id: Schema.Literal(MODEL_DISCOVERY_REQUEST_ID),
  type: Schema.Literal("response"),
  command: Schema.Literal("get_available_models"),
  success: Schema.Literal(true),
  data: Schema.Struct({
    models: Schema.Array(PrimeAgentRpcModel),
  }),
});

const encodePrimeAgentModelDiscoveryRequest = Schema.encodeSync(
  Schema.fromJsonString(PrimeAgentModelDiscoveryRequest),
);
const decodePrimeAgentModelDiscoveryResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(PrimeAgentModelDiscoveryResponse),
);

function qualifyPrimeAgentModelSlug(provider: string, id: string): string {
  // Prime resolves canonical CLI references as `${provider}/${model.id}`;
  // model ids may themselves contain slashes (notably Prime Inference).
  return `${provider}/${id}`;
}

export interface PrimeAgentDiscoveredModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly api?: string | undefined;
  readonly reasoning?: boolean | undefined;
  readonly thinkingLevelMap?: Readonly<Partial<Record<string, string | null>>> | undefined;
}

export function primeAgentServerModelsFromDiscoveredModels(
  discoveredModels: ReadonlyArray<PrimeAgentDiscoveredModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set(PRIME_AGENT_BUILT_IN_MODELS.map((model) => model.slug));
  const models: ServerProviderModel[] = [];
  for (const model of discoveredModels) {
    const provider = model.provider.trim();
    const id = model.id.trim();
    if (!provider || !id) continue;

    const slug = qualifyPrimeAgentModelSlug(provider, id);
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: model.name.trim() || slug,
      subProvider: provider,
      isCustom: false,
      capabilities: makePrimeAgentModelCapabilities({
        provider,
        id,
        ...(model.api === undefined ? {} : { api: model.api }),
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
        ...(model.thinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: model.thinkingLevelMap }),
      }),
    });
  }
  return models;
}

export function parsePrimeAgentModelDiscoveryOutput(
  output: string,
): ReadonlyArray<ServerProviderModel> | undefined {
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const decoded = decodePrimeAgentModelDiscoveryResponse(trimmed);
    if (Option.isNone(decoded)) continue;

    return primeAgentServerModelsFromDiscoveredModels(decoded.value.data.models);
  }
  return undefined;
}

export function primeAgentModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  discoveredModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [...PRIME_AGENT_BUILT_IN_MODELS, ...discoveredModels],
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

export function buildInitialPrimeAgentProviderSnapshot(
  settings: PrimeAgentSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = primeAgentModelsFromSettings(settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: PRIME_AGENT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Prime Agent is disabled in Pylon settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Prime Agent CLI availability...",
      },
    });
  });
}

const runPrimeAgentVersionCommand = (
  settings: PrimeAgentSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "prime-agent";
    const resolvedEnvironment = makePrimeAgentEnvironment(settings, environment);
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: resolvedEnvironment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: resolvedEnvironment,
        shell: spawnCommand.shell,
      }),
    );
  });

const discoverPrimeAgentModels = (
  settings: PrimeAgentSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "prime-agent";
    const args = ["--mode", "rpc", "--no-session", "--offline", "--cwd", process.cwd()] as const;
    const resolvedEnvironment = makePrimeAgentEnvironment(settings, environment);
    const spawnCommand = yield* resolveSpawnCommand(command, args, {
      env: resolvedEnvironment,
    });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: process.cwd(),
        env: resolvedEnvironment,
        shell: spawnCommand.shell,
      }),
    );
    const request = `${encodePrimeAgentModelDiscoveryRequest({
      id: MODEL_DISCOVERY_REQUEST_ID,
      type: "get_available_models",
    })}\n`;
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
        Stream.run(Stream.encodeText(Stream.make(request)), child.stdin),
      ],
      { concurrency: "unbounded" },
    );

    const models = exitCode === 0 ? parsePrimeAgentModelDiscoveryOutput(stdout) : undefined;
    return {
      models,
      exitCode,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
    };
  }).pipe(Effect.scoped);

const PRIME_AGENT_MODEL_DISCOVERY_FALLBACK_MESSAGES = new Set([
  "Prime Agent CLI is ready, but model discovery failed; using the fallback model catalog.",
  "Prime Agent CLI is ready, but model discovery timed out; using the fallback model catalog.",
]);
const PRIME_AGENT_LEGACY_AUTH_REQUIRED_MESSAGE =
  "No configured Prime Agent model provider was found. Run `prime-agent`, use `/login`, then refresh provider status.";

function hasConfiguredPrimeAgentModel(models: ReadonlyArray<ServerProviderModel>): boolean {
  return models.some((model) => model.slug !== "default" && model.isCustom !== true);
}

export function reconcilePrimeAgentDaemonCatalogSnapshot(snapshot: ServerProvider): ServerProvider {
  if (!snapshot.enabled || !snapshot.installed || snapshot.status !== "ready") {
    return snapshot;
  }

  const authenticated = hasConfiguredPrimeAgentModel(snapshot.models);
  const messageWithoutOwnedDiagnostics = (() => {
    if (snapshot.message === undefined) return undefined;
    if (
      snapshot.message === PRIME_AGENT_LEGACY_AUTH_REQUIRED_MESSAGE ||
      PRIME_AGENT_MODEL_DISCOVERY_FALLBACK_MESSAGES.has(snapshot.message)
    ) {
      return undefined;
    }
    const authSuffix = ` ${PRIME_AGENT_LEGACY_AUTH_REQUIRED_MESSAGE}`;
    return snapshot.message.endsWith(authSuffix)
      ? snapshot.message.slice(0, -authSuffix.length)
      : snapshot.message;
  })();
  const { message: _previousMessage, ...snapshotWithoutMessage } = snapshot;
  return {
    ...snapshotWithoutMessage,
    auth: { status: authenticated ? "authenticated" : "unknown" },
    ...(messageWithoutOwnedDiagnostics === undefined
      ? {}
      : { message: messageWithoutOwnedDiagnostics }),
  };
}

/** Bounds the backend sign-in read; it may reach the usage endpoint once. */
const BACKENDS_READ_TIMEOUT_MS = 10_000;

export const checkPrimeAgentProviderStatus = Effect.fn("checkPrimeAgentProviderStatus")(function* (
  settings: PrimeAgentSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options?: {
    readonly discoverModels?: boolean;
    /**
     * What Prime is signed in to per backend, supplied by the driver with its
     * filesystem and HTTP services already provided. Absent in tests and
     * wherever the sign-in is not worth reading; the snapshot then carries no
     * `backends` and clients treat capacity as assumed rather than verified.
     */
    readonly readBackends?: Effect.Effect<ReadonlyArray<ServerProviderBackend>>;
  },
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = primeAgentModelsFromSettings(settings.customModels);

  if (!settings.enabled) {
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Prime Agent is disabled in Pylon settings.",
      },
    });
  }

  const versionResult = yield* runPrimeAgentVersionCommand(settings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Prime Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Prime Agent CLI (`prime-agent`) is not installed or not on PATH."
          : "Failed to execute Prime Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Prime Agent CLI timed out while running `prime-agent --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}
${versionOutput.stderr}`);
  if (versionOutput.code !== 0 || version === null) {
    yield* Effect.logWarning("Prime Agent CLI version probe did not return a usable version.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          versionOutput.code === 0
            ? "Prime Agent CLI ran, but Pylon could not determine its version."
            : "Prime Agent CLI is installed but failed to run.",
      },
    });
  }

  let discoveredModels: ReadonlyArray<ServerProviderModel> | undefined;
  let discoveryMessage: string | undefined;
  if (options?.discoverModels !== false) {
    const discoveryResult = yield* discoverPrimeAgentModels(settings, environment).pipe(
      Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(discoveryResult)) {
      yield* Effect.logWarning("Prime Agent RPC model discovery failed.");
      discoveryMessage =
        "Prime Agent CLI is ready, but model discovery failed; using the fallback model catalog.";
    } else if (Option.isNone(discoveryResult.success)) {
      yield* Effect.logWarning(
        `Prime Agent RPC model discovery timed out after ${MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      );
      discoveryMessage =
        "Prime Agent CLI is ready, but model discovery timed out; using the fallback model catalog.";
    } else {
      const discovery = discoveryResult.success.value;
      discoveredModels = discovery.models;
      if (discoveredModels === undefined) {
        yield* Effect.logWarning("Prime Agent RPC model discovery returned no usable response.", {
          exitCode: discovery.exitCode,
          stdoutLength: discovery.stdoutLength,
          stderrLength: discovery.stderrLength,
        });
        discoveryMessage =
          "Prime Agent CLI is ready, but model discovery failed; using the fallback model catalog.";
      }
    }
  }

  const backends = options?.readBackends
    ? yield* options.readBackends.pipe(
        Effect.timeoutOption(BACKENDS_READ_TIMEOUT_MS),
        Effect.map(Option.getOrElse((): ReadonlyArray<ServerProviderBackend> => [])),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.succeed([] as ReadonlyArray<ServerProviderBackend>),
        ),
      )
    : [];

  return buildServerProvider({
    presentation: PRIME_AGENT_PRESENTATION,
    enabled: true,
    checkedAt,
    models:
      discoveredModels === undefined
        ? models
        : primeAgentModelsFromSettings(settings.customModels, discoveredModels),
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: {
        status:
          discoveredModels !== undefined && discoveredModels.length > 0
            ? "authenticated"
            : "unknown",
      },
      ...(discoveryMessage ? { message: discoveryMessage } : {}),
      backends,
    },
  });
});

export function applyPrimeAgentDistribution(
  snapshot: ServerProvider,
  distribution: ServerProviderDistribution,
): ServerProvider {
  const versionAdvisory =
    distribution.classification === "pylon-managed"
      ? {
          status: distribution.updateAvailable ? ("behind_latest" as const) : ("current" as const),
          currentVersion: distribution.buildId,
          latestVersion: distribution.latestBuildId,
          updateCommand: null,
          canUpdate: false,
          checkedAt: distribution.checkedAt,
          message: distribution.updateAvailable ? distribution.message : null,
        }
      : snapshot.versionAdvisory;
  return {
    ...snapshot,
    distribution,
    ...(versionAdvisory ? { versionAdvisory } : {}),
  };
}

export const enrichPrimeAgentSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly distribution: Effect.Effect<ServerProviderDistribution>;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const snapshot = yield* enrichProviderSnapshotWithVersionAdvisory(
      input.snapshot,
      input.maintenanceCapabilities,
      { enableProviderUpdateChecks: input.enableProviderUpdateChecks },
    ).pipe(Effect.provideService(HttpClient.HttpClient, input.httpClient));
    const distribution = yield* input.distribution;
    yield* input.publishSnapshot(applyPrimeAgentDistribution(snapshot, distribution));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Prime Agent distribution advisory enrichment failed", { cause }),
    ),
    Effect.asVoid,
  );
