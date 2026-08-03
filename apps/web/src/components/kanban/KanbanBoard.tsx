import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  KANBAN_STATUSES,
  type EnvironmentId,
  type KanbanStatus,
  type KanbanWorkItem,
  type KanbanWorkItemId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowRightIcon,
  Columns3Icon,
  EllipsisIcon,
  ExternalLinkIcon,
  GripVerticalIcon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { newCommandId, newKanbanWorkItemId, cn } from "../../lib/utils";
import { kanbanEnvironment } from "../../state/kanban";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  KanbanWorkItemDialog,
  type KanbanWorkItemDialogMode,
  type KanbanWorkItemDraft,
} from "./KanbanWorkItemDialog";
import {
  KANBAN_COLUMN_DESCRIPTIONS,
  KANBAN_COLUMN_LABELS,
  groupActiveKanbanItems,
  resolveKanbanDrop,
  resolveKanbanThreadTrace,
  type KanbanTraceTone,
} from "./kanbanBoard.logic";

const COLUMN_DROP_PREFIX = "kanban-column:";
const EMPTY_GROUPED_ITEMS = groupActiveKanbanItems([]);

const TRACE_TONE_CLASSES: Readonly<Record<KanbanTraceTone, string>> = {
  neutral: "bg-muted-foreground/45",
  info: "bg-info",
  warning: "bg-warning",
  error: "bg-destructive",
  success: "bg-success",
};

function columnDropId(status: KanbanStatus): string {
  return `${COLUMN_DROP_PREFIX}${status}`;
}

function statusFromColumnDropId(id: string): KanbanStatus | null {
  if (!id.startsWith(COLUMN_DROP_PREFIX)) return null;
  const value = id.slice(COLUMN_DROP_PREFIX.length);
  return KANBAN_STATUSES.find((status) => status === value) ?? null;
}

function commandFailureMessage(result: { readonly cause: Cause.Cause<unknown> }): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The board could not save that change.";
}

interface KanbanBoardProps {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connection: { readonly phase: string };
  }>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly titlebarInsetClassName?: string;
}

