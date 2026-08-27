// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

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
  PROVIDER_SESSION_AGENT_ACTIVITY_TOOL_LABEL_MAX_CHARS,
  PROVIDER_SESSION_INPUT_QUEUE_MAX_COUNT,
  RUNTIME_RESOURCE_NAME_MAX_CHARS,
  type ProviderRefineSessionHarnessResult,
  type ProviderSessionAgentActivityTimelineEntry,
  type ProviderSessionAgentActivityToolEntry,
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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  type PrimeAgentDaemonAcpMcpServer,
  type PrimeAgentDaemonAgentConnection,
  type PrimeAgentDaemonExtensionUiResponse,
  type PrimeAgentDaemonImage,
  type PrimeAgentDaemonQueueMode,
  type PrimeAgentDaemonQueuedMessageLane,
  type PrimeAgentDaemonServiceTier,
  type PrimeAgentDaemonThinkingLevel,
} from "./PrimeAgentDaemonBridge.ts";
import {
  decodePrimeAgentDaemonChildren,
  decodePrimeAgentDaemonEvent,
  decodePrimeAgentDaemonSessionState,
  primeAgentDaemonImageDigest,
  PRIME_AGENT_DAEMON_MESSAGE_TEXT_MAX_CHARS,
  PRIME_AGENT_DAEMON_TRANSCRIPT_MAX_MESSAGES,
  type PrimeDaemonEvent,
  type PrimeDaemonUsage,
} from "./PrimeAgentDaemonEvents.ts";
import type { PrimeAgentDaemonManager } from "./PrimeAgentDaemonManager.ts";
import {
  PRIME_AGENT_PLAN_TOOL_DEFINITION,
  PRIME_AGENT_PLAN_TOOL_NAME,
} from "./PrimeAgentManagedExtension.ts";
import { PRIME_AGENT_EVENT_BUFFER_CAPACITY } from "./PrimeAgentEventBuffer.ts";
import { primeAgentSessionFileName } from "./PrimeAgentSessionIdentity.ts";
import {
  isPrimeAgentCompatibleResumeCursor,
  PRIME_AGENT_DAEMON_RESUME_CURSOR,
  type PrimeAgentDaemonResumeCursor,
} from "./PrimeAgentResumeCursor.ts";

export { PRIME_AGENT_DAEMON_RESUME_CURSOR } from "./PrimeAgentResumeCursor.ts";

const COMMAND_TIMEOUT_MS = 30_000;
const RLM_QUIESCENCE_STATS_TIMEOUT_MS = 2_000;
const RLM_QUIESCENCE_CANCELLATION_MAX_RETRIES = 3;
const RLM_WORKER_RECOVERY_TIMEOUT_MS = 60_000;
const RLM_WORKER_RECOVERY_LIST_TIMEOUT_MS = 5_000;
const RLM_WORKER_RECOVERY_LIST_DELAYS_MS = [
  250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000,
  5_000,
] as const;
const PRIME_AGENT_WORKER_RECOVERY_CUSTOM_TYPE = "prime-agent.worker_recovery";
const isRlmQuiescenceWaitCancellation = (cause: unknown) =>
  cause instanceof Error && cause.message === "RLM quiescence wait cancelled";
const isPrimeAgentWorkerRecovering = (cause: unknown) =>
  cause instanceof Error && cause.message === "Session worker is recovering";

function workerRecoverySnapshotIsUnsafe(
  raw: unknown,
  baselineMessageCount: number,
  messageCount: number,
): boolean {
  if (!Predicate.isObject(raw) || !Predicate.isObject(raw.snapshot)) return true;
  const messages = raw.snapshot.messages;
  if (!Array.isArray(messages)) return true;
  const advancedMessageCount = messageCount - baselineMessageCount;
  if (advancedMessageCount < 0 || advancedMessageCount > messages.length) return true;
  if (advancedMessageCount === 0) return false;
  return messages
    .slice(-advancedMessageCount)
    .some(
      (message) =>
        Predicate.isObject(message) &&
        message.role === "custom" &&
        message.customType === PRIME_AGENT_WORKER_RECOVERY_CUSTOM_TYPE,
    );
}
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
const PRIME_AGENT_LIVE_ACTIVITY_MESSAGE_CONTENT_MAX = 64;
const PRIME_AGENT_PROMPT_ADMISSION_EVIDENCE_GRACE_MS = 1_000;
const liveActivityTextEncoder = new TextEncoder();
// Assistant text is mirrored for backward compatibility when tool rows are present.
// Halving the remaining envelope budget keeps that additive wire snapshot bounded.
const LIVE_ACTIVITY_TEXT_BYTE_BUDGET = Math.floor(
  (PROVIDER_SESSION_AGENT_ACTIVITY_SNAPSHOT_MAX_BYTES - 5_536) / 2,
);

type PrimeLiveActivityToolEntry = ProviderSessionAgentActivityToolEntry;

interface PrimeLiveActivitySanitizedState {
  readonly entries: ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>;
  /** Native ids exist only in this private, attachment-local correlation map. */
  readonly nativeTools: Map<string, PrimeLiveActivityToolEntry>;
  readonly nextToolActivityId: number;
}

type PrimeLiveActivityWatchEvent =
  | { readonly kind: "closed" }
  | {
      readonly kind: "replace";
      readonly state: PrimeLiveActivitySanitizedState;
      readonly streamingText?: string;
    }
  | {
      readonly kind: "assistant";
      readonly phase: "start" | "update" | "end";
      readonly text: string;
    }
  | {
      readonly kind: "tool";
      /** Private correlation only; this object is never placed on a public queue. */
      readonly toolCorrelationKey: string;
      readonly label: string;
      readonly status: "started" | "completed" | "failed";
    };

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
  let text = "";
  let bytes = 0;
  for (const part of message.content.slice(0, PRIME_AGENT_LIVE_ACTIVITY_MESSAGE_CONTENT_MAX)) {
    if (!Predicate.isObject(part) || part.type !== "text" || !Predicate.isString(part.text)) {
      continue;
    }
    const addition = truncateLiveActivityText(
      part.text,
      PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS - [...text].length,
      LIVE_ACTIVITY_TEXT_BYTE_BUDGET - bytes,
    );
    text += addition;
    const encodedAddition = JSON.stringify(addition);
    bytes += liveActivityTextEncoder.encode(encodedAddition.slice(1, -1)).byteLength;
    if (
      [...text].length >= PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS ||
      bytes >= LIVE_ACTIVITY_TEXT_BYTE_BUDGET
    ) {
      break;
    }
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Maps an exact native tool name to a fixed, non-sensitive public label. */
export function primeAgentLiveActivityToolLabel(toolName: unknown): string {
  if (!Predicate.isString(toolName) || toolName.length > 64) return "Tool";
  switch (toolName.trim().toLowerCase()) {
    case "ipython":
    case "functions.ipython":
      return "IPython";
    case "bash":
    case "functions.bash":
      return "Shell";
    case "edit":
    case "functions.edit":
    case "apply_patch":
      return "Edit";
    case "read":
    case "functions.read":
      return "Read";
    case "grep":
    case "glob":
    case "find":
    case "search":
      return "Search";
    case "websearch":
    case "functions.websearch":
      return "Web search";
    case "attach_image":
    case "functions.attach_image":
      return "Image";
    default:
      return "Tool";
  }
}

function liveActivityToolCorrelationKey(salt: string, nativeToolId: string): string {
  return NodeCrypto.createHash("sha256")
    .update(salt, "utf8")
    .update("\0", "utf8")
    .update(nativeToolId, "utf8")
    .digest("hex");
}

function boundedLiveActivityEntries(
  input: ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>,
): ReadonlyArray<ProviderSessionAgentActivityTimelineEntry> {
  const entries: Array<ProviderSessionAgentActivityTimelineEntry> = [];
  let remainingCharacters = PROVIDER_SESSION_AGENT_ACTIVITY_SNAPSHOT_MAX_CHARS;
  let remainingBytes = LIVE_ACTIVITY_TEXT_BYTE_BUDGET;

  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (entries.length >= PROVIDER_SESSION_AGENT_ACTIVITY_MAX_ENTRIES) break;
    const entry = input[index];
    if (entry === undefined) continue;
    if ("speaker" in entry) {
      const bounded = truncateLiveActivityText(
        entry.text,
        Math.min(PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS, remainingCharacters),
        remainingBytes,
      );
      if (bounded.length === 0) break;
      const encodedText = JSON.stringify(bounded);
      remainingCharacters -= [...bounded].length;
      remainingBytes -= liveActivityTextEncoder.encode(encodedText.slice(1, -1)).byteLength;
      entries.unshift({ speaker: "assistant", text: bounded });
    } else {
      const label = truncateLiveActivityText(
        entry.label,
        Math.min(PROVIDER_SESSION_AGENT_ACTIVITY_TOOL_LABEL_MAX_CHARS, remainingCharacters),
        remainingBytes,
      );
      if (label.length === 0) break;
      const encodedLabel = JSON.stringify(label);
      remainingCharacters -= [...label].length;
      remainingBytes -= liveActivityTextEncoder.encode(encodedLabel.slice(1, -1)).byteLength;
      // Keep the object identity used only by the private native-id correlation map.
      entries.unshift(label === entry.label ? entry : { ...entry, label });
    }
    if (remainingCharacters === 0 || remainingBytes === 0) break;
  }
  return entries;
}

function pruneLiveActivityNativeTools(
  nativeTools: Map<string, PrimeLiveActivityToolEntry>,
  entries: ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>,
): void {
  for (const [nativeId, entry] of nativeTools) {
    if (!entries.includes(entry)) nativeTools.delete(nativeId);
  }
}

function streamingLiveActivityEntryIndex(
  entries: ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>,
  streamingEntry: ProviderSessionAgentActivityTimelineEntry | undefined,
): number {
  if (streamingEntry === undefined || !("speaker" in streamingEntry)) return -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry === streamingEntry ||
      (entry !== undefined && "speaker" in entry && entry.text === streamingEntry.text)
    ) {
      return index;
    }
  }
  return -1;
}

