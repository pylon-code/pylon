import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { KanbanWorkItem, ProjectId, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

const NO_LINKED_THREAD = "__no-linked-thread__";

export interface KanbanWorkItemDraft {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly title: string;
  readonly description: string | null;
}

export type KanbanWorkItemDialogMode =
  | { readonly kind: "create"; readonly initialProjectId: ProjectId | null }
  | { readonly kind: "edit"; readonly item: KanbanWorkItem };

interface KanbanWorkItemDialogProps {
  readonly mode: KanbanWorkItemDialogMode;
  readonly open: boolean;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (draft: KanbanWorkItemDraft) => Promise<string | null>;
}

export function KanbanWorkItemDialog({
  mode,
  onOpenChange,
  onSubmit,
  open,
  projects,
  threads,
}: KanbanWorkItemDialogProps) {
  const initialProjectId =
    mode.kind === "edit" ? mode.item.projectId : (mode.initialProjectId ?? projects[0]?.id ?? null);
  const [projectId, setProjectId] = useState<ProjectId | null>(initialProjectId);
  const [threadId, setThreadId] = useState<ThreadId | null>(
    mode.kind === "edit" ? mode.item.threadId : null,
  );
  const [title, setTitle] = useState(mode.kind === "edit" ? mode.item.title : "");
  const [description, setDescription] = useState(
    mode.kind === "edit" ? (mode.item.description ?? "") : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const nextProjectId =
      mode.kind === "edit"
        ? mode.item.projectId
        : (mode.initialProjectId ?? projects[0]?.id ?? null);
    setProjectId(nextProjectId);
    setThreadId(mode.kind === "edit" ? mode.item.threadId : null);
    setTitle(mode.kind === "edit" ? mode.item.title : "");
    setDescription(mode.kind === "edit" ? (mode.item.description ?? "") : "");
    setError(null);
    setSaving(false);
  }, [mode, open, projects]);

  const linkedThreadOptions = useMemo(
    () =>
      projectId === null
        ? []
        : threads
            .filter((thread) => thread.projectId === projectId && thread.archivedAt === null)
            .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [projectId, threads],
  );

  const projectTitle =
    projects.find((project) => project.id === projectId)?.title ?? "Unknown project";

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (projectId === null) {
      setError("Choose a project for this work item.");
      return;
    }
    if (normalizedTitle.length === 0) {
      setError("Give this work item a title.");
      return;
    }

    setSaving(true);
    setError(null);
    void onSubmit({
      projectId,
      threadId,
      title: normalizedTitle,
      description: description.trim() || null,
    }).then((message) => {
      setSaving(false);
      if (message === null) {
        onOpenChange(false);
      } else {
        setError(message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-xl">
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{mode.kind === "create" ? "Add work item" : "Edit work item"}</DialogTitle>
            <DialogDescription>
              Keep workflow state explicit. Linking a thread adds live T3 context without letting
              the agent move the card for you.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <label className="grid gap-1.5 text-sm font-medium">
              Project
              {mode.kind === "edit" ? (
                <div className="flex h-8 items-center rounded-lg border border-input bg-muted/30 px-3 text-sm text-muted-foreground">
                  {projectTitle}
                </div>
              ) : (
                <Select
                  value={projectId}
                  onValueChange={(value) => {
                    if (value === null) return;
                    setProjectId(value as ProjectId);
                    setThreadId(null);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              Title
              <Input
                autoFocus
                maxLength={240}
                placeholder="What needs to happen?"
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
              />
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              Linked thread <span className="sr-only">(optional)</span>
              <Select
                value={threadId ?? NO_LINKED_THREAD}
                onValueChange={(value) =>
                  setThreadId(
                    value === null || value === NO_LINKED_THREAD ? null : (value as ThreadId),
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="No linked thread" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_LINKED_THREAD}>No linked thread</SelectItem>
                  {linkedThreadOptions.map((thread) => (
                    <SelectItem key={thread.id} value={thread.id}>
                      {thread.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs font-normal text-muted-foreground">
                A link surfaces branch, activity, approvals, and a direct route back to the thread.
              </span>
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              Notes <span className="sr-only">(optional)</span>
              <Textarea
                maxLength={12_000}
                placeholder="Acceptance notes, constraints, or a useful next step…"
                value={description}
                onChange={(event) => setDescription(event.currentTarget.value)}
              />
            </label>

            {error ? (
              <p className="rounded-lg border border-destructive/20 bg-destructive/6 px-3 py-2 text-sm text-destructive-foreground">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              disabled={saving}
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button disabled={saving || projectId === null} type="submit">
              {saving ? "Saving…" : mode.kind === "create" ? "Add to backlog" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