export function KanbanBoard({
  environments,
  primaryEnvironmentId,
  projects,
  threads,
  titlebarInsetClassName,
}: KanbanBoardProps) {
  const navigate = useNavigate();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(
    primaryEnvironmentId ?? environments[0]?.environmentId ?? null,
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [dialogMode, setDialogMode] = useState<KanbanWorkItemDialogMode | null>(null);
  const [pendingItemIds, setPendingItemIds] = useState<ReadonlySet<KanbanWorkItemId>>(new Set());

  const createItem = useAtomCommand(kanbanEnvironment.create, { reportFailure: false });
  const updateItem = useAtomCommand(kanbanEnvironment.update, { reportFailure: false });
  const moveItem = useAtomCommand(kanbanEnvironment.move, { reportFailure: false });
  const archiveItem = useAtomCommand(kanbanEnvironment.archive, { reportFailure: false });
  const restoreItem = useAtomCommand(kanbanEnvironment.restore, { reportFailure: false });

  useEffect(() => {
    if (
      environmentId !== null &&
      environments.some((entry) => entry.environmentId === environmentId)
    ) {
      return;
    }
    setEnvironmentId(primaryEnvironmentId ?? environments[0]?.environmentId ?? null);
  }, [environmentId, environments, primaryEnvironmentId]);

  const environmentProjects = useMemo(
    () =>
      projects
        .filter((project) => project.environmentId === environmentId)
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [environmentId, projects],
  );
  const environmentThreads = useMemo(
    () => threads.filter((thread) => thread.environmentId === environmentId),
    [environmentId, threads],
  );

  useEffect(() => {
    if (projectId !== null && environmentProjects.some((project) => project.id === projectId)) {
      return;
    }
    setProjectId(environmentProjects[0]?.id ?? null);
  }, [environmentProjects, projectId]);

  const boardQuery = useEnvironmentQuery(
    environmentId === null ? null : kanbanEnvironment.board({ environmentId, input: null }),
  );
  const allItems = boardQuery.data?.snapshot.items ?? [];
  const items = useMemo(
    () => (projectId === null ? [] : allItems.filter((item) => item.projectId === projectId)),
    [allItems, projectId],
  );
  const grouped = useMemo(() => groupActiveKanbanItems(items), [items]);
  const archivedItems = useMemo(
    () =>
      items
        .filter((item) => item.archivedAt !== null)
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [items],
  );
  const projectById = useMemo(
    () => new Map(environmentProjects.map((project) => [project.id, project])),
    [environmentProjects],
  );
  const threadById = useMemo(
    () => new Map(environmentThreads.map((thread) => [thread.id, thread])),
    [environmentThreads],
  );
  const selectedProject = projectId === null ? null : (projectById.get(projectId) ?? null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const runItemMutation = useCallback(
    async (item: KanbanWorkItem, operation: () => ReturnType<typeof moveItem>) => {
      setPendingItemIds((current) => new Set(current).add(item.id));
      const result = await operation();
      setPendingItemIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not update work item",
          description: commandFailureMessage(result),
        });
      }
    },
    [moveItem],
  );

  const handleMove = useCallback(
    (item: KanbanWorkItem, status: KanbanStatus, index: number) => {
      if (environmentId === null || pendingItemIds.has(item.id)) return;
      void runItemMutation(item, () =>
        moveItem({
          environmentId,
          input: {
            commandId: newCommandId(),
            itemId: item.id,
            expectedRevision: item.revision,
            status,
            index,
          },
        }),
      );
    },
    [environmentId, moveItem, pendingItemIds, runItemMutation],
  );

  const handleArchive = useCallback(
    (item: KanbanWorkItem) => {
      if (environmentId === null || pendingItemIds.has(item.id)) return;
      void runItemMutation(item, () =>
        archiveItem({
          environmentId,
          input: {
            commandId: newCommandId(),
            itemId: item.id,
            expectedRevision: item.revision,
          },
        }),
      );
    },
    [archiveItem, environmentId, pendingItemIds, runItemMutation],
  );

  const handleRestore = useCallback(
    (item: KanbanWorkItem) => {
      if (environmentId === null || pendingItemIds.has(item.id)) return;
      void runItemMutation(item, () =>
        restoreItem({
          environmentId,
          input: {
            commandId: newCommandId(),
            itemId: item.id,
            expectedRevision: item.revision,
          },
        }),
      );
    },
    [environmentId, pendingItemIds, restoreItem, runItemMutation],
  );

  const openThread = useCallback(
    (item: KanbanWorkItem) => {
      if (environmentId === null || item.threadId === null) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, item.threadId)),
      });
    },
    [environmentId, navigate],
  );

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (over === null) return;
      const activeItem = items.find((item) => item.id === active.id);
      if (activeItem === undefined) return;
      const overItem = items.find((item) => item.id === over.id) ?? null;
      const overStatus = overItem?.status ?? statusFromColumnDropId(String(over.id));
      if (overStatus === null) return;
      const drop = resolveKanbanDrop({ activeItem, overItem, overStatus, grouped });
      if (drop !== null) handleMove(activeItem, drop.status, drop.index);
    },
    [grouped, handleMove, items],
  );

  const handleDialogSubmit = useCallback(
    async (draft: KanbanWorkItemDraft): Promise<string | null> => {
      if (environmentId === null || dialogMode === null) return "No environment is connected.";
      const result =
        dialogMode.kind === "create"
          ? await createItem({
              environmentId,
              input: {
                commandId: newCommandId(),
                itemId: newKanbanWorkItemId(),
                projectId: draft.projectId,
                threadId: draft.threadId,
                title: draft.title,
                description: draft.description,
              },
            })
          : await updateItem({
              environmentId,
              input: {
                commandId: newCommandId(),
                itemId: dialogMode.item.id,
                expectedRevision: dialogMode.item.revision,
                threadId: draft.threadId,
                title: draft.title,
                description: draft.description,
              },
            });
      if (result._tag === "Failure") return commandFailureMessage(result);
      setProjectId(draft.projectId);
      return null;
    },
    [createItem, dialogMode, environmentId, updateItem],
  );

  const activeItemCount = items.length - archivedItems.length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header
        className={cn(
          "flex min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b border-border px-3 py-2 sm:px-4",
          titlebarInsetClassName,
        )}
      >
        <div className="hidden min-w-0 items-center gap-2 sm:flex">
          <Columns3Icon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Board</h1>
            <p className="hidden truncate text-xs text-muted-foreground lg:block">
              Work stays yours; threads supply the live trace.
            </p>
          </div>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {environments.length > 1 ? (
            <Select
              value={environmentId}
              onValueChange={(value) => {
                if (value === null) return;
                setEnvironmentId(value as EnvironmentId);
                setProjectId(null);
              }}
            >
              <SelectTrigger className="hidden w-40 sm:flex" size="sm">
                <SelectValue placeholder="Environment" />
              </SelectTrigger>
              <SelectContent>
                {environments.map((environment) => (
                  <SelectItem
                    key={environment.environmentId}
                    disabled={environment.connection.phase !== "connected"}
                    value={environment.environmentId}
                  >
                    {environment.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Select
            value={projectId}
            onValueChange={(value) => value !== null && setProjectId(value as ProjectId)}
          >
            <SelectTrigger
              className="w-28 sm:w-48"
              disabled={environmentProjects.length === 0}
              size="sm"
            >
              <SelectValue placeholder="Choose project" />
            </SelectTrigger>
            <SelectContent>
              {environmentProjects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            aria-label={showArchived ? "Show active board" : "Show archived work"}
            aria-pressed={showArchived}
            size="icon-sm"
            title={showArchived ? "Show active board" : "Show archived work"}
            variant={showArchived ? "secondary" : "ghost"}
            onClick={() => setShowArchived((current) => !current)}
          >
            <ArchiveIcon />
          </Button>
          <Button
            aria-label="Add work"
            disabled={projectId === null}
            size="sm"
            onClick={() => setDialogMode({ kind: "create", initialProjectId: projectId })}
          >
            <PlusIcon />
            <span className="hidden sm:inline">Add work</span>
          </Button>
        </div>
      </header>

      {environmentProjects.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>No projects in this environment</EmptyTitle>
            <EmptyDescription>Add a project before creating work for the board.</EmptyDescription>
            <Button
              className="mt-3"
              size="sm"
              onClick={() => openCommandPalette({ open: "add-project" })}
            >
              <PlusIcon />
              Add project
            </Button>
          </EmptyHeader>
        </Empty>
      ) : boardQuery.error ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>Couldn’t load the board</EmptyTitle>
            <EmptyDescription>{boardQuery.error}</EmptyDescription>
            <Button className="mt-3" size="sm" variant="outline" onClick={boardQuery.refresh}>
              <RotateCcwIcon />
              Try again
            </Button>
          </EmptyHeader>
        </Empty>
      ) : showArchived ? (
        <ArchivedBoard
          items={archivedItems}
          pendingItemIds={pendingItemIds}
          project={selectedProject}
          threadById={threadById}
          onRestore={handleRestore}
          onOpenThread={openThread}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-4 text-xs text-muted-foreground">
            <span>
              {boardQuery.data?.synchronized
                ? "Live"
                : boardQuery.isPending
                  ? "Connecting…"
                  : "Waiting"}
            </span>
            <span aria-hidden="true">·</span>
            <span>{activeItemCount === 1 ? "1 work item" : `${activeItemCount} work items`}</span>
            {selectedProject ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate font-mono text-[11px]">
                  {selectedProject.workspaceRoot}
                </span>
              </>
            ) : null}
          </div>
          <DndContext
            collisionDetection={closestCorners}
            sensors={sensors}
            onDragEnd={handleDragEnd}
          >
            <div className="grid min-h-0 flex-1 auto-cols-[minmax(264px,1fr)] grid-flow-col gap-3 overflow-auto p-3 xl:auto-cols-[minmax(250px,1fr)]">
              {KANBAN_STATUSES.map((status) => (
                <KanbanColumn
                  key={status}
                  grouped={grouped}
                  items={grouped[status]}
                  pendingItemIds={pendingItemIds}
                  project={selectedProject}
                  status={status}
                  threadById={threadById}
                  onArchive={handleArchive}
                  onEdit={(item) => setDialogMode({ kind: "edit", item })}
                  onMove={handleMove}
                  onOpenThread={openThread}
                />
              ))}
            </div>
          </DndContext>
        </div>
      )}

      {dialogMode !== null ? (
        <KanbanWorkItemDialog
          mode={dialogMode}
          open
          projects={environmentProjects}
          threads={environmentThreads}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setDialogMode(null);
          }}
          onSubmit={handleDialogSubmit}
        />
      ) : null}
    </div>
  );
}

