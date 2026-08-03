import type {
  KanbanArchiveWorkItemInput,
  KanbanCreateWorkItemInput,
  KanbanEventPayload,
  KanbanEventType,
  KanbanItemPosition,
  KanbanMoveWorkItemInput,
  KanbanOperationError,
  KanbanRestoreWorkItemInput,
  KanbanSnapshot,
  KanbanStatus,
  KanbanUpdateWorkItemInput,
  KanbanWorkItem,
} from "@t3tools/contracts";
import { KanbanOperationError as KanbanOperationErrorClass } from "@t3tools/contracts";

export type KanbanDomainCommand =
  | { readonly type: "create"; readonly input: KanbanCreateWorkItemInput }
  | { readonly type: "update"; readonly input: KanbanUpdateWorkItemInput }
  | { readonly type: "move"; readonly input: KanbanMoveWorkItemInput }
  | { readonly type: "archive"; readonly input: KanbanArchiveWorkItemInput }
  | { readonly type: "restore"; readonly input: KanbanRestoreWorkItemInput };

export interface KanbanDomainEvent {
  readonly type: KanbanEventType;
  readonly payload: KanbanEventPayload;
}

export type KanbanDecision =
  | { readonly kind: "accepted"; readonly event: KanbanDomainEvent }
  | { readonly kind: "rejected"; readonly error: KanbanOperationError };

function reject(
  code: KanbanOperationError["code"],
  message: string,
): Extract<KanbanDecision, { readonly kind: "rejected" }> {
  return {
    kind: "rejected",
    error: new KanbanOperationErrorClass({ code, message }),
  };
}

function itemById(snapshot: KanbanSnapshot, itemId: KanbanWorkItem["id"]): KanbanWorkItem | null {
  return snapshot.items.find((item) => item.id === itemId) ?? null;
}

function requireCurrentItem(
  snapshot: KanbanSnapshot,
  itemId: KanbanWorkItem["id"],
  expectedRevision: number,
): KanbanWorkItem | KanbanDecision {
  const item = itemById(snapshot, itemId);
  if (item === null) {
    return reject("not-found", "That work item no longer exists.");
  }
  if (item.revision !== expectedRevision) {
    return reject("conflict", "That work item changed on another client. Refresh and try again.");
  }
  return item;
}

function isRejected(value: KanbanWorkItem | KanbanDecision): value is KanbanDecision {
  return "kind" in value;
}

function activeColumn(
  items: ReadonlyArray<KanbanWorkItem>,
  status: KanbanStatus,
  projectId: KanbanWorkItem["projectId"],
  excludingId?: KanbanWorkItem["id"],
): KanbanWorkItem[] {
  return items
    .filter(
      (item) =>
        item.archivedAt === null &&
        item.projectId === projectId &&
        item.status === status &&
        item.id !== excludingId,
    )
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

function positionsForColumns(
  columns: ReadonlyMap<KanbanStatus, ReadonlyArray<KanbanWorkItem>>,
): KanbanItemPosition[] {
  const positions: KanbanItemPosition[] = [];
  for (const [status, items] of columns) {
    items.forEach((item, position) => {
      positions.push({ itemId: item.id, status, position });
    });
  }
  return positions;
}

function accepted(
  type: KanbanEventType,
  item: KanbanWorkItem,
  positions: ReadonlyArray<KanbanItemPosition> = [],
): KanbanDecision {
  return {
    kind: "accepted",
    event: {
      type,
      payload: { item, positions },
    },
  };
}

export function decideKanbanCommand(
  snapshot: KanbanSnapshot,
  command: KanbanDomainCommand,
  now: string,
): KanbanDecision {
  switch (command.type) {
    case "create": {
      const { input } = command;
      if (itemById(snapshot, input.itemId) !== null) {
        return reject("conflict", "A work item with that identifier already exists.");
      }
      const item: KanbanWorkItem = {
        id: input.itemId,
        projectId: input.projectId,
        threadId: input.threadId ?? null,
        title: input.title,
        description: input.description ?? null,
        status: "backlog",
        position: activeColumn(snapshot.items, "backlog", input.projectId).length,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      return accepted("work-item.created", item, [
        { itemId: item.id, status: item.status, position: item.position },
      ]);
    }

    case "update": {
      const { input } = command;
      if (
        input.title === undefined &&
        input.description === undefined &&
        input.threadId === undefined
      ) {
        return reject("invalid-command", "Choose at least one field to update.");
      }
      const current = requireCurrentItem(snapshot, input.itemId, input.expectedRevision);
      if (isRejected(current)) return current;
      const item: KanbanWorkItem = {
        ...current,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        revision: current.revision + 1,
        updatedAt: now,
      };
      return accepted("work-item.updated", item);
    }

    case "move": {
      const { input } = command;
      const current = requireCurrentItem(snapshot, input.itemId, input.expectedRevision);
      if (isRejected(current)) return current;
      if (current.archivedAt !== null) {
        return reject("invalid-command", "Restore this work item before moving it.");
      }

      const moving: KanbanWorkItem = {
        ...current,
        status: input.status,
        revision: current.revision + 1,
        updatedAt: now,
      };
      const target = activeColumn(snapshot.items, input.status, current.projectId, current.id);
      target.splice(Math.min(input.index, target.length), 0, moving);

      const columns = new Map<KanbanStatus, ReadonlyArray<KanbanWorkItem>>();
      columns.set(input.status, target);
      if (current.status !== input.status) {
        columns.set(
          current.status,
          activeColumn(snapshot.items, current.status, current.projectId, current.id),
        );
      }
      const positions = positionsForColumns(columns);
      const position = positions.find((candidate) => candidate.itemId === moving.id)?.position ?? 0;
      return accepted("work-item.moved", { ...moving, position }, positions);
    }

    case "archive": {
      const { input } = command;
      const current = requireCurrentItem(snapshot, input.itemId, input.expectedRevision);
      if (isRejected(current)) return current;
      if (current.archivedAt !== null) {
        return reject("invalid-command", "That work item is already archived.");
      }
      const item: KanbanWorkItem = {
        ...current,
        archivedAt: now,
        revision: current.revision + 1,
        updatedAt: now,
      };
      const positions = positionsForColumns(
        new Map([
          [
            current.status,
            activeColumn(snapshot.items, current.status, current.projectId, current.id),
          ],
        ]),
      );
      return accepted("work-item.archived", item, positions);
    }

    case "restore": {
      const { input } = command;
      const current = requireCurrentItem(snapshot, input.itemId, input.expectedRevision);
      if (isRejected(current)) return current;
      if (current.archivedAt === null) {
        return reject("invalid-command", "That work item is already on the board.");
      }
      const column = activeColumn(snapshot.items, current.status, current.projectId, current.id);
      const item: KanbanWorkItem = {
        ...current,
        position: column.length,
        archivedAt: null,
        revision: current.revision + 1,
        updatedAt: now,
      };
      column.push(item);
      return accepted(
        "work-item.restored",
        item,
        positionsForColumns(new Map([[current.status, column]])),
      );
    }
  }
}
