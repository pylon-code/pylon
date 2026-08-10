// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const PRIME_AGENT_DAEMON_PROTOCOL_NAME = "prime-agent.daemon" as const;
export const PRIME_AGENT_MIN_DAEMON_PROTOCOL_VERSION = 7 as const;

const bridgeErrorReason = Schema.Literals([
  "path-not-found",
  "package-not-found",
  "wrong-package",
  "invalid-package-manifest",
  "invalid-public-entry",
  "module-import-failed",
  "incompatible-version",
  "incompatible-protocol",
  "incompatible-exports",
]);

export class PrimeAgentDaemonBridgeError extends Schema.TaggedErrorClass<PrimeAgentDaemonBridgeError>()(
  "PrimeAgentDaemonBridgeError",
  {
    binaryPath: Schema.String,
    reason: bridgeErrorReason,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Prime Agent daemon bridge failed (${this.reason}) for '${this.binaryPath}': ${this.detail}`;
  }
}

export interface PrimeAgentDaemonClient {
  readonly isConnected: boolean;
  readonly connect: (timeoutMs?: number) => Promise<void>;
  readonly waitForHello: (timeoutMs?: number) => Promise<unknown>;
  readonly request: (
    command: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ) => Promise<unknown>;
  readonly enableRequestRecovery?: () => void;
  readonly enableAutoReconnect?: (options: {
    readonly recoverDaemon: () => Promise<void>;
    readonly timeoutMs?: number;
  }) => void;
  readonly close: () => void;
}

export interface PrimeAgentDaemonImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface PrimeAgentDaemonPromptOptions {
  readonly images?: ReadonlyArray<PrimeAgentDaemonImage>;
  readonly queueIfBusy?: boolean;
  readonly signal?: AbortSignal;
}

export type PrimeAgentDaemonExtensionUiResponse =
  | { readonly value: string }
  | { readonly confirmed: boolean }
  | { readonly cancelled: true };

export type PrimeAgentDaemonThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type PrimeAgentDaemonServiceTier = "auto" | "default" | "flex" | "scale" | "priority" | null;

export type PrimeAgentDaemonQueueMode = "all" | "one-at-a-time";

export interface PrimeAgentDaemonClientConstructor {
  new (socketPath: string): PrimeAgentDaemonClient;
}

export interface PrimeAgentDaemonSessionWatcher {
  readonly getMessages: () => Promise<ReadonlyArray<unknown>>;
  readonly subscribe: (listener: (event: unknown) => void | Promise<void>) => () => void;
  readonly close: () => Promise<void>;
}

export interface PrimeAgentDaemonAgentConnection {
  readonly subscribe: (listener: (event: unknown) => void | Promise<void>) => () => void;
  readonly getInitialSnapshot: () => Promise<unknown>;
  readonly getState?: () => Promise<unknown>;
  readonly promptAndWait: (
    message: string,
    options?: PrimeAgentDaemonPromptOptions,
  ) => Promise<unknown>;
  readonly steer?: (
    message: string,
    images?: ReadonlyArray<PrimeAgentDaemonImage>,
  ) => Promise<unknown>;
  readonly followUp?: (
    message: string,
    images?: ReadonlyArray<PrimeAgentDaemonImage>,
  ) => Promise<unknown>;
  readonly abort: () => Promise<unknown>;
  readonly abortAndClearQueue?: () => Promise<unknown>;
  readonly cancelRlmChild?: (childId: string) => Promise<unknown>;
  readonly sendAgentMessage?: (targetActiveSessionId: string, message: string) => Promise<unknown>;
  /** Public read-only attachment to another live session; never receives client input directly. */
  readonly watchSession?: (
    activeSessionId: string,
  ) => Promise<PrimeAgentDaemonSessionWatcher | undefined>;
  readonly getQueue?: () => Promise<unknown>;
  readonly clearQueue?: () => Promise<unknown>;
  readonly setSteeringMode?: (mode: PrimeAgentDaemonQueueMode) => Promise<unknown>;
  readonly setFollowUpMode?: (mode: PrimeAgentDaemonQueueMode) => Promise<unknown>;
  readonly compact?: () => Promise<unknown>;
  readonly refine?: (options: { readonly global: false }) => Promise<unknown>;
  readonly abortCompaction?: () => Promise<unknown>;
  readonly setAutoCompactionEnabled?: (enabled: boolean) => Promise<unknown>;
  readonly setModel?: (provider: string, modelId: string) => Promise<unknown>;
  readonly setThinkingLevel?: (level: PrimeAgentDaemonThinkingLevel) => Promise<unknown>;
  readonly setServiceTier?: (tier: PrimeAgentDaemonServiceTier) => Promise<unknown>;
  readonly respondToExtensionUiRequest?: (
    requestId: string,
    response: PrimeAgentDaemonExtensionUiResponse,
  ) => Promise<unknown>;
  readonly getCommands: () => Promise<unknown>;
  readonly getResourceSnapshot: () => Promise<unknown>;
  readonly reload: () => Promise<unknown>;
  readonly getSessionStats: () => Promise<unknown>;
  readonly getRlmMaxDepthStatus?: () => Promise<unknown>;
  readonly setRlmMaxDepth?: (maxDepth: number) => Promise<unknown>;
  readonly dispose: () => Promise<unknown>;
}

export interface PrimeAgentDaemonAgentConnectionConstructor {
  new (
    client: PrimeAgentDaemonClient,
    activeSessionId: string,
    options?: Readonly<Record<string, unknown>>,
  ): PrimeAgentDaemonAgentConnection;
  readonly attach: (
    client: PrimeAgentDaemonClient,
    activeSessionId: string,
    options?: Readonly<Record<string, unknown>>,
  ) => Promise<PrimeAgentDaemonAgentConnection>;
}

export interface PrimeAgentDaemonBridge {
  readonly packageRoot: string;
  readonly moduleEntryPath: string;
  readonly version: string;
  readonly protocolName: typeof PRIME_AGENT_DAEMON_PROTOCOL_NAME;
  readonly protocolVersion: number;
  readonly DaemonClient: PrimeAgentDaemonClientConstructor;
  readonly DaemonAgentConnection: PrimeAgentDaemonAgentConnectionConstructor;
  readonly defaultDaemonSocketPath: () => string;
}

const packageIdentitySchema = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
});

const primeAgentPackageSchema = Schema.Struct({
  name: Schema.Literal("prime-agent"),
  version: Schema.String,
  exports: Schema.Union([
    Schema.String,
    Schema.Struct({ ".": Schema.String }),
    Schema.Struct({ ".": Schema.Struct({ import: Schema.String }) }),
  ]),
});

const moduleMetadataSchema = Schema.Struct({
  VERSION: Schema.String,
  DAEMON_PROTOCOL_NAME: Schema.String,
  DAEMON_PROTOCOL_VERSION: Schema.Int,
});

const decodePackageIdentity = Schema.decodeUnknownOption(packageIdentitySchema);
const decodePrimeAgentPackage = Schema.decodeUnknownOption(primeAgentPackageSchema);
const decodeModuleMetadata = Schema.decodeUnknownOption(moduleMetadataSchema);
const isPrimeAgentDaemonBridgeError = Schema.is(PrimeAgentDaemonBridgeError);

interface LocatedPackage {
  readonly root: string;
  readonly manifest: Schema.Schema.Type<typeof primeAgentPackageSchema>;
}

function bridgeError(
  binaryPath: string,
  reason: PrimeAgentDaemonBridgeError["reason"],
  detail: string,
  cause?: unknown,
): PrimeAgentDaemonBridgeError {
  return new PrimeAgentDaemonBridgeError({
    binaryPath,
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

async function readJson(filePath: string): Promise<unknown> {
  const source = await NodeFSP.readFile(filePath, "utf8");
  return JSON.parse(source) as unknown;
}

async function locatePrimeAgentPackage(binaryPath: string): Promise<LocatedPackage> {
  let canonicalPath: string;
  try {
    canonicalPath = await NodeFSP.realpath(binaryPath);
  } catch (cause) {
    throw bridgeError(
      binaryPath,
      "path-not-found",
      "The configured Prime Agent executable does not exist or cannot be resolved.",
      cause,
    );
  }

  const canonicalStat = await NodeFSP.stat(canonicalPath);
  let directory = canonicalStat.isDirectory() ? canonicalPath : NodePath.dirname(canonicalPath);
  let nearestWrongPackage: { readonly root: string; readonly name: string } | undefined;
  let nearestInvalidManifest: { readonly root: string; readonly cause: unknown } | undefined;

  while (true) {
    const manifestPath = NodePath.join(directory, "package.json");
    try {
      const rawManifest = await readJson(manifestPath);
      const identity = decodePackageIdentity(rawManifest);
      if (Option.isNone(identity)) {
        nearestInvalidManifest ??= {
          root: directory,
          cause: new Error("package.json must contain string name and version fields"),
        };
      } else if (identity.value.name === "prime-agent") {
        const manifest = decodePrimeAgentPackage(rawManifest);
        if (Option.isNone(manifest)) {
          throw bridgeError(
            binaryPath,
            "invalid-package-manifest",
            `The prime-agent package at '${directory}' does not expose a supported public ESM entry.`,
          );
        }
        return { root: directory, manifest: manifest.value };
      } else {
        nearestWrongPackage ??= { root: directory, name: identity.value.name };
      }
    } catch (cause) {
      if (isPrimeAgentDaemonBridgeError(cause)) throw cause;
      if (
        Predicate.isObject(cause) &&
        "code" in cause &&
        (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      ) {
        // Most ancestors are not package roots.
      } else {
        nearestInvalidManifest ??= { root: directory, cause };
      }
    }

    const parent = NodePath.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  if (nearestInvalidManifest) {
    throw bridgeError(
      binaryPath,
      "invalid-package-manifest",
      `Could not read a valid package manifest at '${nearestInvalidManifest.root}'.`,
      nearestInvalidManifest.cause,
    );
  }
  if (nearestWrongPackage) {
    throw bridgeError(
      binaryPath,
      "wrong-package",
      `The executable belongs to '${nearestWrongPackage.name}' at '${nearestWrongPackage.root}', not prime-agent.`,
    );
  }
  throw bridgeError(
    binaryPath,
    "package-not-found",
    "No containing prime-agent package root was found for the configured executable.",
  );
}

function packagePublicEntry(manifest: LocatedPackage["manifest"]): string {
  if (Predicate.isString(manifest.exports)) return manifest.exports;
  const rootExport = manifest.exports["."];
  return Predicate.isString(rootExport) ? rootExport : rootExport.import;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${NodePath.sep}`) && relative !== "..");
}

