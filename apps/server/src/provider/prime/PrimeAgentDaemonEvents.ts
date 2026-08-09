import {
  PROVIDER_AGENT_CONTROL_ID_MAX_CHARS,
  PROVIDER_SESSION_GOAL_OBJECTIVE_MAX_CHARS,
  type SessionGoalStatus,
  type SessionGoalUpdatedPayload,
  type SessionInputQueueDeliveryMode,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const thinkingLevel = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const serviceTier = Schema.NullOr(
  Schema.Literals(["auto", "default", "flex", "scale", "priority"]),
);
const queueMode = Schema.Literals(["all", "one-at-a-time"]);
const stopReason = Schema.Literals(["stop", "length", "toolUse", "error", "aborted"]);

const textContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
const thinkingContent = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  redacted: Schema.optional(Schema.Boolean),
});
const imageContent = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});
const toolCallContent = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Unknown,
});

const usage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  totalTokens: Schema.Number,
  cost: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    total: Schema.Number,
  }),
});

export const PrimeAgentDaemonAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Union([textContent, thinkingContent, toolCallContent])),
  api: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  responseModel: Schema.optional(Schema.String),
  responseId: Schema.optional(Schema.String),
  usage,
  stopReason,
  stopReasonRaw: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  timestamp: Schema.Number,
});

export const PrimeAgentDaemonUserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Union([textContent, imageContent]))]),
  timestamp: Schema.Number,
});

export const PrimeAgentDaemonToolResultMessage = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.Array(Schema.Union([textContent, imageContent])),
  details: Schema.optional(Schema.Unknown),
  isError: Schema.Boolean,
  timestamp: Schema.Number,
});

export const PrimeAgentDaemonMessage = Schema.Union([
  PrimeAgentDaemonUserMessage,
  PrimeAgentDaemonAssistantMessage,
  PrimeAgentDaemonToolResultMessage,
]);
export type PrimeAgentDaemonMessage = typeof PrimeAgentDaemonMessage.Type;

const assistantStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("start"),
    partial: Schema.optional(PrimeAgentDaemonAssistantMessage),
  }),
  Schema.Struct({
    type: Schema.Literal("text_start"),
    contentIndex: Schema.Int,
    partial: Schema.optional(PrimeAgentDaemonAssistantMessage),
  }),
  Schema.Struct({
    type: Schema.Literal("text_delta"),
    contentIndex: Schema.Int,
    delta: Schema.String,
    partial: Schema.optional(PrimeAgentDaemonAssistantMessage),
  }),
  Schema.Struct({
    type: Schema.Literal("text_end"),
    contentIndex: Schema.Int,
    content: Schema.String,
    partial: Schema.optional(PrimeAgentDaemonAssistantMessage),
  }),
  Schema.Struct({
    type: Schema.Literal("thinking_start"),
    contentIndex: Schema.Int,
    partial: Schema.optional(PrimeAgentDaemonAssistantMessage),
  }),
  Schema.Struct({
    type: Schema.Literal("thinking_delta"),
    contentIndex: Schema.Int,
    delta: Schema.String,
    partial: Schema.optional(PrimeAgentDaemonAssistantMessage),
  }),
  Schema.Struct({
    type: Schema.Literal("thinking_end"),
    contentIndex: Schema.Int,
    content: Schema.String,
    partial: Schema.optional(PrimeAgentDaemonAssistantMessage),
  }),
  Schema.Struct({
    type: Schema.Literal("toolcall_start"),
    contentIndex: Schema.Int,
    partial: Schema.optional(PrimeAgentDaemonAssistantMessage),
  }),
  Schema.Struct({
    type: Schema.Literal("toolcall_delta"),
    contentIndex: Schema.Int,
    delta: Schema.String,
    partial: Schema.optional(PrimeAgentDaemonAssistantMessage),
  }),
  Schema.Struct({
    type: Schema.Literal("toolcall_end"),
    contentIndex: Schema.Int,
    toolCall: toolCallContent,
    partial: Schema.optional(PrimeAgentDaemonAssistantMessage),
  }),
  Schema.Struct({
    type: Schema.Literal("done"),
    reason: Schema.Literals(["stop", "length", "toolUse"]),
    message: PrimeAgentDaemonAssistantMessage,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    reason: Schema.Literals(["aborted", "error"]),
    error: PrimeAgentDaemonAssistantMessage,
  }),
]);

const toolResult = Schema.Struct({
  content: Schema.Array(Schema.Union([textContent, imageContent])),
  details: Schema.Unknown,
  terminate: Schema.optional(Schema.Boolean),
});

const sessionActions = Schema.Struct({
  queuedCount: Schema.Int,
  steering: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(1_000)),
  followUps: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(1_000)),
  active: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(["turn", "session_command"]),
      phase: Schema.Literals(["preparing", "committing", "running"]),
      label: Schema.optional(Schema.String),
    }),
  ),
});

// Prime's public GoalState is the only native goal surface consumed here. Native
// identity, timestamps, reasons, and errors are deliberately absent so decoding
// cannot carry them across the provider boundary.
const goalState = Schema.Struct({
  active: Schema.Boolean,
  status: Schema.String,
  objective: Schema.optional(Schema.String),
  tokenBudget: Schema.optional(Schema.Number),
  tokensUsed: Schema.Number,
  timeUsedSeconds: Schema.Number,
  continuationsUsed: Schema.Number,
});

