import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProviderItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";
import { SessionInputQueueDeliveryMode } from "./providerRuntime.ts";
import { SessionInteractionRequestId, SessionInteractionResponse } from "./sessionInteraction.ts";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  /** True when the provider attached this runtime from a durable continuation. */
  restored: Schema.optional(Schema.Boolean),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderReloadSessionResourcesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderReloadSessionResourcesInput = typeof ProviderReloadSessionResourcesInput.Type;

export class ProviderSessionResourcesReloadError extends Schema.TaggedErrorClass<ProviderSessionResourcesReloadError>()(
  "ProviderSessionResourcesReloadError",
  {
    reason: Schema.Literals(["session-not-ready", "unsupported", "busy", "reload-failed"]),
  },
) {}

export const PROVIDER_SESSION_SIDE_QUESTION_REQUEST_ID_MAX_CHARS = 128;
export const PROVIDER_SESSION_SIDE_QUESTION_MAX_CHARS = 4_096;
export const PROVIDER_SESSION_SIDE_QUESTION_MAX_BYTES = 16_384;
export const PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_CHARS = 8_192;
export const PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_BYTES = 8_192;

/** Public Pylon identity for one ephemeral side-question request. */
export const ProviderSessionSideQuestionRequestId = RuntimeRequestId.check(
  Schema.isMaxLength(PROVIDER_SESSION_SIDE_QUESTION_REQUEST_ID_MAX_CHARS),
);
export type ProviderSessionSideQuestionRequestId = typeof ProviderSessionSideQuestionRequestId.Type;

const ProviderSessionSideQuestionText = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) => {
    if (value.includes("\0")) return "A side question must not contain NUL characters.";
    if ([...value].length > PROVIDER_SESSION_SIDE_QUESTION_MAX_CHARS) {
      return `A side question must be at most ${PROVIDER_SESSION_SIDE_QUESTION_MAX_CHARS} Unicode code points.`;
    }
    if (new TextEncoder().encode(value).byteLength > PROVIDER_SESSION_SIDE_QUESTION_MAX_BYTES) {
      return `A side question must be at most ${PROVIDER_SESSION_SIDE_QUESTION_MAX_BYTES} UTF-8 bytes.`;
    }
    return true;
  }),
);

const ProviderSessionSideQuestionAnswer = Schema.String.check(
  Schema.makeFilter((value) => {
    if (value.includes("\0")) return "A side-question answer must not contain NUL characters.";
    if ([...value].length > PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_CHARS) {
      return `A side-question answer must be at most ${PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_CHARS} Unicode code points.`;
    }
    if (
      new TextEncoder().encode(value).byteLength > PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_BYTES
    ) {
      return `A side-question answer must be at most ${PROVIDER_SESSION_SIDE_QUESTION_ANSWER_MAX_BYTES} UTF-8 bytes.`;
    }
    return true;
  }),
);

export const ProviderAskSessionSideQuestionInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ProviderSessionSideQuestionRequestId,
  question: ProviderSessionSideQuestionText,
});
export type ProviderAskSessionSideQuestionInput = typeof ProviderAskSessionSideQuestionInput.Type;

export const ProviderCancelSessionSideQuestionInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ProviderSessionSideQuestionRequestId,
});
export type ProviderCancelSessionSideQuestionInput =
  typeof ProviderCancelSessionSideQuestionInput.Type;

const ProviderSessionSideQuestionAnsweredResult = Schema.Struct({
  requestId: ProviderSessionSideQuestionRequestId,
  disposition: Schema.Literal("answered"),
  answer: ProviderSessionSideQuestionAnswer,
});

const ProviderSessionSideQuestionUnansweredResult = Schema.Struct({
  requestId: ProviderSessionSideQuestionRequestId,
  disposition: Schema.Literals(["cancelled", "timed-out", "response-too-large", "outcome-unknown"]),
});

export const ProviderAskSessionSideQuestionResult = Schema.Union([
  ProviderSessionSideQuestionAnsweredResult,
  ProviderSessionSideQuestionUnansweredResult,
]);
export type ProviderAskSessionSideQuestionResult = typeof ProviderAskSessionSideQuestionResult.Type;

export const ProviderCancelSessionSideQuestionResult = Schema.Struct({
  requestId: ProviderSessionSideQuestionRequestId,
  disposition: Schema.Literals(["cancel-requested", "already-settled"]),
});
export type ProviderCancelSessionSideQuestionResult =
  typeof ProviderCancelSessionSideQuestionResult.Type;

const ProviderSessionSideQuestionErrorReason = Schema.Literals([
  "session-not-ready",
  "unsupported",
  "busy",
  "request-failed",
]);