function KanbanColumn({
  grouped,
  items,
  onArchive,
  onEdit,
  onMove,
  onOpenThread,
  pendingItemIds,
  project,
  status,
  threadById,
}: {
  readonly grouped: Readonly<Record<KanbanStatus, ReadonlyArray<KanbanWorkItem>>>;
  readonly items: ReadonlyArray<KanbanWorkItem>;
  readonly onArchive: (item: KanbanWorkItem) => void;
  readonly onEdit: (item: KanbanWorkItem) => void;
  readonly onMove: (item: KanbanWorkItem, status: KanbanStatus, index: number) => void;
  readonly onOpenThread: (item: KanbanWorkItem) => void;
  readonly pendingItemIds: ReadonlySet<KanbanWorkItemId>;
  readonly project: EnvironmentProject | null;
  readonly status: KanbanStatus;
  readonly threadById: ReadonlyMap<ThreadId, EnvironmentThreadShell>;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: columnDropId(status) });

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "flex min-h-48 min-w-0 flex-col rounded-xl border border-border/70 bg-muted/18",
        isOver && "border-ring/45 bg-accent/30",
      )}
    >
      <header className="flex h-12 shrink-0 items-center border-b border-border/60 px-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-sm font-semibold">{KANBAN_COLUMN_LABELS[status]}</h2>
            <span className="text-xs tabular-nums text-muted-foreground">{items.length}</span>
          </div>
          <p className="truncate text-[11px] text-muted-foreground/70">
            {KANBAN_COLUMN_DESCRIPTIONS[status]}
          </p>
        </div>
      </header>
      <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-24 flex-1 flex-col gap-2 p-2">
          {items.map((item) => (
            <SortableKanbanCard
              key={item.id}
              grouped={grouped}
              item={item}
              pending={pendingItemIds.has(item.id)}
              project={project}
              thread={item.threadId === null ? null : (threadById.get(item.threadId) ?? null)}
              onArchive={onArchive}
              onEdit={onEdit}
              onMove={onMove}
              onOpenThread={onOpenThread}
            />
          ))}
          {items.length === 0 ? (
            <div className="flex min-h-20 flex-1 items-center justify-center rounded-lg border border-dashed border-border/70 px-4 text-center text-xs text-muted-foreground/65">
              Drop work here
            </div>
          ) : null}
        </div>
      </SortableContext>
    </section>
  );
}