const rlmChild = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()).check(
    Schema.isMaxLength(PROVIDER_AGENT_CONTROL_ID_MAX_CHARS),
  ),
  parentId: Schema.optional(Schema.String),
  activeSessionId: Schema.optional(Schema.String),
  sessionName: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  label: Schema.String,
  status: Schema.Literals(["queued", "running", "done", "error", "cancelled"]),
  durationMs: Schema.optional(Schema.Number),
  answerPreview: Schema.optional(Schema.String),
  repliedSinceTask: Schema.optional(Schema.Boolean),
  toolUseCount: Schema.optional(Schema.Number),
  tokenCount: Schema.optional(Schema.Number),
  recap: Schema.optional(Schema.String),
  sessionDir: Schema.String,
  activity: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(["waiting", "writing", "executing"]),
      toolName: Schema.optional(Schema.String),
    }),
  ),
  error: Schema.optional(Schema.String),
});

const compactionResult = Schema.Struct({
  summary: Schema.String,
  firstKeptEntryId: Schema.String,
  tokensBefore: Schema.Number,
  details: Schema.optional(Schema.Unknown),
  fromHook: Schema.optional(Schema.Boolean),
});

const refinementResult = Schema.Struct({
  id: Schema.String,
  summary: Schema.String,
  rationale: Schema.String,
  expectedOutcome: Schema.String,
  appliedEdits: Schema.Array(
    Schema.Struct({
      action: Schema.Literals(["create", "update", "delete"]),
      kind: Schema.Literals(["prompt", "memory", "skill", "subagent"]),
      id: Schema.String,
      applied: Schema.Boolean,
      error: Schema.optional(Schema.String),
    }),
  ),
  harnessStatePath: Schema.String,
  rollbackOf: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.Literals(["local", "global"])),
});

const agentSessionEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("agent_start") }),
  Schema.Struct({
    type: Schema.Literal("agent_end"),
    messages: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("turn_start") }),
  Schema.Struct({
    type: Schema.Literal("turn_end"),
    message: PrimeAgentDaemonAssistantMessage,
    toolResults: Schema.Array(PrimeAgentDaemonToolResultMessage),
  }),
  Schema.Struct({
    type: Schema.Literal("message_start"),
    message: PrimeAgentDaemonMessage,
  }),
  Schema.Struct({
    type: Schema.Literal("message_update"),
    message: PrimeAgentDaemonAssistantMessage,
    assistantMessageEvent: assistantStreamEvent,
  }),
  Schema.Struct({
    type: Schema.Literal("message_end"),
    message: PrimeAgentDaemonMessage,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_start"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_update"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
    partialResult: toolResult,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_end"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    result: toolResult,
    isError: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("ipython_sent_agent_message"),
    toolCallId: Schema.String,
    message: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("session_info_changed"),
    name: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("session_action_update"),
    actions: sessionActions,
  }),
  Schema.Struct({
    type: Schema.Literal("thinking_level_changed"),
    level: thinkingLevel,
  }),
  Schema.Struct({
    type: Schema.Literal("service_tier_changed"),
    serviceTier,
  }),
  Schema.Struct({
    type: Schema.Literal("compaction_start"),
    reason: Schema.Literals(["manual", "threshold", "overflow", "requested"]),
    customInstructions: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("compaction_end"),
    reason: Schema.Literals(["manual", "threshold", "overflow", "requested"]),
    result: Schema.optional(Schema.NullOr(compactionResult)),
    aborted: Schema.Boolean,
    willRetry: Schema.Boolean,
    errorMessage: Schema.optional(Schema.String),
    errorSeverity: Schema.optional(Schema.Literals(["warning", "error"])),
    customInstructions: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("auto_retry_start"),
    attempt: Schema.Int,
    maxAttempts: Schema.Int,
    delayMs: Schema.Number,
    errorMessage: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("auto_retry_end"),
    success: Schema.Boolean,
    attempt: Schema.Int,
    finalError: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("auth_stale"),
    provider: Schema.String,
    sourceTokens: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
  Schema.Struct({ type: Schema.Literal("rlm_child_update"), child: rlmChild }),
  Schema.Struct({ type: Schema.Literal("recap_update"), recap: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("goal_update"), goal: goalState }),
  Schema.Struct({
    type: Schema.Literal("bash_start"),
    command: Schema.String,
    excludeFromContext: Schema.Boolean,
    transient: Schema.optional(Schema.Boolean),
    runId: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("bash_output"), chunk: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("bash_end"),
    exitCode: Schema.optional(Schema.Number),
    cancelled: Schema.Boolean,
    truncated: Schema.Boolean,
    fullOutputPath: Schema.optional(Schema.String),
    errorMessage: Schema.optional(Schema.String),
    transient: Schema.optional(Schema.Boolean),
    runId: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("refine_complete"), result: refinementResult }),
  Schema.Struct({ type: Schema.Literal("refine_failed"), error: Schema.String }),
]);

const contextUsage = Schema.Struct({
  tokens: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  contextWindow: Schema.Int.check(Schema.isGreaterThan(0)),
  percent: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
});

const sessionState = Schema.Struct({
  activeSessionId: Schema.optional(Schema.String),
  cwd: Schema.String,
  thinkingLevel,
  serviceTier,
  isStreaming: Schema.Boolean,
  isCompacting: Schema.Boolean,
  isBashRunning: Schema.Boolean,
  retryAttempt: Schema.Number,
  sessionId: Schema.String,
  sessionName: Schema.optional(Schema.String),
  messageCount: Schema.Number,
  autoCompactionEnabled: Schema.Boolean,
  steeringMode: Schema.optional(queueMode),
  followUpMode: Schema.optional(queueMode),
  contextUsage: Schema.optional(contextUsage),
  sessionActions,
  goal: Schema.optional(goalState),
  recap: Schema.optional(Schema.String),
});

const sessionSnapshot = Schema.Struct({
  state: sessionState,
  messages: Schema.Array(Schema.Unknown),
  streamingMessage: Schema.optional(Schema.Unknown),
  children: Schema.optional(Schema.Array(rlmChild)),
  lastEventSequence: Schema.optional(Schema.Number),
});