export class ProviderAskSessionSideQuestionError extends Schema.TaggedErrorClass<ProviderAskSessionSideQuestionError>()(
  "ProviderAskSessionSideQuestionError",
  { reason: ProviderSessionSideQuestionErrorReason },
) {}

export class ProviderCancelSessionSideQuestionError extends Schema.TaggedErrorClass<ProviderCancelSessionSideQuestionError>()(
  "ProviderCancelSessionSideQuestionError",
  { reason: ProviderSessionSideQuestionErrorReason },
) {}

export const PROVIDER_AGENT_CONTROL_ID_MAX_CHARS = 512;

export const ProviderCancelSessionAgentInput = Schema.Struct({
  threadId: ThreadId,
  agentId: RuntimeTaskId.check(Schema.isMaxLength(PROVIDER_AGENT_CONTROL_ID_MAX_CHARS)),
});
export type ProviderCancelSessionAgentInput = typeof ProviderCancelSessionAgentInput.Type;

export const ProviderCancelSessionAgentResult = Schema.Struct({
  agentId: RuntimeTaskId.check(Schema.isMaxLength(PROVIDER_AGENT_CONTROL_ID_MAX_CHARS)),
  disposition: Schema.Literals(["cancel-requested", "already-settled"]),
});
export type ProviderCancelSessionAgentResult = typeof ProviderCancelSessionAgentResult.Type;

export const PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS = 16_384;

export const ProviderMessageSessionAgentInput = Schema.Struct({
  threadId: ThreadId,
  agentId: RuntimeTaskId.check(Schema.isMaxLength(PROVIDER_AGENT_CONTROL_ID_MAX_CHARS)),
  message: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS),
  ),
});
export type ProviderMessageSessionAgentInput = typeof ProviderMessageSessionAgentInput.Type;

export const ProviderMessageSessionAgentResult = Schema.Struct({
  agentId: RuntimeTaskId.check(Schema.isMaxLength(PROVIDER_AGENT_CONTROL_ID_MAX_CHARS)),
  disposition: Schema.Literals(["delivered", "queued"]),
});
export type ProviderMessageSessionAgentResult = typeof ProviderMessageSessionAgentResult.Type;

export class ProviderMessageSessionAgentError extends Schema.TaggedErrorClass<ProviderMessageSessionAgentError>()(
  "ProviderMessageSessionAgentError",
  {
    reason: Schema.Literals([
      "session-not-ready",
      "unsupported",
      "agent-not-active",
      "agent-not-messageable",
      "invalid-message",
      "delivery-unknown",
      "request-failed",
    ]),
  },
) {}

export class ProviderCancelSessionAgentError extends Schema.TaggedErrorClass<ProviderCancelSessionAgentError>()(
  "ProviderCancelSessionAgentError",
  {
    reason: Schema.Literals([
      "session-not-ready",
      "unsupported",
      "agent-not-active",
      "request-failed",
    ]),
  },
) {}

/**
 * Hard privacy and resource bounds for ephemeral session-agent live activity.
 * Character limits count Unicode code points; byte limits count UTF-8 bytes.
 */
export const PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS = 4_096;
export const PROVIDER_SESSION_AGENT_ACTIVITY_MAX_ENTRIES = 32;
export const PROVIDER_SESSION_AGENT_ACTIVITY_SNAPSHOT_MAX_CHARS = 16_384;
export const PROVIDER_SESSION_AGENT_ACTIVITY_SNAPSHOT_MAX_BYTES = 65_536;
export const PROVIDER_SESSION_AGENT_ACTIVITY_LIFETIME_MAX_UPDATES = 512;
export const PROVIDER_SESSION_AGENT_ACTIVITY_LIFETIME_MAX_CHARS = 1_048_576;
export const PROVIDER_SESSION_AGENT_ACTIVITY_MAX_CONCURRENT_WATCHERS = 4;

const ProviderSessionAgentActivityText = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      [...value].length <= PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS ||
      `Live activity text must be at most ${PROVIDER_SESSION_AGENT_ACTIVITY_ENTRY_MAX_CHARS} Unicode characters.`,
  ),
);

export const ProviderWatchSessionAgentActivityInput = Schema.Struct({
  threadId: ThreadId,
  agentId: RuntimeTaskId.check(Schema.isMaxLength(PROVIDER_AGENT_CONTROL_ID_MAX_CHARS)),
});
export type ProviderWatchSessionAgentActivityInput =
  typeof ProviderWatchSessionAgentActivityInput.Type;

/** Public tool labels are deliberately short and contain no native tool metadata. */
export const PROVIDER_SESSION_AGENT_ACTIVITY_TOOL_LABEL_MAX_CHARS = 64;

/** Backward-compatible assistant-only projection for older clients. */
export const ProviderSessionAgentActivityEntry = Schema.Struct({
  speaker: Schema.Literal("assistant"),
  text: ProviderSessionAgentActivityText,
});
export type ProviderSessionAgentActivityEntry = typeof ProviderSessionAgentActivityEntry.Type;