function sanitizePrimeAgentLiveActivityMessageState(
  messages: unknown,
  correlationSalt: string,
): PrimeLiveActivitySanitizedState {
  if (!Array.isArray(messages)) {
    return { entries: [], nativeTools: new Map(), nextToolActivityId: 1 };
  }
  let entries: ReadonlyArray<ProviderSessionAgentActivityTimelineEntry> = [];
  const nativeTools = new Map<string, PrimeLiveActivityToolEntry>();
  let nextToolActivityId = 1;
  // A watcher may return an arbitrarily long transcript. Hydration intentionally
  // considers only a small tail and remains a coarse attach-time skeleton.
  const boundedMessages = messages.slice(-PROVIDER_SESSION_AGENT_ACTIVITY_MAX_ENTRIES * 2);

  for (const message of boundedMessages) {
    const text = visibleAssistantText(message);
    if (text !== undefined) {
      entries = boundedLiveActivityEntries([...entries, { speaker: "assistant", text }]);
    }
    if (
      Predicate.isObject(message) &&
      message.role === "assistant" &&
      Array.isArray(message.content)
    ) {
      for (const part of message.content.slice(0, PRIME_AGENT_LIVE_ACTIVITY_MESSAGE_CONTENT_MAX)) {
        if (!Predicate.isObject(part) || part.type !== "toolCall") continue;
        const toolKey = Predicate.isString(part.id)
          ? liveActivityToolCorrelationKey(correlationSalt, part.id)
          : undefined;
        if (toolKey === undefined || nativeTools.has(toolKey)) continue;
        const entry: PrimeLiveActivityToolEntry = {
          kind: "tool",
          activityId: nextToolActivityId,
          label: primeAgentLiveActivityToolLabel(part.name),
          status: "started",
        };
        nextToolActivityId += 1;
        entries = boundedLiveActivityEntries([...entries, entry]);
        nativeTools.set(toolKey, entry);
        pruneLiveActivityNativeTools(nativeTools, entries);
      }
    }
    if (!Predicate.isObject(message) || message.role !== "toolResult") continue;
    const toolKey = Predicate.isString(message.toolCallId)
      ? liveActivityToolCorrelationKey(correlationSalt, message.toolCallId)
      : undefined;
    if (toolKey === undefined) continue;
    const previous = nativeTools.get(toolKey);
    const entry: PrimeLiveActivityToolEntry = {
      kind: "tool",
      activityId: previous?.activityId ?? nextToolActivityId,
      label: previous?.label ?? primeAgentLiveActivityToolLabel(message.toolName),
      status: message.isError === true ? "failed" : "completed",
    };
    if (previous === undefined) nextToolActivityId += 1;
    const previousIndex = previous === undefined ? -1 : entries.indexOf(previous);
    entries = boundedLiveActivityEntries(
      previousIndex < 0
        ? [...entries, entry]
        : entries.map((candidate, index) => (index === previousIndex ? entry : candidate)),
    );
    nativeTools.set(toolKey, entry);
    pruneLiveActivityNativeTools(nativeTools, entries);
  }
  return { entries, nativeTools, nextToolActivityId };
}

/**
 * Privacy boundary for Prime's AgentMessage union. Only assistant text and a
 * coarse tool skeleton survive. Tool inputs/results, reasoning, metadata,
 * native ids, paths, timestamps, and error text are never copied.
 */