const extensionMethod = Schema.Literals([
  "select",
  "confirm",
  "input",
  "editor",
  "notify",
  "setStatus",
  "setWidget",
]);

const extensionPayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.String)),
  timeout: Schema.optional(Schema.Number),
  placeholder: Schema.optional(Schema.String),
  prefill: Schema.optional(Schema.String),
  notifyType: Schema.optional(Schema.Literals(["info", "warning", "error"])),
  statusKey: Schema.optional(Schema.String),
  statusText: Schema.optional(Schema.String),
  widgetKey: Schema.optional(Schema.String),
  widgetLines: Schema.optional(Schema.Array(Schema.String)),
  widgetPlacement: Schema.optional(Schema.Literals(["aboveEditor", "belowEditor"])),
  text: Schema.optional(Schema.String),
});

export const PrimeAgentDaemonConnectionEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session_event"), event: agentSessionEvent }),
  Schema.Struct({
    type: Schema.Literal("side_question_event"),
    event: Schema.Struct({
      id: Schema.String,
      question: Schema.String,
      answer: Schema.String,
      status: Schema.Literals(["running", "complete", "cancelled", "error"]),
      errorMessage: Schema.optional(Schema.String),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("session_replaced"),
    state: sessionState,
    messages: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("session_resynced"), snapshot: sessionSnapshot }),
  Schema.Struct({ type: Schema.Literal("session_status"), recap: Schema.optional(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    request: Schema.Struct({
      id: Schema.String,
      method: extensionMethod,
      payload: extensionPayload,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_error"),
    extensionPath: Schema.String,
    event: Schema.String,
    error: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("connection_status"),
    status: Schema.Literals(["reconnecting", "connected"]),
    error: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("heartbeats_changed") }),
  Schema.Struct({ type: Schema.Literal("closed"), error: Schema.optional(Schema.String) }),
]);
export type PrimeAgentDaemonConnectionEvent = typeof PrimeAgentDaemonConnectionEvent.Type;

const decodeConnectionEvent = Schema.decodeUnknownOption(PrimeAgentDaemonConnectionEvent);
const decodeMessage = Schema.decodeUnknownOption(PrimeAgentDaemonMessage);
const decodeEventType = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String }));

const knownConnectionEventTypes = new Set([
  "session_event",
  "side_question_event",
  "session_replaced",
  "session_resynced",
  "session_status",
  "extension_ui_request",
  "extension_error",
  "connection_status",
  "heartbeats_changed",
  "closed",
]);
const knownSessionEventTypes = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "ipython_sent_agent_message",
  "session_info_changed",
  "session_action_update",
  "thinking_level_changed",
  "service_tier_changed",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "auth_stale",
  "rlm_child_update",
  "recap_update",
  "goal_update",
  "bash_start",
  "bash_output",
  "bash_end",
  "refine_complete",
  "refine_failed",
]);

const MAX_TEXT_LENGTH = 100_000;
const MAX_PREVIEW_LENGTH = 4_000;
const MAX_LIST_ITEMS = 100;
const MAX_SCALAR_FIELDS = 32;

type PrimeDaemonScalar = string | number | boolean | null;

function bounded(value: string, maximum = MAX_TEXT_LENGTH): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function optionalBounded(value: string | undefined, maximum = MAX_TEXT_LENGTH): string | undefined {
  return value === undefined ? undefined : bounded(value, maximum);
}

const unavailableGoalState: SessionGoalUpdatedPayload = {
  available: false,
  active: false,
  status: "idle",
  tokensUsed: 0,
  timeUsedSeconds: 0,
  continuationsUsed: 0,
};

function safeGoalStatus(status: string): SessionGoalStatus | undefined {
  switch (status) {
    case "idle":
    case "active":
    case "paused":
    case "complete":
    case "error":
      return status;
    case "budget_limited":
      return "budget-limited";
    default:
      return undefined;
  }
}

function safeGoalInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)));
}

function safeGoalBudget(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.trunc(value)));
}

function safeGoalState(
  goal: typeof goalState.Type | undefined,
): SessionGoalUpdatedPayload | undefined {
  if (goal === undefined) return undefined;
  const status = safeGoalStatus(goal.status);
  if (status === undefined) return undefined;
  const objective = goal.objective?.replaceAll("\u0000", "").trim();
  const boundedObjective =
    objective === undefined
      ? undefined
      : [...objective].slice(0, PROVIDER_SESSION_GOAL_OBJECTIVE_MAX_CHARS).join("");
  const tokenBudget = safeGoalBudget(goal.tokenBudget);
  return {
    available: true,
    active: status === "active",
    status,
    ...(boundedObjective === undefined || boundedObjective.length === 0
      ? {}
      : { objective: boundedObjective }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    tokensUsed: safeGoalInteger(goal.tokensUsed),
    timeUsedSeconds: safeGoalInteger(goal.timeUsedSeconds),
    continuationsUsed: safeGoalInteger(goal.continuationsUsed),
  };
}

function safeScalarFields(value: unknown): Readonly<Record<string, PrimeDaemonScalar>> | undefined {
  if (!Predicate.isObject(value) || Array.isArray(value)) return undefined;

  const fields: Record<string, PrimeDaemonScalar> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_SCALAR_FIELDS)) {
    if (Predicate.isString(item)) fields[key] = bounded(item, MAX_PREVIEW_LENGTH);
    else if (Predicate.isNumber(item) || Predicate.isBoolean(item) || item === null) {
      fields[key] = item;
    }
  }
  return Object.keys(fields).length === 0 ? undefined : fields;
}

export interface PrimeDaemonUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
}

export interface PrimeDaemonToolCall {
  readonly id: string;
  readonly name: string;
  readonly input?: Readonly<Record<string, PrimeDaemonScalar>> | undefined;
}

