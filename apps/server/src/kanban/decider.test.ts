import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  KanbanWorkItemId,
  ProjectId,
  ThreadId,
  type KanbanSnapshot,
  type KanbanWorkItem,
} from "@t3tools/contracts";

import { decideKanbanCommand } from "./decider.ts";

const NOW = "2026-08-02T12:00:00.000Z";

function item(overrides: Partial<KanbanWorkItem> = {}): KanbanWorkItem {
  return {
    id: KanbanWorkItemId.make("item-1"),
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
    title: "Implement board",
    description: null,
    status: "backlog",
    position: 0,
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

function snapshot(items: ReadonlyArray<KanbanWorkItem>): KanbanSnapshot {
  return { sequence: 1, items };
}

describe("decideKanbanCommand", () => {
  it("creates new work at the end of Backlog", () => {
    const decision = decideKanbanCommand(
      snapshot([item()]),
      {
        type: "create",
        input: {
          commandId: CommandId.make("command-1"),
          itemId: KanbanWorkItemId.make("item-2"),
          projectId: ProjectId.make("project-1"),
          title: "Polish interactions",
        },
      },
      NOW,
    );

    expect(decision.kind).toBe("accepted");
    if (decision.kind === "accepted") {
      expect(decision.event.payload.item).toMatchObject({
        status: "backlog",
        position: 1,
        revision: 0,
      });
    }
  });

  it("keeps ordering independent between projects", () => {
    const otherProjectItem = item({
      id: KanbanWorkItemId.make("other-project-item"),
      projectId: ProjectId.make("project-2"),
      position: 4,
    });
    const decision = decideKanbanCommand(
      snapshot([item(), otherProjectItem]),
      {
        type: "create",
        input: {
          commandId: CommandId.make("command-project-order"),
          itemId: KanbanWorkItemId.make("item-project-order"),
          projectId: ProjectId.make("project-2"),
          title: "Project two work",
        },
      },
      NOW,
    );

    expect(decision.kind).toBe("accepted");
    if (decision.kind === "accepted") {
      expect(decision.event.payload.item.position).toBe(1);
    }
  });

  it("moves and reorders work across columns", () => {
    const moving = item();
    const ready = item({
      id: KanbanWorkItemId.make("item-2"),
      status: "ready",
      title: "Ready work",
    });
    const decision = decideKanbanCommand(
      snapshot([moving, ready]),
      {
        type: "move",
        input: {
          commandId: CommandId.make("command-2"),
          itemId: moving.id,
          expectedRevision: 0,
          status: "ready",
          index: 0,
        },
      },
      NOW,
    );

    expect(decision.kind).toBe("accepted");
    if (decision.kind === "accepted") {
      expect(decision.event.payload.item).toMatchObject({
        status: "ready",
        position: 0,
        revision: 1,
      });
      expect(decision.event.payload.positions).toEqual([
        { itemId: moving.id, status: "ready", position: 0 },
        { itemId: ready.id, status: "ready", position: 1 },
      ]);
    }
  });

  it("rejects stale revisions", () => {
    const current = item({ revision: 3 });
    const decision = decideKanbanCommand(
      snapshot([current]),
      {
        type: "archive",
        input: {
          commandId: CommandId.make("command-3"),
          itemId: current.id,
          expectedRevision: 2,
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({
      kind: "rejected",
      error: { code: "conflict" },
    });
  });

  it("archives and restores without losing workflow status", () => {
    const current = item({ status: "review" });
    const archived = decideKanbanCommand(
      snapshot([current]),
      {
        type: "archive",
        input: {
          commandId: CommandId.make("command-4"),
          itemId: current.id,
          expectedRevision: 0,
        },
      },
      NOW,
    );
    expect(archived.kind).toBe("accepted");
    if (archived.kind !== "accepted") return;

    const restored = decideKanbanCommand(
      snapshot([archived.event.payload.item]),
      {
        type: "restore",
        input: {
          commandId: CommandId.make("command-5"),
          itemId: current.id,
          expectedRevision: 1,
        },
      },
      NOW,
    );

    expect(restored.kind).toBe("accepted");
    if (restored.kind === "accepted") {
      expect(restored.event.payload.item).toMatchObject({
        status: "review",
        archivedAt: null,
        revision: 2,
      });
    }
  });
});
