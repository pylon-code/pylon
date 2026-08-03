import { describe, expect, it } from "vite-plus/test";

import {
  CommandId,
  EventId,
  KanbanWorkItemId,
  ProjectId,
  type KanbanWorkItem,
} from "@t3tools/contracts";

import { EMPTY_KANBAN_CLIENT_STATE, applyKanbanStreamItem } from "./kanban.ts";

const timestamp = "2026-08-02T12:00:00.000Z";
const projectId = ProjectId.make("project-1");

function workItem(id: string, position: number): KanbanWorkItem {
  return {
    id: KanbanWorkItemId.make(id),
    projectId,
    threadId: null,
    title: id,
    description: null,
    status: "backlog",
    position,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  };
}

describe("applyKanbanStreamItem", () => {
  it("installs a snapshot and applies later event positions", () => {
    const first = workItem("first", 0);
    const second = workItem("second", 1);
    const synchronized = applyKanbanStreamItem(EMPTY_KANBAN_CLIENT_STATE, {
      kind: "snapshot",
      snapshot: { sequence: 2, items: [second, first] },
    });

    expect(synchronized.synchronized).toBe(true);
    expect(synchronized.snapshot.items.map((item) => item.id)).toEqual([first.id, second.id]);

    const moved = { ...second, status: "ready" as const, position: 0, revision: 1 };
    const next = applyKanbanStreamItem(synchronized, {
      kind: "event",
      event: {
        sequence: 3,
        eventId: EventId.make("event-3"),
        commandId: CommandId.make("command-3"),
        type: "work-item.moved",
        occurredAt: timestamp,
        payload: {
          item: moved,
          positions: [
            { itemId: first.id, status: "backlog", position: 0 },
            { itemId: second.id, status: "ready", position: 0 },
          ],
        },
      },
    });

    expect(next.snapshot.sequence).toBe(3);
    expect(next.snapshot.items.map((item) => [item.id, item.status])).toEqual([
      [first.id, "backlog"],
      [second.id, "ready"],
    ]);
  });

  it("ignores stale events", () => {
    const synchronized = applyKanbanStreamItem(EMPTY_KANBAN_CLIENT_STATE, {
      kind: "snapshot",
      snapshot: { sequence: 4, items: [workItem("first", 0)] },
    });

    const next = applyKanbanStreamItem(synchronized, {
      kind: "event",
      event: {
        sequence: 4,
        eventId: EventId.make("event-4"),
        commandId: CommandId.make("command-4"),
        type: "work-item.updated",
        occurredAt: timestamp,
        payload: { item: { ...workItem("first", 0), title: "stale" }, positions: [] },
      },
    });

    expect(next).toBe(synchronized);
  });
});
