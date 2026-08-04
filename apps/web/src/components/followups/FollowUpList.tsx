import { useAtomValue } from "@effect/atom-react";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EMPTY_FOLLOW_UP_CLIENT_STATE } from "@t3tools/client-runtime/state/followups";
import { CommandId, type FollowUp, type ScopedProjectRef } from "@t3tools/contracts";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  ClipboardListIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ShieldOffIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { sortScopedProjectsForSidebar } from "~/components/Sidebar.logic";
import { isElectron } from "~/env";
import { cn, randomUUID } from "~/lib/utils";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { followUpEnvironment } from "~/state/followups";
import { useAtomCommand } from "~/state/use-atom-command";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { Badge } from "../ui/badge";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Field, FieldLabel } from "../ui/field";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { FollowUpDialog } from "./FollowUpDialog";
import {
  FOLLOW_UP_DEFER_REASON_LABELS,
  FOLLOW_UP_KIND_LABELS,
  groupFollowUps,
} from "./followUps.logic";

interface ProjectOption {
  readonly value: string;
  readonly label: string;
}

export function FollowUpList() {
  const projects = useProjects();
  const threads = useThreadShells();
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const { environments } = useEnvironments();
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null | undefined>(
    undefined,
  );
  const [dialogProjectRef, setDialogProjectRef] = useState<ScopedProjectRef | null>(null);

  const orderedProjects = useMemo(
    () => sortScopedProjectsForSidebar(projects, threads, "updated_at"),
    [projects, threads],
  );
  const environmentLabels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const projectByKey = useMemo(
    () =>
      new Map(
        orderedProjects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          project,
        ]),
      ),
    [orderedProjects],
  );
  const selectedProject =
    selectedProjectKey === undefined || selectedProjectKey === null
      ? null
      : (projectByKey.get(selectedProjectKey) ?? orderedProjects[0] ?? null);
  const projectItems = useMemo<ReadonlyArray<ProjectOption>>(
    () =>
      orderedProjects.map((project) => ({
        value: scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
        label: `${project.title} · ${environmentLabels.get(project.environmentId) ?? project.environmentId}`,
      })),
    [environmentLabels, orderedProjects],
  );

  useEffect(() => {
    if (!shellsBootstrapped || selectedProjectKey !== undefined) return;
    const firstProject = orderedProjects[0];
    setSelectedProjectKey(
      firstProject
        ? scopedProjectKey(scopeProjectRef(firstProject.environmentId, firstProject.id))
        : null,
    );
  }, [orderedProjects, selectedProjectKey, shellsBootstrapped]);

  if (!shellsBootstrapped || selectedProjectKey === undefined) {
    return (
      <Empty className="min-h-0 flex-1" role="status">
        <EmptyHeader>
          <EmptyTitle>Loading projects…</EmptyTitle>
          <EmptyDescription>Waiting for connected environments.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (selectedProject === null) {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyMedia variant="icon">
          <ClipboardListIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No projects yet</EmptyTitle>
          <EmptyDescription>
            Add a project before filing project-scoped follow-ups.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const selectedRef = scopeProjectRef(selectedProject.environmentId, selectedProject.id);
  const selectedKey = scopedProjectKey(selectedRef);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        className={cn(
          "workspace-topbar shrink-0 border-b border-border/70 px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
          isElectron && "drag-region",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3">
          <h1 className="shrink-0 text-sm font-semibold text-foreground">Follow-ups</h1>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2 [-webkit-app-region:no-drag]">
            <Select
              items={projectItems}
              value={selectedKey}
              onValueChange={(value) => value && setSelectedProjectKey(value)}
            >
              <SelectTrigger
                aria-label="Follow-ups project"
                className="min-w-0 flex-1 sm:w-64 sm:flex-none"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectPopup matchTriggerWidth>
                {projectItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button size="sm" onClick={() => setDialogProjectRef(selectedRef)}>
              <PlusIcon />
              Add
            </Button>
          </div>
        </div>
      </header>
      <ProjectFollowUps key={selectedKey} projectRef={selectedRef} />
      {dialogProjectRef ? (
        <FollowUpDialog
          projectRef={dialogProjectRef}
          projectTitle={projectByKey.get(scopedProjectKey(dialogProjectRef))?.title ?? "project"}
          onClose={() => setDialogProjectRef(null)}
        />
      ) : null}
    </div>
  );
}

function ProjectFollowUps({ projectRef }: { readonly projectRef: ScopedProjectRef }) {
  const result = useAtomValue(
    followUpEnvironment.list({ environmentId: projectRef.environmentId, input: null }),
  );
  const state = AsyncResult.getOrElse(result, () => EMPTY_FOLLOW_UP_CLIENT_STATE);
  const items = useMemo(
    () => state.snapshot.items.filter((item) => item.projectId === projectRef.projectId),
    [projectRef.projectId, state.snapshot.items],
  );
  const grouped = useMemo(() => groupFollowUps(items), [items]);
  const openCount = grouped.blocker.length + grouped.open.length + grouped.idea.length;

  if (result._tag === "Failure") {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyHeader>
          <EmptyTitle>Couldn’t load follow-ups</EmptyTitle>
          <EmptyDescription>Check the environment connection and try again.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (!state.synchronized) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-3 px-4 py-6 sm:px-6">
        <p className="text-xs font-medium text-muted-foreground">Loading follow-ups…</p>
        {[0, 1, 2].map((index) => (
          <div key={index} className="h-28 rounded-lg border border-border/60 bg-card/20" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyMedia variant="icon">
          <ClipboardListIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No follow-ups</EmptyTitle>
          <EmptyDescription>
            Deferred work for this project will appear here with its evidence and verify check.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-5xl gap-7 px-4 py-6 sm:px-6">
        {(["blocker", "open", "idea"] as const).map((kind) => (
          <FollowUpSection
            key={kind}
            items={grouped[kind]}
            label={FOLLOW_UP_KIND_LABELS[kind]}
            projectRef={projectRef}
          />
        ))}
        <details className="group rounded-lg border border-border/55 bg-card/15">
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium text-muted-foreground outline-none ring-ring focus-visible:ring-2 focus-visible:ring-inset">
            <ChevronRightIcon className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
            Closed
            <span className="tabular-nums text-xs text-muted-foreground/70">
              {grouped.closed.length}
            </span>
          </summary>
          <div className="border-t border-border/55">
            {grouped.closed.length > 0 ? (
              grouped.closed.map((item) => (
                <FollowUpRow key={item.id} item={item} projectRef={projectRef} />
              ))
            ) : (
              <p className="px-3 py-3 text-xs text-muted-foreground">No closed follow-ups.</p>
            )}
          </div>
        </details>
        {openCount === 0 ? (
          <p className="text-center text-xs text-muted-foreground">All follow-ups are closed.</p>
        ) : null}
      </div>
    </div>
  );
}

function FollowUpSection({
  label,
  items,
  projectRef,
}: {
  readonly label: string;
  readonly items: ReadonlyArray<FollowUp>;
  readonly projectRef: ScopedProjectRef;
}) {
  return (
    <section aria-labelledby={`follow-up-${label.toLowerCase()}`}>
      <div className="mb-2 flex items-baseline gap-2 px-1">
        <h2
          id={`follow-up-${label.toLowerCase()}`}
          className="text-sm font-semibold text-foreground"
        >
          {label}
        </h2>
        <span className="tabular-nums text-xs text-muted-foreground">{items.length}</span>
      </div>
      {items.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-border/60 bg-card/20">
          {items.map((item) => (
            <FollowUpRow key={item.id} item={item} projectRef={projectRef} />
          ))}
        </div>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">None.</p>
      )}
    </section>
  );
}

function FollowUpRow({
  item,
  projectRef,
}: {
  readonly item: FollowUp;
  readonly projectRef: ScopedProjectRef;
}) {
  const [resolutionStatus, setResolutionStatus] = useState<"resolved" | "waived" | null>(null);

  return (
    <article className="border-b border-border/50 p-3 last:border-b-0 sm:p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="min-w-0 text-sm font-semibold leading-5 text-foreground">
              {item.title}
            </h3>
            <Badge size="sm" variant="outline">
              {FOLLOW_UP_DEFER_REASON_LABELS[item.deferReason]}
            </Badge>
            <Badge size="sm" variant="secondary">
              {item.sourceKind === "agent" ? "Agent filed" : "Human filed"}
            </Badge>
            {item.status !== "open" ? (
              <Badge size="sm" variant="success">
                {item.status}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">{item.observation}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="rounded-md border border-border/55 bg-background/45 px-2.5 py-2">
              <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                Verify
              </p>
              <p className="mt-0.5 text-xs leading-4 text-foreground/90">{item.verifyCheck}</p>
            </div>
            {item.gate ? (
              <div className="flex min-w-36 items-start gap-2 rounded-md border border-border/55 bg-background/45 px-2.5 py-2">
                <GitBranchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                    Branch gate
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs text-foreground/90">
                    {item.gate.ref}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
          {item.evidence.length > 0 ? (
            <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground/80">
              {item.evidence
                .map(
                  (evidence) =>
                    `${evidence.path}${evidence.line === null ? "" : `:${evidence.line}`}`,
                )
                .join(" · ")}
            </p>
          ) : null}
        </div>
        {item.status === "open" ? (
          <Menu>
            <MenuTrigger
              aria-label={`Actions for ${item.title}`}
              render={<Button size="icon-sm" variant="ghost" />}
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setResolutionStatus("resolved")}>
                <CheckCircle2Icon />
                Resolve
              </MenuItem>
              <MenuItem onClick={() => setResolutionStatus("waived")}>
                <ShieldOffIcon />
                Waive
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      {resolutionStatus ? (
        <FollowUpResolutionDialog
          item={item}
          projectRef={projectRef}
          status={resolutionStatus}
          onClose={() => setResolutionStatus(null)}
        />
      ) : null}
    </article>
  );
}

function FollowUpResolutionDialog({
  item,
  projectRef,
  status,
  onClose,
}: {
  readonly item: FollowUp;
  readonly projectRef: ScopedProjectRef;
  readonly status: "resolved" | "waived";
  readonly onClose: () => void;
}) {
  const updateStatus = useAtomCommand(followUpEnvironment.updateStatus, "update follow-up status");
  const [note, setNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const actionLabel = status === "resolved" ? "Resolve" : "Waive";

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (note.trim().length === 0 || isSaving) return;

    setIsSaving(true);
    const result = await updateStatus({
      environmentId: projectRef.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        itemId: item.id,
        expectedRevision: item.revision,
        status,
        resolution: { note: note.trim(), threadId: null, commitSha: null },
        actor: "human",
      },
    });
    setIsSaving(false);

    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `Follow-up ${status}` });
      onClose();
      return;
    }
    toastManager.add({
      type: "error",
      title: `Couldn’t ${status === "resolved" ? "resolve" : "waive"} follow-up`,
      description: "The dossier changed or the environment rejected the update.",
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="overflow-hidden">
        <form className="flex min-h-0 flex-1 flex-col overflow-hidden" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{actionLabel} follow-up</DialogTitle>
            <DialogDescription>
              Add the required resolution note for “{item.title}”.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Field>
              <FieldLabel>Resolution note</FieldLabel>
              <Textarea
                autoFocus
                maxLength={4000}
                required
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={
                  status === "resolved"
                    ? "What changed, and how was the verify check satisfied?"
                    : "Why is this work intentionally being waived?"
                }
              />
            </Field>
          </DialogPanel>
          <DialogFooter>
            <Button disabled={isSaving} onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button
              disabled={note.trim().length === 0 || isSaving}
              type="submit"
              variant={status === "waived" ? "destructive" : "default"}
            >
              {isSaving ? `${actionLabel.slice(0, -1)}ing…` : actionLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