async function resolvePublicEntry(binaryPath: string, located: LocatedPackage): Promise<string> {
  const relativeEntry = packagePublicEntry(located.manifest);
  if (!relativeEntry.startsWith("./")) {
    throw bridgeError(
      binaryPath,
      "invalid-public-entry",
      `The prime-agent public export must be package-relative; received '${relativeEntry}'.`,
    );
  }

  const candidate = NodePath.resolve(located.root, relativeEntry);
  if (!isPathInside(located.root, candidate)) {
    throw bridgeError(
      binaryPath,
      "invalid-public-entry",
      `The prime-agent public export escapes its package root: '${relativeEntry}'.`,
    );
  }

  try {
    const canonicalEntry = await NodeFSP.realpath(candidate);
    const stat = await NodeFSP.stat(canonicalEntry);
    if (!stat.isFile() || !isPathInside(located.root, canonicalEntry)) {
      throw new Error("public export is not a package-owned file");
    }
    return canonicalEntry;
  } catch (cause) {
    throw bridgeError(
      binaryPath,
      "invalid-public-entry",
      `The prime-agent public export '${relativeEntry}' is missing or unsafe.`,
      cause,
    );
  }
}

function requireDaemonExports(input: {
  readonly binaryPath: string;
  readonly loadedModule: unknown;
  readonly manifestVersion: string;
}): Omit<PrimeAgentDaemonBridge, "packageRoot" | "moduleEntryPath"> {
  const metadata = decodeModuleMetadata(input.loadedModule);
  if (Option.isNone(metadata)) {
    throw bridgeError(
      input.binaryPath,
      "incompatible-exports",
      "The prime-agent public API is missing VERSION or daemon protocol metadata.",
    );
  }
  if (
    metadata.value.VERSION.trim().length === 0 ||
    metadata.value.VERSION !== input.manifestVersion
  ) {
    throw bridgeError(
      input.binaryPath,
      "incompatible-version",
      `Public API VERSION '${metadata.value.VERSION}' does not match package version '${input.manifestVersion}'.`,
    );
  }
  if (
    metadata.value.DAEMON_PROTOCOL_NAME !== PRIME_AGENT_DAEMON_PROTOCOL_NAME ||
    metadata.value.DAEMON_PROTOCOL_VERSION < PRIME_AGENT_MIN_DAEMON_PROTOCOL_VERSION
  ) {
    throw bridgeError(
      input.binaryPath,
      "incompatible-protocol",
      `Pylon requires ${PRIME_AGENT_DAEMON_PROTOCOL_NAME} v${PRIME_AGENT_MIN_DAEMON_PROTOCOL_VERSION} or newer; installed prime-agent ${metadata.value.VERSION} provides '${metadata.value.DAEMON_PROTOCOL_NAME}' v${metadata.value.DAEMON_PROTOCOL_VERSION}.`,
    );
  }
  if (!Predicate.isObject(input.loadedModule)) {
    throw bridgeError(
      input.binaryPath,
      "incompatible-exports",
      "The prime-agent public entry did not evaluate to an ESM module namespace.",
    );
  }

  const daemonClient = input.loadedModule.DaemonClient;
  const daemonAgentConnection = input.loadedModule.DaemonAgentConnection;
  const defaultDaemonSocketPath = input.loadedModule.defaultDaemonSocketPath;
  if (
    !Predicate.isFunction(daemonClient) ||
    !Predicate.isObject(daemonClient.prototype) ||
    !Predicate.isFunction(daemonClient.prototype.connect) ||
    !Predicate.isFunction(daemonClient.prototype.waitForHello) ||
    !Predicate.isFunction(daemonClient.prototype.request) ||
    !Predicate.isFunction(daemonClient.prototype.close) ||
    !Predicate.isFunction(daemonAgentConnection) ||
    !("attach" in daemonAgentConnection) ||
    !Predicate.isFunction(daemonAgentConnection.attach) ||
    !Predicate.isObject(daemonAgentConnection.prototype) ||
    !Predicate.isFunction(daemonAgentConnection.prototype.subscribe) ||
    !Predicate.isFunction(daemonAgentConnection.prototype.getInitialSnapshot) ||
    !Predicate.isFunction(daemonAgentConnection.prototype.getCommands) ||
    !Predicate.isFunction(daemonAgentConnection.prototype.getResourceSnapshot) ||
    !Predicate.isFunction(daemonAgentConnection.prototype.reload) ||
    !Predicate.isFunction(daemonAgentConnection.prototype.getSessionStats) ||
    !Predicate.isFunction(daemonAgentConnection.prototype.promptAndWait) ||
    !Predicate.isFunction(daemonAgentConnection.prototype.abort) ||
    !Predicate.isFunction(daemonAgentConnection.prototype.dispose) ||
    !Predicate.isFunction(defaultDaemonSocketPath)
  ) {
    throw bridgeError(
      input.binaryPath,
      "incompatible-exports",
      "The installed prime-agent public API does not provide the required daemon client surface.",
    );
  }

  let defaultSocketPath: unknown;
  try {
    defaultSocketPath = defaultDaemonSocketPath();
  } catch (cause) {
    throw bridgeError(
      input.binaryPath,
      "incompatible-exports",
      "defaultDaemonSocketPath failed when called.",
      cause,
    );
  }
  if (!Predicate.isString(defaultSocketPath) || defaultSocketPath.trim().length === 0) {
    throw bridgeError(
      input.binaryPath,
      "incompatible-exports",
      "defaultDaemonSocketPath must return a non-empty string.",
    );
  }

  return {
    version: metadata.value.VERSION,
    protocolName: PRIME_AGENT_DAEMON_PROTOCOL_NAME,
    protocolVersion: metadata.value.DAEMON_PROTOCOL_VERSION,
    DaemonClient: daemonClient as PrimeAgentDaemonClientConstructor,
    DaemonAgentConnection:
      daemonAgentConnection as unknown as PrimeAgentDaemonAgentConnectionConstructor,
    defaultDaemonSocketPath: defaultDaemonSocketPath as () => string,
  };
}