export const ProviderSessionAgentActivityToolEntry = Schema.Struct({
  kind: Schema.Literal("tool"),
  activityId: PositiveInt,
  label: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SESSION_AGENT_ACTIVITY_TOOL_LABEL_MAX_CHARS),
  ),
  status: Schema.Literals(["started", "completed", "failed"]),
});
export type ProviderSessionAgentActivityToolEntry =
  typeof ProviderSessionAgentActivityToolEntry.Type;

/**
 * Additive provider-neutral activity consumed by timeline-aware clients. Native
 * tool ids, inputs, outputs, errors, timing, and metadata have no field here.
 */
export const ProviderSessionAgentActivityTimelineEntry = Schema.Union([
  ProviderSessionAgentActivityEntry,
  ProviderSessionAgentActivityToolEntry,
]);
export type ProviderSessionAgentActivityTimelineEntry =
  typeof ProviderSessionAgentActivityTimelineEntry.Type;

const providerSessionAgentActivitySnapshotBounds = Schema.makeFilter(
  (snapshot: {
    readonly entries: ReadonlyArray<{ readonly speaker: "assistant"; readonly text: string }>;
    readonly activity?:
      | ReadonlyArray<
          | { readonly speaker: "assistant"; readonly text: string }
          | {
              readonly kind: "tool";
              readonly activityId: number;
              readonly label: string;
            }
        >
      | undefined;
  }) => {
    const timeline = snapshot.activity ?? snapshot.entries;
    const text = timeline.map((entry) => ("text" in entry ? entry.text : entry.label)).join("");
    if ([...text].length > PROVIDER_SESSION_AGENT_ACTIVITY_SNAPSHOT_MAX_CHARS) {
      return `Live activity snapshot text must be at most ${PROVIDER_SESSION_AGENT_ACTIVITY_SNAPSHOT_MAX_CHARS} Unicode characters.`;
    }
    if (snapshot.activity !== undefined) {
      const assistantEntries = snapshot.activity.filter(
        (entry): entry is { readonly speaker: "assistant"; readonly text: string } =>
          "speaker" in entry,
      );
      if (
        assistantEntries.length !== snapshot.entries.length ||
        assistantEntries.some((entry, index) => entry.text !== snapshot.entries[index]?.text)
      ) {
        return "Live activity assistant entries must match the backward-compatible projection.";
      }
      const activityIds = snapshot.activity.flatMap((entry) =>
        "kind" in entry ? [entry.activityId] : [],
      );
      if (new Set(activityIds).size !== activityIds.length) {
        return "Live activity tool ids must be unique within a replacement snapshot.";
      }
    }
    if (
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
      PROVIDER_SESSION_AGENT_ACTIVITY_SNAPSHOT_MAX_BYTES
    ) {
      return `Encoded live activity snapshot must be at most ${PROVIDER_SESSION_AGENT_ACTIVITY_SNAPSHOT_MAX_BYTES} UTF-8 bytes.`;
    }
    return true;
  },
);

/** A complete replacement snapshot. Revisions and activity ids are subscription-local. */
export const ProviderSessionAgentActivitySnapshot = Schema.Struct({
  agentId: RuntimeTaskId.check(Schema.isMaxLength(PROVIDER_AGENT_CONTROL_ID_MAX_CHARS)),
  revision: PositiveInt,
  entries: Schema.Array(ProviderSessionAgentActivityEntry).check(
    Schema.isMaxLength(PROVIDER_SESSION_AGENT_ACTIVITY_MAX_ENTRIES),
  ),
  activity: Schema.optional(
    Schema.Array(ProviderSessionAgentActivityTimelineEntry).check(
      Schema.isMaxLength(PROVIDER_SESSION_AGENT_ACTIVITY_MAX_ENTRIES),
    ),
  ),
}).check(providerSessionAgentActivitySnapshotBounds);
export type ProviderSessionAgentActivitySnapshot = typeof ProviderSessionAgentActivitySnapshot.Type;

export class ProviderWatchSessionAgentActivityError extends Schema.TaggedErrorClass<ProviderWatchSessionAgentActivityError>()(
  "ProviderWatchSessionAgentActivityError",
  {
    reason: Schema.Literals([
      "session-not-ready",
      "unsupported",
      "agent-not-active",
      "limit-reached",
      "request-failed",
    ]),
  },
) {}

export const ProviderGetSessionAgentDepthInput = Schema.Struct({ threadId: ThreadId });
export type ProviderGetSessionAgentDepthInput = typeof ProviderGetSessionAgentDepthInput.Type;