export type PrimeDaemonMessage =
  | {
      readonly role: "user";
      readonly timestamp: number;
      readonly text: string;
      readonly imageMimeTypes: ReadonlyArray<string>;
    }
  | {
      readonly role: "assistant";
      readonly timestamp: number;
      readonly provider: string;
      readonly model: string;
      readonly responseId?: string | undefined;
      readonly text: string;
      readonly thinking: string;
      readonly toolCalls: ReadonlyArray<PrimeDaemonToolCall>;
      readonly usage: PrimeDaemonUsage;
      readonly stopReason: typeof stopReason.Type;
      readonly errorMessage?: string | undefined;
    }
  | {
      readonly role: "toolResult";
      readonly timestamp: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly text: string;
      readonly imageMimeTypes: ReadonlyArray<string>;
      readonly isError: boolean;
    };

export interface PrimeDaemonSessionState {
  readonly activeSessionId?: string | undefined;
  readonly sessionId: string;
  readonly sessionName?: string | undefined;
  readonly cwd: string;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly isBashRunning: boolean;
  readonly retryAttempt: number;
  readonly thinkingLevel: typeof thinkingLevel.Type;
  readonly serviceTier: typeof serviceTier.Type;
  readonly messageCount: number;
  readonly autoCompactionEnabled: boolean;
  readonly inputQueue: {
    readonly steeringCount: number;
    readonly followUpCount: number;
    readonly activeAction: boolean;
    readonly steeringMode?: SessionInputQueueDeliveryMode | undefined;
    readonly followUpMode?: SessionInputQueueDeliveryMode | undefined;
  };
  readonly contextUsage?:
    | {
        readonly tokens: number | null;
        readonly contextWindow: number;
        readonly percent: number | null;
      }
    | undefined;
  readonly goal: SessionGoalUpdatedPayload;
  readonly recap?: string | undefined;
}

export type PrimeDaemonEvent =
  | { readonly _tag: "RunStarted" }
  | { readonly _tag: "RunCompleted"; readonly messages: ReadonlyArray<PrimeDaemonMessage> }
  | { readonly _tag: "TurnStarted" }
  | {
      readonly _tag: "TurnCompleted";
      readonly message: Extract<PrimeDaemonMessage, { readonly role: "assistant" }>;
      readonly toolResults: ReadonlyArray<
        Extract<PrimeDaemonMessage, { readonly role: "toolResult" }>
      >;
    }
  | { readonly _tag: "MessageStarted"; readonly message: PrimeDaemonMessage }
  | { readonly _tag: "MessageCompleted"; readonly message: PrimeDaemonMessage }
  | {
      readonly _tag: "AssistantStream";
      readonly phase: "start" | "delta" | "end" | "done" | "error";
      readonly kind: "message" | "text" | "thinking" | "toolCall";
      readonly contentIndex?: number | undefined;
      readonly delta?: string | undefined;
      readonly content?: string | undefined;
      readonly toolCall?: PrimeDaemonToolCall | undefined;
      readonly message?: Extract<PrimeDaemonMessage, { readonly role: "assistant" }> | undefined;
    }
  | {
      readonly _tag: "ToolStarted";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input?: Readonly<Record<string, PrimeDaemonScalar>> | undefined;
    }
  | {
      readonly _tag: "ToolProgress";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly text: string;
    }
  | {
      readonly _tag: "ToolCompleted";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly text: string;
      readonly isError: boolean;
    }
  | {
      readonly _tag: "AgentMessageSent";
      readonly toolCallId: string;
      readonly receipt?: Readonly<Record<string, PrimeDaemonScalar>> | undefined;
    }
  | { readonly _tag: "SessionInfoChanged"; readonly name?: string | undefined }
  | {
      readonly _tag: "QueueChanged";
      readonly queuedCount: number;
      readonly steeringCount: number;
      readonly followUpCount: number;
      readonly active?:
        | {
            readonly kind: "turn" | "session_command";
            readonly phase: string;
          }
        | undefined;
    }
  | { readonly _tag: "ThinkingLevelChanged"; readonly level: typeof thinkingLevel.Type }
  | { readonly _tag: "ServiceTierChanged"; readonly serviceTier: typeof serviceTier.Type }
  | { readonly _tag: "CompactionStarted" }
  | {
      readonly _tag: "CompactionCompleted";
      readonly outcome: "completed" | "aborted" | "skipped" | "failed";
      readonly willRetry: boolean;
    }
  | {
      readonly _tag: "RetryStarted";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
    }
  | {
      readonly _tag: "RetryCompleted";
      readonly success: boolean;
      readonly attempt: number;
    }
  | { readonly _tag: "AuthStale"; readonly provider: string; readonly sourceCount: number }
  | {
      readonly _tag: "ChildUpdated";
      readonly child: {
        readonly id: string;
        readonly parentId?: string | undefined;
        readonly activeSessionId?: string | undefined;
        readonly sessionName?: string | undefined;
        readonly model?: string | undefined;
        readonly label: string;
        readonly status: "queued" | "running" | "done" | "error" | "cancelled";
        readonly durationMs?: number | undefined;
        readonly answerPreview?: string | undefined;
        readonly toolUseCount?: number | undefined;
        readonly tokenCount?: number | undefined;
        readonly recap?: string | undefined;
        readonly activity?:
          | {
              readonly kind: "waiting" | "writing" | "executing";
              readonly toolName?: string | undefined;
            }
          | undefined;
        readonly error?: string | undefined;
      };
    }
  | { readonly _tag: "RecapUpdated"; readonly recap?: string | undefined }
  | { readonly _tag: "GoalUpdated"; readonly goal: SessionGoalUpdatedPayload }
  | {
      readonly _tag: "BashStarted";
      readonly command: string;
      readonly excludeFromContext: boolean;
      readonly transient: boolean;
      readonly runId?: string | undefined;
    }
  | { readonly _tag: "BashOutput"; readonly chunk: string }
  | {
      readonly _tag: "BashCompleted";
      readonly exitCode?: number | undefined;
      readonly cancelled: boolean;
      readonly truncated: boolean;
      readonly errorMessage?: string | undefined;
      readonly transient: boolean;
      readonly runId?: string | undefined;
    }
  | {
      readonly _tag: "RefinementCompleted";
      readonly appliedCount: number;
      readonly failedCount: number;
    }
  | { readonly _tag: "RefinementFailed" }
  | {
      readonly _tag: "SideQuestionUpdated";
      readonly id: string;
      readonly question: string;
      readonly answer: string;
      readonly status: "running" | "complete" | "cancelled" | "error";
      readonly errorMessage?: string | undefined;
    }
  | {
      readonly _tag: "SessionReplaced";
      readonly state: PrimeDaemonSessionState;
      readonly messages: ReadonlyArray<PrimeDaemonMessage>;
    }
  | {
      readonly _tag: "SessionResynced";
      readonly state: PrimeDaemonSessionState;
      readonly messages: ReadonlyArray<PrimeDaemonMessage>;
      readonly streamingMessage?: PrimeDaemonMessage | undefined;
      readonly children: ReadonlyArray<
        Extract<PrimeDaemonEvent, { readonly _tag: "ChildUpdated" }>["child"]
      >;
      readonly lastEventSequence?: number | undefined;
    }
  | { readonly _tag: "SessionStatus"; readonly recap?: string | undefined }
  | {
      readonly _tag: "ExtensionRequest";
      readonly request: {
        readonly id: string;
        readonly method: string;
        readonly title?: string | undefined;
        readonly message?: string | undefined;
        readonly options?: ReadonlyArray<string> | undefined;
        readonly timeoutMs?: number | undefined;
        readonly placeholder?: string | undefined;
        readonly prefill?: string | undefined;
        readonly notifyType?: "info" | "warning" | "error" | undefined;
        readonly statusKey?: string | undefined;
        readonly statusText?: string | undefined;
        readonly widgetKey?: string | undefined;
        readonly widgetLines?: ReadonlyArray<string> | undefined;
        readonly widgetPlacement?: "aboveEditor" | "belowEditor" | undefined;
        readonly text?: string | undefined;
      };
    }
  | {
      readonly _tag: "ExtensionError";
      readonly extensionPath: string;
      readonly event: string;
      readonly error: string;
    }
  | {
      readonly _tag: "ConnectionStatus";
      readonly status: "reconnecting" | "connected";
      readonly error?: string | undefined;
    }
  | { readonly _tag: "HeartbeatsChanged" }
  | { readonly _tag: "SessionClosed"; readonly error?: string | undefined }
  | {
      readonly _tag: "Ignored";
      readonly reason: "unknown-event" | "malformed-event";
      readonly sourceType?: string | undefined;
    };

