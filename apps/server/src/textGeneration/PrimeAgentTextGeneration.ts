// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type ModelSelection,
  type PrimeAgentSettings,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  isProviderSendTurnSupportedImageMimeType,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { PRIME_AGENT_TEXT_GENERATION_HELPER_SOURCE } from "@t3tools/shared/primeAgentTextGenerationHelper";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import {
  makePrimeAgentEnvironment,
  PRIME_AGENT_HOME_ENV,
} from "../provider/acp/PrimeAgentAcpSupport.ts";
import { locatePrimeAgentPublicPackage } from "../provider/prime/PrimeAgentDaemonBridge.ts";
import {
  PRIME_AGENT_INHERIT_MODEL_OPTION,
  resolvePrimeAgentTurnControls,
} from "../provider/prime/PrimeAgentModelOptions.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PRIME_AGENT_TIMEOUT_MS = 180_000;
const PRIME_AGENT_FORCE_KILL_AFTER = "2 seconds";
const PRIME_AGENT_STDOUT_MAX_BYTES = 64 * 1024;
const PRIME_AGENT_STDERR_MAX_BYTES = 4 * 1024;
const PRIME_AGENT_MAX_IMAGE_AGGREGATE_BYTES = 16 * 1024 * 1024;

const HelperImage = Schema.Struct({
  data: Schema.String,
  mimeType: Schema.String,
});
const HelperInput = Schema.Struct({
  prompt: Schema.String,
  images: Schema.Array(HelperImage),
});
const encodeHelperInput = Schema.encodeEffect(Schema.fromJsonString(HelperInput));

type PrimeAgentTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

type HelperImageInput = typeof HelperImage.Type;

export interface PrimeAgentTextGenerationOptions {
  /** Test-only override; production uses the 180 second request boundary. */
  readonly timeoutMs?: number | undefined;
  /** Test-only hook used to prove a validated image identity cannot be swapped before open. */
  readonly beforeImageOpen?: ((filePath: string) => Effect.Effect<void, never>) | undefined;
}

function pathApiForPlatform(platform: NodeJS.Platform) {
  return platform === "win32" ? NodePath.win32 : NodePath.posix;
}

function environmentValueLast(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return environment[name];
  const entries = Object.entries(environment);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const [candidate, value] = entries[index]!;
    if (candidate.toUpperCase() === name.toUpperCase()) return value;
  }
  return undefined;
}

/** Apply Windows' case-insensitive, last-assignment-wins environment semantics. */
export function normalizePrimeAgentTextGenerationEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return { ...environment };
  const normalized = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(environment)) {
    normalized.set(name.toUpperCase(), value);
  }
  return Object.fromEntries(normalized);
}

function effectiveEnvironmentHome(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const pathApi = pathApiForPlatform(platform);
  const candidates =
    platform === "win32"
      ? [
          environmentValueLast(environment, "USERPROFILE", platform)?.trim(),
          `${environmentValueLast(environment, "HOMEDRIVE", platform)?.trim() ?? ""}${environmentValueLast(environment, "HOMEPATH", platform)?.trim() ?? ""}`,
        ]
      : [environment.HOME?.trim()];
  const configuredHome = candidates.find((candidate): candidate is string =>
    Boolean(candidate && pathApi.isAbsolute(candidate)),
  );
  if (configuredHome) {
    return pathApi.normalize(configuredHome);
  }
  return NodeOS.homedir();
}

/** Resolve Prime's final merged agent-dir environment for one helper cwd. */
export function resolvePrimeAgentTextGenerationHomePath(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
}): string {
  const platform = input.platform;
  const pathApi = pathApiForPlatform(platform);
  const effectiveHome = effectiveEnvironmentHome(input.environment, platform);
  const configured = environmentValueLast(
    input.environment,
    PRIME_AGENT_HOME_ENV,
    platform,
  )?.trim();
  if (!configured) return pathApi.join(effectiveHome, ".prime", "agent");
  const expanded =
    configured === "~"
      ? effectiveHome
      : configured.startsWith("~/") || configured.startsWith("~\\")
        ? pathApi.join(effectiveHome, configured.slice(2))
        : configured;
  return pathApi.isAbsolute(expanded)
    ? pathApi.resolve(expanded)
    : pathApi.resolve(input.cwd, expanded);
}

function textGenerationError(
  operation: PrimeAgentTextGenerationOperation,
  detail: string,
): TextGenerationError {
  return new TextGenerationError({ operation, detail });
}

