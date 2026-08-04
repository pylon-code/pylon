import * as Schema from "effect/Schema";

import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const FOLLOW_UP_KINDS = ["blocker", "open", "idea"] as const;
export const FOLLOW_UP_STATUSES = ["open", "resolved", "waived", "moot"] as const;
export const FOLLOW_UP_DEFER_REASONS = [
  "out-of-scope",
  "needs-decision",
  "blocked-externally",
  "idea",
] as const;

export const FollowUpKind = Schema.Literals(FOLLOW_UP_KINDS);
export type FollowUpKind = typeof FollowUpKind.Type;

export const FollowUpStatus = Schema.Literals(FOLLOW_UP_STATUSES);
export type FollowUpStatus = typeof FollowUpStatus.Type;

export const FollowUpDeferReason = Schema.Literals(FOLLOW_UP_DEFER_REASONS);
export type FollowUpDeferReason = typeof FollowUpDeferReason.Type;

export const FollowUpId = TrimmedNonEmptyString.pipe(Schema.brand("FollowUpId"));
export type FollowUpId = typeof FollowUpId.Type;

export const FollowUpTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const FollowUpObservation = TrimmedNonEmptyString.check(Schema.isMaxLength(8_000));
export const FollowUpVerifyCheck = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));

export const FollowUpEvidence = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  line: Schema.NullOr(NonNegativeInt),
  commitSha: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type FollowUpEvidence = typeof FollowUpEvidence.Type;

export const FollowUpGate = Schema.Struct({
  kind: Schema.Literal("branch"),
  ref: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
});
export type FollowUpGate = typeof FollowUpGate.Type;

export const FollowUpResolution = Schema.Struct({
  note: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  threadId: Schema.NullOr(ThreadId),
  commitSha: Schema.NullOr(TrimmedString.check(Schema.isMaxLength(64))),
});
export type FollowUpResolution = typeof FollowUpResolution.Type;

export const FollowUpSourceKind = Schema.Literals(["human", "agent"]);
export type FollowUpSourceKind = typeof FollowUpSourceKind.Type;

export const FollowUp = Schema.Struct({
  id: FollowUpId,
  projectId: ProjectId,
  kind: FollowUpKind,
  status: FollowUpStatus,
  title: FollowUpTitle,
  observation: FollowUpObservation,
  deferReason: FollowUpDeferReason,
  verifyCheck: FollowUpVerifyCheck,
  evidence: Schema.Array(FollowUpEvidence),
  gate: Schema.NullOr(FollowUpGate),
  sourceKind: FollowUpSourceKind,
  sourceThreadId: Schema.NullOr(ThreadId),
  resolution: Schema.NullOr(FollowUpResolution),
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FollowUp = typeof FollowUp.Type;

export const FollowUpEventType = Schema.Literals(["follow-up.filed", "follow-up.status-changed"]);
export type FollowUpEventType = typeof FollowUpEventType.Type;

export const FollowUpEventPayload = Schema.Struct({ item: FollowUp });
export type FollowUpEventPayload = typeof FollowUpEventPayload.Type;

export const FollowUpEvent = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  commandId: CommandId,
  type: FollowUpEventType,
  occurredAt: IsoDateTime,
  payload: FollowUpEventPayload,
});
export type FollowUpEvent = typeof FollowUpEvent.Type;

export const FollowUpSnapshot = Schema.Struct({
  sequence: NonNegativeInt,
  items: Schema.Array(FollowUp),
});
export type FollowUpSnapshot = typeof FollowUpSnapshot.Type;

export const FollowUpStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), snapshot: FollowUpSnapshot }),
  Schema.Struct({ kind: Schema.Literal("event"), event: FollowUpEvent }),
]);
export type FollowUpStreamItem = typeof FollowUpStreamItem.Type;

export const FollowUpFileInput = Schema.Struct({
  commandId: CommandId,
  itemId: FollowUpId,
  projectId: ProjectId,
  kind: FollowUpKind,
  title: FollowUpTitle,
  observation: FollowUpObservation,
  deferReason: FollowUpDeferReason,
  verifyCheck: FollowUpVerifyCheck,
  evidence: Schema.optional(Schema.Array(FollowUpEvidence)),
  gate: Schema.optional(Schema.NullOr(FollowUpGate)),
  sourceKind: FollowUpSourceKind,
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)),
});
export type FollowUpFileInput = typeof FollowUpFileInput.Type;

export const FollowUpUpdateStatusInput = Schema.Struct({
  commandId: CommandId,
  itemId: FollowUpId,
  expectedRevision: NonNegativeInt,
  status: FollowUpStatus,
  resolution: Schema.optional(Schema.NullOr(FollowUpResolution)),
  actor: FollowUpSourceKind,
});
export type FollowUpUpdateStatusInput = typeof FollowUpUpdateStatusInput.Type;

export const FollowUpSubscribeInput = Schema.Struct({});
export type FollowUpSubscribeInput = typeof FollowUpSubscribeInput.Type;

export const FollowUpErrorCode = Schema.Literals([
  "not-found",
  "conflict",
  "invalid-project",
  "invalid-thread",
  "invalid-command",
  "forbidden",
  "persistence",
]);
export type FollowUpErrorCode = typeof FollowUpErrorCode.Type;

export class FollowUpOperationError extends Schema.TaggedErrorClass<FollowUpOperationError>()(
  "FollowUpOperationError",
  { code: FollowUpErrorCode, message: TrimmedNonEmptyString },
) {}
