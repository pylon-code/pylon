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

export const KANBAN_STATUSES = ["backlog", "ready", "in_progress", "review", "done"] as const;

export const KanbanStatus = Schema.Literals(KANBAN_STATUSES);
export type KanbanStatus = typeof KanbanStatus.Type;

export const KanbanWorkItemId = TrimmedNonEmptyString.pipe(Schema.brand("KanbanWorkItemId"));
export type KanbanWorkItemId = typeof KanbanWorkItemId.Type;

export const KanbanWorkItemTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
export const KanbanWorkItemDescription = TrimmedString.check(Schema.isMaxLength(12_000));

export const KanbanWorkItem = Schema.Struct({
  id: KanbanWorkItemId,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  title: KanbanWorkItemTitle,
  description: Schema.NullOr(KanbanWorkItemDescription),
  status: KanbanStatus,
  position: NonNegativeInt,
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type KanbanWorkItem = typeof KanbanWorkItem.Type;

export const KanbanItemPosition = Schema.Struct({
  itemId: KanbanWorkItemId,
  status: KanbanStatus,
  position: NonNegativeInt,
});
export type KanbanItemPosition = typeof KanbanItemPosition.Type;

export const KanbanEventType = Schema.Literals([
  "work-item.created",
  "work-item.updated",
  "work-item.moved",
  "work-item.archived",
  "work-item.restored",
]);
export type KanbanEventType = typeof KanbanEventType.Type;

export const KanbanEventPayload = Schema.Struct({
  item: KanbanWorkItem,
  positions: Schema.Array(KanbanItemPosition),
});
export type KanbanEventPayload = typeof KanbanEventPayload.Type;

export const KanbanEvent = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  commandId: CommandId,
  type: KanbanEventType,
  occurredAt: IsoDateTime,
  payload: KanbanEventPayload,
});
export type KanbanEvent = typeof KanbanEvent.Type;

export const KanbanSnapshot = Schema.Struct({
  sequence: NonNegativeInt,
  items: Schema.Array(KanbanWorkItem),
});
export type KanbanSnapshot = typeof KanbanSnapshot.Type;

export const KanbanStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: KanbanSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: KanbanEvent,
  }),
]);
export type KanbanStreamItem = typeof KanbanStreamItem.Type;

export const KanbanCreateWorkItemInput = Schema.Struct({
  commandId: CommandId,
  itemId: KanbanWorkItemId,
  projectId: ProjectId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  title: KanbanWorkItemTitle,
  description: Schema.optional(Schema.NullOr(KanbanWorkItemDescription)),
});
export type KanbanCreateWorkItemInput = typeof KanbanCreateWorkItemInput.Type;

export const KanbanUpdateWorkItemInput = Schema.Struct({
  commandId: CommandId,
  itemId: KanbanWorkItemId,
  expectedRevision: NonNegativeInt,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  title: Schema.optional(KanbanWorkItemTitle),
  description: Schema.optional(Schema.NullOr(KanbanWorkItemDescription)),
});
export type KanbanUpdateWorkItemInput = typeof KanbanUpdateWorkItemInput.Type;

export const KanbanMoveWorkItemInput = Schema.Struct({
  commandId: CommandId,
  itemId: KanbanWorkItemId,
  expectedRevision: NonNegativeInt,
  status: KanbanStatus,
  index: NonNegativeInt,
});
export type KanbanMoveWorkItemInput = typeof KanbanMoveWorkItemInput.Type;

export const KanbanArchiveWorkItemInput = Schema.Struct({
  commandId: CommandId,
  itemId: KanbanWorkItemId,
  expectedRevision: NonNegativeInt,
});
export type KanbanArchiveWorkItemInput = typeof KanbanArchiveWorkItemInput.Type;

export const KanbanRestoreWorkItemInput = KanbanArchiveWorkItemInput;
export type KanbanRestoreWorkItemInput = typeof KanbanRestoreWorkItemInput.Type;

export const KanbanSubscribeInput = Schema.Struct({});
export type KanbanSubscribeInput = typeof KanbanSubscribeInput.Type;

export const KanbanErrorCode = Schema.Literals([
  "not-found",
  "conflict",
  "invalid-project",
  "invalid-thread",
  "invalid-command",
  "persistence",
]);
export type KanbanErrorCode = typeof KanbanErrorCode.Type;

export class KanbanOperationError extends Schema.TaggedErrorClass<KanbanOperationError>()(
  "KanbanOperationError",
  {
    code: KanbanErrorCode,
    message: TrimmedNonEmptyString,
  },
) {}