function mapUsage(value: typeof usage.Type): PrimeDaemonUsage {
  return {
    inputTokens: value.input,
    outputTokens: value.output,
    cachedInputTokens: value.cacheRead,
    cacheWriteTokens: value.cacheWrite,
    totalTokens: value.totalTokens,
    totalCostUsd: value.cost.total,
  };
}

function mapToolCall(value: typeof toolCallContent.Type): PrimeDaemonToolCall {
  return {
    id: bounded(value.id, MAX_PREVIEW_LENGTH),
    name: bounded(value.name, MAX_PREVIEW_LENGTH),
    input: safeScalarFields(value.arguments),
  };
}

function contentText(
  content: ReadonlyArray<typeof textContent.Type | typeof imageContent.Type>,
): string {
  return bounded(
    content
      .filter((part): part is typeof textContent.Type => part.type === "text")
      .map((part) => part.text)
      .join(""),
  );
}

const PRIVATE_AGENT_RUNTIME_RESULT_MARKERS = [
  "RLMSpawnHandle(",
  "rlm_child_id",
  "session_dir",
  "active_session_id",
  "activeSessionId",
  "sessionDir",
  "rlmChildId",
  "goal_id",
  "goalId",
] as const;

function safeToolResultText(text: string): string {
  return PRIVATE_AGENT_RUNTIME_RESULT_MARKERS.some((marker) => text.includes(marker))
    ? "Native agent operation completed."
    : text;
}

type PrimeDaemonAssistantMessage = Extract<PrimeDaemonMessage, { readonly role: "assistant" }>;
type PrimeDaemonToolResultMessage = Extract<PrimeDaemonMessage, { readonly role: "toolResult" }>;