async function loadPrimeAgentDaemonBridgePromise(
  binaryPath: string,
): Promise<PrimeAgentDaemonBridge> {
  const located = await locatePrimeAgentPackage(binaryPath);
  const moduleEntryPath = await resolvePublicEntry(binaryPath, located);

  let loadedModule: unknown;
  try {
    loadedModule = await import(/* @vite-ignore */ NodeURL.pathToFileURL(moduleEntryPath).href);
  } catch (cause) {
    throw bridgeError(
      binaryPath,
      "module-import-failed",
      `Failed to import the installed prime-agent public entry '${moduleEntryPath}'.`,
      cause,
    );
  }

  return {
    packageRoot: located.root,
    moduleEntryPath,
    ...requireDaemonExports({
      binaryPath,
      loadedModule,
      manifestVersion: located.manifest.version,
    }),
  };
}

export const loadPrimeAgentDaemonBridge = Effect.fn("loadPrimeAgentDaemonBridge")(function* (
  binaryPath: string,
): Effect.fn.Return<PrimeAgentDaemonBridge, PrimeAgentDaemonBridgeError> {
  return yield* Effect.tryPromise({
    try: () => loadPrimeAgentDaemonBridgePromise(binaryPath),
    catch: (cause) =>
      isPrimeAgentDaemonBridgeError(cause)
        ? cause
        : bridgeError(binaryPath, "package-not-found", "Unexpected bridge loading failure.", cause),
  });
});

/**
 * A daemon launched by Pylon must not inherit Prime Agent's private worker role.
 * Prefix filtering is deliberate: upstream may add internal coordination fields.
 */
export function sanitizePrimeAgentDaemonEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith("PRIME_AGENT_INTERNAL_")),
  );
}