function helperFailureDetail(stderr: string): string {
  const marker = stderr
    .split(/\r?\n/u)
    .map((line) => /^PYLON_PRIME_ERROR:(sdk|model|auth|quota|request|empty|oversize)$/u.exec(line))
    .find((match) => match !== null)?.[1];
  switch (marker) {
    case "sdk":
      return "The selected Prime Agent installation does not expose a compatible public SDK.";
    case "model":
      return "Prime Agent could not use the selected model or model options.";
    case "auth":
      return "Prime Agent authentication failed for the selected model provider.";
    case "quota":
      return "Prime Agent has no available capacity for the selected model provider.";
    case "empty":
      return "Prime Agent returned an empty response.";
    case "oversize":
      return "Prime Agent returned too much background text.";
    default:
      return "Prime Agent background text generation failed.";
  }
}

type PrimeAgentImageFileIdentity = Pick<FileSystem.File.Info, "type" | "dev" | "ino">;

/** Images fail closed when the platform cannot supply a stable positive inode. */
export function hasStablePrimeAgentImageFileIdentity(
  expected: PrimeAgentImageFileIdentity,
  actual: PrimeAgentImageFileIdentity,
): boolean {
  if (expected.type !== "File" || actual.type !== "File" || expected.dev !== actual.dev) {
    return false;
  }
  const expectedIno = Option.getOrUndefined(expected.ino);
  const actualIno = Option.getOrUndefined(actual.ino);
  return (
    typeof expectedIno === "number" &&
    Number.isSafeInteger(expectedIno) &&
    expectedIno > 0 &&
    typeof actualIno === "number" &&
    Number.isSafeInteger(actualIno) &&
    actualIno > 0 &&
    expectedIno === actualIno
  );
}

