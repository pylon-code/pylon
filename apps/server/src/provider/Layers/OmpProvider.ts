import {
  type ModelCapabilities,
  type OmpSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  parseGenericCliVersion,
  ProviderCommandNotFoundError,
  providerModelsFromSettings,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const OMP_PRESENTATION = {
  displayName: "Oh My Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;

export type OmpProviderSettings = OmpSettings & { readonly enabled: boolean };
const OMP_VERSION_TIMEOUT_MS = 5_000;
const MINIMUM_OMP_ACP_VERSION = "15.13.1";
const OMP_MODELS_TIMEOUT_MS = 20_000;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export const DEFAULT_OMP_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Profile default",
  isCustom: false,
  isDefault: true,
  capabilities: EMPTY_CAPABILITIES,
};

const OMP_PROVIDER_WORD_LABELS: Readonly<Record<string, string>> = {
  ai: "AI",
  api: "API",
  github: "GitHub",
  gitlab: "GitLab",
  lm: "LM",
  openai: "OpenAI",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
  xai: "xAI",
  zai: "Z.AI",
};

interface OmpModelJson {
  readonly provider: string;
  readonly id: string;
  readonly selector: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly thinking: ReadonlyArray<string> | null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map(
      (part) =>
        OMP_PROVIDER_WORD_LABELS[part.toLowerCase()] ??
        `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
    )
    .join(" ");
}

function parseOmpModel(value: unknown): OmpModelJson | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const provider = nonEmptyString(record.provider);
  const id = nonEmptyString(record.id);
  const name = nonEmptyString(record.name);
  if (!provider || !id || !name) return undefined;
  const selector = nonEmptyString(record.selector) ?? `${provider}/${id}`;
  const thinking = Array.isArray(record.thinking)
    ? record.thinking.flatMap((entry) => (nonEmptyString(entry) ? [nonEmptyString(entry)!] : []))
    : null;
  return {
    provider,
    id,
    selector,
    name,
    reasoning: record.reasoning === true,
    thinking,
  };
}

export function parseOmpModelsJson(raw: string): ReadonlyArray<OmpModelJson> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const models = (parsed as Record<string, unknown>).models;
  if (!Array.isArray(models)) return undefined;
  return models.flatMap((model) => {
    const parsedModel = parseOmpModel(model);
    return parsedModel ? [parsedModel] : [];
  });
}

function ompModelCapabilities(model: OmpModelJson): ModelCapabilities {
  if (!model.reasoning) return EMPTY_CAPABILITIES;
  // The catalog reports only effort tiers, not the profile's live selection.
  // OMP ACP also accepts off/auto. Leave currentValue and isDefault absent so
  // choosing a model inherits its profile value until the user explicitly
  // selects one of these exact ACP values.
  const efforts = Array.from(new Set(["off", "auto", ...(model.thinking ?? [])]));
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "thinking",
        label: "Thinking",
        description: "Reasoning effort used by Oh My Pi for this model.",
        type: "select",
        options: efforts.map((effort) => ({
          id: effort,
          label: titleCase(effort),
        })),
      },
    ],
  });
}

export function buildOmpDiscoveredModels(
  models: ReadonlyArray<OmpModelJson>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const discovered: ServerProviderModel[] = [];
  for (const model of models) {
    if (seen.has(model.selector)) continue;
    seen.add(model.selector);
    discovered.push({
      slug: model.selector,
      name: model.name,
      subProvider: titleCase(model.provider),
      isCustom: false,
      capabilities: ompModelCapabilities(model),
    });
  }
  return discovered;
}

export function buildOmpCliArgs(
  settings: Pick<OmpSettings, "profile">,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const profile = settings.profile.trim();
  // OMP stops parsing global profile flags after a non-launch subcommand such
  // as `models`, so the profile must precede that subcommand. (`omp acp` is a
  // launch-shaped exception and is assembled separately by OmpAcpSupport.)
  return profile ? ["--profile", profile, ...args] : [...args];
}

const runOmpCommand = (
  settings: OmpSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(settings.binaryPath, [...args], {
        env: environment,
        shell: false,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout, { maxBytes: 4 * 1024 * 1024 }),
        collectStreamAsString(child.stderr, { maxBytes: 4 * 1024 * 1024 }),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0 && /is not recognized/u.test(stderr)) {
      return yield* new ProviderCommandNotFoundError({
        binaryPath: settings.binaryPath,
        exitCode,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });
    }
    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

export const makePendingOmpProvider = (
  settings: OmpProviderSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = providerModelsFromSettings(
      [DEFAULT_OMP_MODEL],
      settings.customModels,
      EMPTY_CAPABILITIES,
    );
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Oh My Pi availability..."
          : "Oh My Pi is disabled in Pylon settings.",
      },
    });
  });

function commandFailureMessage(command: string, result: CommandResult): string {
  return result.code === null
    ? `Oh My Pi \`${command}\` ended without an exit code.`
    : `Oh My Pi \`${command}\` exited with code ${result.code}.`;
}

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  settings: OmpProviderSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = providerModelsFromSettings(
    [DEFAULT_OMP_MODEL],
    settings.customModels,
    EMPTY_CAPABILITIES,
  );
  const buildFailure = (input: {
    readonly installed: boolean;
    readonly version?: string | null;
    readonly message: string;
    readonly status?: "warning" | "error";
  }) =>
    buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: input.installed,
        version: input.version ?? null,
        status: input.status ?? "error",
        auth: { status: "unknown" },
        message: input.message,
      },
    });

  if (!settings.enabled) {
    return buildFailure({
      installed: false,
      status: "warning",
      message: "Oh My Pi is disabled in Pylon settings.",
    });
  }

  const versionProbe = yield* runOmpCommand(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(OMP_VERSION_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionProbe)) {
    return buildFailure({
      installed: !isCommandMissingCause(versionProbe.failure),
      message: isCommandMissingCause(versionProbe.failure)
        ? "Oh My Pi CLI (`omp`) is not installed or not on PATH."
        : "Failed to execute the Oh My Pi CLI health check.",
    });
  }
  if (Option.isNone(versionProbe.success)) {
    return buildFailure({
      installed: true,
      message: "Oh My Pi CLI timed out while running `omp --version`.",
    });
  }
  const versionResult = versionProbe.success.value;
  if (versionResult.code !== 0) {
    return buildFailure({
      installed: true,
      message: commandFailureMessage("--version", versionResult),
    });
  }
  const version = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (!version) {
    return buildFailure({
      installed: true,
      message: "Unable to determine the installed Oh My Pi version from `omp --version`.",
    });
  }
  if (compareSemverVersions(version, MINIMUM_OMP_ACP_VERSION) < 0) {
    return buildFailure({
      installed: true,
      version,
      message: `Oh My Pi v${version} is too old. Pylon requires v${MINIMUM_OMP_ACP_VERSION} or newer (ACP + profiles). Run \`omp update\`.`,
    });
  }

  const modelsArgs = buildOmpCliArgs(settings, ["models", "--json", "--no-extensions"]);
  const modelsProbe = yield* runOmpCommand(settings, modelsArgs, environment).pipe(
    Effect.timeoutOption(OMP_MODELS_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(modelsProbe)) {
    return buildFailure({
      installed: true,
      version,
      status: fallbackModels.length > 0 ? "warning" : "error",
      message: "Failed to execute Oh My Pi model discovery.",
    });
  }
  if (Option.isNone(modelsProbe.success)) {
    return buildFailure({
      installed: true,
      version,
      status: fallbackModels.length > 0 ? "warning" : "error",
      message:
        "Oh My Pi model discovery timed out while running `omp models --json --no-extensions`.",
    });
  }
  const modelsResult = modelsProbe.success.value;
  if (modelsResult.code !== 0) {
    return buildFailure({
      installed: true,
      version,
      status: fallbackModels.length > 0 ? "warning" : "error",
      message: commandFailureMessage("models --json", modelsResult),
    });
  }
  const parsedModels = parseOmpModelsJson(modelsResult.stdout);
  if (!parsedModels) {
    return buildFailure({
      installed: true,
      version,
      status: fallbackModels.length > 0 ? "warning" : "error",
      message: "Oh My Pi returned invalid JSON from `omp models --json --no-extensions`.",
    });
  }

  const discoveredModels = buildOmpDiscoveredModels(parsedModels).filter(
    (model) => model.slug !== DEFAULT_OMP_MODEL.slug,
  );
  const models = providerModelsFromSettings(
    [DEFAULT_OMP_MODEL, ...discoveredModels],
    settings.customModels,
    EMPTY_CAPABILITIES,
  );
  const hasDiscoveredModel = discoveredModels.length > 0;
  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: hasDiscoveredModel ? "ready" : "warning",
      auth: { status: "unknown" },
      ...(!hasDiscoveredModel
        ? {
            message:
              "Oh My Pi returned an empty model catalog. Pylon will ask it to use the profile default.",
          }
        : {}),
    },
  });
});
