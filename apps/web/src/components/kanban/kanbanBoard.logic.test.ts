import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { KanbanWorkItemId, ProjectId, type KanbanWorkItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveKanbanDrop, resolveKanbanThreadTrace } from "./kanbanBoard.logic";

describe("kanban board logic", () => {
  it("prioritizes actionable linked-thread state", () => {
    const thread = {
      branch: "feat/board",
      hasPendingApprovals: true,
      hasPendingUserInput: false,
      session: { status: "running" },
      latestTurn: { state: "running" },
    } as EnvironmentThreadShell;

    expect(resolveKanbanThreadTrace(thread)).toEqual({
      label: "Needs approval",
      tone: "warning",
      branch: "feat/board",
    });
  });

  it("computes a drop index after removing the active item", () => {
    const makeItem = (id: string, position: number): KanbanWorkItem => ({
      id: KanbanWorkItemId.make(id),
      projectId: ProjectId.make("project-1"),
      threadId: null,
      title: id,
      description: null,
      status: "ready",
      position,
      revision: 0,
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
      archivedAt: null,
    });
    const first = makeItem("first", 0);
    const second = makeItem("second", 1);
    const third = makeItem("third", 2);

    expect(
      resolveKanbanDrop({
        activeItem: first,
        overItem: third,
        overStatus: "ready",
        grouped: {
          backlog: [],
          ready: [first, second, third],
          in_progress: [],
          review: [],
          done: [],
        },
      }),
    ).toEqual({ status: "ready", index: 2 });
  });
});