function SortableKanbanCard({
  grouped,
  item,
  onArchive,
  onEdit,
  onMove,
  onOpenThread,
  pending,
  project,
  thread,
}: {
  readonly grouped: Readonly<Record<KanbanStatus, ReadonlyArray<KanbanWorkItem>>>;
  readonly item: KanbanWorkItem;
  readonly onArchive: (item: KanbanWorkItem) => void;
  readonly onEdit: (item: KanbanWorkItem) => void;
  readonly onMove: (item: KanbanWorkItem, status: KanbanStatus, index: number) => void;
  readonly onOpenThread: (item: KanbanWorkItem) => void;
  readonly pending: boolean;
  readonly project: EnvironmentProject | null;
  readonly thread: EnvironmentThreadShell | null;
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: item.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "z-10 opacity-45")}
    >
      <KanbanCard
        dragHandleProps={{ ...attributes, ...listeners }}
        grouped={grouped}
        item={item}
        pending={pending}
        project={project}
        thread={thread}
        onArchive={onArchive}
        onEdit={onEdit}
        onMove={onMove}
        onOpenThread={onOpenThread}
      />
    </div>
  );
}

function KanbanCard({
  dragHandleProps,
  grouped,
  item,
  onArchive,
  onEdit,
  onMove,
  onOpenThread,
  pending,
  project,
  thread,
}: {
  readonly dragHandleProps?: ComponentProps<"button">;
  readonly grouped: Readonly<Record<KanbanStatus, ReadonlyArray<KanbanWorkItem>>>;
  readonly item: KanbanWorkItem;
  readonly onArchive?: (item: KanbanWorkItem) => void;
  readonly onEdit?: (item: KanbanWorkItem) => void;
  readonly onMove?: (item: KanbanWorkItem, status: KanbanStatus, index: number) => void;
  readonly onOpenThread: (item: KanbanWorkItem) => void;
  readonly pending: boolean;
  readonly project: EnvironmentProject | null;
  readonly thread: EnvironmentThreadShell | null;
}) {
  const trace = resolveKanbanThreadTrace(thread);

  return (
    <article
      className={cn(
        "group rounded-lg border border-border/75 bg-card p-2.5 text-card-foreground shadow-xs/5",
        pending && "opacity-60",
      )}
    >
      <div className="flex items-start gap-1.5">
        {dragHandleProps ? (
          <button
            aria-label={`Move ${item.title}`}
            className="-ml-1 mt-0.5 inline-flex size-6 shrink-0 touch-none items-center justify-center rounded-md text-muted-foreground/45 outline-none hover:bg-accent hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
            {...dragHandleProps}
          >
            <GripVerticalIcon className="size-3.5" />
          </button>
        ) : null}
        {onEdit ? (
          <button
            className="min-w-0 flex-1 text-left text-sm font-medium leading-snug outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
            onClick={() => onEdit(item)}
          >
            {item.title}
          </button>
        ) : (
          <h3 className="min-w-0 flex-1 text-sm font-medium leading-snug">{item.title}</h3>
        )}
        {onEdit || onArchive || onMove ? (
          <Menu>
            <MenuTrigger className="-mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/55 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <EllipsisIcon className="size-3.5" />
              <span className="sr-only">Work item actions</span>
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-44">
              {onEdit ? <MenuItem onClick={() => onEdit(item)}>Edit</MenuItem> : null}
              {onMove ? (
                <>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Move to</MenuGroupLabel>
                    {KANBAN_STATUSES.filter((status) => status !== item.status).map((status) => (
                      <MenuItem
                        key={status}
                        onClick={() => onMove(item, status, grouped[status].length)}
                      >
                        <ArrowRightIcon />
                        {KANBAN_COLUMN_LABELS[status]}
                      </MenuItem>
                    ))}
                  </MenuGroup>
                </>
              ) : null}
              {onArchive ? (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={() => onArchive(item)}>
                    <ArchiveIcon />
                    Archive
                  </MenuItem>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>

      {item.description ? (
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {item.description}
        </p>
      ) : null}

      {item.threadId !== null ? (
        <button
          className="mt-2.5 w-full rounded-md border border-border/65 bg-muted/25 p-2 text-left outline-none hover:bg-accent/55 focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
          onClick={() => onOpenThread(item)}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {thread?.title ?? "Linked thread unavailable"}
            </span>
            <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
          </span>
          {trace ? (
            <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                className={cn("size-1.5 shrink-0 rounded-full", TRACE_TONE_CLASSES[trace.tone])}
              />
              <span>{trace.label}</span>
              {trace.branch ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="truncate font-mono">{trace.branch}</span>
                </>
              ) : null}
            </span>
          ) : null}
        </button>
      ) : (
        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/55 pt-2">
          <span className="truncate text-[11px] text-muted-foreground/70">
            {project?.title ?? "Project work"}
          </span>
          <Badge className="font-normal" size="sm" variant="outline">
            Unlinked
          </Badge>
        </div>
      )}
    </article>
  );
}

function ArchivedBoard({
  items,
  onOpenThread,
  onRestore,
  pendingItemIds,
  project,
  threadById,
}: {
  readonly items: ReadonlyArray<KanbanWorkItem>;
  readonly onOpenThread: (item: KanbanWorkItem) => void;
  readonly onRestore: (item: KanbanWorkItem) => void;
  readonly pendingItemIds: ReadonlySet<KanbanWorkItemId>;
  readonly project: EnvironmentProject | null;
  readonly threadById: ReadonlyMap<ThreadId, EnvironmentThreadShell>;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto max-w-5xl">
        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Archived work</h2>
            <p className="text-sm text-muted-foreground">
              Restore an item to return it to its previous column.
            </p>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">{items.length}</span>
        </div>
        {items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            Nothing archived for this project.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <div key={item.id} className="relative">
                <KanbanCard
                  grouped={EMPTY_GROUPED_ITEMS}
                  item={item}
                  pending={pendingItemIds.has(item.id)}
                  project={project}
                  thread={item.threadId === null ? null : (threadById.get(item.threadId) ?? null)}
                  onOpenThread={onOpenThread}
                />
                <Button
                  className="mt-2 w-full"
                  disabled={pendingItemIds.has(item.id)}
                  size="xs"
                  variant="outline"
                  onClick={() => onRestore(item)}
                >
                  <ArchiveRestoreIcon />
                  Restore to {KANBAN_COLUMN_LABELS[item.status]}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