function mapMessage(
  value: typeof PrimeAgentDaemonAssistantMessage.Type,
): PrimeDaemonAssistantMessage;
function mapMessage(
  value: typeof PrimeAgentDaemonToolResultMessage.Type,
): PrimeDaemonToolResultMessage;
function mapMessage(value: PrimeAgentDaemonMessage): PrimeDaemonMessage;
function mapMessage(value: PrimeAgentDaemonMessage): PrimeDaemonMessage {
  switch (value.role) {
    case "user": {
      if (Predicate.isString(value.content)) {
        return {
          role: "user",
          timestamp: value.timestamp,
          text: bounded(value.content),
          imageMimeTypes: [],
        };
      }
      return {
        role: "user",
        timestamp: value.timestamp,
        text: contentText(value.content),
        imageMimeTypes: value.content
          .filter((part): part is typeof imageContent.Type => part.type === "image")
          .slice(0, MAX_LIST_ITEMS)
          .map((part) => bounded(part.mimeType, MAX_PREVIEW_LENGTH)),
      };
    }
    case "assistant":
      return {
        role: "assistant",
        timestamp: value.timestamp,
        provider: bounded(value.provider, MAX_PREVIEW_LENGTH),
        model: bounded(value.responseModel ?? value.model, MAX_PREVIEW_LENGTH),
        responseId: optionalBounded(value.responseId, MAX_PREVIEW_LENGTH),
        text: bounded(
          value.content
            .filter((part): part is typeof textContent.Type => part.type === "text")
            .map((part) => part.text)
            .join(""),
        ),
        thinking: bounded(
          value.content
            .filter((part): part is typeof thinkingContent.Type => part.type === "thinking")
            .map((part) => part.thinking)
            .join(""),
        ),
        toolCalls: value.content
          .filter((part): part is typeof toolCallContent.Type => part.type === "toolCall")
          .slice(0, MAX_LIST_ITEMS)
          .map(mapToolCall),
        usage: mapUsage(value.usage),
        stopReason: value.stopReason,
        errorMessage: optionalBounded(value.errorMessage),
      };
    case "toolResult":
      return {
        role: "toolResult",
        timestamp: value.timestamp,
        toolCallId: bounded(value.toolCallId, MAX_PREVIEW_LENGTH),
        toolName: bounded(value.toolName, MAX_PREVIEW_LENGTH),
        text: safeToolResultText(contentText(value.content)),
        imageMimeTypes: value.content
          .filter((part): part is typeof imageContent.Type => part.type === "image")
          .slice(0, MAX_LIST_ITEMS)
          .map((part) => bounded(part.mimeType, MAX_PREVIEW_LENGTH)),
        isError: value.isError,
      };
  }
}

function mapUnknownMessages(values: ReadonlyArray<unknown>): ReadonlyArray<PrimeDaemonMessage> {
  return values.flatMap((value) => {
    const decoded = decodeMessage(value);
    return Option.isSome(decoded) ? [mapMessage(decoded.value)] : [];
  });
}

function mapToolText(value: typeof toolResult.Type): string {
  return safeToolResultText(contentText(value.content));
}

function mapChild(
  value: typeof rlmChild.Type,
): Extract<PrimeDaemonEvent, { readonly _tag: "ChildUpdated" }>["child"] {
  return {
    id: bounded(value.id, MAX_PREVIEW_LENGTH),
    parentId: optionalBounded(value.parentId, MAX_PREVIEW_LENGTH),
    activeSessionId: optionalBounded(value.activeSessionId, MAX_PREVIEW_LENGTH),
    sessionName: optionalBounded(value.sessionName, MAX_PREVIEW_LENGTH),
    model: optionalBounded(value.model, MAX_PREVIEW_LENGTH),
    label: bounded(value.label, MAX_PREVIEW_LENGTH),
    status: value.status,
    durationMs: value.durationMs,
    answerPreview: optionalBounded(value.answerPreview, MAX_PREVIEW_LENGTH),
    toolUseCount: value.toolUseCount,
    tokenCount: value.tokenCount,
    recap: optionalBounded(value.recap, MAX_PREVIEW_LENGTH),
    activity: value.activity,
    error: optionalBounded(value.error, MAX_PREVIEW_LENGTH),
  };
}

function mapQueueMode(
  mode: typeof queueMode.Type | undefined,
): SessionInputQueueDeliveryMode | undefined {
  return mode === undefined ? undefined : mode === "all" ? "all-at-once" : "one-at-a-time";
}

export function decodePrimeAgentDaemonSessionState(
  value: unknown,
): PrimeDaemonSessionState | undefined {
  const decoded = Schema.decodeUnknownOption(sessionState)(value);
  return Option.isSome(decoded) ? mapState(decoded.value) : undefined;
}

function mapState(value: typeof sessionState.Type): PrimeDaemonSessionState {
  return {
    activeSessionId: optionalBounded(value.activeSessionId, MAX_PREVIEW_LENGTH),
    sessionId: bounded(value.sessionId, MAX_PREVIEW_LENGTH),
    sessionName: optionalBounded(value.sessionName, MAX_PREVIEW_LENGTH),
    cwd: bounded(value.cwd, MAX_PREVIEW_LENGTH),
    isStreaming: value.isStreaming,
    isCompacting: value.isCompacting,
    isBashRunning: value.isBashRunning,
    retryAttempt: value.retryAttempt,
    thinkingLevel: value.thinkingLevel,
    serviceTier: value.serviceTier,
    messageCount: value.messageCount,
    autoCompactionEnabled: value.autoCompactionEnabled,
    inputQueue: {
      steeringCount: value.sessionActions.steering.length,
      followUpCount: value.sessionActions.followUps.length,
      activeAction: value.sessionActions.active !== undefined,
      steeringMode: mapQueueMode(value.steeringMode),
      followUpMode: mapQueueMode(value.followUpMode),
    },
    contextUsage: value.contextUsage,
    goal: safeGoalState(value.goal) ?? unavailableGoalState,
    recap: optionalBounded(value.recap, MAX_PREVIEW_LENGTH),
  };
}

