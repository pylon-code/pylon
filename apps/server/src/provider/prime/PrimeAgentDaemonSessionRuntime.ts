import {
  RUNTIME_RESOURCE_CATALOG_MAX_ITEMS,
  RUNTIME_RESOURCE_DESCRIPTION_MAX_CHARS,
  PROVIDER_AGENT_CONTROL_ID_MAX_CHARS,
  PROVIDER_SESSION_AGENT_DEPTH_MAX_SETTABLE,
  PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS,
  PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS,
  PROVIDER_SESSION_AGENT_ACTIVITY_MAX_ENTRIES,
  PROVIDER_SESSION_AGENT_ACTIVITY_SNAPSHOT_MAX_BYTES,
  PROVIDER_SESSION_AGENT_ACTIVITY_SNAPSHOT_MAX_CHARS,
  PROVIDER_SESSION_INPUT_QUEUE_MAX_COUNT,
  RUNTIME_RESOURCE_NAME_MAX_CHARS,
  type ProviderRefineSessionHarnessResult,
  type ProviderSessionAgentActivityEntry,
  type ProviderSessionAgentDepthSource,
  type SessionAgentDepthUpdatedPayload,
  type SessionInputQueueDeliveryMode,
  type SessionInputQueueUpdatedPayload,
  type SessionResourcesUpdatedPayload,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  type PrimeAgentDaemonAgentConnection,
  type PrimeAgentDaemonExtensionUiResponse,
  type PrimeAgentDaemonImage,
  type PrimeAgentDaemonQueueMode,
  type PrimeAgentDaemonServiceTier,
  type PrimeAgentDaemonThinkingLevel,
} from "./PrimeAgentDaemonBridge.ts";
import {
  decodePrimeAgentDaemonEvent,
  decodePrimeAgentDaemonSessionState,
  type PrimeDaemonEvent,
} from "./PrimeAgentDaemonEvents.ts";
import type { PrimeAgentDaemonManager } from "./PrimeAgentDaemonManager.ts";
import { PRIME_AGENT_EVENT_BUFFER_CAPACITY } from "./PrimeAgentEventBuffer.ts";
import { primeAgentSessionFileName } from "./PrimeAgentSessionIdentity.ts";
import {
  isPrimeAgentCompatibleResumeCursor,
  PRIME_AGENT_DAEMON_RESUME_CURSOR,
  type PrimeAgentDaemonResumeCursor,
} from "./PrimeAgentResumeCursor.ts";

export { PRIME_AGENT_DAEMON_RESUME_CURSOR } from "./PrimeAgentResumeCursor.ts";

const COMMAND_TIMEOUT_MS = 30_000;
const SIDE_QUESTION_TERMINAL_MAX_BYTES = 8_192;
const SIDE_QUESTION_TERMINAL_MAX_CODEPOINTS = 8_192;
const SIDE_QUESTION_MAX_UPDATES = 512;
const SIDE_QUESTION_MAX_CUMULATIVE_BYTES = 4 * 1_024 * 1_024;
const SIDE_QUESTION_EVENT_ID_MAX_CODE_UNITS = 64;
const SIDE_QUESTION_EVENT_ANSWER_MAX_CODE_UNITS = 16_384;
const SIDE_QUESTION_PRESTART_ABORT_MAX = 4;
const SIDE_QUESTION_ABORT_TIMEOUT_MS = 2_000;
const SIDE_QUESTION_NATIVE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PRIME_AGENT_LIVE_ACTIVITY_REFRESH_DELAY_MS = 500;
const PRIME_AGENT_LIVE_ACTIVITY_PENDING_EVENT_MAX = 64;
const liveActivityTextEncoder = new TextEncoder();
// Reserve room for the canonical agent id, revision, entry envelopes and JSON escaping.
const LIVE_ACTIVITY_TEXT_BYTE_BUDGET = PROVIDER_SESSION_AGENT_ACTIVITY_SNAPSHOT_MAX_BYTES - 5_536;

function truncateLiveActivityText(text: string, maxCharacters: number, maxBytes: number): string {
  let characters = 0;
  let bytes = 0;
  let output = "";
  for (const character of text) {
    const encodedCharacter = JSON.stringify(character);
    const characterBytes = liveActivityTextEncoder.encode(encodedCharacter.slice(1, -1)).byteLength;
    if (characters >= maxCharacters || bytes + characterBytes > maxBytes) break;
    output += character;
    characters += 1;
    bytes += characterBytes;
  }
  return output;
}

function visibleAssistantText(message: unknown): string | undefined {
  if (
    !Predicate.isObject(message) ||
    message.role !== "assistant" ||
    !Array.isArray(message.content)
  ) {
    return undefined;
  }
  const text = message.content
    .filter(
      (part) => Predicate.isObject(part) && part.type === "text" && Predicate.isString(part.text),
    )
    .map((part) => part.text as string)
    .join("");
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Privacy boundary for Prime's AgentMessage union. Only assistant text content
 * survives; roles, tool calls/results, thinking, metadata, ids and timestamps
 * are discarded before a value can enter a Pylon stream.
 */
export function sanitizePrimeAgentLiveActivityMessages(
  messages: unknown,
): ReadonlyArray<ProviderSessionAgentActivityEntry> {
  if (!Array.isArray(messages)) return [];
  const entries: Array<ProviderSessionAgentActivityEntry> = [];
  let remainingCharacters = PROVIDER_SESSION_AGENT_ACTIVITY_SNAPSHOT_MAX_CHARS;
  let remainingBytes = LIVE_ACTIVITY_TEXT_BYTE_BUDGET;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (entries.length >= PROVIDER_SESSION_AGENT_ACTIVITY_MAX_ENTRIES) break;
    const text = visibleAssistantText(messages[index]);
    if (text === undefined) continue;
    const bounded = truncateLiveActivityText(
      text,
      Math.min(PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS, remainingCharacters),
      remainingBytes,
    );
    if (bounded.length === 0) break;
    const characterCount = [...bounded].length;
    const encodedText = JSON.stringify(bounded);
    const byteCount = liveActivityTextEncoder.encode(encodedText.slice(1, -1)).byteLength;
    entries.unshift({ speaker: "assistant", text: bounded });
    remainingCharacters -= characterCount;
    remainingBytes -= byteCount;
    if (remainingCharacters === 0 || remainingBytes === 0) break;
  }
  return entries;
}