function hasDeclaredImageMagic(bytes: Uint8Array, mimeType: string): boolean {
  const matches = (signature: ReadonlyArray<number>, offset = 0) =>
    signature.every((value, index) => bytes[offset + index] === value);
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return matches([0xff, 0xd8, 0xff]);
    case "image/gif":
      return (
        matches([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        matches([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      );
    case "image/webp":
      return matches([0x52, 0x49, 0x46, 0x46]) && matches([0x57, 0x45, 0x42, 0x50], 8);
    default:
      return false;
  }
}

/**
 * Build a background text-generation closure bound to one effective Prime
 * Agent instance. Every request uses a fresh isolated Node helper and the
 * selected installation's package-owned public SDK entry.
 */
export const makePrimeAgentTextGeneration = Effect.fn("makePrimeAgentTextGeneration")(function* (
  primeAgentSettings: PrimeAgentSettings,
  environment?: NodeJS.ProcessEnv,
  options: PrimeAgentTextGenerationOptions = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const hostPlatform = yield* HostProcessPlatform;
  const normalizedInputEnvironment = normalizePrimeAgentTextGenerationEnvironment(
    environment ?? process.env,
    hostPlatform,
  );
  const resolvedEnvironment = normalizePrimeAgentTextGenerationEnvironment(
    makePrimeAgentEnvironment(primeAgentSettings, normalizedInputEnvironment),
    hostPlatform,
  );
  const helperEnvironment = Object.fromEntries(
    Object.entries(resolvedEnvironment).filter(([name]) => {
      const normalizedName = name.toUpperCase();
      return (
        normalizedName !== "NODE_OPTIONS" &&
        normalizedName !== "NODE_PATH" &&
        normalizedName !== "FORCE_COLOR" &&
        normalizedName !== "NO_COLOR" &&
        normalizedName !== "CLICOLOR_FORCE" &&
        normalizedName !== PRIME_AGENT_HOME_ENV &&
        normalizedName !== "RLM_DEPTH" &&
        !normalizedName.startsWith("PRIME_AGENT_INTERNAL_") &&
        !normalizedName.startsWith("PYLON_PRIME_")
      );
    }),
  );
  const timeoutMs = options.timeoutMs ?? PRIME_AGENT_TIMEOUT_MS;

  const readBoundedImageFile = Effect.fn("readBoundedPrimeAgentImageFile")(function* (
    filePath: string,
    expectedInfo: FileSystem.File.Info,
    maxBytes: number,
  ): Effect.fn.Return<Uint8Array | null> {
    return yield* Effect.gen(function* () {
      if (options.beforeImageOpen) yield* options.beforeImageOpen(filePath);
      const file = yield* fileSystem.open(filePath, { flag: "r" });
      const openedInfo = yield* file.stat;
      const expectedBytes = Number(expectedInfo.size);
      if (
        !hasStablePrimeAgentImageFileIdentity(expectedInfo, openedInfo) ||
        !Number.isSafeInteger(expectedBytes) ||
        expectedBytes <= 0 ||
        expectedBytes > maxBytes
      ) {
        return null;
      }

      const buffer = new Uint8Array(expectedBytes + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.byteLength) {
        const read = Number(yield* file.read(buffer.subarray(bytesRead)));
        if (!Number.isSafeInteger(read) || read <= 0) break;
        bytesRead += read;
      }
      const [finalOpenedInfo, finalPathInfo] = yield* Effect.all([
        file.stat,
        fileSystem.stat(filePath),
      ]);
      return bytesRead === expectedBytes &&
        hasStablePrimeAgentImageFileIdentity(openedInfo, finalOpenedInfo) &&
        hasStablePrimeAgentImageFileIdentity(openedInfo, finalPathInfo)
        ? buffer.slice(0, bytesRead)
        : null;
    }).pipe(
      Effect.scoped,
      Effect.orElseSucceed(() => null),
    );
  });

  const materializeImageAttachments = Effect.fn("materializePrimeAgentImageAttachments")(function* (
    attachments: TextGeneration.BranchNameGenerationInput["attachments"],
  ): Effect.fn.Return<ReadonlyArray<HelperImageInput>> {
    const images: HelperImageInput[] = [];
    let totalImageBytes = 0;
    for (const attachment of attachments ?? []) {
      if (
        attachment.type !== "image" ||
        !isProviderSendTurnSupportedImageMimeType(attachment.mimeType)
      ) {
        continue;
      }
      const remainingBytes = PRIME_AGENT_MAX_IMAGE_AGGREGATE_BYTES - totalImageBytes;
      if (
        remainingBytes <= 0 ||
        attachment.sizeBytes <= 0 ||
        attachment.sizeBytes > remainingBytes
      ) {
        continue;
      }
      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) continue;

      const [canonicalRoot, canonicalFile] = yield* Effect.all([
        fileSystem.realPath(serverConfig.attachmentsDir).pipe(Effect.option),
        fileSystem.realPath(resolvedPath).pipe(Effect.option),
      ]);
      if (Option.isNone(canonicalRoot) || Option.isNone(canonicalFile)) continue;
      const relativePath = path.relative(canonicalRoot.value, canonicalFile.value);
      if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        continue;
      }

      const candidateInfo = yield* fileSystem.stat(canonicalFile.value).pipe(Effect.option);
      if (Option.isNone(candidateInfo) || candidateInfo.value.type !== "File") continue;
      const bytes = yield* readBoundedImageFile(
        canonicalFile.value,
        candidateInfo.value,
        Math.min(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, remainingBytes),
      );
      const mimeType = attachment.mimeType.toLowerCase();
      if (!bytes || !hasDeclaredImageMagic(bytes, mimeType)) continue;
      totalImageBytes += bytes.byteLength;
      images.push({
        data: Buffer.from(bytes).toString("base64"),
        mimeType,
      });
    }
    return images;
  });

  const runPrimeAgentJson = Effect.fn("runPrimeAgentJson")(function* <S extends Schema.Top>(input: {
    readonly operation: PrimeAgentTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly images?: ReadonlyArray<HelperImageInput> | undefined;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const controls = resolvePrimeAgentTurnControls(input.modelSelection);
    if (controls._tag === "Invalid") {
      return yield* textGenerationError(input.operation, controls.issue);
    }
    const thinking =
      controls.thinkingLevel === PRIME_AGENT_INHERIT_MODEL_OPTION
        ? undefined
        : controls.thinkingLevel;
    const serviceTier =
      controls.serviceTier === PRIME_AGENT_INHERIT_MODEL_OPTION ? undefined : controls.serviceTier;

    const agentDir = resolvePrimeAgentTextGenerationHomePath({
      environment: resolvedEnvironment,
      cwd: input.cwd,
      platform: hostPlatform,
    });
    const requestEnvironment = {
      ...helperEnvironment,
      NO_COLOR: "1",
      [PRIME_AGENT_HOME_ENV]: agentDir,
    };
    const executablePath = yield* resolveCommandPath(
      primeAgentSettings.binaryPath.trim() || "prime-agent",
      { env: requestEnvironment },
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() =>
        textGenerationError(
          input.operation,
          "The selected Prime Agent installation is unavailable.",
        ),
      ),
    );
    const publicPackage = yield* locatePrimeAgentPublicPackage(executablePath).pipe(
      Effect.mapError(() =>
        textGenerationError(
          input.operation,
          "The selected Prime Agent installation does not expose a compatible public SDK.",
        ),
      ),
    );
    const encodedInput = yield* encodeHelperInput({
      prompt: input.prompt,
      images: [...(input.images ?? [])],
    }).pipe(
      Effect.mapError(() =>
        textGenerationError(input.operation, "Failed to prepare Prime Agent input."),
      ),
    );

    const runHelper = Effect.gen(function* () {
      const helperPath = yield* fileSystem
        .makeTempFileScoped({ prefix: "pylon-prime-text-", suffix: ".mjs" })
        .pipe(
          Effect.tap((filePath) =>
            fileSystem.writeFileString(filePath, PRIME_AGENT_TEXT_GENERATION_HELPER_SOURCE),
          ),
          Effect.mapError(() =>
            textGenerationError(
              input.operation,
              "Failed to prepare isolated Prime Agent text generation.",
            ),
          ),
        );
      const isolatedSdkAgentDir = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "pylon-prime-sdk-home-" })
        .pipe(
          Effect.mapError(() =>
            textGenerationError(
              input.operation,
              "Failed to prepare isolated Prime Agent text generation.",
            ),
          ),
        );
      const command = ChildProcess.make(process.execPath, [helperPath], {
        cwd: input.cwd,
        env: {
          ...requestEnvironment,
          [PRIME_AGENT_HOME_ENV]: isolatedSdkAgentDir,
          PYLON_PRIME_SDK_ENTRY: publicPackage.moduleEntryPath,
          PYLON_PRIME_AGENT_DIR: agentDir,
          PYLON_PRIME_MODEL: input.modelSelection.model,
          PYLON_PRIME_THINKING: thinking ?? "",
          PYLON_PRIME_SERVICE_TIER: serviceTier ?? "",
        },
        extendEnv: false,
        shell: false,
        killSignal: "SIGTERM",
        forceKillAfter: PRIME_AGENT_FORCE_KILL_AFTER,
      });
      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError(() =>
            textGenerationError(
              input.operation,
              "Could not start isolated Prime Agent text generation.",
            ),
          ),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({
            stream: child.stdout,
            maxBytes: PRIME_AGENT_STDOUT_MAX_BYTES,
          }),
          collectUint8StreamText({
            stream: child.stderr,
            maxBytes: PRIME_AGENT_STDERR_MAX_BYTES,
          }),
          child.exitCode,
          Stream.run(Stream.encodeText(Stream.make(encodedInput)), child.stdin),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(() =>
          textGenerationError(input.operation, "Isolated Prime Agent text generation failed."),
        ),
      );
      return { stdout, stderr, exitCode: Number(exitCode) };
    });

    const completed = yield* runHelper.pipe(Effect.scoped, Effect.timeoutOption(timeoutMs));
    if (Option.isNone(completed)) {
      return yield* textGenerationError(
        input.operation,
        "Prime Agent background text generation timed out.",
      );
    }

    const result = completed.value;
    if (result.stdout.truncated) {
      return yield* textGenerationError(
        input.operation,
        "Prime Agent returned too much background text.",
      );
    }
    if (result.exitCode !== 0) {
      return yield* textGenerationError(input.operation, helperFailureDetail(result.stderr.text));
    }
    const rawOutput = result.stdout.text.trim();
    if (!rawOutput) {
      return yield* textGenerationError(input.operation, "Prime Agent returned an empty response.");
    }
    if (result.stdout.invalidUtf8) {
      return yield* textGenerationError(
        input.operation,
        "Prime Agent returned invalid structured output.",
      );
    }

    // Prompt builders own operation-specific schemas, so this decoder cannot be hoisted.
    // eslint-disable-next-line t3code/no-inline-schema-compile
    return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
      extractJsonObject(rawOutput),
    ).pipe(
      Effect.mapError(() =>
        textGenerationError(input.operation, "Prime Agent returned invalid structured output."),
      ),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PrimeAgentTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runPrimeAgentJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PrimeAgentTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runPrimeAgentJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PrimeAgentTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const images = yield* materializeImageAttachments(input.attachments);
      const generated = yield* runPrimeAgentJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        images,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PrimeAgentTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const images = yield* materializeImageAttachments(input.attachments);
      const generated = yield* runPrimeAgentJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        images,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return TextGeneration.TextGeneration.of({
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  });
});