function mapAssistantStream(
  event: typeof assistantStreamEvent.Type,
): Extract<PrimeDaemonEvent, { readonly _tag: "AssistantStream" }> {
  switch (event.type) {
    case "start":
      return {
        _tag: "AssistantStream",
        phase: "start",
        kind: "message",
        message: event.partial === undefined ? undefined : mapMessage(event.partial),
      };
    case "text_start":
      return {
        _tag: "AssistantStream",
        phase: "start",
        kind: "text",
        contentIndex: event.contentIndex,
      };
    case "text_delta":
      return {
        _tag: "AssistantStream",
        phase: "delta",
        kind: "text",
        contentIndex: event.contentIndex,
        delta: bounded(event.delta),
      };
    case "text_end":
      return {
        _tag: "AssistantStream",
        phase: "end",
        kind: "text",
        contentIndex: event.contentIndex,
        content: bounded(event.content),
      };
    case "thinking_start":
      return {
        _tag: "AssistantStream",
        phase: "start",
        kind: "thinking",
        contentIndex: event.contentIndex,
      };
    case "thinking_delta":
      return {
        _tag: "AssistantStream",
        phase: "delta",
        kind: "thinking",
        contentIndex: event.contentIndex,
        delta: bounded(event.delta),
      };
    case "thinking_end":
      return {
        _tag: "AssistantStream",
        phase: "end",
        kind: "thinking",
        contentIndex: event.contentIndex,
        content: bounded(event.content),
      };
    case "toolcall_start":
      return {
        _tag: "AssistantStream",
        phase: "start",
        kind: "toolCall",
        contentIndex: event.contentIndex,
      };
    case "toolcall_delta":
      return {
        _tag: "AssistantStream",
        phase: "delta",
        kind: "toolCall",
        contentIndex: event.contentIndex,
        delta: bounded(event.delta),
      };
    case "toolcall_end":
      return {
        _tag: "AssistantStream",
        phase: "end",
        kind: "toolCall",
        contentIndex: event.contentIndex,
        toolCall: mapToolCall(event.toolCall),
      };
    case "done":
      return {
        _tag: "AssistantStream",
        phase: "done",
        kind: "message",
        message: mapMessage(event.message),
      };
    case "error":
      return {
        _tag: "AssistantStream",
        phase: "error",
        kind: "message",
        message: mapMessage(event.error),
      };
  }
}

function mapSessionEvent(event: typeof agentSessionEvent.Type): PrimeDaemonEvent {
  switch (event.type) {
    case "agent_start":
      return { _tag: "RunStarted" };
    case "agent_end":
      return { _tag: "RunCompleted", messages: mapUnknownMessages(event.messages) };
    case "turn_start":
      return { _tag: "TurnStarted" };
    case "turn_end":
      return {
        _tag: "TurnCompleted",
        message: mapMessage(event.message),
        toolResults: event.toolResults.map((message) => mapMessage(message)),
      };
    case "message_start":
      return { _tag: "MessageStarted", message: mapMessage(event.message) };
    case "message_update":
      return mapAssistantStream(event.assistantMessageEvent);
    case "message_end":
      return { _tag: "MessageCompleted", message: mapMessage(event.message) };
    case "tool_execution_start":
      return {
        _tag: "ToolStarted",
        toolCallId: bounded(event.toolCallId, MAX_PREVIEW_LENGTH),
        toolName: bounded(event.toolName, MAX_PREVIEW_LENGTH),
        input: safeScalarFields(event.args),
      };
    case "tool_execution_update":
      return {
        _tag: "ToolProgress",
        toolCallId: bounded(event.toolCallId, MAX_PREVIEW_LENGTH),
        toolName: bounded(event.toolName, MAX_PREVIEW_LENGTH),
        text: mapToolText(event.partialResult),
      };
    case "tool_execution_end":
      return {
        _tag: "ToolCompleted",
        toolCallId: bounded(event.toolCallId, MAX_PREVIEW_LENGTH),
        toolName: bounded(event.toolName, MAX_PREVIEW_LENGTH),
        text: mapToolText(event.result),
        isError: event.isError,
      };
    case "ipython_sent_agent_message":
      return {
        _tag: "AgentMessageSent",
        toolCallId: bounded(event.toolCallId, MAX_PREVIEW_LENGTH),
        receipt: safeScalarFields(event.message),
      };
    case "session_info_changed":
      return {
        _tag: "SessionInfoChanged",
        name: optionalBounded(event.name, MAX_PREVIEW_LENGTH),
      };
    case "session_action_update":
      return {
        _tag: "QueueChanged",
        queuedCount: event.actions.steering.length + event.actions.followUps.length,
        steeringCount: event.actions.steering.length,
        followUpCount: event.actions.followUps.length,
        active:
          event.actions.active === undefined
            ? undefined
            : { kind: event.actions.active.kind, phase: event.actions.active.phase },
      };
    case "thinking_level_changed":
      return { _tag: "ThinkingLevelChanged", level: event.level };
    case "service_tier_changed":
      return { _tag: "ServiceTierChanged", serviceTier: event.serviceTier };
    case "compaction_start":
      return { _tag: "CompactionStarted" };
    case "compaction_end":
      return {
        _tag: "CompactionCompleted",
        outcome: event.aborted
          ? "aborted"
          : event.errorSeverity === "warning"
            ? "skipped"
            : event.errorMessage !== undefined || event.errorSeverity === "error"
              ? "failed"
              : "completed",
        willRetry: event.willRetry,
      };
    case "auto_retry_start":
      return {
        _tag: "RetryStarted",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
      };
    case "auto_retry_end":
      return {
        _tag: "RetryCompleted",
        success: event.success,
        attempt: event.attempt,
      };
    case "auth_stale":
      return {
        _tag: "AuthStale",
        provider: bounded(event.provider, MAX_PREVIEW_LENGTH),
        sourceCount: event.sourceTokens?.length ?? 0,
      };
    case "rlm_child_update":
      return { _tag: "ChildUpdated", child: mapChild(event.child) };
    case "recap_update":
      return { _tag: "RecapUpdated", recap: optionalBounded(event.recap, MAX_PREVIEW_LENGTH) };
    case "goal_update": {
      const goal = safeGoalState(event.goal);
      return {
        _tag: "GoalUpdated",
        goal: goal ?? unavailableGoalState,
      };
    }
    case "bash_start":
      return {
        _tag: "BashStarted",
        command: bounded(event.command),
        excludeFromContext: event.excludeFromContext,
        transient: event.transient ?? false,
        runId: optionalBounded(event.runId, MAX_PREVIEW_LENGTH),
      };
    case "bash_output":
      return { _tag: "BashOutput", chunk: bounded(event.chunk) };
    case "bash_end":
      return {
        _tag: "BashCompleted",
        exitCode: event.exitCode,
        cancelled: event.cancelled,
        truncated: event.truncated,
        errorMessage: optionalBounded(event.errorMessage),
        transient: event.transient ?? false,
        runId: optionalBounded(event.runId, MAX_PREVIEW_LENGTH),
      };
    case "refine_complete":
      return {
        _tag: "RefinementCompleted",
        appliedCount: event.result.appliedEdits.filter((item) => item.applied).length,
        failedCount: event.result.appliedEdits.filter((item) => !item.applied).length,
      };
    case "refine_failed":
      return { _tag: "RefinementFailed" };
  }
}

