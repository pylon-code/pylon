import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { KANBAN_STATUSES, type KanbanStatus, type KanbanWorkItem } from "@t3tools/contracts";

export const KANBAN_COLUMN_LABELS: Readonly<Record<KanbanStatus, string>> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

export const KANBAN_COLUMN_DESCRIPTIONS: Readonly<Record<KanbanStatus, string>> = {
  backlog: "Captured work",
  ready: "Clear to start",
  in_progress: "Being worked",
  review: "Needs a look",
  done: "Completed",
};

export type KanbanTraceTone = "neutral" | "info" | "warning" | "error" | "success";

export interface KanbanThreadTrace {
  readonly label: string;
  readonly tone: KanbanTraceTone;
  readonly branch: string | null;
}

export function resolveKanbanThreadTrace(
  thread: EnvironmentThreadShell | null,
): KanbanThreadTrace | null {
  if (thread === null) return null;

  const branch = thread.branch ?? null;
  if (thread.hasPendingApprovals) {
    return { label: "Needs approval", tone: "warning", branch };
  }
  if (thread.hasPendingUserInput) {
    return { label: "Needs input", tone: "warning", branch };
  }
  if (thread.session?.status === "starting") {
    return { label: "Starting", tone: "info", branch };
  }
  if (thread.session?.status === "running" || thread.latestTurn?.state === "running") {
    return { label: "Running", tone: "info", branch };
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return { label: "Failed", tone: "error", branch };
  }
  if (thread.latestTurn?.state === "completed") {
    return { label: "Complete", tone: "success", branch };
  }
  if (thread.session?.status === "ready") {
    return { label: "Ready", tone: "neutral", branch };
  }
  return { label: "Idle", tone: "neutral", branch };
}

export function groupActiveKanbanItems(
  items: ReadonlyArray<KanbanWorkItem>,
): Readonly<Record<KanbanStatus, ReadonlyArray<KanbanWorkItem>>> {
  const grouped: Record<KanbanStatus, KanbanWorkItem[]> = {
    backlog: [],
    ready: [],
    in_progress: [],
    review: [],
    done: [],
  };
  for (const item of items) {
    if (item.archivedAt === null) grouped[item.status].push(item);
  }
  for (const status of KANBAN_STATUSES) {
    grouped[status].sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id),
    );
  }
  return grouped;
}

export function resolveKanbanDrop(input: {
  readonly activeItem: KanbanWorkItem;
  readonly overItem: KanbanWorkItem | null;
  readonly overStatus: KanbanStatus;
  readonly grouped: Readonly<Record<KanbanStatus, ReadonlyArray<KanbanWorkItem>>>;
}): { readonly status: KanbanStatus; readonly index: number } | null {
  const { activeItem, grouped, overItem, overStatus } = input;
  const targetItems = grouped[overStatus].filter((item) => item.id !== activeItem.id);
  const index =
    overItem === null
      ? targetItems.length
      : Math.max(
          0,
          grouped[overStatus].findIndex((item) => item.id === overItem.id),
        );

  if (activeItem.status === overStatus && activeItem.position === index) return null;
  return { status: overStatus, index };
}