const thinkingLevelSchema = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const serviceTierSchema = Schema.NullOr(
  Schema.Literals(["auto", "default", "flex", "scale", "priority"]),
);
const imageSchema = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});
const extensionUiResponseSchema = Schema.Union([
  Schema.Struct({ value: Schema.String }),
  Schema.Struct({ confirmed: Schema.Boolean }),
  Schema.Struct({ cancelled: Schema.Literal(true) }),
]);
const createSuccessSchema = Schema.Struct({
  type: Schema.Literal("response"),
  command: Schema.Literal("create"),
  success: Schema.Literal(true),
  data: Schema.Struct({
    activeSessionId: Schema.String,
    sessionId: Schema.String,
    sessionFile: Schema.String,
  }),
});
const createFailureSchema = Schema.Struct({
  type: Schema.Literal("response"),
  command: Schema.Literal("create"),
  success: Schema.Literal(false),
  error: Schema.String,
});
const modelSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.String,
});
const catalogProviderStringSchema = Schema.String.check(Schema.isMaxLength(128));
const catalogModelStringSchema = Schema.String.check(Schema.isMaxLength(512));
const catalogThinkingValueSchema = Schema.NullOr(catalogProviderStringSchema);
const catalogThinkingLevelMapSchema = Schema.Struct({
  off: Schema.optional(catalogThinkingValueSchema),
  minimal: Schema.optional(catalogThinkingValueSchema),
  low: Schema.optional(catalogThinkingValueSchema),
  medium: Schema.optional(catalogThinkingValueSchema),
  high: Schema.optional(catalogThinkingValueSchema),
  xhigh: Schema.optional(catalogThinkingValueSchema),
  max: Schema.optional(catalogThinkingValueSchema),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const catalogModelSchema = Schema.Struct({
  id: catalogModelStringSchema,
  name: catalogModelStringSchema,
  provider: catalogProviderStringSchema,
  api: catalogProviderStringSchema,
  reasoning: Schema.Boolean,
  thinkingLevelMap: Schema.optional(catalogThinkingLevelMapSchema),
});
const AVAILABLE_MODEL_CATALOG_MAX_ITEMS = 512;
const COMPLETE_MODEL_CATALOG_MAX_ITEMS = 2_048;
const availableModelsSchema = Schema.Array(catalogModelSchema).check(
  Schema.isMaxLength(AVAILABLE_MODEL_CATALOG_MAX_ITEMS),
);
const modelCatalogSchema = Schema.Struct({
  models: Schema.Array(catalogModelSchema).check(
    Schema.isMaxLength(COMPLETE_MODEL_CATALOG_MAX_ITEMS),
  ),
  configuredProviders: Schema.Array(catalogProviderStringSchema).check(Schema.isMaxLength(128)),
});
const resourceSourceInfoSchema = Schema.Struct({
  scope: Schema.Literals(["user", "project", "temporary"]),
});
const resourceSnapshotSchema = Schema.Struct({
  skills: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.optional(Schema.String),
        filePath: Schema.String,
        sourceInfo: Schema.optional(resourceSourceInfoSchema),
      }),
    ),
  ),
  prompts: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.optional(Schema.String),
        argumentHint: Schema.optional(Schema.String),
        filePath: Schema.String,
        sourceInfo: Schema.optional(resourceSourceInfoSchema),
      }),
    ),
  ),
  extensions: Schema.Array(Schema.Struct({ path: Schema.String })),
  diagnostics: Schema.Struct({
    extensions: Schema.Array(
      Schema.Struct({
        type: Schema.Literals(["warning", "error", "collision"]),
        path: Schema.optional(Schema.String),
      }),
    ),
  }),
});
const commandsSchema = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    registeredName: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    argumentHint: Schema.optional(Schema.String),
    source: Schema.Literals(["extension", "prompt", "skill"]),
    sourceInfo: Schema.Struct({
      path: Schema.String,
      scope: Schema.optional(Schema.Literals(["user", "project", "temporary"])),
    }),
  }),
);
const sessionStatsSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  contextUsage: Schema.optional(
    Schema.Struct({
      tokens: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      contextWindow: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
});
const rlmMaxDepthStatusSchema = Schema.Struct({
  maxDepth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  source: Schema.Literals(["chat", "default", "env", "global", "inherited"]),
});
const agentMessageReceiptSchema = Schema.Struct({
  deliveryStatus: Schema.Literals(["delivered", "queued"]),
});
const refinementResultSchema = Schema.Struct({
  appliedEdits: Schema.Array(Schema.Struct({ applied: Schema.Boolean })),
  scope: Schema.optional(Schema.Literals(["local", "global"])),
});

const decodeThinkingLevel = Schema.decodeUnknownOption(thinkingLevelSchema);
const decodeServiceTier = Schema.decodeUnknownOption(serviceTierSchema);
const decodeImage = Schema.decodeUnknownOption(imageSchema);
const decodeExtensionUiResponse = Schema.decodeUnknownOption(extensionUiResponseSchema);
const decodeCreateSuccess = Schema.decodeUnknownOption(createSuccessSchema);
const decodeCreateFailure = Schema.decodeUnknownOption(createFailureSchema);
const decodeModel = Schema.decodeUnknownOption(modelSchema);
const decodeAvailableModels = Schema.decodeUnknownOption(availableModelsSchema);
const decodeModelCatalog = Schema.decodeUnknownOption(modelCatalogSchema);
const decodeResourceSnapshot = Schema.decodeUnknownOption(resourceSnapshotSchema);
const decodeCommands = Schema.decodeUnknownOption(commandsSchema);
const decodeSessionStats = Schema.decodeUnknownOption(sessionStatsSchema);
const decodeRlmMaxDepthStatus = Schema.decodeUnknownOption(rlmMaxDepthStatusSchema);
const decodeAgentMessageReceipt = Schema.decodeUnknownOption(agentMessageReceiptSchema);
const decodeRefinementResult = Schema.decodeUnknownOption(refinementResultSchema);

function providerAgentDepthSource(
  source: (typeof rlmMaxDepthStatusSchema.Type)["source"],
): Exclude<ProviderSessionAgentDepthSource, "policy"> {
  switch (source) {
    case "chat":
      return "session";
    case "env":
      return "environment";
    case "default":
    case "global":
    case "inherited":
      return source;
  }
}

function safeAgentDepth(
  status: typeof rlmMaxDepthStatusSchema.Type,
  writable: boolean,
): SessionAgentDepthUpdatedPayload {
  return {
    maxDepth: status.maxDepth,
    source: writable ? providerAgentDepthSource(status.source) : "policy",
    writable,
    settable: writable,
    maxSettableDepth: PROVIDER_SESSION_AGENT_DEPTH_MAX_SETTABLE,
  };
}

function decodeInputQueueCounts(value: unknown): Option.Option<SessionInputQueueUpdatedPayload> {
  if (typeof value !== "object" || value === null) return Option.none();
  const queue = value as { readonly steering?: unknown; readonly followUp?: unknown };
  const steering = queue.steering;
  const followUp = queue.followUp;
  if (
    !Array.isArray(steering) ||
    !Array.isArray(followUp) ||
    steering.length > PROVIDER_SESSION_INPUT_QUEUE_MAX_COUNT ||
    followUp.length > PROVIDER_SESSION_INPUT_QUEUE_MAX_COUNT
  ) {
    return Option.none();
  }
  return Option.some({ steeringCount: steering.length, followUpCount: followUp.length });
}

function resourceText(value: string | undefined, maxChars: number): string | undefined {
  const trimmed = value?.replaceAll("\u0000", "").trim();
  return trimmed ? trimmed.slice(0, maxChars) : undefined;
}

function safeSessionResources(
  resources: typeof resourceSnapshotSchema.Type,
  commands: typeof commandsSchema.Type,
  disableCommands: boolean,
): PrimeAgentDaemonSessionResources {
  const skills = (resources.skills ?? [])
    .slice(0, RUNTIME_RESOURCE_CATALOG_MAX_ITEMS)
    .flatMap((skill) => {
      const name = resourceText(skill.name, RUNTIME_RESOURCE_NAME_MAX_CHARS);
      if (name === undefined) return [];
      const description = resourceText(skill.description, RUNTIME_RESOURCE_DESCRIPTION_MAX_CHARS);
      return [
        {
          name,
          ...(description === undefined ? {} : { description }),
          ...(skill.sourceInfo === undefined ? {} : { scope: skill.sourceInfo.scope }),
        },
      ];
    });
  const prompts = (resources.prompts ?? [])
    .slice(0, RUNTIME_RESOURCE_CATALOG_MAX_ITEMS)
    .flatMap((prompt) => {
      const name = resourceText(prompt.name, RUNTIME_RESOURCE_NAME_MAX_CHARS);
      if (name === undefined) return [];
      const description = resourceText(prompt.description, RUNTIME_RESOURCE_DESCRIPTION_MAX_CHARS);
      const argumentHint = resourceText(prompt.argumentHint, RUNTIME_RESOURCE_NAME_MAX_CHARS);
      return [
        {
          name,
          ...(description === undefined ? {} : { description }),
          ...(argumentHint === undefined ? {} : { argumentHint }),
          ...(prompt.sourceInfo === undefined ? {} : { scope: prompt.sourceInfo.scope }),
        },
      ];
    });
  const safeCommands = commands.slice(0, RUNTIME_RESOURCE_CATALOG_MAX_ITEMS).flatMap((command) => {
    if (disableCommands) return [];
    const name = resourceText(command.name, RUNTIME_RESOURCE_NAME_MAX_CHARS);
    if (name === undefined) return [];
    const description = resourceText(command.description, RUNTIME_RESOURCE_DESCRIPTION_MAX_CHARS);
    const argumentHint = resourceText(command.argumentHint, RUNTIME_RESOURCE_NAME_MAX_CHARS);
    return [
      {
        name,
        source: command.source,
        ...(description === undefined ? {} : { description }),
        ...(argumentHint === undefined ? {} : { argumentHint }),
      },
    ];
  });
  return { available: true, skills, prompts, commands: safeCommands };
}

const unavailableSessionResources: PrimeAgentDaemonSessionResources = {
  available: false,
  skills: [],
  prompts: [],
  commands: [],
};

const runtimeErrorOperation = Schema.Literals([
  "open-client",
  "configure-client",
  "create-session",
  "attach-session",
  "initial-snapshot",
  "verify-extension",
  "reload-resources",
  "get-agent-depth",
  "set-agent-depth",
  "get-agent-roster",
  "cancel-agent",
  "message-agent",
  "watch-agent-activity",
  "prompt",
  "steer",
  "follow-up",
  "get-input-queue",
  "clear-input-queue",
  "set-input-queue-mode",
  "get-compaction-state",
  "compact",
  "refine-local-harness",
  "abort-compaction",
  "set-auto-compaction",
  "abort",
  "abort-and-clear-queue",
  "side-question",
  "abort-side-question",
  "model-catalog",
  "set-model",
  "set-thinking-level",
  "set-service-tier",
  "extension-ui-response",
  "session-stats",
  "dispose",
]);
const runtimeErrorReason = Schema.Literals([
  "invalid-input",
  "incompatible-api",
  "request-failed",
  "request-timed-out",
  "invalid-response",
  "agent-not-active",
  "disposed",
]);

export class PrimeAgentDaemonSessionRuntimeError extends Schema.TaggedErrorClass<PrimeAgentDaemonSessionRuntimeError>()(
  "PrimeAgentDaemonSessionRuntimeError",
  {
    operation: runtimeErrorOperation,
    reason: runtimeErrorReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Prime Agent daemon session failed (${this.operation}/${this.reason}): ${this.detail}`;
  }
}

export interface PrimeAgentDaemonSessionRuntimeInput {
  readonly manager: PrimeAgentDaemonManager;
  readonly cwd: string;
  /** Isolated, deterministic, server-owned directory for this Pylon thread. */
  readonly sessionDir: string;
  readonly agentDir?: string;
  readonly model?: string;
  readonly thinkingLevel?: PrimeAgentDaemonThinkingLevel;
  /** Absolute server-owned extension paths explicitly loaded for this session. */
  readonly extensions?: ReadonlyArray<string>;
  readonly disableExtensionDiscovery?: boolean;
  /** Supervised sessions fail closed on transport loss and are re-created after verification. */
  readonly disableAutoReconnect?: boolean;
  readonly requiredExtension?: {
    readonly path: string;
    readonly markerCommand: string;
  };
  readonly resumeCursor?: unknown;
  /** Private stable native id selected from the server-owned identity sidecar. */
  readonly resumeSessionId?: string;
}

export interface PrimeAgentDaemonPromptInput {
  readonly text: string;
  readonly images?: ReadonlyArray<PrimeAgentDaemonImage>;
  /** Cancels prompt admission before the daemon accepts ownership of the turn. */
  readonly signal?: AbortSignal;
}

export type PrimeAgentDaemonSideQuestionResult =
  | { readonly disposition: "answered"; readonly answer: string }
  | { readonly disposition: "cancelled" }
  | { readonly disposition: "response-too-large" };

export interface PrimeAgentDaemonSafeModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}

export interface PrimeAgentDaemonCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly api: string;
  readonly reasoning: boolean;
  readonly thinkingLevelMap?:
    | Readonly<Partial<Record<PrimeAgentDaemonThinkingLevel, string | null>>>
    | undefined;
}

export type PrimeAgentDaemonSessionResources = SessionResourcesUpdatedPayload;

export type PrimeAgentDaemonAgentDepth = SessionAgentDepthUpdatedPayload;

export type PrimeAgentDaemonInputQueue = SessionInputQueueUpdatedPayload;

export type PrimeAgentDaemonChild = Extract<
  PrimeDaemonEvent,
  { readonly _tag: "ChildUpdated" }
>["child"];

export interface PrimeAgentDaemonInputQueueStatus {
  readonly queue: PrimeAgentDaemonInputQueue;
  readonly activeAction: boolean;
  readonly isStreaming: boolean;
}

export interface PrimeAgentDaemonCompactionState {
  readonly isCompacting: boolean;
  readonly autoCompactionEnabled: boolean;
  readonly isStreaming: boolean;
  readonly isBashRunning: boolean;
  readonly inputQueueActive: boolean;
  readonly steeringCount: number;
  readonly followUpCount: number;
}

export interface PrimeAgentDaemonReloadResourcesResult {
  readonly resources: PrimeAgentDaemonSessionResources;
  readonly agentDepth: PrimeAgentDaemonAgentDepth;
}

/** Provider-neutral session usage fields projected from Prime's private daemon response. */
export interface PrimeAgentDaemonSessionStats {
  readonly contextUsage?:
    | {
        readonly usedTokens: number | null;
        readonly maxTokens: number;
      }
    | undefined;
}

type PrimeAgentDaemonCanonicalSnapshot = Extract<
  PrimeDaemonEvent,
  { readonly _tag: "SessionResynced" }
>;

export interface PrimeAgentDaemonSessionRuntime {
  /** Opaque and safe to persist in ProviderSession.resumeCursor. */
  readonly resumeCursor: PrimeAgentDaemonResumeCursor;
  /** Private native identity used only to refresh the server-owned sidecar. */
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly activeSessionId: string;
  readonly initialSnapshot: PrimeAgentDaemonCanonicalSnapshot;
  readonly initialResources: PrimeAgentDaemonSessionResources;
  readonly initialAgentDepth: PrimeAgentDaemonAgentDepth;
  readonly initialInputQueue: PrimeAgentDaemonInputQueue;
  readonly inputQueueModesAvailable: boolean;
  readonly compactionAvailable: boolean;
  readonly refinementAvailable: boolean;
  readonly autoCompactionWritable: boolean;
  readonly initialCompactionState: PrimeAgentDaemonCompactionState;
  readonly getCompactionState: Effect.Effect<
    PrimeAgentDaemonCompactionState,
    PrimeAgentDaemonSessionRuntimeError
  >;
  /** Starts one argument-free manual compaction and discards every native result field. */
  readonly compact: Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  /** Refines the local harness and retains only aggregate edit counts from the native result. */
  readonly refineLocalHarness: Effect.Effect<
    ProviderRefineSessionHarnessResult,
    PrimeAgentDaemonSessionRuntimeError
  >;
  /** Requests native compaction cancellation without claiming a terminal outcome. */
  readonly abortCompaction: Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  /** Prime persists this as the provider-wide default as well as current session state. */
  readonly setAutoCompactionEnabled: (
    enabled: boolean,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  /** Reload the native runtime, then return sanitized post-reload session state. */
  readonly reloadResources: Effect.Effect<
    PrimeAgentDaemonReloadResourcesResult,
    PrimeAgentDaemonSessionRuntimeError
  >;
  readonly getAgentDepth: Effect.Effect<
    PrimeAgentDaemonAgentDepth,
    PrimeAgentDaemonSessionRuntimeError
  >;
  readonly setAgentDepth: (
    maxDepth: number,
  ) => Effect.Effect<PrimeAgentDaemonAgentDepth, PrimeAgentDaemonSessionRuntimeError>;
  readonly getAgentRoster: Effect.Effect<
    ReadonlyArray<PrimeAgentDaemonChild>,
    PrimeAgentDaemonSessionRuntimeError
  >;
  readonly agentMessageAvailable: boolean;
  readonly cancelAgent: (
    agentId: string,
  ) => Effect.Effect<boolean, PrimeAgentDaemonSessionRuntimeError>;
  /** Sends bounded text to one private native endpoint and retains only its disposition. */
  readonly messageAgent: (
    activeSessionId: string,
    message: string,
  ) => Effect.Effect<"delivered" | "queued", PrimeAgentDaemonSessionRuntimeError>;
  readonly watchAgentActivityAvailable: boolean;
  /** Opens a separate public watcher connection and emits sanitized replacement entries only. */
  readonly watchAgentActivity: (
    activeSessionId: string,
  ) => Stream.Stream<
    ReadonlyArray<ProviderSessionAgentActivityEntry>,
    PrimeAgentDaemonSessionRuntimeError
  >;
  readonly events: Stream.Stream<PrimeDaemonEvent, never>;
  readonly prompt: (
    input: PrimeAgentDaemonPromptInput,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly steer: (
    input: PrimeAgentDaemonPromptInput,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly followUp: (
    input: PrimeAgentDaemonPromptInput,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly getInputQueue: Effect.Effect<
    PrimeAgentDaemonInputQueue,
    PrimeAgentDaemonSessionRuntimeError
  >;
  readonly getInputQueueStatus: Effect.Effect<
    PrimeAgentDaemonInputQueueStatus,
    PrimeAgentDaemonSessionRuntimeError
  >;
  readonly clearInputQueue: Effect.Effect<
    PrimeAgentDaemonInputQueueStatus,
    PrimeAgentDaemonSessionRuntimeError
  >;
  readonly setInputQueueMode: (input: {
    readonly queue: "steering" | "follow-up";
    readonly mode: SessionInputQueueDeliveryMode;
  }) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly abort: Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly abortAndClearQueue: Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly sideQuestionsAvailable: boolean;
  /** Runs one requester-scoped unary question; native prompt/error/id fields never escape. */
  readonly askSideQuestion: (
    nativeId: string,
    question: string,
  ) => Effect.Effect<PrimeAgentDaemonSideQuestionResult, PrimeAgentDaemonSessionRuntimeError>;
  readonly abortSideQuestion: (
    nativeId: string,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly discoverAvailableModels: Effect.Effect<
    ReadonlyArray<PrimeAgentDaemonCatalogModel>,
    PrimeAgentDaemonSessionRuntimeError
  >;
  readonly setModel: (
    model: string,
  ) => Effect.Effect<PrimeAgentDaemonSafeModel, PrimeAgentDaemonSessionRuntimeError>;
  readonly setThinkingLevel: (
    level: PrimeAgentDaemonThinkingLevel,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly setServiceTier: (
    tier: PrimeAgentDaemonServiceTier,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly respondToExtensionUiRequest: (
    requestId: string,
    response: PrimeAgentDaemonExtensionUiResponse,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly getSessionStats: Effect.Effect<
    PrimeAgentDaemonSessionStats,
    PrimeAgentDaemonSessionRuntimeError
  >;
  readonly dispose: Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
}

function runtimeError(
  operation: PrimeAgentDaemonSessionRuntimeError["operation"],
  reason: PrimeAgentDaemonSessionRuntimeError["reason"],
  detail: string,
): PrimeAgentDaemonSessionRuntimeError {
  return new PrimeAgentDaemonSessionRuntimeError({ operation, reason, detail });
}

function validateNonEmpty(
  operation: PrimeAgentDaemonSessionRuntimeError["operation"],
  label: string,
  value: string,
): Effect.Effect<string, PrimeAgentDaemonSessionRuntimeError> {
  const normalized = value.trim();
  return normalized.length > 0
    ? Effect.succeed(normalized)
    : Effect.fail(runtimeError(operation, "invalid-input", `${label} must be non-empty.`));
}

function validateImages(
  operation: PrimeAgentDaemonSessionRuntimeError["operation"],
  images: ReadonlyArray<PrimeAgentDaemonImage> | undefined,
): Effect.Effect<ReadonlyArray<PrimeAgentDaemonImage>, PrimeAgentDaemonSessionRuntimeError> {
  const result: PrimeAgentDaemonImage[] = [];
  for (const image of images ?? []) {
    const decoded = decodeImage(image);
    if (
      Option.isNone(decoded) ||
      decoded.value.data.length === 0 ||
      decoded.value.mimeType.trim().length === 0
    ) {
      return Effect.fail(
        runtimeError(operation, "invalid-input", "Each image must contain data and a MIME type."),
      );
    }
    result.push(decoded.value);
  }
  return Effect.succeed(result);
}

function validatePromptContent(
  operation: "prompt" | "steer" | "follow-up",
  text: string,
  images: ReadonlyArray<PrimeAgentDaemonImage>,
): Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError> {
  return text.trim().length > 0 || images.length > 0
    ? Effect.void
    : Effect.fail(
        runtimeError(
          operation,
          "invalid-input",
          "A prompt requires non-empty text or at least one image.",
        ),
      );
}

function safeEvent(event: PrimeDaemonEvent): PrimeDaemonEvent {
  // Extension installation paths are daemon-local diagnostics, never provider events.
  return event._tag === "ExtensionError" ? { ...event, extensionPath: "<redacted>" } : event;
}

function splitModelSelector(
  model: string,
): Effect.Effect<
  { readonly provider: string; readonly modelId: string },
  PrimeAgentDaemonSessionRuntimeError
> {
  const selector = model.trim();
  const separator = selector.indexOf("/");
  if (separator <= 0 || separator === selector.length - 1) {
    return Effect.fail(
      runtimeError("set-model", "invalid-input", "Model must use a provider/model selector."),
    );
  }
  return Effect.succeed({
    provider: selector.slice(0, separator),
    modelId: selector.slice(separator + 1),
  });
}

function safeCatalogModel(model: typeof catalogModelSchema.Type): PrimeAgentDaemonCatalogModel {
  const thinkingLevelMap = model.thinkingLevelMap;
  return {
    id: model.id.trim(),
    name: model.name.trim(),
    provider: model.provider.trim(),
    api: model.api.trim(),
    reasoning: model.reasoning,
    ...(thinkingLevelMap === undefined
      ? {}
      : {
          thinkingLevelMap: {
            ...(thinkingLevelMap.off === undefined
              ? {}
              : { off: thinkingLevelMap.off === null ? null : thinkingLevelMap.off.trim() }),
            ...(thinkingLevelMap.minimal === undefined
              ? {}
              : {
                  minimal:
                    thinkingLevelMap.minimal === null ? null : thinkingLevelMap.minimal.trim(),
                }),
            ...(thinkingLevelMap.low === undefined
              ? {}
              : { low: thinkingLevelMap.low === null ? null : thinkingLevelMap.low.trim() }),
            ...(thinkingLevelMap.medium === undefined
              ? {}
              : {
                  medium: thinkingLevelMap.medium === null ? null : thinkingLevelMap.medium.trim(),
                }),
            ...(thinkingLevelMap.high === undefined
              ? {}
              : { high: thinkingLevelMap.high === null ? null : thinkingLevelMap.high.trim() }),
            ...(thinkingLevelMap.xhigh === undefined
              ? {}
              : {
                  xhigh: thinkingLevelMap.xhigh === null ? null : thinkingLevelMap.xhigh.trim(),
                }),
            ...(thinkingLevelMap.max === undefined
              ? {}
              : { max: thinkingLevelMap.max === null ? null : thinkingLevelMap.max.trim() }),
          },
        }),
  };
}

const catalogNulCharacter = String.fromCharCode(0);

function safeCatalogModels(
  models: ReadonlyArray<typeof catalogModelSchema.Type>,
): Option.Option<ReadonlyArray<PrimeAgentDaemonCatalogModel>> {
  const safeModels: PrimeAgentDaemonCatalogModel[] = [];
  const qualifiedIds = new Set<string>();
  for (const model of models) {
    const safeModel = safeCatalogModel(model);
    if (
      safeModel.provider.length === 0 ||
      safeModel.id.length === 0 ||
      safeModel.api.length === 0 ||
      safeModel.provider.includes(catalogNulCharacter) ||
      safeModel.id.includes(catalogNulCharacter) ||
      safeModel.name.includes(catalogNulCharacter) ||
      safeModel.api.includes(catalogNulCharacter) ||
      Object.values(safeModel.thinkingLevelMap ?? {}).some(
        (value) => value !== null && (value.length === 0 || value.includes(catalogNulCharacter)),
      )
    ) {
      return Option.none();
    }
    const qualifiedId = `${safeModel.provider}/${safeModel.id}`;
    if (qualifiedIds.has(qualifiedId)) return Option.none();
    qualifiedIds.add(qualifiedId);
    safeModels.push(safeModel);
  }
  return Option.some(safeModels);
}

export const makePrimeAgentDaemonSessionRuntime = Effect.fn("makePrimeAgentDaemonSessionRuntime")(
  function* (
    input: PrimeAgentDaemonSessionRuntimeInput,
  ): Effect.fn.Return<
    PrimeAgentDaemonSessionRuntime,
    PrimeAgentDaemonSessionRuntimeError,
    Scope.Scope
  > {
    const cwd = yield* validateNonEmpty("create-session", "cwd", input.cwd);
    const sessionDir = yield* validateNonEmpty("create-session", "sessionDir", input.sessionDir);
    const shouldContinue = input.resumeCursor !== undefined;
    if (shouldContinue && !isPrimeAgentCompatibleResumeCursor(input.resumeCursor)) {
      return yield* runtimeError(
        "create-session",
        "invalid-input",
        "The Prime Agent resume cursor is invalid or unsupported.",
      );
    }
    const resumeSessionId = input.resumeSessionId?.trim();
    if (
      resumeSessionId !== undefined &&
      (!shouldContinue || !/^[A-Za-z0-9_-]{1,256}$/.test(resumeSessionId))
    ) {
      return yield* runtimeError(
        "create-session",
        "invalid-input",
        "The Prime Agent resume session identity is invalid.",
      );
    }
    if (
      input.thinkingLevel !== undefined &&
      Option.isNone(decodeThinkingLevel(input.thinkingLevel))
    ) {
      return yield* runtimeError(
        "create-session",
        "invalid-input",
        "The Prime Agent thinking level is invalid.",
      );
    }

    const client = yield* input.manager
      .openClient()
      .pipe(
        Effect.mapError(() =>
          runtimeError("open-client", "request-failed", "Could not open the shared daemon client."),
        ),
      );
    let connection: PrimeAgentDaemonAgentConnection | undefined;
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    let disposeStarted = false;

    const closeClient = Effect.sync(() => {
      client.close();
    });

    if (input.disableAutoReconnect !== true && !Predicate.isFunction(client.enableAutoReconnect)) {
      client.close();
      return yield* runtimeError(
        "configure-client",
        "incompatible-api",
        "The installed daemon client does not support automatic reconnect.",
      );
    }
    yield* Effect.try({
      try: () => {
        if (input.disableAutoReconnect !== true) {
          client.enableRequestRecovery?.();
          client.enableAutoReconnect!({ recoverDaemon: input.manager.recover });
        }
      },
      catch: () =>
        runtimeError(
          "configure-client",
          "request-failed",
          "Could not enable daemon client reconnect.",
        ),
    }).pipe(Effect.onError(() => closeClient));

    const configuredModel = input.model?.trim();
    const configuredAgentDir = input.agentDir?.trim();
    const configuredExtensions = (input.extensions ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      input.requiredExtension !== undefined &&
      (input.disableExtensionDiscovery !== true ||
        configuredExtensions.length !== 1 ||
        configuredExtensions[0] !== input.requiredExtension.path)
    ) {
      client.close();
      return yield* runtimeError(
        "verify-extension",
        "invalid-input",
        "Managed execution policy verification requires one explicit extension with discovery disabled.",
      );
    }
    const createResponse = yield* Effect.tryPromise({
      try: () =>
        client.request(
          {
            type: "create",
            lifecycle: "client_owned",
            ...(resumeSessionId === undefined
              ? { continueRecent: shouldContinue }
              : { sessionPath: resumeSessionId, continueRecent: false }),
            config: {
              cwd,
              sessionDir,
              noBuiltinTools: false,
              noExtensions: input.disableExtensionDiscovery ?? false,
              noSkills: false,
              noContextFiles: false,
              ...(configuredAgentDir ? { agentDir: configuredAgentDir } : {}),
              ...(configuredExtensions.length > 0 ? { extensions: configuredExtensions } : {}),
              ...(configuredModel && configuredModel !== "default"
                ? { model: configuredModel }
                : {}),
              ...(input.thinkingLevel === undefined ? {} : { thinking: input.thinkingLevel }),
            },
          },
          COMMAND_TIMEOUT_MS,
        ),
      catch: () =>
        runtimeError(
          "create-session",
          "request-failed",
          "The daemon did not complete the create command.",
        ),
    }).pipe(Effect.onError(() => closeClient));
    const created = decodeCreateSuccess(createResponse);
    if (Option.isNone(created)) {
      client.close();
      return yield* runtimeError(
        "create-session",
        Option.isSome(decodeCreateFailure(createResponse)) ? "request-failed" : "invalid-response",
        Option.isSome(decodeCreateFailure(createResponse))
          ? "The daemon rejected the create command."
          : "The daemon returned an invalid create response.",
      );
    }
    const activeSessionId = created.value.data.activeSessionId.trim();
    if (activeSessionId.length === 0) {
      client.close();
      return yield* runtimeError(
        "create-session",
        "invalid-response",
        "The daemon create response omitted its active session identifier.",
      );
    }
    const completeUnattachedOwnedSession = Effect.tryPromise({
      try: () =>
        client.request({ type: "complete_owned_session", activeSessionId }, COMMAND_TIMEOUT_MS),
      catch: () => undefined,
    }).pipe(Effect.ignore, Effect.ensuring(closeClient));

    const sessionId = created.value.data.sessionId.trim();
    const sessionFile = created.value.data.sessionFile.trim();
    if (
      !/^[A-Za-z0-9_-]{1,256}$/.test(sessionId) ||
      primeAgentSessionFileName(sessionDir, sessionFile) === undefined ||
      (resumeSessionId !== undefined && sessionId !== resumeSessionId)
    ) {
      yield* completeUnattachedOwnedSession;
      return yield* runtimeError(
        "create-session",
        "invalid-response",
        "The daemon create response did not match the isolated durable session identity.",
      );
    }

    connection = yield* Effect.tryPromise({
      try: () =>
        input.manager.bridge.DaemonAgentConnection.attach(client, activeSessionId, {
          closeClientOnDispose: false,
          supportsExtensionUi: true,
          ownedSession: true,
          ...(input.disableAutoReconnect === true ? {} : { recoverDaemon: input.manager.recover }),
        }),
      catch: () =>
        runtimeError(
          "attach-session",
          "request-failed",
          "Could not attach to the created daemon session.",
        ),
    }).pipe(Effect.onError(() => completeUnattachedOwnedSession));

    const closeAttachedSession = Effect.promise(async () => {
      await connection?.dispose().catch(() => undefined);
      client.close();
    });
    let verifiedInventory:
      | readonly [typeof resourceSnapshotSchema.Type, typeof commandsSchema.Type]
      | undefined;
    let verifiedAgentDepth: PrimeAgentDaemonAgentDepth | undefined;
    if (input.requiredExtension !== undefined) {
      if (
        !Predicate.isFunction(connection?.setRlmMaxDepth) ||
        !Predicate.isFunction(connection?.getRlmMaxDepthStatus)
      ) {
        yield* closeAttachedSession;
        return yield* runtimeError(
          "verify-extension",
          "incompatible-api",
          "The installed daemon cannot verify the managed execution policy extension.",
        );
      }
      yield* Effect.tryPromise({
        try: async () => {
          const rawSetDepth = await connection!.setRlmMaxDepth!(0);
          const [rawResources, rawCommands, rawDepth] = await Promise.all([
            connection!.getResourceSnapshot!(),
            connection!.getCommands!(),
            connection!.getRlmMaxDepthStatus!(),
          ]);
          const resources = decodeResourceSnapshot(rawResources);
          const commands = decodeCommands(rawCommands);
          const setDepth = decodeRlmMaxDepthStatus(rawSetDepth);
          const depth = decodeRlmMaxDepthStatus(rawDepth);
          if (
            Option.isNone(resources) ||
            Option.isNone(commands) ||
            Option.isNone(setDepth) ||
            Option.isNone(depth)
          ) {
            throw new Error("invalid managed extension inventory");
          }
          const extensionLoaded =
            resources.value.extensions.length === 1 &&
            resources.value.extensions[0]?.path === input.requiredExtension!.path;
          const markerLoaded = commands.value.some(
            (command) =>
              command.name === input.requiredExtension!.markerCommand &&
              command.source === "extension" &&
              command.sourceInfo.path === input.requiredExtension!.path,
          );
          const extensionFailed = resources.value.diagnostics.extensions.some(
            (diagnostic) => diagnostic.type !== "warning",
          );
          verifiedInventory = [resources.value, commands.value];
          verifiedAgentDepth = safeAgentDepth(depth.value, false);
          if (
            !extensionLoaded ||
            !markerLoaded ||
            extensionFailed ||
            setDepth.value.maxDepth !== 0 ||
            depth.value.maxDepth !== 0
          ) {
            throw new Error("managed extension did not load");
          }
        },
        catch: () =>
          runtimeError(
            "verify-extension",
            "invalid-response",
            "Prime Agent did not load the required managed execution policy extension.",
          ),
      }).pipe(Effect.onError(() => closeAttachedSession));
    }

    const eventQueue = yield* Queue.bounded<PrimeDaemonEvent>(PRIME_AGENT_EVENT_BUFFER_CAPACITY);
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    let initializing = true;
    let initializationOverflow = false;
    let initializationAcceptedEventCount = 0;
    const bufferedEvents: unknown[] = [];
    let lastSnapshotSequence: number | undefined;
    const knownAgentRoster = new Map<string, PrimeAgentDaemonChild>();

    interface ActivePrivateSideQuestion {
      readonly completion: Deferred.Deferred<
        PrimeAgentDaemonSideQuestionResult,
        PrimeAgentDaemonSessionRuntimeError
      >;
      updateCount: number;
      cumulativeAnswerBytes: number;
      settled: boolean;
      terminalObserved: boolean;
      abortRequested: boolean;
    }
    const activePrivateSideQuestions = new Map<string, ActivePrivateSideQuestion>();
    const prestartAbortedSideQuestionIds = new Set<string>();
    const recentlySettledSideQuestionIds = new Set<string>();
    const rememberSettledSideQuestionId = (nativeId: string) => {
      recentlySettledSideQuestionIds.delete(nativeId);
      recentlySettledSideQuestionIds.add(nativeId);
      if (recentlySettledSideQuestionIds.size > SIDE_QUESTION_PRESTART_ABORT_MAX) {
        const oldest = recentlySettledSideQuestionIds.values().next().value;
        if (oldest !== undefined) recentlySettledSideQuestionIds.delete(oldest);
      }
    };
    const privateSideQuestionEventSchema = Schema.Struct({
      type: Schema.Literal("side_question_event"),
      event: Schema.Struct({
        id: Schema.String.check(Schema.isMaxLength(SIDE_QUESTION_EVENT_ID_MAX_CODE_UNITS)),
        answer: Schema.String.check(Schema.isMaxLength(SIDE_QUESTION_EVENT_ANSWER_MAX_CODE_UNITS)),
        status: Schema.Literals(["running", "complete", "cancelled", "error"]),
      }),
    });
    const decodePrivateSideQuestionEvent = Schema.decodeUnknownOption(
      privateSideQuestionEventSchema,
    );
    const privateSideQuestionFailure = () =>
      runtimeError(
        "side-question",
        "request-failed",
        "The Prime Agent side question did not complete safely.",
      );
    const failActivePrivateSideQuestions = () =>
      Effect.forEach(activePrivateSideQuestions.values(), (active) => {
        active.settled = true;
        return Deferred.fail(active.completion, privateSideQuestionFailure());
      }).pipe(Effect.asVoid);

    /**
     * Privacy boundary for requester-only native side-question traffic. This method
     * consumes the entire envelope before generic decoding, retaining only the exact
     * private correlation match, cumulative answer snapshot, and terminal status.
     */
    const handlePrivateSideQuestionEvent = (raw: unknown): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (!Predicate.isObject(raw)) return false;
        if (raw.type === "side_question_event") {
          const decoded = decodePrivateSideQuestionEvent(raw);
          if (Option.isNone(decoded)) {
            yield* failActivePrivateSideQuestions();
            return true;
          }
          const active = activePrivateSideQuestions.get(decoded.value.event.id);
          if (active === undefined || active.settled) return true;

          active.updateCount += 1;
          const answerBytes = liveActivityTextEncoder.encode(decoded.value.event.answer).byteLength;
          active.cumulativeAnswerBytes += answerBytes;
          const snapshotByteLimitBreached = answerBytes > SIDE_QUESTION_TERMINAL_MAX_BYTES;
          const answerCodepoints = snapshotByteLimitBreached
            ? 0
            : [...decoded.value.event.answer].length;
          if (
            active.updateCount > SIDE_QUESTION_MAX_UPDATES ||
            active.cumulativeAnswerBytes > SIDE_QUESTION_MAX_CUMULATIVE_BYTES ||
            snapshotByteLimitBreached ||
            answerCodepoints > SIDE_QUESTION_TERMINAL_MAX_CODEPOINTS ||
            decoded.value.event.answer.includes("\0")
          ) {
            active.settled = true;
            yield* Deferred.succeed(active.completion, {
              disposition: "response-too-large",
            });
            return true;
          }

          switch (decoded.value.event.status) {
            case "running":
              return true;
            case "complete":
              active.settled = true;
              active.terminalObserved = true;
              yield* Deferred.succeed(active.completion, {
                disposition: "answered",
                answer: decoded.value.event.answer,
              });
              return true;
            case "cancelled":
              active.settled = true;
              active.terminalObserved = true;
              yield* Deferred.succeed(active.completion, { disposition: "cancelled" });
              return true;
            case "error":
              active.settled = true;
              active.terminalObserved = true;
              yield* Deferred.fail(active.completion, privateSideQuestionFailure());
              return true;
          }
        }
        if (
          raw.type === "session_resynced" ||
          raw.type === "session_replaced" ||
          raw.type === "closed" ||
          (raw.type === "connection_status" && raw.status === "reconnecting")
        ) {
          yield* failActivePrivateSideQuestions();
        }
        return false;
      });

    const trackAgentRoster = (event: PrimeDaemonEvent) => {
      if (event._tag === "SessionResynced") {
        knownAgentRoster.clear();
        for (const child of event.children) knownAgentRoster.set(child.id, child);
      } else if (event._tag === "ChildUpdated") {
        knownAgentRoster.set(event.child.id, event.child);
      }
    };

    const offerDecoded = (raw: unknown) => {
      const event = safeEvent(decodePrimeAgentDaemonEvent(raw));
      if (event._tag === "SessionResynced" && event.lastEventSequence !== undefined) {
        if (lastSnapshotSequence !== undefined && event.lastEventSequence <= lastSnapshotSequence) {
          return Effect.void;
        }
        lastSnapshotSequence = event.lastEventSequence;
      }
      trackAgentRoster(event);
      return Queue.offer(eventQueue, event).pipe(Effect.asVoid);
    };
    const routeRawEvent = (raw: unknown) =>
      handlePrivateSideQuestionEvent(raw).pipe(
        Effect.flatMap((handled) => (handled ? Effect.void : offerDecoded(raw))),
      );

    // The initial snapshot reserves one queue slot. Admission is cumulative for
    // the whole initialization phase: draining a batch never reopens capacity.
    // This keeps overlapping fire-and-forget daemon callbacks bounded too.
    unsubscribe = connection.subscribe((event) => {
      if (initializing) {
        if (initializationAcceptedEventCount >= PRIME_AGENT_EVENT_BUFFER_CAPACITY - 1) {
          initializationOverflow = true;
          return;
        }
        initializationAcceptedEventCount += 1;
        bufferedEvents.push(event);
        return;
      }
      return runPromise(routeRawEvent(event));
    });

    const rawSnapshot = yield* Effect.tryPromise({
      try: () => connection!.getInitialSnapshot(),
      catch: () =>
        runtimeError(
          "initial-snapshot",
          "request-failed",
          "Could not read the daemon session snapshot.",
        ),
    }).pipe(
      Effect.onError(() =>
        Effect.promise(async () => {
          unsubscribe?.();
          await connection?.dispose().catch(() => undefined);
          client.close();
        }),
      ),
    );
    if (initializationOverflow) {
      unsubscribe();
      yield* Effect.promise(() => connection!.dispose().catch(() => undefined));
      client.close();
      return yield* runtimeError(
        "initial-snapshot",
        "request-failed",
        "The daemon emitted too many events while initializing the session.",
      );
    }
    const initialEvent = safeEvent(
      decodePrimeAgentDaemonEvent({ type: "session_resynced", snapshot: rawSnapshot }),
    );
    if (initialEvent._tag !== "SessionResynced" || initialEvent.state.sessionId !== sessionId) {
      unsubscribe();
      yield* Effect.promise(() => connection!.dispose().catch(() => undefined));
      client.close();
      return yield* runtimeError(
        "initial-snapshot",
        "invalid-response",
        "The daemon returned an invalid or mismatched initial snapshot.",
      );
    }
    if (
      input.requiredExtension !== undefined &&
      (initialEvent.state.isStreaming ||
        initialEvent.state.isBashRunning ||
        initialEvent.state.inputQueue.activeAction ||
        initialEvent.children.some(
          (child) => child.status === "queued" || child.status === "running",
        ))
    ) {
      unsubscribe();
      yield* Effect.promise(() => connection!.dispose().catch(() => undefined));
      client.close();
      return yield* runtimeError(
        "verify-extension",
        "invalid-response",
        "Prime Agent restored active execution that was not admitted by supervised mode.",
      );
    }
    lastSnapshotSequence = initialEvent.lastEventSequence;
    trackAgentRoster(initialEvent);

    const initialResources =
      verifiedInventory !== undefined
        ? safeSessionResources(verifiedInventory[0], verifiedInventory[1], true)
        : yield* Effect.tryPromise({
            try: () => Promise.all([connection!.getResourceSnapshot(), connection!.getCommands()]),
            catch: () => undefined,
          }).pipe(
            Effect.timeoutOption(1_000),
            Effect.orElseSucceed(() => Option.none()),
            Effect.map((result) => {
              if (Option.isNone(result) || result.value === undefined)
                return unavailableSessionResources;
              const resources = decodeResourceSnapshot(result.value[0]);
              const commands = decodeCommands(result.value[1]);
              return Option.isSome(resources) && Option.isSome(commands)
                ? safeSessionResources(resources.value, commands.value, false)
                : unavailableSessionResources;
            }),
          );

    const initialAgentDepth =
      verifiedAgentDepth ??
      (yield* Effect.gen(function* () {
        if (!Predicate.isFunction(connection?.getRlmMaxDepthStatus)) {
          return yield* runtimeError(
            "get-agent-depth",
            "incompatible-api",
            "The installed Prime Agent connection does not expose agent depth.",
          );
        }
        const rawDepth = yield* Effect.tryPromise({
          try: () => connection!.getRlmMaxDepthStatus!(),
          catch: () =>
            runtimeError(
              "get-agent-depth",
              "request-failed",
              "Could not read the Prime Agent session agent depth.",
            ),
        });
        const depth = decodeRlmMaxDepthStatus(rawDepth);
        if (Option.isNone(depth)) {
          return yield* runtimeError(
            "get-agent-depth",
            "invalid-response",
            "Prime Agent returned an invalid session agent depth.",
          );
        }
        return safeAgentDepth(depth.value, true);
      }).pipe(Effect.onError(() => closeAttachedSession)));

    const readInputQueueStatus = (
      operation: "get-input-queue" | "clear-input-queue" | "set-input-queue-mode",
    ): Effect.Effect<PrimeAgentDaemonInputQueueStatus, PrimeAgentDaemonSessionRuntimeError> =>
      Effect.gen(function* () {
        const getState = connection!.getState;
        const statusOutput = yield* Effect.tryPromise({
          try: async () =>
            typeof getState === "function"
              ? { kind: "state" as const, value: await getState.call(connection) }
              : {
                  kind: "snapshot" as const,
                  value: await connection!.getInitialSnapshot(),
                },
          catch: () =>
            runtimeError(
              operation,
              "request-failed",
              "Could not read the Prime Agent session action state.",
            ),
        }).pipe(
          Effect.timeoutOrElse({
            duration: COMMAND_TIMEOUT_MS,
            orElse: () =>
              runtimeError(
                operation,
                "request-timed-out",
                "Timed out while reading the Prime Agent session action state.",
              ),
          }),
        );
        const state =
          statusOutput.kind === "state"
            ? decodePrimeAgentDaemonSessionState(statusOutput.value)
            : (() => {
                const event = decodePrimeAgentDaemonEvent({
                  type: "session_resynced",
                  snapshot: statusOutput.value,
                });
                return event._tag === "SessionResynced" ? event.state : undefined;
              })();
        if (
          state === undefined ||
          state.activeSessionId !== initialEvent.state.activeSessionId ||
          state.sessionId !== sessionId
        ) {
          return yield* runtimeError(
            operation,
            "invalid-response",
            "Prime Agent returned an invalid or mismatched session action state.",
          );
        }
        return {
          queue: {
            steeringCount: state.inputQueue.steeringCount,
            followUpCount: state.inputQueue.followUpCount,
            steeringMode: state.inputQueue.steeringMode,
            followUpMode: state.inputQueue.followUpMode,
          },
          activeAction: state.inputQueue.activeAction,
          isStreaming: state.isStreaming,
        };
      });

    const initialInputQueue = yield* Effect.gen(function* () {
      const safeQueue = {
        steeringCount: initialEvent.state.inputQueue.steeringCount,
        followUpCount: initialEvent.state.inputQueue.followUpCount,
        steeringMode: initialEvent.state.inputQueue.steeringMode,
        followUpMode: initialEvent.state.inputQueue.followUpMode,
      };
      if (
        input.requiredExtension === undefined ||
        (safeQueue.steeringCount === 0 && safeQueue.followUpCount === 0)
      ) {
        return safeQueue;
      }
      const clearQueue = yield* requireMethod("clear-input-queue", connection!.clearQueue);
      const removed = yield* Effect.tryPromise({
        try: () => clearQueue.call(connection),
        catch: () =>
          runtimeError(
            "clear-input-queue",
            "request-failed",
            "Could not clear restored Prime Agent session inputs in supervised mode.",
          ),
      });
      if (Option.isNone(decodeInputQueueCounts(removed))) {
        return yield* runtimeError(
          "clear-input-queue",
          "invalid-response",
          "Prime Agent returned an invalid cleared supervised input queue.",
        );
      }
      const confirmed = yield* readInputQueueStatus("clear-input-queue");
      if (
        confirmed.queue.steeringCount > 0 ||
        confirmed.queue.followUpCount > 0 ||
        confirmed.activeAction ||
        confirmed.isStreaming
      ) {
        return yield* runtimeError(
          "clear-input-queue",
          "invalid-response",
          "Prime Agent did not confirm an empty supervised session input queue.",
        );
      }
      return confirmed.queue;
    }).pipe(Effect.onError(() => closeAttachedSession));

    const ensureOpen = (
      operation: PrimeAgentDaemonSessionRuntimeError["operation"],
    ): Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError> =>
      disposed || disposeStarted
        ? Effect.fail(runtimeError(operation, "disposed", "The daemon session is disposed."))
        : Effect.void;

    const callVoid = (
      operation: PrimeAgentDaemonSessionRuntimeError["operation"],
      call: () => Promise<unknown>,
    ) =>
      ensureOpen(operation).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: call,
            catch: () => runtimeError(operation, "request-failed", "The daemon operation failed."),
          }),
        ),
        Effect.flatMap((output) =>
          output === undefined
            ? Effect.void
            : Effect.fail(
                runtimeError(
                  operation,
                  "invalid-response",
                  "The daemon operation returned an invalid response.",
                ),
              ),
        ),
      );

    const requireMethod = <T extends (...args: never[]) => Promise<unknown>>(
      operation: PrimeAgentDaemonSessionRuntimeError["operation"],
      method: T | undefined,
    ): Effect.Effect<T, PrimeAgentDaemonSessionRuntimeError> =>
      Predicate.isFunction(method)
        ? Effect.succeed(method)
        : Effect.fail(
            runtimeError(
              operation,
              "incompatible-api",
              "The installed Prime Agent connection does not support this operation.",
            ),
          );

    const agentMessageAvailable =
      input.requiredExtension === undefined && Predicate.isFunction(connection!.sendAgentMessage);
    const compactionAvailable =
      input.requiredExtension === undefined &&
      Predicate.isFunction(connection!.getState) &&
      Predicate.isFunction(connection!.compact) &&
      Predicate.isFunction(connection!.abortCompaction);
    const refinementAvailable =
      input.requiredExtension === undefined &&
      !shouldContinue &&
      Predicate.isFunction(connection!.refine);
    const autoCompactionWritable =
      input.requiredExtension === undefined &&
      Predicate.isFunction(connection!.getState) &&
      Predicate.isFunction(connection!.setAutoCompactionEnabled);
    const initialCompactionState: PrimeAgentDaemonCompactionState = {
      isCompacting: initialEvent.state.isCompacting,
      autoCompactionEnabled: initialEvent.state.autoCompactionEnabled,
      isStreaming: initialEvent.state.isStreaming,
      isBashRunning: initialEvent.state.isBashRunning,
      inputQueueActive: initialEvent.state.inputQueue.activeAction,
      steeringCount: initialEvent.state.inputQueue.steeringCount,
      followUpCount: initialEvent.state.inputQueue.followUpCount,
    };

    const getCompactionState = Effect.gen(function* () {
      yield* ensureOpen("get-compaction-state");
      const getState = yield* requireMethod("get-compaction-state", connection!.getState);
      const output = yield* Effect.tryPromise({
        try: () => getState.call(connection),
        catch: () =>
          runtimeError(
            "get-compaction-state",
            "request-failed",
            "Could not read Prime Agent context compaction state.",
          ),
      }).pipe(
        Effect.timeoutOrElse({
          duration: COMMAND_TIMEOUT_MS,
          orElse: () =>
            runtimeError(
              "get-compaction-state",
              "request-timed-out",
              "Timed out while reading Prime Agent context compaction state.",
            ),
        }),
      );
      const state = decodePrimeAgentDaemonSessionState(output);
      if (
        state === undefined ||
        state.activeSessionId !== initialEvent.state.activeSessionId ||
        state.sessionId !== sessionId
      ) {
        return yield* runtimeError(
          "get-compaction-state",
          "invalid-response",
          "Prime Agent returned invalid or mismatched context compaction state.",
        );
      }
      return {
        isCompacting: state.isCompacting,
        autoCompactionEnabled: state.autoCompactionEnabled,
        isStreaming: state.isStreaming,
        isBashRunning: state.isBashRunning,
        inputQueueActive: state.inputQueue.activeAction,
        steeringCount: state.inputQueue.steeringCount,
        followUpCount: state.inputQueue.followUpCount,
      } satisfies PrimeAgentDaemonCompactionState;
    });

    const compact = Effect.gen(function* () {
      yield* ensureOpen("compact");
      if (!compactionAvailable) {
        return yield* runtimeError(
          "compact",
          "incompatible-api",
          "The installed Prime Agent connection does not support context compaction.",
        );
      }
      const method = yield* requireMethod("compact", connection!.compact);
      yield* Effect.tryPromise({
        // Never pass custom instructions. The entire native CompactionResult is private.
        try: async () => {
          await method.call(connection);
        },
        catch: () =>
          runtimeError("compact", "request-failed", "Prime Agent context compaction failed."),
      });
    });

    const refineLocalHarness = Effect.gen(function* () {
      yield* ensureOpen("refine-local-harness");
      if (!refinementAvailable) {
        return yield* runtimeError(
          "refine-local-harness",
          "incompatible-api",
          "The active Prime Agent session does not support local harness refinement.",
        );
      }
      const method = yield* requireMethod("refine-local-harness", connection!.refine);
      const rawResult = yield* Effect.tryPromise({
        // Pylon never supplies instructions, rollback identities, or global scope. A rejected
        // request is outcome-ambiguous because Prime may continue after its request timeout.
        try: () => method.call(connection, { global: false }),
        catch: () =>
          runtimeError(
            "refine-local-harness",
            "request-failed",
            "Prime Agent local harness refinement outcome is unavailable.",
          ),
      });
      const decoded = decodeRefinementResult(rawResult);
      if (
        Option.isNone(decoded) ||
        decoded.value.scope === "global" ||
        decoded.value.appliedEdits.length > 128
      ) {
        return yield* runtimeError(
          "refine-local-harness",
          "invalid-response",
          "Prime Agent returned an invalid local harness refinement result.",
        );
      }
      const appliedCount = decoded.value.appliedEdits.filter((item) => item.applied).length;
      const failedCount = decoded.value.appliedEdits.length - appliedCount;
      return {
        appliedCount,
        failedCount,
        outcome:
          appliedCount > 0 && failedCount > 0
            ? "partial"
            : failedCount > 0
              ? "failed"
              : "completed",
      } satisfies ProviderRefineSessionHarnessResult;
    });

    const abortCompaction = Effect.gen(function* () {
      yield* ensureOpen("abort-compaction");
      if (!compactionAvailable) {
        return yield* runtimeError(
          "abort-compaction",
          "incompatible-api",
          "The installed Prime Agent connection does not support compaction cancellation.",
        );
      }
      const method = yield* requireMethod("abort-compaction", connection!.abortCompaction);
      yield* callVoid("abort-compaction", () => method.call(connection)).pipe(
        Effect.timeoutOrElse({
          duration: COMMAND_TIMEOUT_MS,
          orElse: () =>
            runtimeError(
              "abort-compaction",
              "request-timed-out",
              "Timed out while requesting Prime Agent compaction cancellation.",
            ),
        }),
      );
    });

    const setAutoCompactionEnabled = Effect.fn(
      "PrimeAgentDaemonSessionRuntime.setAutoCompactionEnabled",
    )(function* (enabled: boolean) {
      yield* ensureOpen("set-auto-compaction");
      if (!autoCompactionWritable) {
        return yield* runtimeError(
          "set-auto-compaction",
          "incompatible-api",
          "The installed Prime Agent connection does not support automatic compaction settings.",
        );
      }
      const method = yield* requireMethod(
        "set-auto-compaction",
        connection!.setAutoCompactionEnabled,
      );
      // This writes Prime's provider-wide default. Do not impose a local timeout: a timed-out
      // native promise could persist the setting later, and closing one session cannot reconcile
      // that provider-global uncertainty.
      yield* callVoid("set-auto-compaction", () => method.call(connection, enabled));
    });

    const getAgentDepth = Effect.gen(function* () {
      yield* ensureOpen("get-agent-depth");
      if (input.requiredExtension !== undefined) return initialAgentDepth;
      const method = yield* requireMethod("get-agent-depth", connection!.getRlmMaxDepthStatus);
      const output = yield* Effect.tryPromise({
        try: () => method.call(connection),
        catch: () =>
          runtimeError(
            "get-agent-depth",
            "request-failed",
            "Could not read the Prime Agent session agent depth.",
          ),
      });
      const depth = decodeRlmMaxDepthStatus(output);
      if (Option.isNone(depth)) {
        return yield* runtimeError(
          "get-agent-depth",
          "invalid-response",
          "Prime Agent returned an invalid session agent depth.",
        );
      }
      return safeAgentDepth(depth.value, true);
    });

    const setAgentDepth = Effect.fn("PrimeAgentDaemonSessionRuntime.setAgentDepth")(function* (
      maxDepth: number,
    ) {
      yield* ensureOpen("set-agent-depth");
      if (
        !Number.isInteger(maxDepth) ||
        maxDepth < 0 ||
        maxDepth > PROVIDER_SESSION_AGENT_DEPTH_MAX_SETTABLE
      ) {
        return yield* runtimeError(
          "set-agent-depth",
          "invalid-input",
          `Agent depth must be an integer from 0 to ${PROVIDER_SESSION_AGENT_DEPTH_MAX_SETTABLE}.`,
        );
      }
      if (input.requiredExtension !== undefined) {
        return yield* runtimeError(
          "set-agent-depth",
          "invalid-input",
          "Agent depth is fixed by the supervised execution policy.",
        );
      }
      const method = yield* requireMethod("set-agent-depth", connection!.setRlmMaxDepth);
      const output = yield* Effect.tryPromise({
        // Per-session only. Never pass Prime's global persistence option.
        try: () => method.call(connection, maxDepth),
        catch: () =>
          runtimeError(
            "set-agent-depth",
            "request-failed",
            "Could not update the Prime Agent session agent depth.",
          ),
      });
      const depth = decodeRlmMaxDepthStatus(output);
      if (Option.isNone(depth) || depth.value.maxDepth !== maxDepth) {
        return yield* runtimeError(
          "set-agent-depth",
          "invalid-response",
          "Prime Agent did not confirm the requested session agent depth.",
        );
      }
      return safeAgentDepth(depth.value, true);
    });

    const readAgentRoster = (
      operation: "get-agent-roster" | "cancel-agent",
    ): Effect.Effect<ReadonlyArray<PrimeAgentDaemonChild>, PrimeAgentDaemonSessionRuntimeError> =>
      Effect.gen(function* () {
        yield* ensureOpen(operation);
        return [...knownAgentRoster.values()];
      });

    const getAgentRoster = readAgentRoster("get-agent-roster");

    const cancelAgent = Effect.fn("PrimeAgentDaemonSessionRuntime.cancelAgent")(function* (
      rawAgentId: string,
    ) {
      yield* ensureOpen("cancel-agent");
      const agentId = yield* validateNonEmpty("cancel-agent", "Agent id", rawAgentId);
      if (agentId.length > PROVIDER_AGENT_CONTROL_ID_MAX_CHARS) {
        return yield* runtimeError(
          "cancel-agent",
          "invalid-input",
          `Agent id must be at most ${PROVIDER_AGENT_CONTROL_ID_MAX_CHARS} characters.`,
        );
      }
      if (input.requiredExtension !== undefined) {
        return yield* runtimeError(
          "cancel-agent",
          "invalid-input",
          "Agent cancellation is unavailable in supervised sessions.",
        );
      }
      const method = yield* requireMethod("cancel-agent", connection!.cancelRlmChild);
      const output = yield* Effect.tryPromise({
        try: () => method.call(connection, agentId),
        catch: () =>
          runtimeError("cancel-agent", "request-failed", "Could not cancel the Prime Agent agent."),
      }).pipe(
        Effect.timeoutOrElse({
          duration: COMMAND_TIMEOUT_MS,
          orElse: () =>
            runtimeError(
              "cancel-agent",
              "request-failed",
              "Timed out while cancelling the Prime Agent agent.",
            ),
        }),
      );
      if (typeof output !== "boolean") {
        return yield* runtimeError(
          "cancel-agent",
          "invalid-response",
          "Prime Agent returned an invalid agent cancellation result.",
        );
      }
      return output;
    });

    const messageAgent = Effect.fn("PrimeAgentDaemonSessionRuntime.messageAgent")(function* (
      rawActiveSessionId: string,
      rawMessage: string,
    ) {
      yield* ensureOpen("message-agent");
      const targetActiveSessionId = yield* validateNonEmpty(
        "message-agent",
        "Target active session id",
        rawActiveSessionId,
      );
      const message = yield* validateNonEmpty("message-agent", "Message", rawMessage);
      if (message.length > PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS) {
        return yield* runtimeError(
          "message-agent",
          "invalid-input",
          `Message must be at most ${PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS} characters.`,
        );
      }
      if (input.requiredExtension !== undefined) {
        return yield* runtimeError(
          "message-agent",
          "invalid-input",
          "Agent messaging is unavailable in supervised sessions.",
        );
      }
      const method = yield* requireMethod("message-agent", connection!.sendAgentMessage);
      const output = yield* Effect.tryPromise({
        try: () => method.call(connection, targetActiveSessionId, message),
        catch: () =>
          runtimeError(
            "message-agent",
            "request-failed",
            "Prime Agent message delivery could not be confirmed.",
          ),
      }).pipe(
        Effect.timeoutOrElse({
          duration: COMMAND_TIMEOUT_MS,
          orElse: () =>
            runtimeError(
              "message-agent",
              "request-timed-out",
              "Prime Agent message delivery could not be confirmed.",
            ),
        }),
      );
      const receipt = decodeAgentMessageReceipt(output);
      if (Option.isNone(receipt)) {
        return yield* runtimeError(
          "message-agent",
          "invalid-response",
          "Prime Agent message delivery could not be confirmed.",
        );
      }
      return receipt.value.deliveryStatus;
    });

    const watchAgentActivityAvailable =
      input.requiredExtension === undefined && Predicate.isFunction(connection!.watchSession);

    const watchAgentActivity: PrimeAgentDaemonSessionRuntime["watchAgentActivity"] = (
      rawActiveSessionId,
    ) =>
      Stream.callback<
        ReadonlyArray<ProviderSessionAgentActivityEntry>,
        PrimeAgentDaemonSessionRuntimeError
      >((queue) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            yield* ensureOpen("watch-agent-activity");
            const activeSessionId = yield* validateNonEmpty(
              "watch-agent-activity",
              "Target active session id",
              rawActiveSessionId,
            );
            if (input.requiredExtension !== undefined) {
              return yield* runtimeError(
                "watch-agent-activity",
                "incompatible-api",
                "Live agent activity is unavailable in supervised sessions.",
              );
            }
            const method = connection!.watchSession;
            if (!Predicate.isFunction(method)) {
              return yield* runtimeError(
                "watch-agent-activity",
                "incompatible-api",
                "The installed Prime Agent connection does not support live agent activity.",
              );
            }
            const watcher = yield* Effect.tryPromise({
              try: () => method.call(connection, activeSessionId),
              catch: () =>
                runtimeError(
                  "watch-agent-activity",
                  "request-failed",
                  "Could not attach the live agent activity watcher.",
                ),
            });
            if (
              !Predicate.isObject(watcher) ||
              !Predicate.isFunction(watcher.getMessages) ||
              !Predicate.isFunction(watcher.subscribe) ||
              !Predicate.isFunction(watcher.close)
            ) {
              return yield* runtimeError(
                "watch-agent-activity",
                "request-failed",
                "Could not attach the live agent activity watcher.",
              );
            }

            let closed = false;
            let initialized = false;
            let pendingEventsTerminal = false;
            const pendingWatchEvents: Array<unknown> = [];
            let streamingMessageActive = false;
            let latestEntries: ReadonlyArray<ProviderSessionAgentActivityEntry> | undefined;
            let lastPublishedEntries: ReadonlyArray<ProviderSessionAgentActivityEntry> | undefined;
            const pendingEntries =
              yield* Queue.sliding<ReadonlyArray<ProviderSessionAgentActivityEntry>>(1);
            const entriesChanged = (next: ReadonlyArray<ProviderSessionAgentActivityEntry>) =>
              lastPublishedEntries === undefined ||
              next.length !== lastPublishedEntries.length ||
              next.some((entry, index) => entry.text !== lastPublishedEntries?.[index]?.text);
            const offerEntries = (next: ReadonlyArray<ProviderSessionAgentActivityEntry>) =>
              Effect.gen(function* () {
                latestEntries = next;
                if (closed || !entriesChanged(next)) return;
                lastPublishedEntries = next;
                yield* Queue.offer(queue, next);
              });
            const queueEntries = (next: ReadonlyArray<ProviderSessionAgentActivityEntry>) =>
              Effect.gen(function* () {
                latestEntries = next;
                if (!closed) yield* Queue.offer(pendingEntries, next);
              });
            const failActivity = (error: PrimeAgentDaemonSessionRuntimeError) =>
              Effect.gen(function* () {
                if (closed) return;
                closed = true;
                yield* Queue.fail(queue, error);
              });
            const replacementEntries = (event: Record<string, unknown>) => {
              const state = Predicate.isObject(event.state) ? event.state : undefined;
              const snapshot = Predicate.isObject(event.snapshot) ? event.snapshot : undefined;
              const replacement = state ?? snapshot;
              const messages = Array.isArray(event.messages)
                ? event.messages
                : replacement !== undefined && Array.isArray(replacement.messages)
                  ? replacement.messages
                  : undefined;
              if (messages === undefined) return undefined;
              const streamingMessage =
                replacement !== undefined && "streamingMessage" in replacement
                  ? replacement.streamingMessage
                  : event.streamingMessage;
              const visibleStreaming = sanitizePrimeAgentLiveActivityMessages([
                streamingMessage,
              ])[0];
              return {
                entries:
                  visibleStreaming === undefined
                    ? sanitizePrimeAgentLiveActivityMessages(messages)
                    : sanitizePrimeAgentLiveActivityMessages([
                        ...messages,
                        {
                          role: "assistant",
                          content: [{ type: "text", text: visibleStreaming.text }],
                        },
                      ]),
                streaming: visibleStreaming !== undefined,
              };
            };
            const updateStreamingMessage = (
              message: unknown,
              phase: "start" | "update" | "end",
            ) => {
              const visible = sanitizePrimeAgentLiveActivityMessages([message]);
              if (visible.length === 0) return undefined;
              const committed = [...(latestEntries ?? [])];
              if (
                phase === "end" &&
                !streamingMessageActive &&
                committed.at(-1)?.text === visible[0]?.text
              ) {
                streamingMessageActive = false;
                return committed;
              }
              if (streamingMessageActive && phase !== "start") committed.pop();
              const next = sanitizePrimeAgentLiveActivityMessages([
                ...committed.map((entry) => ({
                  role: "assistant",
                  content: [{ type: "text", text: entry.text }],
                })),
                message,
              ]);
              streamingMessageActive = phase !== "end";
              return next;
            };
            const handleWatchEvent = (event: unknown) =>
              Effect.gen(function* () {
                if (closed || !Predicate.isObject(event) || !Predicate.isString(event.type)) return;
                if (event.type === "closed") {
                  yield* failActivity(
                    runtimeError(
                      "watch-agent-activity",
                      "request-failed",
                      "The live agent activity watcher closed unexpectedly.",
                    ),
                  );
                  return;
                }
                if (event.type === "session_replaced" || event.type === "session_resynced") {
                  const replacement = replacementEntries(event);
                  if (replacement !== undefined) {
                    yield* Queue.poll(pendingEntries);
                    streamingMessageActive = replacement.streaming;
                    yield* offerEntries(replacement.entries);
                  }
                  return;
                }
                if (event.type !== "session_event" || !Predicate.isObject(event.event)) return;
                const nativeEvent = event.event;
                if (
                  nativeEvent.type === "message_start" ||
                  nativeEvent.type === "message_update" ||
                  nativeEvent.type === "message_end"
                ) {
                  const phase =
                    nativeEvent.type === "message_start"
                      ? "start"
                      : nativeEvent.type === "message_update"
                        ? "update"
                        : "end";
                  const next = updateStreamingMessage(nativeEvent.message, phase);
                  if (next === undefined) return;
                  if (phase === "end") {
                    yield* Queue.poll(pendingEntries);
                    yield* offerEntries(next);
                  } else {
                    yield* queueEntries(next);
                  }
                }
              });

            const safeAssistantMessage = (text: string) => ({
              role: "assistant",
              content: [{ type: "text", text }],
            });
            const sanitizePendingWatchEvent = (event: unknown): unknown => {
              if (!Predicate.isObject(event) || !Predicate.isString(event.type)) return undefined;
              if (event.type === "closed") return { type: "closed" };
              if (event.type === "session_replaced" || event.type === "session_resynced") {
                const replacement = replacementEntries(event);
                if (replacement === undefined) return { type: event.type };
                const committed = replacement.streaming
                  ? replacement.entries.slice(0, -1)
                  : replacement.entries;
                const streaming = replacement.streaming ? replacement.entries.at(-1) : undefined;
                return {
                  type: event.type,
                  messages: committed.map((entry) => safeAssistantMessage(entry.text)),
                  ...(streaming === undefined
                    ? {}
                    : { streamingMessage: safeAssistantMessage(streaming.text) }),
                };
              }
              if (event.type !== "session_event" || !Predicate.isObject(event.event)) {
                return undefined;
              }
              const nativeEvent = event.event;
              if (
                nativeEvent.type !== "message_start" &&
                nativeEvent.type !== "message_update" &&
                nativeEvent.type !== "message_end"
              ) {
                return undefined;
              }
              const visible = sanitizePrimeAgentLiveActivityMessages([nativeEvent.message]);
              return {
                type: "session_event",
                event: {
                  type: nativeEvent.type,
                  ...(visible[0] === undefined
                    ? {}
                    : { message: safeAssistantMessage(visible[0].text) }),
                },
              };
            };

            const unsubscribeResult = yield* Effect.try({
              try: () =>
                watcher.subscribe(async (event) => {
                  if (!initialized) {
                    if (pendingEventsTerminal) return;
                    const pending = sanitizePendingWatchEvent(event);
                    if (pending === undefined) return;
                    if (pendingWatchEvents.length >= PRIME_AGENT_LIVE_ACTIVITY_PENDING_EVENT_MAX) {
                      pendingEventsTerminal = true;
                      await runPromise(
                        failActivity(
                          runtimeError(
                            "watch-agent-activity",
                            "request-failed",
                            "Too many live agent activity events arrived during initialization.",
                          ),
                        ),
                      );
                      return;
                    }
                    pendingWatchEvents.push(pending);
                    if (Predicate.isObject(pending) && pending.type === "closed") {
                      pendingEventsTerminal = true;
                    }
                    return;
                  }
                  await runPromise(handleWatchEvent(event));
                }),
              catch: () =>
                runtimeError(
                  "watch-agent-activity",
                  "request-failed",
                  "Could not subscribe to live agent activity.",
                ),
            }).pipe(
              Effect.onError(() => Effect.promise(() => watcher.close().catch(() => undefined))),
            );
            if (!Predicate.isFunction(unsubscribeResult)) {
              yield* Effect.promise(() => watcher.close().catch(() => undefined));
              return yield* runtimeError(
                "watch-agent-activity",
                "request-failed",
                "Could not subscribe to live agent activity.",
              );
            }

            const initialMessages = yield* Effect.tryPromise({
              try: () => watcher.getMessages(),
              catch: () =>
                runtimeError(
                  "watch-agent-activity",
                  "request-failed",
                  "Could not read initial live agent activity.",
                ),
            }).pipe(
              Effect.onError(() =>
                Effect.promise(async () => {
                  unsubscribeResult();
                  await watcher.close().catch(() => undefined);
                }),
              ),
            );
            const initialEntries = sanitizePrimeAgentLiveActivityMessages(initialMessages);
            latestEntries = initialEntries;
            lastPublishedEntries = initialEntries;
            if (!closed) yield* Queue.offer(queue, initialEntries);
            while (pendingWatchEvents.length > 0) {
              if (closed) break;
              const batch = pendingWatchEvents.splice(0, pendingWatchEvents.length);
              for (const event of batch) {
                if (closed) break;
                yield* handleWatchEvent(event);
              }
            }
            initialized = true;

            const refreshFiber = yield* Effect.gen(function* () {
              while (true) {
                const first = yield* Queue.take(pendingEntries);
                yield* Effect.sleep(PRIME_AGENT_LIVE_ACTIVITY_REFRESH_DELAY_MS);
                const remaining = yield* Queue.poll(pendingEntries);
                if (closed) return;
                yield* offerEntries(Option.getOrElse(remaining, () => first));
              }
            }).pipe(Effect.forkScoped({ startImmediately: true }));

            return {
              watcher,
              unsubscribe: unsubscribeResult,
              refreshFiber,
              close: () => {
                closed = true;
              },
            };
          }),
          ({ watcher, unsubscribe, refreshFiber, close }) =>
            Effect.gen(function* () {
              close();
              yield* Fiber.interrupt(refreshFiber);
              unsubscribe();
              yield* Effect.promise(() => watcher.close().catch(() => undefined));
            }),
        ).pipe(Effect.catch((error) => Queue.fail(queue, error))),
      );

    const prompt = Effect.fn("PrimeAgentDaemonSessionRuntime.prompt")(function* (
      promptInput: PrimeAgentDaemonPromptInput,
    ) {
      yield* ensureOpen("prompt");
      const images = yield* validateImages("prompt", promptInput.images);
      yield* validatePromptContent("prompt", promptInput.text, images);
      yield* callVoid("prompt", () =>
        connection!.promptAndWait(promptInput.text, {
          queueIfBusy: false,
          ...(images.length === 0 ? {} : { images }),
          ...(promptInput.signal === undefined ? {} : { signal: promptInput.signal }),
        }),
      );
    });

    const steer = Effect.fn("PrimeAgentDaemonSessionRuntime.steer")(function* (
      promptInput: PrimeAgentDaemonPromptInput,
    ) {
      yield* ensureOpen("steer");
      const images = yield* validateImages("steer", promptInput.images);
      yield* validatePromptContent("steer", promptInput.text, images);
      const method = yield* requireMethod("steer", connection!.steer);
      yield* callVoid("steer", () => method.call(connection, promptInput.text, images));
    });

    const followUp = Effect.fn("PrimeAgentDaemonSessionRuntime.followUp")(function* (
      promptInput: PrimeAgentDaemonPromptInput,
    ) {
      yield* ensureOpen("follow-up");
      const images = yield* validateImages("follow-up", promptInput.images);
      yield* validatePromptContent("follow-up", promptInput.text, images);
      const method = yield* requireMethod("follow-up", connection!.followUp);
      yield* callVoid("follow-up", () => method.call(connection, promptInput.text, images));
    });

    const getInputQueue = Effect.gen(function* () {
      yield* ensureOpen("get-input-queue");
      const method = yield* requireMethod("get-input-queue", connection!.getQueue);
      const output = yield* Effect.tryPromise({
        try: () => method.call(connection),
        catch: () =>
          runtimeError(
            "get-input-queue",
            "request-failed",
            "Could not read the Prime Agent session input queue.",
          ),
      });
      const queue = decodeInputQueueCounts(output);
      if (Option.isNone(queue)) {
        return yield* runtimeError(
          "get-input-queue",
          "invalid-response",
          "Prime Agent returned an invalid session input queue.",
        );
      }
      return queue.value;
    });

    const getInputQueueStatus = Effect.gen(function* () {
      yield* ensureOpen("get-input-queue");
      return yield* readInputQueueStatus("get-input-queue");
    });

    const clearInputQueue = Effect.gen(function* () {
      yield* ensureOpen("clear-input-queue");
      const clear = yield* requireMethod("clear-input-queue", connection!.clearQueue);
      const removed = yield* Effect.tryPromise({
        try: () => clear.call(connection),
        catch: () =>
          runtimeError(
            "clear-input-queue",
            "request-failed",
            "Could not clear the Prime Agent session input queue.",
          ),
      });
      if (Option.isNone(decodeInputQueueCounts(removed))) {
        return yield* runtimeError(
          "clear-input-queue",
          "invalid-response",
          "Prime Agent returned an invalid cleared input queue.",
        );
      }
      const status = yield* readInputQueueStatus("clear-input-queue");
      if (status.queue.steeringCount !== 0 || status.queue.followUpCount !== 0) {
        return yield* runtimeError(
          "clear-input-queue",
          "invalid-response",
          "Prime Agent did not confirm an empty session input queue.",
        );
      }
      return status;
    });

    const setInputQueueMode = Effect.fn("PrimeAgentDaemonSessionRuntime.setInputQueueMode")(
      function* (input: {
        readonly queue: "steering" | "follow-up";
        readonly mode: SessionInputQueueDeliveryMode;
      }) {
        yield* ensureOpen("set-input-queue-mode");
        const nativeMode: PrimeAgentDaemonQueueMode =
          input.mode === "all-at-once" ? "all" : "one-at-a-time";
        const method = yield* requireMethod(
          "set-input-queue-mode",
          input.queue === "steering" ? connection!.setSteeringMode : connection!.setFollowUpMode,
        );
        const output = yield* Effect.tryPromise({
          try: () => method.call(connection, nativeMode),
          catch: () =>
            runtimeError(
              "set-input-queue-mode",
              "request-failed",
              "Could not update the Prime Agent session input delivery mode.",
            ),
        }).pipe(
          Effect.timeoutOrElse({
            duration: COMMAND_TIMEOUT_MS,
            orElse: () =>
              runtimeError(
                "set-input-queue-mode",
                "request-timed-out",
                "Timed out while updating the Prime Agent session input delivery mode.",
              ),
          }),
        );
        if (output !== undefined) {
          return yield* runtimeError(
            "set-input-queue-mode",
            "invalid-response",
            "Prime Agent returned an invalid input delivery mode response.",
          );
        }
      },
    );

    const abort = Effect.gen(function* () {
      yield* ensureOpen("abort");
      yield* callVoid("abort", () => connection!.abort());
    });

    const abortAndClearQueue = Effect.gen(function* () {
      yield* ensureOpen("abort-and-clear-queue");
      const method = yield* requireMethod("abort-and-clear-queue", connection!.abortAndClearQueue);
      const output = yield* Effect.tryPromise({
        try: () => method.call(connection),
        catch: () =>
          runtimeError(
            "abort-and-clear-queue",
            "request-failed",
            "The daemon abort-and-clear operation failed.",
          ),
      });
      if (Option.isNone(decodeInputQueueCounts(output))) {
        return yield* runtimeError(
          "abort-and-clear-queue",
          "invalid-response",
          "The daemon abort-and-clear operation returned an invalid response.",
        );
      }
    });

    const sideQuestionsAvailable =
      Predicate.isFunction(connection!.startSideQuestion) &&
      Predicate.isFunction(connection!.abortSideQuestion);

    const bestEffortAbortSideQuestion = (nativeId: string, active: ActivePrivateSideQuestion) =>
      Effect.suspend(() => {
        if (active.abortRequested || active.terminalObserved) return Effect.void;
        active.abortRequested = true;
        return Effect.tryPromise({
          try: () => connection!.abortSideQuestion!.call(connection, nativeId),
          catch: () => undefined,
        }).pipe(Effect.timeoutOption(SIDE_QUESTION_ABORT_TIMEOUT_MS), Effect.ignore);
      });

    const askSideQuestion = Effect.fn("PrimeAgentDaemonSessionRuntime.askSideQuestion")(function* (
      nativeId: string,
      question: string,
    ) {
      yield* ensureOpen("side-question");
      if (!SIDE_QUESTION_NATIVE_ID_PATTERN.test(nativeId) || question.trim().length === 0) {
        return yield* runtimeError(
          "side-question",
          "invalid-input",
          "The side-question request is invalid.",
        );
      }
      const start = yield* requireMethod("side-question", connection!.startSideQuestion);
      yield* requireMethod("abort-side-question", connection!.abortSideQuestion);
      if (activePrivateSideQuestions.has(nativeId)) {
        return yield* runtimeError(
          "side-question",
          "invalid-input",
          "The side-question request is already active.",
        );
      }

      const completion = yield* Deferred.make<
        PrimeAgentDaemonSideQuestionResult,
        PrimeAgentDaemonSessionRuntimeError
      >();
      const active: ActivePrivateSideQuestion = {
        completion,
        updateCount: 0,
        cumulativeAnswerBytes: 0,
        settled: false,
        terminalObserved: false,
        abortRequested: false,
      };
      // No yield may occur between consuming a pre-start abort and registration.
      if (prestartAbortedSideQuestionIds.delete(nativeId)) {
        rememberSettledSideQuestionId(nativeId);
        return { disposition: "cancelled" } as const;
      }
      activePrivateSideQuestions.set(nativeId, active);

      const terminal = Deferred.await(completion);
      return yield* Effect.raceFirst(
        Effect.tryPromise({
          // Deliberately pass no transcript: a defensive unary request has no native follow-ups.
          try: () => start.call(connection, nativeId, question),
          catch: () => privateSideQuestionFailure(),
        }).pipe(Effect.andThen(terminal)),
        terminal,
      ).pipe(
        Effect.ensuring(
          bestEffortAbortSideQuestion(nativeId, active).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                activePrivateSideQuestions.delete(nativeId);
                rememberSettledSideQuestionId(nativeId);
              }),
            ),
          ),
        ),
      );
    });

    const abortSideQuestion = Effect.fn("PrimeAgentDaemonSessionRuntime.abortSideQuestion")(
      function* (nativeId: string) {
        yield* ensureOpen("abort-side-question");
        if (!SIDE_QUESTION_NATIVE_ID_PATTERN.test(nativeId)) {
          return yield* runtimeError(
            "abort-side-question",
            "invalid-input",
            "The side-question cancellation request is invalid.",
          );
        }
        yield* requireMethod("abort-side-question", connection!.abortSideQuestion);
        const active = activePrivateSideQuestions.get(nativeId);
        if (active !== undefined) {
          yield* bestEffortAbortSideQuestion(nativeId, active);
          return;
        }
        if (
          recentlySettledSideQuestionIds.has(nativeId) ||
          prestartAbortedSideQuestionIds.has(nativeId)
        ) {
          return;
        }
        if (prestartAbortedSideQuestionIds.size >= SIDE_QUESTION_PRESTART_ABORT_MAX) {
          const oldest = prestartAbortedSideQuestionIds.values().next().value;
          if (oldest !== undefined) prestartAbortedSideQuestionIds.delete(oldest);
        }
        prestartAbortedSideQuestionIds.add(nativeId);
      },
    );

    const reloadResources = Effect.gen(function* () {
      yield* ensureOpen("reload-resources");
      if (input.requiredExtension !== undefined) {
        return yield* runtimeError(
          "reload-resources",
          "invalid-input",
          "Resource reload is unavailable for supervised Prime Agent sessions.",
        );
      }
      const reload = yield* requireMethod("reload-resources", connection!.reload);
      yield* callVoid("reload-resources", () => reload.call(connection));
      yield* ensureOpen("reload-resources");
      const getDepth = yield* requireMethod("reload-resources", connection!.getRlmMaxDepthStatus);
      const rawState = yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            connection!.getResourceSnapshot(),
            connection!.getCommands(),
            getDepth.call(connection),
          ]),
        catch: () =>
          runtimeError(
            "reload-resources",
            "request-failed",
            "The daemon session state could not be read after reload.",
          ),
      });
      const resources = decodeResourceSnapshot(rawState[0]);
      const commands = decodeCommands(rawState[1]);
      const agentDepth = decodeRlmMaxDepthStatus(rawState[2]);
      if (Option.isNone(resources) || Option.isNone(commands) || Option.isNone(agentDepth)) {
        return yield* runtimeError(
          "reload-resources",
          "invalid-response",
          "The daemon returned invalid session state after reload.",
        );
      }
      return {
        resources: safeSessionResources(resources.value, commands.value, false),
        agentDepth: safeAgentDepth(agentDepth.value, true),
      };
    });

    const discoverAvailableModels = Effect.gen(function* () {
      yield* ensureOpen("model-catalog");
      const catalogMethod = connection!.getModelCatalog;
      const availableMethod = connection!.getAvailableModels;
      if (!Predicate.isFunction(catalogMethod) && !Predicate.isFunction(availableMethod)) {
        return yield* runtimeError(
          "model-catalog",
          "incompatible-api",
          "The installed Prime Agent connection does not support model discovery.",
        );
      }

      const result = yield* Effect.tryPromise({
        try: async () => {
          if (Predicate.isFunction(catalogMethod)) {
            try {
              return { kind: "catalog" as const, value: await catalogMethod.call(connection) };
            } catch {
              if (!Predicate.isFunction(availableMethod)) throw new Error("model catalog failed");
            }
          }
          return { kind: "available" as const, value: await availableMethod!.call(connection) };
        },
        catch: () =>
          runtimeError(
            "model-catalog",
            "request-failed",
            "Could not read the Prime Agent model catalog.",
          ),
      }).pipe(
        Effect.timeoutOrElse({
          duration: COMMAND_TIMEOUT_MS,
          orElse: () =>
            runtimeError(
              "model-catalog",
              "request-timed-out",
              "Timed out while reading the Prime Agent model catalog.",
            ),
        }),
      );

      if (result.kind === "available") {
        const decoded = decodeAvailableModels(result.value);
        if (Option.isNone(decoded)) {
          return yield* runtimeError(
            "model-catalog",
            "invalid-response",
            "Prime Agent returned an invalid model catalog.",
          );
        }
        const models = safeCatalogModels(decoded.value);
        if (Option.isNone(models)) {
          return yield* runtimeError(
            "model-catalog",
            "invalid-response",
            "Prime Agent returned an invalid model catalog.",
          );
        }
        return models.value;
      }

      const decoded = decodeModelCatalog(result.value);
      if (Option.isNone(decoded)) {
        return yield* runtimeError(
          "model-catalog",
          "invalid-response",
          "Prime Agent returned an invalid model catalog.",
        );
      }
      const models = safeCatalogModels(decoded.value.models);
      if (Option.isNone(models)) {
        return yield* runtimeError(
          "model-catalog",
          "invalid-response",
          "Prime Agent returned an invalid model catalog.",
        );
      }
      const configuredProviders = new Set<string>();
      for (const rawProvider of decoded.value.configuredProviders) {
        const provider = rawProvider.trim();
        if (
          provider.length === 0 ||
          provider.includes(catalogNulCharacter) ||
          configuredProviders.has(provider)
        ) {
          return yield* runtimeError(
            "model-catalog",
            "invalid-response",
            "Prime Agent returned an invalid model catalog.",
          );
        }
        configuredProviders.add(provider);
      }
      const representedProviders = new Set(models.value.map((model) => model.provider));
      if ([...configuredProviders].some((provider) => !representedProviders.has(provider))) {
        return yield* runtimeError(
          "model-catalog",
          "invalid-response",
          "Prime Agent returned an invalid model catalog.",
        );
      }
      const configuredModels = models.value.filter((model) =>
        configuredProviders.has(model.provider),
      );
      if (configuredModels.length > AVAILABLE_MODEL_CATALOG_MAX_ITEMS) {
        return yield* runtimeError(
          "model-catalog",
          "invalid-response",
          "Prime Agent returned an invalid model catalog.",
        );
      }
      return configuredModels;
    });

    const setModel = Effect.fn("PrimeAgentDaemonSessionRuntime.setModel")(function* (
      selector: string,
    ) {
      yield* ensureOpen("set-model");
      const selected = yield* splitModelSelector(selector);
      const method = yield* requireMethod("set-model", connection!.setModel);
      const output = yield* Effect.tryPromise({
        try: () => method.call(connection, selected.provider, selected.modelId),
        catch: () => runtimeError("set-model", "request-failed", "The daemon model switch failed."),
      });
      const decoded = decodeModel(output);
      if (Option.isNone(decoded)) {
        return yield* runtimeError(
          "set-model",
          "invalid-response",
          "The daemon returned an invalid model response.",
        );
      }
      return {
        id: decoded.value.id,
        name: decoded.value.name,
        provider: decoded.value.provider,
      } satisfies PrimeAgentDaemonSafeModel;
    });

    const setThinkingLevel = Effect.fn("PrimeAgentDaemonSessionRuntime.setThinkingLevel")(
      function* (level: PrimeAgentDaemonThinkingLevel) {
        yield* ensureOpen("set-thinking-level");
        if (Option.isNone(decodeThinkingLevel(level))) {
          return yield* runtimeError(
            "set-thinking-level",
            "invalid-input",
            "The Prime Agent thinking level is invalid.",
          );
        }
        const method = yield* requireMethod("set-thinking-level", connection!.setThinkingLevel);
        yield* callVoid("set-thinking-level", () => method.call(connection, level));
      },
    );

    const setServiceTier = Effect.fn("PrimeAgentDaemonSessionRuntime.setServiceTier")(function* (
      tier: PrimeAgentDaemonServiceTier,
    ) {
      yield* ensureOpen("set-service-tier");
      if (Option.isNone(decodeServiceTier(tier))) {
        return yield* runtimeError(
          "set-service-tier",
          "invalid-input",
          "The Prime Agent service tier is invalid.",
        );
      }
      const method = yield* requireMethod("set-service-tier", connection!.setServiceTier);
      yield* callVoid("set-service-tier", () => method.call(connection, tier));
    });

    const respondToExtensionUiRequest = Effect.fn(
      "PrimeAgentDaemonSessionRuntime.respondToExtensionUiRequest",
    )(function* (requestId: string, response: PrimeAgentDaemonExtensionUiResponse) {
      yield* ensureOpen("extension-ui-response");
      const normalizedRequestId = yield* validateNonEmpty(
        "extension-ui-response",
        "requestId",
        requestId,
      );
      if (Option.isNone(decodeExtensionUiResponse(response))) {
        return yield* runtimeError(
          "extension-ui-response",
          "invalid-input",
          "The extension UI response is invalid.",
        );
      }
      const method = yield* requireMethod(
        "extension-ui-response",
        connection!.respondToExtensionUiRequest,
      );
      yield* callVoid("extension-ui-response", () =>
        method.call(connection, normalizedRequestId, response),
      );
    });

    const getSessionStats = Effect.gen(function* () {
      yield* ensureOpen("session-stats");
      const method = yield* requireMethod("session-stats", connection!.getSessionStats);
      const output = yield* Effect.tryPromise({
        try: () => method.call(connection),
        catch: () =>
          runtimeError("session-stats", "request-failed", "Could not read daemon session usage."),
      });
      const decoded = decodeSessionStats(output);
      if (Option.isNone(decoded) || decoded.value.sessionId !== sessionId) {
        return yield* runtimeError(
          "session-stats",
          "invalid-response",
          "The daemon returned invalid session usage.",
        );
      }
      return decoded.value.contextUsage === undefined
        ? {}
        : ({
            contextUsage: {
              usedTokens: decoded.value.contextUsage.tokens,
              maxTokens: decoded.value.contextUsage.contextWindow,
            },
          } satisfies PrimeAgentDaemonSessionStats);
    });

    // Keep initialization admission active through every control-plane read.
    // The cumulative cap guarantees this entire flush fits without a consumer.
    yield* Queue.offer(eventQueue, initialEvent);
    while (bufferedEvents.length > 0) {
      const batch = bufferedEvents.splice(0);
      for (const bufferedEvent of batch) {
        yield* routeRawEvent(bufferedEvent);
      }
    }
    if (initializationOverflow) {
      unsubscribe();
      yield* Effect.promise(() => connection!.dispose().catch(() => undefined));
      client.close();
      yield* Queue.shutdown(eventQueue);
      return yield* runtimeError(
        "initial-snapshot",
        "request-failed",
        "The daemon emitted too many events while initializing the session.",
      );
    }
    // JavaScript cannot run a callback between this final empty check and the
    // synchronous assignment. Later events enter the normal bounded queue path.
    initializing = false;

    const dispose = Effect.suspend(() => {
      if (disposed || disposeStarted) return Effect.void;
      disposeStarted = true;
      unsubscribe?.();
      const nativeSideQuestions = [...activePrivateSideQuestions.entries()];
      return Effect.forEach(nativeSideQuestions, ([nativeId, active]) =>
        bestEffortAbortSideQuestion(nativeId, active),
      ).pipe(
        Effect.andThen(failActivePrivateSideQuestions()),
        Effect.andThen(
          Effect.tryPromise({
            try: () => connection!.dispose(),
            catch: () =>
              runtimeError("dispose", "request-failed", "Could not dispose the daemon session."),
          }).pipe(
            Effect.flatMap((output) =>
              output === undefined
                ? Effect.void
                : Effect.fail(
                    runtimeError(
                      "dispose",
                      "invalid-response",
                      "The daemon dispose operation returned an invalid response.",
                    ),
                  ),
            ),
          ),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            disposed = true;
            activePrivateSideQuestions.clear();
            prestartAbortedSideQuestionIds.clear();
            recentlySettledSideQuestionIds.clear();
            client.close();
            yield* Queue.shutdown(eventQueue);
          }),
        ),
      );
    });

    yield* Effect.addFinalizer(() => dispose.pipe(Effect.ignore));

    return {
      resumeCursor: PRIME_AGENT_DAEMON_RESUME_CURSOR,
      sessionId,
      sessionFile,
      activeSessionId,
      initialSnapshot: initialEvent,
      initialResources,
      initialAgentDepth,
      initialInputQueue,
      inputQueueModesAvailable:
        typeof connection.setSteeringMode === "function" &&
        typeof connection.setFollowUpMode === "function",
      compactionAvailable,
      refinementAvailable,
      autoCompactionWritable,
      initialCompactionState,
      getCompactionState,
      compact,
      refineLocalHarness,
      abortCompaction,
      setAutoCompactionEnabled,
      reloadResources,
      getAgentDepth,
      setAgentDepth,
      getAgentRoster,
      agentMessageAvailable,
      cancelAgent,
      messageAgent,
      watchAgentActivityAvailable,
      watchAgentActivity,
      events: Stream.fromQueue(eventQueue),
      prompt,
      steer,
      followUp,
      getInputQueue,
      getInputQueueStatus,
      clearInputQueue,
      setInputQueueMode,
      abort,
      abortAndClearQueue,
      sideQuestionsAvailable,
      askSideQuestion,
      abortSideQuestion,
      discoverAvailableModels,
      setModel,
      setThinkingLevel,
      setServiceTier,
      respondToExtensionUiRequest,
      getSessionStats,
      dispose,
    } satisfies PrimeAgentDaemonSessionRuntime;
  },
);