export function mapPrimeAgentDaemonConnectionEvent(
  event: PrimeAgentDaemonConnectionEvent,
): PrimeDaemonEvent {
  switch (event.type) {
    case "session_event":
      return mapSessionEvent(event.event);
    case "side_question_event":
      return {
        _tag: "SideQuestionUpdated",
        id: bounded(event.event.id, MAX_PREVIEW_LENGTH),
        question: bounded(event.event.question, MAX_PREVIEW_LENGTH),
        answer: bounded(event.event.answer),
        status: event.event.status,
        errorMessage: optionalBounded(event.event.errorMessage),
      };
    case "session_replaced":
      return {
        _tag: "SessionReplaced",
        state: mapState(event.state),
        messages: mapUnknownMessages(event.messages),
      };
    case "session_resynced": {
      const streamingMessage =
        event.snapshot.streamingMessage === undefined
          ? undefined
          : decodeMessage(event.snapshot.streamingMessage);
      return {
        _tag: "SessionResynced",
        state: mapState(event.snapshot.state),
        messages: mapUnknownMessages(event.snapshot.messages),
        streamingMessage:
          streamingMessage && Option.isSome(streamingMessage)
            ? mapMessage(streamingMessage.value)
            : undefined,
        children: (event.snapshot.children ?? []).slice(0, MAX_LIST_ITEMS).map(mapChild),
        lastEventSequence: event.snapshot.lastEventSequence,
      };
    }
    case "session_status":
      return { _tag: "SessionStatus", recap: optionalBounded(event.recap, MAX_PREVIEW_LENGTH) };
    case "extension_ui_request":
      return {
        _tag: "ExtensionRequest",
        request: {
          id: bounded(event.request.id, MAX_PREVIEW_LENGTH),
          method: bounded(event.request.method, MAX_PREVIEW_LENGTH),
          title: optionalBounded(event.request.payload.title, MAX_PREVIEW_LENGTH),
          message: optionalBounded(event.request.payload.message, MAX_PREVIEW_LENGTH),
          options: event.request.payload.options
            ?.slice(0, MAX_LIST_ITEMS)
            .map((item) => bounded(item, MAX_PREVIEW_LENGTH)),
          timeoutMs: event.request.payload.timeout,
          placeholder: optionalBounded(event.request.payload.placeholder, MAX_PREVIEW_LENGTH),
          prefill: optionalBounded(event.request.payload.prefill),
          notifyType: event.request.payload.notifyType,
          statusKey: optionalBounded(event.request.payload.statusKey, MAX_PREVIEW_LENGTH),
          statusText: optionalBounded(event.request.payload.statusText, MAX_PREVIEW_LENGTH),
          widgetKey: optionalBounded(event.request.payload.widgetKey, MAX_PREVIEW_LENGTH),
          widgetLines: event.request.payload.widgetLines
            ?.slice(0, MAX_LIST_ITEMS)
            .map((item) => bounded(item, MAX_PREVIEW_LENGTH)),
          widgetPlacement: event.request.payload.widgetPlacement,
          text: optionalBounded(event.request.payload.text),
        },
      };
    case "extension_error":
      return {
        _tag: "ExtensionError",
        extensionPath: bounded(event.extensionPath, MAX_PREVIEW_LENGTH),
        event: bounded(event.event, MAX_PREVIEW_LENGTH),
        error: bounded(event.error),
      };
    case "connection_status":
      return {
        _tag: "ConnectionStatus",
        status: event.status,
        error: optionalBounded(event.error),
      };
    case "heartbeats_changed":
      return { _tag: "HeartbeatsChanged" };
    case "closed":
      return { _tag: "SessionClosed", error: optionalBounded(event.error) };
  }
}

function sourceType(input: unknown): { readonly sourceType?: string; readonly known: boolean } {
  const outer = decodeEventType(input);
  if (Option.isNone(outer)) return { known: false };
  if (outer.value.type !== "session_event") {
    return { sourceType: outer.value.type, known: knownConnectionEventTypes.has(outer.value.type) };
  }
  if (!Predicate.isObject(input) || !("event" in input)) {
    return { sourceType: "session_event", known: true };
  }
  const inner = decodeEventType(input.event);
  if (Option.isNone(inner)) return { sourceType: "session_event", known: true };
  return {
    sourceType: `session_event/${inner.value.type}`,
    known: knownSessionEventTypes.has(inner.value.type),
  };
}

/**
 * Decodes the untrusted daemon callback value and immediately projects it into a
 * bounded, provider-internal vocabulary. New or malformed events are inert data,
 * never exceptions and never an implicit success path.
 */
export function decodePrimeAgentDaemonEvent(input: unknown): PrimeDaemonEvent {
  const decoded = decodeConnectionEvent(input);
  if (Option.isSome(decoded)) return mapPrimeAgentDaemonConnectionEvent(decoded.value);

  const source = sourceType(input);
  return {
    _tag: "Ignored",
    reason: source.known ? "malformed-event" : "unknown-event",
    sourceType: source.sourceType,
  };
}