export const ProviderSetSessionAgentDepthInput = Schema.Struct({
  threadId: ThreadId,
  maxDepth: Schema.Number,
});
export type ProviderSetSessionAgentDepthInput = typeof ProviderSetSessionAgentDepthInput.Type;

export class ProviderSessionAgentDepthError extends Schema.TaggedErrorClass<ProviderSessionAgentDepthError>()(
  "ProviderSessionAgentDepthError",
  {
    reason: Schema.Literals([
      "session-not-ready",
      "unsupported",
      "policy-forbidden",
      "busy",
      "invalid-depth",
      "request-failed",
    ]),
  },
) {}

export const ProviderFollowUpInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
});
export type ProviderFollowUpInput = typeof ProviderFollowUpInput.Type;

export const ProviderGetSessionInputQueueInput = Schema.Struct({ threadId: ThreadId });
export type ProviderGetSessionInputQueueInput = typeof ProviderGetSessionInputQueueInput.Type;

export const ProviderClearSessionInputQueueInput = Schema.Struct({ threadId: ThreadId });
export type ProviderClearSessionInputQueueInput = typeof ProviderClearSessionInputQueueInput.Type;

/** Remove the current item only when the selected privacy-safe queue lane contains exactly one. */
export const ProviderRemoveOnlySessionInputQueueItemInput = Schema.Struct({
  threadId: ThreadId,
  queue: Schema.Literals(["steering", "follow-up"]),
});
export type ProviderRemoveOnlySessionInputQueueItemInput =
  typeof ProviderRemoveOnlySessionInputQueueItemInput.Type;

export const ProviderSetSessionInputQueueModeInput = Schema.Struct({
  threadId: ThreadId,
  queue: Schema.Literals(["steering", "follow-up"]),
  mode: SessionInputQueueDeliveryMode,
});
export type ProviderSetSessionInputQueueModeInput =
  typeof ProviderSetSessionInputQueueModeInput.Type;

export class ProviderSessionInputQueueError extends Schema.TaggedErrorClass<ProviderSessionInputQueueError>()(
  "ProviderSessionInputQueueError",
  {
    reason: Schema.Literals([
      "session-not-ready",
      "unsupported",
      "not-running",
      "invalid-input",
      "request-failed",
    ]),
  },
) {}

export const ProviderGetSessionCompactionInput = Schema.Struct({ threadId: ThreadId });
export type ProviderGetSessionCompactionInput = typeof ProviderGetSessionCompactionInput.Type;

export const ProviderCompactSessionInput = Schema.Struct({ threadId: ThreadId });
export type ProviderCompactSessionInput = typeof ProviderCompactSessionInput.Type;

export const ProviderAbortSessionCompactionInput = Schema.Struct({ threadId: ThreadId });
export type ProviderAbortSessionCompactionInput = typeof ProviderAbortSessionCompactionInput.Type;

export const ProviderSetSessionAutoCompactionInput = Schema.Struct({
  threadId: ThreadId,
  enabled: Schema.Boolean,
});
export type ProviderSetSessionAutoCompactionInput =
  typeof ProviderSetSessionAutoCompactionInput.Type;

export class ProviderSessionCompactionError extends Schema.TaggedErrorClass<ProviderSessionCompactionError>()(
  "ProviderSessionCompactionError",
  {
    reason: Schema.Literals(["session-not-ready", "unsupported", "busy", "request-failed"]),
  },
) {}

export const ProviderRefineSessionHarnessInput = Schema.Struct({ threadId: ThreadId });
export type ProviderRefineSessionHarnessInput = typeof ProviderRefineSessionHarnessInput.Type;

export const ProviderRefineSessionHarnessResult = Schema.Struct({
  appliedCount: NonNegativeInt,
  failedCount: NonNegativeInt,
  outcome: Schema.Literals(["completed", "partial", "failed"]),
});
export type ProviderRefineSessionHarnessResult = typeof ProviderRefineSessionHarnessResult.Type;

export class ProviderRefineSessionHarnessError extends Schema.TaggedErrorClass<ProviderRefineSessionHarnessError>()(
  "ProviderRefineSessionHarnessError",
  {
    reason: Schema.Literals(["session-not-ready", "unsupported", "busy", "request-failed"]),
  },
) {}

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

export const ProviderRespondToInteractionInput = Schema.Struct({
  threadId: ThreadId,
  requestId: SessionInteractionRequestId,
  response: SessionInteractionResponse,
});
export type ProviderRespondToInteractionInput = typeof ProviderRespondToInteractionInput.Type;

export class ProviderRespondToInteractionError extends Schema.TaggedErrorClass<ProviderRespondToInteractionError>()(
  "ProviderRespondToInteractionError",
  {
    reason: Schema.Literals(["session-not-ready", "unsupported", "stale", "request-failed"]),
  },
) {}

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