export function sanitizePrimeAgentLiveActivityMessages(
  messages: unknown,
): ReadonlyArray<ProviderSessionAgentActivityTimelineEntry> {
  return sanitizePrimeAgentLiveActivityMessageState(messages, "standalone").entries;
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
const resumeQueueSuccessSchema = Schema.Struct({
  type: Schema.Literal("response"),
  command: Schema.Literal("resume_queue"),
  success: Schema.Literal(true),
});
const resumeQueueEmptySchema = Schema.Struct({
  type: Schema.Literal("response"),
  command: Schema.Literal("resume_queue"),
  success: Schema.Literal(false),
  error: Schema.Literal("No queued work to resume"),
});
const sessionListSuccessSchema = Schema.Struct({
  type: Schema.Literal("response"),
  command: Schema.Literal("list"),
  success: Schema.Literal(true),
  data: Schema.Struct({
    sessions: Schema.Array(
      Schema.Struct({
        activeSessionId: Schema.optional(Schema.String),
        sessionId: Schema.String,
        sessionFile: Schema.optional(Schema.String),
        workerState: Schema.optional(Schema.String),
        workerPid: Schema.optional(Schema.Int),
      }),
    ),
  }),
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
const managedPlanToolDefinitionSchema = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  description: Schema.String,
  promptGuidelines: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(32))),
  parameters: Schema.Unknown,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const nonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const sessionStatsSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  tokens: Schema.optional(
    Schema.Struct({
      input: nonNegativeInt,
      output: nonNegativeInt,
      cacheRead: nonNegativeInt,
      cacheWrite: nonNegativeInt,
      total: nonNegativeInt,
    }),
  ),
  cost: Schema.optional(nonNegativeFinite),
  contextUsage: Schema.optional(
    Schema.Struct({
      tokens: Schema.NullOr(nonNegativeInt),
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
const decodeResumeQueueSuccess = Schema.decodeUnknownOption(resumeQueueSuccessSchema);
const decodeResumeQueueEmpty = Schema.decodeUnknownOption(resumeQueueEmptySchema);
const decodeSessionListSuccess = Schema.decodeUnknownOption(sessionListSuccessSchema);
const decodeModel = Schema.decodeUnknownOption(modelSchema);
const decodeAvailableModels = Schema.decodeUnknownOption(availableModelsSchema);
const decodeModelCatalog = Schema.decodeUnknownOption(modelCatalogSchema);
const decodeResourceSnapshot = Schema.decodeUnknownOption(resourceSnapshotSchema);
const decodeCommands = Schema.decodeUnknownOption(commandsSchema);
const decodeManagedPlanToolDefinition = Schema.decodeUnknownOption(managedPlanToolDefinitionSchema);
const decodeSessionStats = Schema.decodeUnknownOption(sessionStatsSchema);
const decodeRlmMaxDepthStatus = Schema.decodeUnknownOption(rlmMaxDepthStatusSchema);
const decodeAgentMessageReceipt = Schema.decodeUnknownOption(agentMessageReceiptSchema);
const decodeRefinementResult = Schema.decodeUnknownOption(refinementResultSchema);

function managedPlanToolDefinitionMatches(value: unknown): boolean {
  const decoded = decodeManagedPlanToolDefinition(value);
  if (Option.isNone(decoded)) return false;
  const expected = PRIME_AGENT_PLAN_TOOL_DEFINITION;
  return (
    decoded.value.name === expected.name &&
    decoded.value.label === expected.label &&
    decoded.value.description === expected.description &&
    JSON.stringify(decoded.value.promptGuidelines) === JSON.stringify(expected.promptGuidelines) &&
    JSON.stringify(decoded.value.parameters) === JSON.stringify(expected.parameters)
  );
}

function subtractCumulativeUsage(
  current: PrimeDaemonUsage | undefined,
  baseline: PrimeDaemonUsage | undefined,
): PrimeDaemonUsage | undefined {
  if (current === undefined || baseline === undefined) return undefined;
  const usage = {
    inputTokens: current.inputTokens - baseline.inputTokens,
    outputTokens: current.outputTokens - baseline.outputTokens,
    cachedInputTokens: current.cachedInputTokens - baseline.cachedInputTokens,
    cacheWriteTokens: current.cacheWriteTokens - baseline.cacheWriteTokens,
    totalTokens: current.totalTokens - baseline.totalTokens,
    totalCostUsd: current.totalCostUsd - baseline.totalCostUsd,
  };
  return Object.values(usage).every((value) => Number.isFinite(value) && value >= 0)
    ? usage
    : undefined;
}

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

interface PrimeAgentDaemonPrivateInputQueue {
  readonly steering: ReadonlyArray<string>;
  readonly followUp: ReadonlyArray<string>;
  readonly snapshot: SessionInputQueueUpdatedPayload;
}

function decodePrivateInputQueue(value: unknown): Option.Option<PrimeAgentDaemonPrivateInputQueue> {
  if (typeof value !== "object" || value === null) return Option.none();
  const queue = value as { readonly steering?: unknown; readonly followUp?: unknown };
  const steering = queue.steering;
  const followUp = queue.followUp;
  if (
    !Array.isArray(steering) ||
    !steering.every((entry) => typeof entry === "string") ||
    !Array.isArray(followUp) ||
    !followUp.every((entry) => typeof entry === "string") ||
    steering.length > PROVIDER_SESSION_INPUT_QUEUE_MAX_COUNT ||
    followUp.length > PROVIDER_SESSION_INPUT_QUEUE_MAX_COUNT
  ) {
    return Option.none();
  }
  return Option.some({
    steering,
    followUp,
    snapshot: { steeringCount: steering.length, followUpCount: followUp.length },
  });
}

function decodeInputQueueCounts(value: unknown): Option.Option<SessionInputQueueUpdatedPayload> {
  return Option.map(decodePrivateInputQueue(value), (queue) => queue.snapshot);
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
  "configure-mcp",
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
  "rlm-quiescence",
  "steer",
  "follow-up",
  "get-input-queue",
  "clear-input-queue",
  "remove-only-input-queue-item",
  "set-input-queue-mode",
  "get-compaction-state",
  "compact",
  "refine-local-harness",
  "abort-compaction",
  "set-auto-compaction",
  "abort",
  "abort-and-clear-queue",
  "resume-after-abort",
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
  /** Explicit Pylon-owned extension that must load without errors or collisions. */
  readonly expectedExtension?: {
    readonly path: string;
    readonly markerCommand: string;
    /** Rechecks Pylon's generated source without returning its contents. */
    readonly verifySource: () => Promise<boolean>;
  };
  /** Supervised mode additionally requires an exclusive extension inventory and zero agent depth. */
  readonly requiredExtension?: {
    readonly path: string;
    readonly markerCommand: string;
  };
  /** Pylon-owned, thread-scoped MCP server attached only for this live provider session. */
  readonly mcpServer?: {
    readonly ownerId: string;
    readonly server: PrimeAgentDaemonAcpMcpServer;
  };
  readonly resumeCursor?: unknown;
  /** Private stable native id selected from the server-owned identity sidecar. */
  readonly resumeSessionId?: string;
}

export interface PrimeAgentDaemonPromptInput {
  readonly text: string;
  readonly images?: ReadonlyArray<PrimeAgentDaemonImage>;
  /** Correlates the initial descendant barrier with one Pylon turn/input generation. */
  readonly rlmQuiescenceToken?: string;
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
  readonly usage?: PrimeDaemonUsage | undefined;
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
  readonly inputQueueMutationAvailable: boolean;
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
    ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>,
    PrimeAgentDaemonSessionRuntimeError
  >;
  readonly events: Stream.Stream<PrimeDaemonEvent, never>;
  /** True only when Prime exposes its authoritative descendant-quiescence barrier. */
  readonly rlmQuiescenceAvailable: boolean;
  readonly waitForRlmQuiescence: (
    token: string,
    signal: AbortSignal,
  ) => Effect.Effect<void, PrimeAgentDaemonSessionRuntimeError>;
  readonly isRlmQuiescenceGenerationCurrent: (generation: number) => boolean;
  /** Resolves a reconnect generation after the adapter validates the public snapshot suffix. */
  readonly resolveReconnectSnapshot: (
    generation: number,
    reconciled: boolean,
    terminalResponseObserved?: boolean,
  ) => boolean;
  readonly noteWorkerRecoveryTerminalResponse: () => void;
  readonly isConnectionGenerationCurrent: (generation: number) => boolean;
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
  /** Deletes only the current sole item in a lane; the native preview never leaves this method. */
  readonly removeOnlyInputQueueItem: (
    queue: "steering" | "follow-up",
  ) => Effect.Effect<
    "applied" | "rejected" | "invalid" | "unsupported",
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
    let needsResumeAfterAbort = false;
    let connectionGeneration = 0;
    let rlmEventContinuityValid = true;
    let rlmTurnUsageBaseline: PrimeDaemonUsage | undefined;
    let observedCompletedMessageCount = 0;
    let activePromptRecovery:
      | {
          readonly admissionGeneration: number;
          readonly baselineMessageCount: number;
          readonly promptText: string;
          readonly promptImageMimeTypes: ReadonlyArray<string>;
          readonly promptImageDigests: ReadonlyArray<string>;
          readonly signal: AbortSignal | undefined;
          readonly promise: Promise<void>;
          readonly resolve: () => void;
          readonly admissionEvidencePromise: Promise<boolean>;
          readonly resolveAdmissionEvidence: (admitted: boolean) => void;
          readonly cancellationPromise: Promise<void>;
          readonly cleanupAdmissionEvidence: () => void;
          reconnectGeneration: number | undefined;
          firstUserMessageObserved: boolean;
          promptAdmissionObserved: boolean;
          admissionEvidenceSettled: boolean;
          snapshotProvesAdmission: boolean;
          settled: boolean;
        }
      | undefined;
    type ReconnectResolution = {
      readonly generation: number;
      readonly promise: Promise<boolean>;
      readonly resolve: (reconciled: boolean) => void;
      settled: boolean;
    };
    let reconnectResolution: ReconnectResolution | undefined;
    let activeWorkerRecovery:
      | {
          readonly resolution: ReconnectResolution;
          readonly baselineMessageCount: number;
          terminalResponseObserved: boolean;
          explicitSnapshotRaw?: object;
          explicitSnapshotOffered: boolean;
        }
      | undefined;
    const rlmQuiescenceSemaphore = yield* Semaphore.make(1);
    const resumeAfterAbortSemaphore = yield* Semaphore.make(1);

    const settlePromptAdmissionEvidence = (
      prompt: NonNullable<typeof activePromptRecovery>,
      admitted: boolean,
    ) => {
      if (prompt.admissionEvidenceSettled) return;
      prompt.admissionEvidenceSettled = true;
      prompt.resolveAdmissionEvidence(admitted);
    };

    // Worker command failures and session events arrive on independent callbacks.
    // Allow already-in-flight proof to win without leaving an unproven prompt pending forever.
    const awaitPromptAdmissionEvidence = (
      prompt: NonNullable<typeof activePromptRecovery>,
    ): Promise<boolean> => {
      if (prompt.promptAdmissionObserved) return Promise.resolve(true);
      return Effect.raceFirst(
        Effect.promise(() => prompt.admissionEvidencePromise),
        Effect.sleep(PRIME_AGENT_PROMPT_ADMISSION_EVIDENCE_GRACE_MS).pipe(Effect.as(false)),
      ).pipe(Effect.runPromise);
    };

    // A recovered transport can leave Prime's original prompt RPC unresolved even
    // after its worker accepted and completed the input. Release only from the same
    // generation proof used by the adapter; never issue another prompt command.
    const settlePromptRecoveryIfProven = () => {
      const prompt = activePromptRecovery;
      const reconnect = reconnectResolution;
      if (
        prompt === undefined ||
        prompt.settled ||
        prompt.signal?.aborted === true ||
        !prompt.snapshotProvesAdmission ||
        prompt.reconnectGeneration === undefined ||
        reconnect === undefined ||
        reconnect.generation !== prompt.reconnectGeneration ||
        !reconnect.settled ||
        !rlmEventContinuityValid
      ) {
        return;
      }
      prompt.settled = true;
      prompt.resolve();
    };

    const settleReconnectResolution = (generation: number, reconciled: boolean) => {
      const pending = reconnectResolution;
      if (pending === undefined || pending.generation !== generation || pending.settled)
        return false;
      pending.settled = true;
      rlmEventContinuityValid = reconciled;
      pending.resolve(reconciled);
      if (reconciled) settlePromptRecoveryIfProven();
      return true;
    };

    const resolveReconnectSnapshot = (
      generation: number,
      reconciled: boolean,
      terminalResponseObserved = false,
    ) => {
      const recovery = activeWorkerRecovery;
      if (
        recovery !== undefined &&
        recovery.resolution.generation === generation &&
        !recovery.explicitSnapshotOffered
      ) {
        return false;
      }
      const settled = settleReconnectResolution(generation, reconciled);
      if (
        settled &&
        reconciled &&
        recovery !== undefined &&
        recovery.resolution.generation === generation
      ) {
        // Snapshot reconciliation makes the adapter's current terminal state authoritative.
        recovery.terminalResponseObserved = terminalResponseObserved;
      }
      return settled;
    };

    const noteWorkerRecoveryTerminalResponse = () => {
      const recovery = activeWorkerRecovery;
      if (
        recovery !== undefined &&
        recovery.resolution.generation === connectionGeneration &&
        (!recovery.resolution.settled || rlmEventContinuityValid)
      ) {
        // The adapter can observe the terminal response before the catch-up snapshot.
        // Keep early proof provisional; the gate still requires that snapshot to reconcile.
        recovery.terminalResponseObserved = true;
      }
    };

    const beginReconnectResolution = () => {
      if (reconnectResolution !== undefined && !reconnectResolution.settled) {
        reconnectResolution.settled = true;
        reconnectResolution.resolve(false);
      }
      let resolve!: (reconciled: boolean) => void;
      const promise = new Promise<boolean>((complete) => {
        resolve = complete;
      });
      const pending: ReconnectResolution = {
        generation: connectionGeneration,
        promise,
        resolve,
        settled: false,
      };
      reconnectResolution = pending;
      return pending;
    };

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
      input.expectedExtension !== undefined &&
      (configuredExtensions.filter((path) => path === input.expectedExtension!.path).length !== 1 ||
        !Predicate.isFunction(input.expectedExtension.verifySource))
    ) {
      client.close();
      return yield* runtimeError(
        "verify-extension",
        "invalid-input",
        "Managed provider verification requires its explicit extension path exactly once.",
      );
    }
    if (
      input.requiredExtension !== undefined &&
      (input.expectedExtension?.path !== input.requiredExtension.path ||
        input.expectedExtension?.markerCommand !== input.requiredExtension.markerCommand ||
        input.disableExtensionDiscovery !== true ||
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
    const sessionRuntimeConfig: Record<string, unknown> = {
      cwd,
      sessionDir,
      noBuiltinTools: false,
      noExtensions: input.disableExtensionDiscovery ?? false,
      noSkills: false,
      noContextFiles: false,
      ...(configuredAgentDir ? { agentDir: configuredAgentDir } : {}),
      ...(configuredExtensions.length > 0 ? { extensions: configuredExtensions } : {}),
      ...(configuredModel && configuredModel !== "default" ? { model: configuredModel } : {}),
      ...(input.thinkingLevel === undefined ? {} : { thinking: input.thinkingLevel }),
    };
    const createResponse = yield* Effect.tryPromise({
      try: () =>
        client.request(
          {
            type: "create",
            lifecycle: "client_owned",
            ...(resumeSessionId === undefined
              ? { continueRecent: shouldContinue }
              : { sessionPath: resumeSessionId, continueRecent: false }),
            config: sessionRuntimeConfig,
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
          ownedSessionRecoveryConfig: sessionRuntimeConfig,
          ...(input.disableAutoReconnect === true ? {} : { recoverDaemon: input.manager.recover }),
        }),
      catch: () =>
        runtimeError(
          "attach-session",
          "request-failed",
          "Could not attach to the created daemon session.",
        ),
    }).pipe(Effect.onError(() => completeUnattachedOwnedSession));

    let mcpAttached = false;
    const releaseMcpServer = Effect.suspend(() => {
      const configured = input.mcpServer;
      const release = connection?.releaseAcpMcpServers;
      if (!mcpAttached || configured === undefined || !Predicate.isFunction(release)) {
        return Effect.void;
      }
      mcpAttached = false;
      return Effect.tryPromise({
        try: () =>
          release
            .call(connection, configured.ownerId, [configured.server.name])
            .then(() => undefined),
        catch: () =>
          runtimeError(
            "configure-mcp",
            "request-failed",
            "Could not release Pylon's scoped MCP server from the Prime Agent session.",
          ),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not release Prime Agent's Pylon MCP session.", {
            operation: error.operation,
            reason: error.reason,
          }),
        ),
      );
    });
    const closeAttachedSession = releaseMcpServer.pipe(
      Effect.andThen(
        Effect.promise(async () => {
          await connection?.dispose().catch(() => undefined);
          client.close();
        }),
      ),
    );
    const configureMcpServer = Effect.gen(function* () {
      const configured = input.mcpServer;
      if (configured === undefined) return;
      const supports = connection?.supportsAcpMcpServers;
      const replace = connection?.replaceAcpMcpServers;
      const release = connection?.releaseAcpMcpServers;
      if (
        !Predicate.isFunction(supports) ||
        !Predicate.isFunction(replace) ||
        !Predicate.isFunction(release) ||
        supports.call(connection) !== true
      ) {
        return yield* runtimeError(
          "configure-mcp",
          "incompatible-api",
          "The installed Prime Agent daemon cannot attach Pylon's scoped MCP server. Upgrade Prime Agent or disable agent browser access for this session.",
        );
      }
      yield* Effect.tryPromise({
        try: () => replace.call(connection, [configured.server], configured.ownerId),
        catch: () =>
          runtimeError(
            "configure-mcp",
            "request-failed",
            "Prime Agent rejected Pylon's scoped MCP server configuration.",
          ),
      });
      mcpAttached = true;
    });
    yield* configureMcpServer.pipe(Effect.onError(() => closeAttachedSession));
    let verifiedInventory:
      | readonly [typeof resourceSnapshotSchema.Type, typeof commandsSchema.Type]
      | undefined;
    let verifiedInventoryCommandsDisabled = false;
    let verifiedAgentDepth: PrimeAgentDaemonAgentDepth | undefined;
    const expectedExtension = input.expectedExtension;
    if (expectedExtension !== undefined) {
      if (
        !Predicate.isFunction(connection?.getToolDefinition) ||
        (input.requiredExtension !== undefined &&
          (!Predicate.isFunction(connection?.setRlmMaxDepth) ||
            !Predicate.isFunction(connection?.getRlmMaxDepthStatus)))
      ) {
        yield* closeAttachedSession;
        return yield* runtimeError(
          "verify-extension",
          "incompatible-api",
          "The installed daemon cannot verify the managed provider extension.",
        );
      }
      yield* Effect.tryPromise({
        try: async () => {
          const rawSetDepth =
            input.requiredExtension === undefined
              ? undefined
              : await connection!.setRlmMaxDepth!(0);
          const [rawResources, rawCommands, rawToolDefinition, sourceVerified, rawDepth] =
            await Promise.all([
              connection!.getResourceSnapshot!(),
              connection!.getCommands!(),
              connection!.getToolDefinition!(PRIME_AGENT_PLAN_TOOL_NAME),
              expectedExtension.verifySource(),
              input.requiredExtension === undefined
                ? Promise.resolve(undefined)
                : connection!.getRlmMaxDepthStatus!(),
            ]);
          const resources = decodeResourceSnapshot(rawResources);
          const commands = decodeCommands(rawCommands);
          if (Option.isNone(resources) || Option.isNone(commands)) {
            throw new Error("invalid managed extension inventory");
          }
          const extensionMatches = resources.value.extensions.filter(
            (extension) => extension.path === expectedExtension.path,
          );
          const markerMatches = commands.value.filter(
            (command) =>
              command.name === expectedExtension.markerCommand &&
              command.source === "extension" &&
              command.sourceInfo.path === expectedExtension.path,
          );
          const extensionFailed = resources.value.diagnostics.extensions.some((diagnostic) =>
            input.requiredExtension === undefined
              ? diagnostic.type !== "warning" && diagnostic.path === expectedExtension.path
              : diagnostic.type !== "warning",
          );
          if (
            extensionMatches.length !== 1 ||
            sourceVerified !== true ||
            (input.requiredExtension !== undefined && resources.value.extensions.length !== 1) ||
            markerMatches.length !== 1 ||
            extensionFailed ||
            !managedPlanToolDefinitionMatches(rawToolDefinition)
          ) {
            throw new Error("managed extension did not load");
          }
          verifiedInventory = [resources.value, commands.value];
          verifiedInventoryCommandsDisabled = input.requiredExtension !== undefined;
          if (input.requiredExtension !== undefined) {
            const setDepth = decodeRlmMaxDepthStatus(rawSetDepth);
            const depth = decodeRlmMaxDepthStatus(rawDepth);
            if (
              Option.isNone(setDepth) ||
              Option.isNone(depth) ||
              setDepth.value.maxDepth !== 0 ||
              depth.value.maxDepth !== 0
            ) {
              throw new Error("managed extension agent depth was not disabled");
            }
            verifiedAgentDepth = safeAgentDepth(depth.value, false);
          }
        },
        catch: () =>
          runtimeError(
            "verify-extension",
            "invalid-response",
            "Prime Agent did not load the required managed provider extension.",
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
    let lastSnapshotConnectionGeneration = 0;
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

    const messageMatchesPromptAdmission = (
      prompt: NonNullable<typeof activePromptRecovery>,
      message: Extract<PrimeDaemonEvent, { readonly _tag: "MessageCompleted" }>["message"],
    ) =>
      message.role === "user" &&
      prompt.promptText.trim().length > 0 &&
      prompt.promptText.length <= PRIME_AGENT_DAEMON_MESSAGE_TEXT_MAX_CHARS &&
      message.text === prompt.promptText &&
      message.imageMimeTypes.length === prompt.promptImageMimeTypes.length &&
      message.imageMimeTypes.every(
        (mimeType, index) => mimeType === prompt.promptImageMimeTypes[index],
      ) &&
      message.imageDigests.length === prompt.promptImageDigests.length &&
      message.imageDigests.every((digest, index) => digest === prompt.promptImageDigests[index]);

    const snapshotPromptAdmissionEvidence = (
      prompt: NonNullable<typeof activePromptRecovery>,
      event: Extract<PrimeDaemonEvent, { readonly _tag: "SessionResynced" }>,
    ): "matched" | "mismatched" | "insufficient" => {
      if (prompt.firstUserMessageObserved) {
        return prompt.promptAdmissionObserved ? "matched" : "mismatched";
      }
      const advancedMessageCount = event.state.messageCount - prompt.baselineMessageCount;
      const expectedTailLength = Math.min(
        event.state.messageCount,
        PRIME_AGENT_DAEMON_TRANSCRIPT_MAX_MESSAGES,
      );
      if (
        advancedMessageCount <= 0 ||
        advancedMessageCount > event.messages.length ||
        event.messages.length !== expectedTailLength
      ) {
        return "insufficient";
      }
      const firstUserMessage = event.messages
        .slice(-advancedMessageCount)
        .find((message) => message.role === "user");
      if (firstUserMessage === undefined) return "insufficient";
      return messageMatchesPromptAdmission(prompt, firstUserMessage) ? "matched" : "mismatched";
    };

    const offerDecoded = (raw: unknown) => {
      const decoded = safeEvent(decodePrimeAgentDaemonEvent(raw));
      const eventConnectionGeneration = connectionGeneration;
      const workerRecovery = activeWorkerRecovery;
      const workerRecoveryRequiresExplicitSnapshot =
        workerRecovery !== undefined && workerRecovery.resolution === reconnectResolution;
      if (
        decoded._tag === "SessionResynced" &&
        workerRecoveryRequiresExplicitSnapshot &&
        workerRecovery?.explicitSnapshotRaw !== raw
      ) {
        // Quarantine supervisor snapshots until the post-ready read supplies the exact proof object.
        return Effect.void;
      }
      const reconnectSnapshot =
        decoded._tag === "SessionResynced" &&
        reconnectResolution !== undefined &&
        reconnectResolution.generation === eventConnectionGeneration &&
        !reconnectResolution.settled &&
        (!workerRecoveryRequiresExplicitSnapshot || workerRecovery?.explicitSnapshotRaw === raw);
      const workerRecoverySnapshot = reconnectSnapshot && workerRecoveryRequiresExplicitSnapshot;
      if (workerRecoverySnapshot && workerRecovery !== undefined) {
        workerRecovery.explicitSnapshotOffered = true;
      }
      const unsafeWorkerRecoverySnapshot =
        workerRecoverySnapshot &&
        decoded._tag === "SessionResynced" &&
        (decoded.state.sessionId !== sessionId ||
          decoded.state.activeSessionId !== activeSessionId ||
          workerRecoverySnapshotIsUnsafe(
            raw,
            workerRecovery?.baselineMessageCount ?? Number.MAX_SAFE_INTEGER,
            decoded.state.messageCount,
          ) ||
          (decoded.lastEventSequence !== undefined &&
            lastSnapshotSequence !== undefined &&
            lastSnapshotConnectionGeneration === eventConnectionGeneration &&
            decoded.lastEventSequence < lastSnapshotSequence));
      if (unsafeWorkerRecoverySnapshot) {
        settleReconnectResolution(eventConnectionGeneration, false);
      }
      const reconciledSnapshot = reconnectSnapshot && !unsafeWorkerRecoverySnapshot;
      const event =
        reconciledSnapshot && decoded._tag === "SessionResynced"
          ? { ...decoded, connectionGeneration: eventConnectionGeneration }
          : decoded;
      const prompt = activePromptRecovery;
      if (event._tag === "SessionResynced") {
        if (
          !workerRecoverySnapshot &&
          event.lastEventSequence !== undefined &&
          lastSnapshotSequence !== undefined &&
          lastSnapshotConnectionGeneration === eventConnectionGeneration &&
          event.lastEventSequence <= lastSnapshotSequence
        ) {
          return Effect.void;
        }
        lastSnapshotSequence = event.lastEventSequence;
        lastSnapshotConnectionGeneration = eventConnectionGeneration;
        if (prompt !== undefined) {
          const admissionEvidence = snapshotPromptAdmissionEvidence(prompt, event);
          if (event.connectionGeneration !== undefined) {
            prompt.reconnectGeneration = event.connectionGeneration;
            prompt.snapshotProvesAdmission = admissionEvidence === "matched";
          }
          if (admissionEvidence !== "insufficient") {
            prompt.firstUserMessageObserved = true;
            prompt.promptAdmissionObserved = admissionEvidence === "matched";
            settlePromptAdmissionEvidence(prompt, prompt.promptAdmissionObserved);
          }
        }
        observedCompletedMessageCount = event.state.messageCount;
      } else if (event._tag === "MessageCompleted") {
        if (
          prompt !== undefined &&
          event.message.role === "user" &&
          !prompt.firstUserMessageObserved
        ) {
          prompt.firstUserMessageObserved = true;
          prompt.promptAdmissionObserved = messageMatchesPromptAdmission(prompt, event.message);
          settlePromptAdmissionEvidence(prompt, prompt.promptAdmissionObserved);
          if (
            prompt.promptAdmissionObserved &&
            prompt.reconnectGeneration === eventConnectionGeneration &&
            reconnectResolution?.generation === eventConnectionGeneration
          ) {
            prompt.snapshotProvesAdmission = true;
            settlePromptRecoveryIfProven();
          }
        }
        observedCompletedMessageCount += 1;
      }
      trackAgentRoster(event);
      return Queue.offer(eventQueue, event).pipe(Effect.asVoid);
    };
    const routeRawEvent = (raw: unknown) =>
      handlePrivateSideQuestionEvent(raw).pipe(
        Effect.flatMap((handled) => (handled ? Effect.void : offerDecoded(raw))),
      );
    let mcpRecoveryTail = Promise.resolve();
    let mcpRecoveryPending = false;
    let mcpRecoveryFailed = false;
    const routeMcpAwareRawEvent = (raw: unknown): Promise<void> => {
      const rawType =
        typeof raw === "object" && raw !== null && "type" in raw && typeof raw.type === "string"
          ? raw.type
          : undefined;
      const connectionStatus =
        rawType === "connection_status" &&
        "status" in (raw as object) &&
        typeof (raw as { readonly status?: unknown }).status === "string"
          ? (raw as { readonly status: string }).status
          : undefined;
      if (connectionStatus === "reconnecting") {
        connectionGeneration += 1;
        rlmEventContinuityValid = false;
        beginReconnectResolution();
      } else if (rawType === "closed") {
        settleReconnectResolution(connectionGeneration, false);
        const prompt = activePromptRecovery;
        if (prompt !== undefined) settlePromptAdmissionEvidence(prompt, false);
      }
      if (
        input.mcpServer === undefined ||
        (rawType !== "session_resynced" && rawType !== "connection_status" && rawType !== "closed")
      ) {
        return runPromise(routeRawEvent(raw));
      }
      const delivery = mcpRecoveryTail.then(() =>
        runPromise(
          Effect.gen(function* () {
            if (rawType === "connection_status") {
              const status = connectionStatus;
              if (status === "reconnecting") {
                mcpAttached = false;
                mcpRecoveryPending = true;
              }
              if (status === "connected" && mcpRecoveryPending) {
                mcpRecoveryPending = false;
                mcpRecoveryFailed = true;
                yield* routeRawEvent({
                  type: "closed",
                  error: "Prime Agent reconnected without restoring Pylon's scoped browser tools.",
                });
                return;
              }
              if (status === "connected" && mcpRecoveryFailed) return;
              yield* routeRawEvent(raw);
              return;
            }
            if (rawType === "session_resynced" && mcpRecoveryPending && !mcpRecoveryFailed) {
              const restored = yield* configureMcpServer.pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
              mcpRecoveryPending = false;
              if (!restored) {
                mcpRecoveryFailed = true;
                yield* routeRawEvent({
                  type: "closed",
                  error:
                    "Pylon browser tools could not be restored after the Prime Agent daemon reconnected.",
                });
                return;
              }
            }
            if (rawType === "closed") {
              mcpRecoveryPending = false;
              mcpRecoveryFailed = true;
            }
            if (!mcpRecoveryFailed || rawType === "closed") yield* routeRawEvent(raw);
          }),
        ),
      );
      mcpRecoveryTail = delivery.catch(() => undefined);
      return delivery;
    };
    const verifyManagedExtensionAfterReconnect = Effect.tryPromise({
      try: async () => {
        if (expectedExtension === undefined) return true;
        const [rawResources, rawCommands, rawToolDefinition, sourceVerified, rawDepth] =
          await Promise.all([
            connection!.getResourceSnapshot(),
            connection!.getCommands(),
            connection!.getToolDefinition!(PRIME_AGENT_PLAN_TOOL_NAME),
            expectedExtension.verifySource(),
            input.requiredExtension === undefined
              ? Promise.resolve(undefined)
              : connection!.getRlmMaxDepthStatus!(),
          ]);
        const resources = decodeResourceSnapshot(rawResources);
        const commands = decodeCommands(rawCommands);
        if (Option.isNone(resources) || Option.isNone(commands)) return false;
        const depth =
          input.requiredExtension === undefined ? undefined : decodeRlmMaxDepthStatus(rawDepth);
        return (
          sourceVerified === true &&
          (depth === undefined || (Option.isSome(depth) && depth.value.maxDepth === 0)) &&
          resources.value.extensions.filter(
            (extension) => extension.path === expectedExtension.path,
          ).length === 1 &&
          (input.requiredExtension === undefined || resources.value.extensions.length === 1) &&
          commands.value.filter(
            (command) =>
              command.name === expectedExtension.markerCommand &&
              command.source === "extension" &&
              command.sourceInfo.path === expectedExtension.path,
          ).length === 1 &&
          !resources.value.diagnostics.extensions.some((diagnostic) =>
            input.requiredExtension === undefined
              ? diagnostic.type !== "warning" && diagnostic.path === expectedExtension.path
              : diagnostic.type !== "warning",
          ) &&
          managedPlanToolDefinitionMatches(rawToolDefinition)
        );
      },
      catch: () => false,
    });
    type ManagedRecoveryResolution = {
      readonly promise: Promise<boolean>;
      readonly resolve: (verified: boolean) => void;
      settled: boolean;
      verified?: boolean;
    };
    let managedRecoveryTail = Promise.resolve();
    let managedRecoveryResolution: ManagedRecoveryResolution | undefined;
    let managedRecoveryFailed = false;
    const beginManagedRecovery = (): ManagedRecoveryResolution => {
      const previous = managedRecoveryResolution;
      if (previous !== undefined && !previous.settled) {
        previous.settled = true;
        previous.verified = false;
        previous.resolve(false);
      }
      let resolve!: (verified: boolean) => void;
      const promise = new Promise<boolean>((complete) => {
        resolve = complete;
      });
      const recovery = { promise, resolve, settled: false };
      managedRecoveryResolution = recovery;
      return recovery;
    };
    const settleManagedRecovery = (
      recovery: ManagedRecoveryResolution | undefined,
      verified: boolean,
    ): boolean => {
      if (recovery === undefined || recovery !== managedRecoveryResolution || recovery.settled) {
        return false;
      }
      recovery.settled = true;
      recovery.verified = verified;
      recovery.resolve(verified);
      if (!verified) managedRecoveryFailed = true;
      return true;
    };
    const managedRecoveryPending = () =>
      managedRecoveryResolution !== undefined && !managedRecoveryResolution.settled;
    const routeManagedAwareRawEvent = (raw: unknown): Promise<void> => {
      const rawType =
        typeof raw === "object" && raw !== null && "type" in raw && typeof raw.type === "string"
          ? raw.type
          : undefined;
      const connectionStatus =
        rawType === "connection_status" &&
        "status" in (raw as object) &&
        typeof (raw as { readonly status?: unknown }).status === "string"
          ? (raw as { readonly status: string }).status
          : undefined;
      if (connectionStatus === "reconnecting" && expectedExtension !== undefined) {
        beginManagedRecovery();
      }
      const recovery = managedRecoveryResolution;
      const workerRecoveryRequiresExplicitSnapshot =
        activeWorkerRecovery !== undefined &&
        activeWorkerRecovery.resolution === reconnectResolution;
      if (
        rawType === "session_resynced" &&
        workerRecoveryRequiresExplicitSnapshot &&
        activeWorkerRecovery?.explicitSnapshotRaw !== raw
      ) {
        return Promise.resolve();
      }
      if (
        expectedExtension === undefined ||
        (!managedRecoveryPending() &&
          !managedRecoveryFailed &&
          rawType !== "session_resynced" &&
          rawType !== "connection_status" &&
          rawType !== "closed")
      ) {
        return routeMcpAwareRawEvent(raw);
      }
      const delivery = managedRecoveryTail.then(() =>
        runPromise(
          Effect.gen(function* () {
            if (
              rawType === "session_resynced" &&
              (recovery === undefined || recovery !== managedRecoveryResolution || recovery.settled)
            ) {
              return;
            }
            if (connectionStatus === "connected" && managedRecoveryPending()) {
              settleManagedRecovery(recovery, false);
              settleReconnectResolution(connectionGeneration, false);
              yield* routeRawEvent({
                type: "closed",
                error:
                  "Prime Agent reconnected without restoring Pylon's managed provider extension.",
              });
              return;
            }
            if (rawType === "session_resynced" && recovery !== undefined && !recovery.settled) {
              const restored = yield* verifyManagedExtensionAfterReconnect;
              if (!restored) {
                settleManagedRecovery(recovery, false);
                settleReconnectResolution(connectionGeneration, false);
                yield* routeRawEvent({
                  type: "closed",
                  error:
                    "Pylon's managed provider extension could not be verified after Prime Agent reconnected.",
                });
                return;
              }
            }
            if (rawType === "closed") {
              settleManagedRecovery(recovery, false);
              managedRecoveryFailed = true;
            }
            if (!managedRecoveryFailed || rawType === "closed") {
              yield* Effect.promise(() => routeMcpAwareRawEvent(raw));
              if (rawType === "session_resynced") {
                settleManagedRecovery(recovery, true);
              }
            }
          }),
        ),
      );
      const guarded = delivery.catch((cause) => {
        settleManagedRecovery(recovery, false);
        throw cause;
      });
      managedRecoveryTail = guarded.catch(() => undefined);
      return guarded;
    };
    const beginManagedWorkerRecovery = (): Promise<void> => {
      if (expectedExtension === undefined) return Promise.resolve();
      const recovery = beginManagedRecovery();
      const delivery = managedRecoveryTail
        .then(() =>
          runPromise(routeRawEvent({ type: "connection_status", status: "reconnecting" })),
        )
        .catch((cause) => {
          settleManagedRecovery(recovery, false);
          throw cause;
        });
      managedRecoveryTail = delivery.catch(() => undefined);
      return delivery;
    };
    const awaitManagedRecovery = Effect.suspend(() => {
      if (expectedExtension === undefined) return Effect.void;
      const recovery = managedRecoveryResolution;
      return Effect.tryPromise({
        try: async () => {
          await managedRecoveryTail;
          if (recovery === undefined) return true;
          return recovery.settled ? recovery.verified === true : recovery.promise;
        },
        catch: () =>
          runtimeError(
            "verify-extension",
            "request-failed",
            "Could not verify Pylon's managed provider extension after reconnecting.",
          ),
      }).pipe(
        Effect.flatMap((verified) =>
          verified && !managedRecoveryFailed
            ? Effect.void
            : runtimeError(
                "verify-extension",
                "request-failed",
                "Pylon's managed provider extension is unavailable after reconnecting.",
              ),
        ),
      );
    });
    const awaitMcpRecovery = Effect.suspend(() =>
      input.mcpServer === undefined
        ? Effect.void
        : Effect.tryPromise({
            try: () => mcpRecoveryTail,
            catch: () =>
              runtimeError(
                "configure-mcp",
                "request-failed",
                "Could not restore Pylon browser tools after the Prime Agent daemon reconnected.",
              ),
          }).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                mcpRecoveryFailed
                  ? runtimeError(
                      "configure-mcp",
                      "request-failed",
                      "Pylon browser tools are unavailable after the Prime Agent daemon reconnected.",
                    )
                  : Effect.void,
              ),
            ),
          ),
    );
    const awaitProviderRecovery = Effect.all([awaitManagedRecovery, awaitMcpRecovery]).pipe(
      Effect.asVoid,
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
      return routeManagedAwareRawEvent(event);
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
    lastSnapshotConnectionGeneration = connectionGeneration;
    observedCompletedMessageCount = initialEvent.state.messageCount;
    trackAgentRoster(initialEvent);

    const initialResources =
      verifiedInventory !== undefined
        ? safeSessionResources(
            verifiedInventory[0],
            verifiedInventory[1],
            verifiedInventoryCommandsDisabled,
          )
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
    const rlmQuiescenceAvailable = Predicate.isFunction(connection!.waitForHeadlessCompletion);
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
        const method = connection!.getRlmChildSnapshots;
        if (!Predicate.isFunction(method)) return [...knownAgentRoster.values()];
        const output = yield* Effect.tryPromise({
          try: () => method.call(connection),
          catch: () =>
            runtimeError(
              operation,
              "request-failed",
              "Could not refresh the Prime Agent agent roster.",
            ),
        }).pipe(
          Effect.timeoutOrElse({
            duration: COMMAND_TIMEOUT_MS,
            orElse: () =>
              runtimeError(
                operation,
                "request-timed-out",
                "Timed out while refreshing the Prime Agent agent roster.",
              ),
          }),
        );
        const children = decodePrimeAgentDaemonChildren(output);
        if (children === undefined) {
          return yield* runtimeError(
            operation,
            "invalid-response",
            "Prime Agent returned an invalid authoritative agent roster.",
          );
        }
        knownAgentRoster.clear();
        for (const child of children) knownAgentRoster.set(child.id, child);
        return children;
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
        ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>,
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

            const activityCorrelationSalt = NodeCrypto.randomUUID();
            let closed = false;
            let initialized = false;
            let pendingEventsTerminal = false;
            const pendingWatchEvents: Array<PrimeLiveActivityWatchEvent> = [];
            let streamingMessageActive = false;
            let streamingEntry: ProviderSessionAgentActivityTimelineEntry | undefined;
            let latestEntries: ReadonlyArray<ProviderSessionAgentActivityTimelineEntry> | undefined;
            let lastPublishedEntries:
              | ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>
              | undefined;
            let nativeTools = new Map<string, PrimeLiveActivityToolEntry>();
            let nextToolActivityId = 1;
            const pendingEntries =
              yield* Queue.sliding<ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>>(1);
            const entryEquals = (
              left: ProviderSessionAgentActivityTimelineEntry,
              right: ProviderSessionAgentActivityTimelineEntry | undefined,
            ) => {
              if (right === undefined || "speaker" in left !== "speaker" in right) return false;
              return "speaker" in left && "speaker" in right
                ? left.text === right.text
                : "kind" in left &&
                    "kind" in right &&
                    left.activityId === right.activityId &&
                    left.label === right.label &&
                    left.status === right.status;
            };
            const entriesChanged = (
              next: ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>,
            ) =>
              lastPublishedEntries === undefined ||
              next.length !== lastPublishedEntries.length ||
              next.some((entry, index) => !entryEquals(entry, lastPublishedEntries?.[index]));
            const offerEntries = (next: ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>) =>
              Effect.gen(function* () {
                latestEntries = next;
                if (closed || !entriesChanged(next)) return;
                lastPublishedEntries = next;
                yield* Queue.offer(queue, next);
              });
            const queueEntries = (next: ReadonlyArray<ProviderSessionAgentActivityTimelineEntry>) =>
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
            const replacementState = (event: Record<string, unknown>) => {
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
              return {
                state: sanitizePrimeAgentLiveActivityMessageState(
                  messages,
                  activityCorrelationSalt,
                ),
                streamingText: visibleAssistantText(streamingMessage),
              };
            };
            const sanitizeWatchEvent = (
              event: unknown,
            ): PrimeLiveActivityWatchEvent | undefined => {
              if (!Predicate.isObject(event) || !Predicate.isString(event.type)) return undefined;
              if (event.type === "closed") return { kind: "closed" };
              if (event.type === "session_replaced" || event.type === "session_resynced") {
                const replacement = replacementState(event);
                return replacement === undefined
                  ? undefined
                  : {
                      kind: "replace",
                      state: replacement.state,
                      ...(replacement.streamingText === undefined
                        ? {}
                        : { streamingText: replacement.streamingText }),
                    };
              }
              if (event.type !== "session_event" || !Predicate.isObject(event.event)) {
                return undefined;
              }
              const nativeEvent = event.event;
              if (
                nativeEvent.type === "message_start" ||
                nativeEvent.type === "message_update" ||
                nativeEvent.type === "message_end"
              ) {
                const text = visibleAssistantText(nativeEvent.message);
                if (text === undefined) return undefined;
                return {
                  kind: "assistant",
                  phase:
                    nativeEvent.type === "message_start"
                      ? "start"
                      : nativeEvent.type === "message_update"
                        ? "update"
                        : "end",
                  text,
                };
              }
              if (
                nativeEvent.type !== "tool_execution_start" &&
                nativeEvent.type !== "tool_execution_end"
              ) {
                // Progress payloads are deliberately ignored without reading partialResult.
                return undefined;
              }
              if (!Predicate.isString(nativeEvent.toolCallId)) return undefined;
              return {
                kind: "tool",
                toolCorrelationKey: liveActivityToolCorrelationKey(
                  activityCorrelationSalt,
                  nativeEvent.toolCallId,
                ),
                label: primeAgentLiveActivityToolLabel(nativeEvent.toolName),
                status:
                  nativeEvent.type === "tool_execution_start"
                    ? "started"
                    : nativeEvent.isError === true
                      ? "failed"
                      : "completed",
              };
            };
            const updateStreamingText = (text: string, phase: "start" | "update" | "end") => {
              const committed = [...(latestEntries ?? [])];
              const streamingIndex = streamingLiveActivityEntryIndex(committed, streamingEntry);
              if (streamingIndex >= 0) committed.splice(streamingIndex, 1);
              const lastCommitted = committed.at(-1);
              if (
                phase === "end" &&
                !streamingMessageActive &&
                lastCommitted !== undefined &&
                "speaker" in lastCommitted &&
                lastCommitted.text === text
              ) {
                streamingEntry = undefined;
                return committed;
              }
              const next = boundedLiveActivityEntries([
                ...committed,
                { speaker: "assistant", text },
              ]);
              streamingMessageActive = phase !== "end";
              streamingEntry = streamingMessageActive ? next.at(-1) : undefined;
              return next;
            };
            const updateTool = (
              toolCorrelationKey: string,
              label: string,
              status: "started" | "completed" | "failed",
            ) => {
              const previous = nativeTools.get(toolCorrelationKey);
              const entries = [...(latestEntries ?? [])];
              if (
                previous !== undefined &&
                (previous.status !== "started" || previous.status === status)
              ) {
                return entries;
              }
              const entry: PrimeLiveActivityToolEntry = {
                kind: "tool",
                activityId: previous?.activityId ?? nextToolActivityId,
                label: previous?.label ?? label,
                status,
              };
              if (previous === undefined) nextToolActivityId += 1;
              const previousIndex = previous === undefined ? -1 : entries.indexOf(previous);
              const next = boundedLiveActivityEntries(
                previousIndex < 0
                  ? [...entries, entry]
                  : entries.map((candidate, index) =>
                      index === previousIndex ? entry : candidate,
                    ),
              );
              nativeTools.set(toolCorrelationKey, entry);
              pruneLiveActivityNativeTools(nativeTools, next);
              return next;
            };
            const handleWatchEvent = (event: PrimeLiveActivityWatchEvent) =>
              Effect.gen(function* () {
                if (closed) return;
                if (event.kind === "closed") {
                  yield* failActivity(
                    runtimeError(
                      "watch-agent-activity",
                      "request-failed",
                      "The live agent activity watcher closed unexpectedly.",
                    ),
                  );
                  return;
                }
                if (event.kind === "replace") {
                  yield* Queue.poll(pendingEntries);
                  const replacementEntries = new Map<
                    PrimeLiveActivityToolEntry,
                    PrimeLiveActivityToolEntry
                  >();
                  const replacementTools = new Map<string, PrimeLiveActivityToolEntry>();
                  for (const [toolKey, incoming] of event.state.nativeTools) {
                    const existing = nativeTools.get(toolKey);
                    const reconciled: PrimeLiveActivityToolEntry = {
                      ...incoming,
                      activityId: existing?.activityId ?? nextToolActivityId,
                      ...(existing !== undefined &&
                      existing.status !== "started" &&
                      incoming.status === "started"
                        ? { status: existing.status }
                        : {}),
                    };
                    if (existing === undefined) nextToolActivityId += 1;
                    replacementEntries.set(incoming, reconciled);
                    replacementTools.set(toolKey, reconciled);
                  }
                  nativeTools = replacementTools;
                  let next: ReadonlyArray<ProviderSessionAgentActivityTimelineEntry> =
                    event.state.entries.map((entry) =>
                      "kind" in entry ? (replacementEntries.get(entry) ?? entry) : entry,
                    );
                  if (event.streamingText === undefined) {
                    streamingMessageActive = false;
                    streamingEntry = undefined;
                  } else {
                    next = boundedLiveActivityEntries([
                      ...next,
                      { speaker: "assistant", text: event.streamingText },
                    ]);
                    streamingMessageActive = true;
                    streamingEntry = next.at(-1);
                  }
                  yield* offerEntries(next);
                  return;
                }
                if (event.kind === "tool") {
                  yield* offerEntries(
                    updateTool(event.toolCorrelationKey, event.label, event.status),
                  );
                  return;
                }
                const next = updateStreamingText(event.text, event.phase);
                if (event.phase === "end") {
                  yield* Queue.poll(pendingEntries);
                  yield* offerEntries(next);
                } else {
                  yield* queueEntries(next);
                }
              });

            const unsubscribeResult = yield* Effect.try({
              try: () =>
                watcher.subscribe(async (event) => {
                  const pending = sanitizeWatchEvent(event);
                  if (pending === undefined) return;
                  if (!initialized) {
                    if (pendingEventsTerminal) return;
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
                    if (pending.kind === "closed") pendingEventsTerminal = true;
                    return;
                  }
                  await runPromise(handleWatchEvent(pending));
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
            const initialState = sanitizePrimeAgentLiveActivityMessageState(
              initialMessages,
              activityCorrelationSalt,
            );
            const initialEntries = initialState.entries;
            nativeTools = initialState.nativeTools;
            nextToolActivityId = initialState.nextToolActivityId;
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

    const readRlmUsage = Effect.fn("PrimeAgentDaemonSessionRuntime.readRlmUsage")(function* () {
      const statsOption = yield* getSessionStats.pipe(
        Effect.timeoutOption(RLM_QUIESCENCE_STATS_TIMEOUT_MS),
        Effect.orElseSucceed(() => Option.none()),
      );
      return Option.isSome(statsOption) ? statsOption.value.usage : undefined;
    });

    const awaitReconnectResolution = Effect.fn(
      "PrimeAgentDaemonSessionRuntime.awaitReconnectResolution",
    )(function* () {
      const generation = connectionGeneration;
      const pending = reconnectResolution;
      if (pending !== undefined && pending.generation === generation && !pending.settled) {
        const reconciled = yield* Effect.promise(() => pending.promise);
        if (!reconciled) {
          return yield* runtimeError(
            "rlm-quiescence",
            "request-failed",
            "Prime Agent reconnected before descendant quiescence could be confirmed.",
          );
        }
      }
      if (!rlmEventContinuityValid || generation !== connectionGeneration) {
        return yield* runtimeError(
          "rlm-quiescence",
          "request-failed",
          "Prime Agent reconnected before descendant quiescence could be confirmed.",
        );
      }
      return generation;
    });

    const readWorkerRecoverySummary = Effect.fn(
      "PrimeAgentDaemonSessionRuntime.readWorkerRecoverySummary",
    )(function* () {
      const output = yield* Effect.promise(async () => {
        try {
          return await client.request(
            { type: "list", includeClientOwned: true },
            RLM_WORKER_RECOVERY_LIST_TIMEOUT_MS,
          );
        } catch {
          return undefined;
        }
      });
      const listed = decodeSessionListSuccess(output);
      if (Option.isNone(listed)) return undefined;
      const candidates = listed.value.data.sessions.filter(
        (candidate) => candidate.activeSessionId?.trim() === activeSessionId,
      );
      if (candidates.length !== 1) return undefined;
      const candidate = candidates[0];
      if (
        candidate === undefined ||
        candidate.sessionId.trim() !== sessionId ||
        candidate.sessionFile?.trim() !== sessionFile ||
        candidate.workerPid === undefined ||
        candidate.workerPid <= 0 ||
        (candidate.workerState !== "recovering" && candidate.workerState !== "ready")
      ) {
        return undefined;
      }
      return { state: candidate.workerState, pid: candidate.workerPid } as const;
    });

    const awaitAbortSignal = (signal: AbortSignal) =>
      Effect.callback<void>((resume) => {
        if (signal.aborted) {
          resume(Effect.void);
          return;
        }
        const onAbort = () => resume(Effect.void);
        signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", onAbort));
      });

    const awaitWorkerRecoveryGate = Effect.fn(
      "PrimeAgentDaemonSessionRuntime.awaitWorkerRecoveryGate",
    )(function* (resolution: ReconnectResolution, expectedGeneration: number, signal: AbortSignal) {
      const ownsRecovery = () =>
        !disposed &&
        !disposeStarted &&
        !signal.aborted &&
        connectionGeneration === expectedGeneration &&
        activeWorkerRecovery?.resolution === resolution;
      const gate = Effect.gen(function* () {
        if (!ownsRecovery()) return false;
        yield* Effect.promise(() => beginManagedWorkerRecovery());
        const first = yield* readWorkerRecoverySummary();
        if (!ownsRecovery() || first?.state !== "recovering") return false;
        const workerPid = first.pid;
        let ready = false;
        for (const delay of RLM_WORKER_RECOVERY_LIST_DELAYS_MS) {
          yield* Effect.sleep(delay);
          if (!ownsRecovery()) return false;
          const current = yield* readWorkerRecoverySummary();
          if (!ownsRecovery() || current === undefined || current.pid !== workerPid) return false;
          if (current.state === "ready") {
            ready = true;
            break;
          }
        }
        if (!ready || !ownsRecovery() || resolution.settled) return false;
        const snapshot = yield* Effect.tryPromise({
          try: () => connection!.getInitialSnapshot(),
          catch: () => undefined,
        }).pipe(Effect.timeoutOption(RLM_WORKER_RECOVERY_LIST_TIMEOUT_MS));
        if (
          Option.isNone(snapshot) ||
          snapshot.value === undefined ||
          !ownsRecovery() ||
          resolution.settled
        ) {
          return false;
        }
        const recovery = activeWorkerRecovery;
        if (recovery?.resolution !== resolution) return false;
        const explicitSnapshot = { type: "session_resynced", snapshot: snapshot.value } as const;
        recovery.explicitSnapshotRaw = explicitSnapshot;
        yield* Effect.promise(() => routeManagedAwareRawEvent(explicitSnapshot));
        const reconciled = yield* Effect.promise(() => resolution.promise);
        return reconciled && ownsRecovery();
      });
      const outcome = yield* Effect.raceFirst(
        gate.pipe(Effect.map((recovered) => ({ kind: "gate" as const, recovered }))),
        awaitAbortSignal(signal).pipe(Effect.as({ kind: "aborted" as const })),
      ).pipe(Effect.timeoutOption(RLM_WORKER_RECOVERY_TIMEOUT_MS));
      if (Option.isNone(outcome)) return { kind: "timed-out" as const };
      return outcome.value;
    });

    const waitForRlmQuiescence = Effect.fn("PrimeAgentDaemonSessionRuntime.waitForRlmQuiescence")(
      function* (token: string, signal: AbortSignal) {
        const cancellationError = () =>
          runtimeError(
            "rlm-quiescence",
            "request-failed",
            "Prime Agent descendant quiescence wait was cancelled.",
          );
        let workerRecoveryResolution: ReconnectResolution | undefined;
        const wait = Effect.gen(function* () {
          yield* ensureOpen("rlm-quiescence");
          if (signal.aborted) {
            return yield* cancellationError();
          }
          if (!rlmQuiescenceAvailable) return;
          const waitGeneration = yield* awaitReconnectResolution();
          if (signal.aborted) {
            return yield* cancellationError();
          }
          const waitForHeadlessCompletion = yield* requireMethod(
            "rlm-quiescence",
            connection!.waitForHeadlessCompletion,
          );
          // Pylon-managed sessions disable Prime autonomous gates. The native method therefore
          // supplies only the authoritative descendant ordering boundary; its payload stays private.
          let cancellationRetries = 0;
          let workerRecoveryAttempted = false;
          let barrierRetried = false;
          while (true) {
            const waitResult = yield* Effect.promise(async () => {
              try {
                await waitForHeadlessCompletion.call(connection, {
                  waitForRlmQuiescence: true,
                });
                return "completed" as const;
              } catch (cause) {
                if (isRlmQuiescenceWaitCancellation(cause)) return "cancelled" as const;
                if (isPrimeAgentWorkerRecovering(cause)) return "worker-recovering" as const;
                return "failed" as const;
              }
            });
            if (signal.aborted) {
              return yield* cancellationError();
            }
            if (waitResult === "completed") break;
            if (waitResult === "worker-recovering") {
              if (workerRecoveryAttempted) {
                return yield* runtimeError(
                  "rlm-quiescence",
                  "request-failed",
                  "Prime Agent could not confirm descendant quiescence.",
                );
              }
              workerRecoveryAttempted = true;
              rlmEventContinuityValid = false;
              const resolution = beginReconnectResolution();
              workerRecoveryResolution = resolution;
              activeWorkerRecovery = {
                resolution,
                baselineMessageCount: observedCompletedMessageCount,
                terminalResponseObserved: false,
                explicitSnapshotOffered: false,
              };
              const recovery = yield* awaitWorkerRecoveryGate(resolution, waitGeneration, signal);
              if (signal.aborted || recovery.kind === "aborted") {
                return yield* cancellationError();
              }
              if (
                recovery.kind !== "gate" ||
                !recovery.recovered ||
                connectionGeneration !== waitGeneration
              ) {
                return yield* runtimeError(
                  "rlm-quiescence",
                  "request-failed",
                  connectionGeneration === waitGeneration
                    ? "Prime Agent could not confirm descendant quiescence."
                    : "Prime Agent reconnected before descendant quiescence could be confirmed.",
                );
              }
              barrierRetried = true;
              continue;
            }
            if (
              waitResult !== "cancelled" ||
              cancellationRetries >= RLM_QUIESCENCE_CANCELLATION_MAX_RETRIES
            ) {
              return yield* runtimeError(
                "rlm-quiescence",
                "request-failed",
                "Prime Agent could not confirm descendant quiescence.",
              );
            }
            cancellationRetries += 1;
            barrierRetried = true;
            yield* ensureOpen("rlm-quiescence");
            const retryGeneration = yield* awaitReconnectResolution();
            if (signal.aborted) {
              return yield* cancellationError();
            }
            if (retryGeneration !== waitGeneration) {
              return yield* runtimeError(
                "rlm-quiescence",
                "request-failed",
                "Prime Agent reconnected before descendant quiescence could be confirmed.",
              );
            }
          }
          const recovery = activeWorkerRecovery;
          if (
            workerRecoveryResolution !== undefined &&
            (recovery?.resolution !== workerRecoveryResolution ||
              !recovery.terminalResponseObserved)
          ) {
            return yield* runtimeError(
              "rlm-quiescence",
              "request-failed",
              "Prime Agent could not confirm descendant quiescence.",
            );
          }
          const quiescenceGeneration = yield* awaitReconnectResolution();
          if (signal.aborted) {
            return yield* cancellationError();
          }
          if (barrierRetried && quiescenceGeneration !== waitGeneration) {
            return yield* runtimeError(
              "rlm-quiescence",
              "request-failed",
              "Prime Agent reconnected before descendant quiescence could be confirmed.",
            );
          }
          const currentUsage = yield* readRlmUsage();
          const completedConnectionGeneration = yield* awaitReconnectResolution();
          if (signal.aborted) {
            return yield* cancellationError();
          }
          if (barrierRetried && completedConnectionGeneration !== waitGeneration) {
            return yield* runtimeError(
              "rlm-quiescence",
              "request-failed",
              "Prime Agent reconnected before descendant quiescence could be confirmed.",
            );
          }
          const usage = subtractCumulativeUsage(currentUsage, rlmTurnUsageBaseline);
          yield* Queue.offer(eventQueue, {
            _tag: "RlmQuiesced",
            token,
            connectionGeneration: completedConnectionGeneration,
            ...(usage === undefined ? {} : { usage }),
          });
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const resolution = workerRecoveryResolution;
              if (resolution === undefined) return;
              if (!resolution.settled) settleReconnectResolution(resolution.generation, false);
              if (activeWorkerRecovery?.resolution === resolution) {
                activeWorkerRecovery = undefined;
              }
            }),
          ),
        );
        yield* rlmQuiescenceSemaphore
          .withPermit(wait)
          .pipe(
            Effect.mapError(
              (error) =>
                error ??
                runtimeError(
                  "rlm-quiescence",
                  "request-failed",
                  "Prime Agent could not confirm descendant quiescence.",
                ),
            ),
          );
      },
    );

    const resolveCurrentActiveSessionId = Effect.fn(
      "PrimeAgentDaemonSessionRuntime.resolveCurrentActiveSessionId",
    )(function* () {
      const output = yield* Effect.tryPromise({
        try: () => client.request({ type: "list", includeClientOwned: true }, COMMAND_TIMEOUT_MS),
        catch: () =>
          runtimeError(
            "resume-after-abort",
            "request-failed",
            "The daemon did not resolve the current session after aborting.",
          ),
      });
      const listed = decodeSessionListSuccess(output);
      if (Option.isNone(listed)) {
        return yield* runtimeError(
          "resume-after-abort",
          "invalid-response",
          "The daemon returned an invalid session list while resuming input.",
        );
      }
      const matching = listed.value.data.sessions.filter(
        (candidate) =>
          candidate.activeSessionId !== undefined &&
          (candidate.sessionId.trim() === sessionId ||
            candidate.sessionFile?.trim() === sessionFile),
      );
      if (matching.length !== 1) {
        return yield* runtimeError(
          "resume-after-abort",
          "invalid-response",
          "The daemon did not identify one current session while resuming input.",
        );
      }
      const currentActiveSessionId = matching[0]?.activeSessionId?.trim() ?? "";
      if (currentActiveSessionId.length === 0) {
        return yield* runtimeError(
          "resume-after-abort",
          "invalid-response",
          "The daemon omitted the current session identity while resuming input.",
        );
      }
      return currentActiveSessionId;
    });

    const resumeAfterAbort = Effect.fn("PrimeAgentDaemonSessionRuntime.resumeAfterAbort")(
      function* () {
        return yield* resumeAfterAbortSemaphore.withPermit(
          Effect.gen(function* () {
            if (!needsResumeAfterAbort) return false;
            yield* ensureOpen("resume-after-abort");
            const currentActiveSessionId = yield* resolveCurrentActiveSessionId();
            const output = yield* Effect.tryPromise({
              try: () =>
                client.request(
                  { type: "resume_queue", activeSessionId: currentActiveSessionId },
                  COMMAND_TIMEOUT_MS,
                ),
              catch: () =>
                runtimeError(
                  "resume-after-abort",
                  "request-failed",
                  "The daemon did not resume session input after aborting.",
                ),
            });
            if (
              Option.isNone(decodeResumeQueueSuccess(output)) &&
              Option.isNone(decodeResumeQueueEmpty(output))
            ) {
              return yield* runtimeError(
                "resume-after-abort",
                "invalid-response",
                "The daemon returned an invalid session input resume response.",
              );
            }
            needsResumeAfterAbort = false;
            return true;
          }),
        );
      },
    );

    const prompt = Effect.fn("PrimeAgentDaemonSessionRuntime.prompt")(function* (
      promptInput: PrimeAgentDaemonPromptInput,
    ) {
      yield* ensureOpen("prompt");
      yield* awaitProviderRecovery;
      const resumedAfterAbort = yield* resumeAfterAbort();
      const images = yield* validateImages("prompt", promptInput.images);
      yield* validatePromptContent("prompt", promptInput.text, images);
      if (rlmQuiescenceAvailable && promptInput.rlmQuiescenceToken !== undefined) {
        rlmEventContinuityValid = true;
        reconnectResolution = undefined;
        rlmTurnUsageBaseline = yield* readRlmUsage();
      } else {
        rlmTurnUsageBaseline = undefined;
      }
      let resolveRecovery!: () => void;
      const recoveryPromise = new Promise<void>((resolve) => {
        resolveRecovery = resolve;
      });
      let resolveAdmissionEvidence!: (admitted: boolean) => void;
      const admissionEvidencePromise = new Promise<boolean>((resolve) => {
        resolveAdmissionEvidence = resolve;
      });
      let resolveCancellation!: () => void;
      const cancellationPromise = new Promise<void>((resolve) => {
        resolveCancellation = resolve;
      });
      let recovery!: NonNullable<typeof activePromptRecovery>;
      const onAdmissionAbort = () => {
        settlePromptAdmissionEvidence(recovery, false);
        resolveCancellation();
      };
      recovery = {
        admissionGeneration: connectionGeneration,
        baselineMessageCount: observedCompletedMessageCount,
        promptText: promptInput.text,
        promptImageMimeTypes: images.map((image) => image.mimeType),
        promptImageDigests: images.map((image) => primeAgentDaemonImageDigest(image.data)),
        signal: promptInput.signal,
        promise: recoveryPromise,
        resolve: resolveRecovery,
        admissionEvidencePromise,
        resolveAdmissionEvidence,
        cancellationPromise,
        cleanupAdmissionEvidence: () =>
          promptInput.signal?.removeEventListener("abort", onAdmissionAbort),
        reconnectGeneration: undefined,
        firstUserMessageObserved: false,
        promptAdmissionObserved: false,
        admissionEvidenceSettled: false,
        snapshotProvesAdmission: false,
        settled: false,
      };
      promptInput.signal?.addEventListener("abort", onAdmissionAbort, { once: true });
      if (promptInput.signal?.aborted === true) onAdmissionAbort();
      activePromptRecovery = recovery;
      // Promise.race deliberately leaves Prime's request-recovery handler attached.
      // If its replayed result later rejects, the adopted native execution still owns
      // completion through events and the correlated quiescence barrier.
      yield* callVoid("prompt", () => {
        const request = connection!.promptAndWait(promptInput.text, {
          queueIfBusy: resumedAfterAbort,
          ...(resumedAfterAbort ? { streamingBehavior: "followUp" as const } : {}),
          ...(images.length === 0 ? {} : { images }),
          ...(promptInput.signal === undefined ? {} : { signal: promptInput.signal }),
        });
        const requestWithRecovery = request.catch(async (error: unknown) => {
          if (error instanceof Error && error.message === "Daemon worker client closed") {
            const admissionProven = await awaitPromptAdmissionEvidence(recovery);
            if (
              admissionProven &&
              recovery.admissionGeneration === connectionGeneration &&
              recovery.signal?.aborted !== true &&
              rlmEventContinuityValid
            ) {
              // The supervisor can lose its worker command client after admission
              // while the native run continues. The exact same-generation user
              // message proves ownership, so never resend the prompt; events and the
              // correlated quiescence barrier remain authoritative.
              return;
            }
          }
          const reconnect = reconnectResolution;
          const canAwaitReconnect =
            reconnect !== undefined &&
            (recovery.reconnectGeneration === reconnect.generation || !reconnect.settled);
          if (canAwaitReconnect) {
            const reconciled = await reconnect.promise;
            if (reconciled && recovery.reconnectGeneration === reconnect.generation) {
              const admissionProven =
                recovery.snapshotProvesAdmission || (await awaitPromptAdmissionEvidence(recovery));
              if (admissionProven && recovery.signal?.aborted !== true) {
                const recoveredBeforeCancellation = await Promise.race([
                  recovery.promise.then(() => true),
                  recovery.cancellationPromise.then(() => false),
                ]);
                if (recoveredBeforeCancellation) return;
              }
            }
          }
          throw error;
        });
        return Promise.race([requestWithRecovery, recovery.promise]);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            settlePromptAdmissionEvidence(recovery, false);
            recovery.cleanupAdmissionEvidence();
            if (activePromptRecovery === recovery) activePromptRecovery = undefined;
          }),
        ),
      );
    });

    const steer = Effect.fn("PrimeAgentDaemonSessionRuntime.steer")(function* (
      promptInput: PrimeAgentDaemonPromptInput,
    ) {
      yield* ensureOpen("steer");
      yield* awaitProviderRecovery;
      const images = yield* validateImages("steer", promptInput.images);
      yield* validatePromptContent("steer", promptInput.text, images);
      const method = yield* requireMethod("steer", connection!.steer);
      yield* callVoid("steer", () => method.call(connection, promptInput.text, images));
    });

    const followUp = Effect.fn("PrimeAgentDaemonSessionRuntime.followUp")(function* (
      promptInput: PrimeAgentDaemonPromptInput,
    ) {
      yield* ensureOpen("follow-up");
      yield* awaitProviderRecovery;
      const images = yield* validateImages("follow-up", promptInput.images);
      yield* validatePromptContent("follow-up", promptInput.text, images);
      const method = yield* requireMethod("follow-up", connection!.followUp);
      yield* callVoid("follow-up", () => method.call(connection, promptInput.text, images));
    });

    const readPrivateInputQueue = (operation: "get-input-queue" | "remove-only-input-queue-item") =>
      Effect.gen(function* () {
        const method = yield* requireMethod(operation, connection!.getQueue);
        const output = yield* Effect.tryPromise({
          try: () => method.call(connection),
          catch: () =>
            runtimeError(
              operation,
              "request-failed",
              "Could not read the Prime Agent session input queue.",
            ),
        }).pipe(
          Effect.timeoutOrElse({
            duration: COMMAND_TIMEOUT_MS,
            orElse: () =>
              runtimeError(
                operation,
                "request-timed-out",
                "Timed out while reading the Prime Agent session input queue.",
              ),
          }),
        );
        const queue = decodePrivateInputQueue(output);
        if (Option.isNone(queue)) {
          return yield* runtimeError(
            operation,
            "invalid-response",
            "Prime Agent returned an invalid session input queue.",
          );
        }
        return queue.value;
      });

    const getInputQueue = Effect.gen(function* () {
      yield* ensureOpen("get-input-queue");
      return (yield* readPrivateInputQueue("get-input-queue")).snapshot;
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

    const removeOnlyInputQueueItem = Effect.fn(
      "PrimeAgentDaemonSessionRuntime.removeOnlyInputQueueItem",
    )(function* (queue: "steering" | "follow-up") {
      yield* ensureOpen("remove-only-input-queue-item");
      yield* requireMethod("remove-only-input-queue-item", connection!.mutateQueuedMessage);
      const current = yield* readPrivateInputQueue("remove-only-input-queue-item");
      const nativeLane: PrimeAgentDaemonQueuedMessageLane =
        queue === "steering" ? "steering" : "followUp";
      const entries = nativeLane === "steering" ? current.steering : current.followUp;
      if (entries.length !== 1) return "rejected" as const;
      const expectedText = entries[0]!;
      const response = yield* Effect.acquireUseRelease(
        input.manager
          .openClient()
          .pipe(
            Effect.mapError(() =>
              runtimeError(
                "remove-only-input-queue-item",
                "request-failed",
                "Could not open an isolated Prime Agent mutation connection.",
              ),
            ),
          ),
        (mutationClient) =>
          Effect.gen(function* () {
            if (mutationClient.supportsServerCapability?.("queue_message_mutation") === false) {
              return { success: true, data: { status: "unsupported" } };
            }
            return yield* Effect.tryPromise({
              try: () =>
                mutationClient.request(
                  {
                    type: "mutate_queued_message",
                    activeSessionId,
                    lane: nativeLane,
                    index: 0,
                    expectedText,
                    mutation: { type: "delete" },
                  },
                  COMMAND_TIMEOUT_MS,
                ),
              catch: () =>
                runtimeError(
                  "remove-only-input-queue-item",
                  "request-failed",
                  "Could not remove the sole Prime Agent session input.",
                ),
            }).pipe(
              Effect.timeoutOrElse({
                duration: COMMAND_TIMEOUT_MS,
                orElse: () =>
                  runtimeError(
                    "remove-only-input-queue-item",
                    "request-timed-out",
                    "Timed out while removing the sole Prime Agent session input.",
                  ),
              }),
            );
          }),
        (mutationClient) => Effect.sync(() => mutationClient.close()),
      );
      if (typeof response !== "object" || response === null) {
        return yield* runtimeError(
          "remove-only-input-queue-item",
          "invalid-response",
          "Prime Agent returned an invalid queued input mutation response.",
        );
      }
      const envelope = response as {
        readonly success?: unknown;
        readonly data?: { readonly status?: unknown };
      };
      if (envelope.success !== true) {
        return yield* runtimeError(
          "remove-only-input-queue-item",
          "request-failed",
          "Prime Agent rejected the queued input mutation request.",
        );
      }
      const status = envelope.data?.status;
      if (
        status !== "applied" &&
        status !== "rejected" &&
        status !== "invalid" &&
        status !== "unsupported"
      ) {
        return yield* runtimeError(
          "remove-only-input-queue-item",
          "invalid-response",
          "Prime Agent returned an invalid queued input mutation status.",
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
      // Prime suspends new session input as soon as abort begins. Keep this set
      // even when the response is lost because the native side effect may have run.
      needsResumeAfterAbort = true;
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
            expectedExtension === undefined
              ? Promise.resolve(undefined)
              : connection!.getToolDefinition!(PRIME_AGENT_PLAN_TOOL_NAME),
            expectedExtension === undefined
              ? Promise.resolve(true)
              : expectedExtension.verifySource(),
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
      if (
        expectedExtension !== undefined &&
        (rawState[4] !== true ||
          resources.value.extensions.filter(
            (extension) => extension.path === expectedExtension.path,
          ).length !== 1 ||
          (input.requiredExtension !== undefined && resources.value.extensions.length !== 1) ||
          commands.value.filter(
            (command) =>
              command.name === expectedExtension.markerCommand &&
              command.source === "extension" &&
              command.sourceInfo.path === expectedExtension.path,
          ).length !== 1 ||
          resources.value.diagnostics.extensions.some((diagnostic) =>
            input.requiredExtension === undefined
              ? diagnostic.type !== "warning" && diagnostic.path === expectedExtension.path
              : diagnostic.type !== "warning",
          ) ||
          !managedPlanToolDefinitionMatches(rawState[3]))
      ) {
        return yield* runtimeError(
          "reload-resources",
          "invalid-response",
          "Prime Agent did not preserve the required managed provider extension after reload.",
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
        catch: () =>
          runtimeError(
            "set-model",
            "request-failed",
            // A Prime release can drop a model id from its catalog, which rejects a
            // durable Pylon selection here rather than at discovery. Name that cause
            // without copying Prime's native error text across the boundary.
            "Prime Agent rejected the selected model. It may no longer exist in Prime Agent's catalog; select another model.",
          ),
      });
      const decoded = decodeModel(output);
      if (Option.isNone(decoded)) {
        return yield* runtimeError(
          "set-model",
          "invalid-response",
          "The daemon returned an invalid model response.",
        );
      }
      sessionRuntimeConfig.model = `${decoded.value.provider}/${decoded.value.id}`;
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
        sessionRuntimeConfig.thinking = level;
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
      const usage =
        decoded.value.tokens === undefined || decoded.value.cost === undefined
          ? undefined
          : {
              inputTokens: decoded.value.tokens.input,
              outputTokens: decoded.value.tokens.output,
              cachedInputTokens: decoded.value.tokens.cacheRead,
              cacheWriteTokens: decoded.value.tokens.cacheWrite,
              totalTokens: decoded.value.tokens.total,
              totalCostUsd: decoded.value.cost,
            };
      return {
        ...(usage === undefined ? {} : { usage }),
        ...(decoded.value.contextUsage === undefined
          ? {}
          : {
              contextUsage: {
                usedTokens: decoded.value.contextUsage.tokens,
                maxTokens: decoded.value.contextUsage.contextWindow,
              },
            }),
      } satisfies PrimeAgentDaemonSessionStats;
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
      settleReconnectResolution(connectionGeneration, false);
      unsubscribe?.();
      const nativeSideQuestions = [...activePrivateSideQuestions.entries()];
      return Effect.forEach(nativeSideQuestions, ([nativeId, active]) =>
        bestEffortAbortSideQuestion(nativeId, active),
      ).pipe(
        Effect.andThen(failActivePrivateSideQuestions()),
        Effect.andThen(releaseMcpServer),
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
      inputQueueMutationAvailable:
        typeof connection.mutateQueuedMessage === "function" &&
        (client.supportsServerCapability?.("queue_message_mutation") ?? true),
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
      rlmQuiescenceAvailable,
      waitForRlmQuiescence,
      isRlmQuiescenceGenerationCurrent: (generation) =>
        rlmEventContinuityValid && generation === connectionGeneration,
      resolveReconnectSnapshot,
      noteWorkerRecoveryTerminalResponse,
      isConnectionGenerationCurrent: (generation) => generation === connectionGeneration,
      prompt,
      steer,
      followUp,
      getInputQueue,
      getInputQueueStatus,
      clearInputQueue,
      removeOnlyInputQueueItem,
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
