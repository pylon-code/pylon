import { ChevronDownIcon, ListTodoIcon, UsersIcon, XIcon } from "lucide-react";
import { memo } from "react";

import { formatDuration } from "../../session-logic";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  TASK_PROGRESS_STATUS_LABEL,
  keyedTaskProgressSteps,
  TaskProgressSegments,
  TaskStatusIndicator,
} from "./TaskProgressStatus";

export interface ComposerTasksProgress {
  readonly step: string;
  readonly completedSteps: number;
  readonly totalSteps: number;
}

export type ComposerTaskStep =
  | {
      readonly durationMs?: number;
      readonly step: string;
      readonly status: "pending" | "inProgress" | "completed";
    }
  | {
      readonly durationMs?: number;
      readonly step: string;
      readonly status: "waiting";
      readonly waitingOn: "user" | "delegates" | "external";
    };

export interface ComposerDelegatedWorkSummary {
  readonly workingAgents: number;
  readonly waitingAgents: number;
}

export interface ComposerTasksDismissalSnapshot {
  readonly turnId: string;
  readonly waitingKey: string | null;
}

export function composerTasksWaitingKey(
  steps: readonly ComposerTaskStep[] | null | undefined,
): string | null {
  const waitingStep = steps?.find((step) => step.status === "waiting");
  return waitingStep ? `${waitingStep.step}:${waitingStep.waitingOn}` : null;
}

export function areComposerTasksDismissed(
  snapshot: ComposerTasksDismissalSnapshot | null,
  activeTurnId: string | null,
  steps: readonly ComposerTaskStep[] | null | undefined,
): boolean {
  return (
    activeTurnId !== null &&
    snapshot?.turnId === activeTurnId &&
    snapshot.waitingKey === composerTasksWaitingKey(steps)
  );
}

function delegatedWorkLabel(
  summary: ComposerDelegatedWorkSummary | null | undefined,
): string | null {
  if (!summary || summary.workingAgents + summary.waitingAgents === 0) return null;
  const parts: string[] = [];
  if (summary.workingAgents > 0) {
    parts.push(
      `${summary.workingAgents} ${summary.workingAgents === 1 ? "agent" : "agents"} working`,
    );
  }
  if (summary.waitingAgents > 0) {
    parts.push(
      parts.length === 0
        ? `${summary.waitingAgents} ${summary.waitingAgents === 1 ? "agent" : "agents"} waiting`
        : `${summary.waitingAgents} waiting`,
    );
  }
  return parts.join(", ");
}

function waitingOwnerLabel(waitingOn: "user" | "delegates" | "external"): string {
  switch (waitingOn) {
    case "user":
      return "Needs your input";
    case "delegates":
      return "Waiting on agents";
    case "external":
      return "Waiting on external system";
  }
}

export const ComposerTasksBadge = memo(function ComposerTasksBadge({
  delegatedWork,
  expanded,
  hasTrailingShoulder = false,
  onDismiss,
  onToggle,
  placement = "tab",
  progress,
  steps,
}: {
  readonly delegatedWork?: ComposerDelegatedWorkSummary | null;
  readonly expanded: boolean;
  readonly hasTrailingShoulder?: boolean;
  readonly onDismiss: () => void;
  readonly onToggle: () => void;
  readonly placement?: "inline" | "tab";
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  if (progress.totalSteps <= 0) return null;

  const allDone = progress.completedSteps >= progress.totalSteps;
  const currentStep = steps.find((step) => step.status === "inProgress");
  const waitingStep = steps.find((step) => step.status === "waiting");
  const nextStep = steps.find((step) => step.status === "pending");
  const labelStep = currentStep?.step ?? waitingStep?.step ?? nextStep?.step ?? progress.step;
  const labelContext = currentStep
    ? "Current task"
    : waitingStep
      ? "Waiting task"
      : allDone
        ? "Completed plan"
        : "Next task";
  const delegatesLabel = delegatedWorkLabel(delegatedWork);
  const label = [
    `Tasks: ${progress.completedSteps} of ${progress.totalSteps} complete. ${labelContext}: ${labelStep}.`,
    waitingStep ? `${waitingOwnerLabel(waitingStep.waitingOn)}.` : null,
    delegatesLabel ? `${delegatesLabel}.` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  if (placement === "inline") {
    return (
      <span className="inline-flex shrink-0 items-center gap-0.5" data-composer-tasks-badge="true">
        <Button
          size="micro"
          variant="ghost-muted"
          aria-expanded={expanded}
          aria-label={label}
          className="shrink-0 gap-1 px-1.5"
          onClick={onToggle}
          onPointerDown={(event) => event.preventDefault()}
        >
          <ListTodoIcon aria-hidden className="size-3 shrink-0" />
          <span>Tasks</span>
          <TaskProgressSegments fit className="w-10" steps={steps} />
          <span
            className={cn(
              "font-medium tabular-nums",
              allDone ? "text-success" : "text-muted-foreground",
            )}
          >
            {progress.completedSteps}/{progress.totalSteps}
          </span>
          {delegatesLabel ? (
            <span className="inline-flex items-center gap-1 text-foreground/70">
              <UsersIcon aria-hidden className="size-3 shrink-0" />
              <span>{delegatesLabel}</span>
            </span>
          ) : null}
        </Button>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Dismiss tasks for this turn"
          className="shrink-0"
          onClick={onDismiss}
          onPointerDown={(event) => event.preventDefault()}
        >
          <XIcon aria-hidden className="size-2.5" />
        </Button>
      </span>
    );
  }

  return (
    <div
      className={cn(
        "chat-composer-shoulder-tab chat-composer-tasks-tab absolute -top-7 left-5.5 z-0 flex h-8 items-center gap-1 rounded-t-xl border border-b-0 px-2 pb-1 text-xs leading-none text-muted-foreground",
        hasTrailingShoulder ? "right-30" : "right-5.5",
        allDone && "text-foreground",
      )}
      data-composer-tasks-badge="true"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={label}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-muted-foreground hover:text-foreground"
        onClick={onToggle}
        onPointerDown={(event) => event.preventDefault()}
      >
        <ListTodoIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0">Tasks</span>
        <span
          className="min-w-0 flex-1 truncate text-left font-medium text-foreground/80"
          data-composer-task-current="true"
        >
          {progress.step}
        </span>
        <span
          className={cn(
            "shrink-0 font-medium tabular-nums",
            allDone ? "text-success" : "text-muted-foreground",
          )}
        >
          {progress.completedSteps}/{progress.totalSteps}
        </span>
        {delegatesLabel ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-foreground/70">
            <UsersIcon aria-hidden className="size-3 shrink-0" />
            <span>{delegatesLabel}</span>
          </span>
        ) : null}
        <TaskProgressSegments fit className="w-20" steps={steps} />
      </button>
      <Button
        size="icon-micro"
        variant="ghost-muted"
        aria-label="Dismiss tasks for this turn"
        className="shrink-0"
        onClick={onDismiss}
        onPointerDown={(event) => event.preventDefault()}
      >
        <XIcon aria-hidden className="size-3" />
      </Button>
    </div>
  );
});

export const ComposerTasksDrawer = memo(function ComposerTasksDrawer({
  delegatedWork,
  onDismiss,
  onCollapse,
  progress,
  steps,
}: {
  readonly delegatedWork?: ComposerDelegatedWorkSummary | null;
  readonly onDismiss: () => void;
  readonly onCollapse: () => void;
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  const delegatesLabel = delegatedWorkLabel(delegatedWork);
  return (
    <div
      className="chat-composer-top-drawer"
      data-chat-composer-collapsed-controls="true"
      data-chat-composer-tasks-drawer="true"
    >
      <div className="flex items-center gap-1 px-3 py-1.5 sm:px-4">
        <button
          type="button"
          aria-expanded="true"
          aria-label={`Collapse tasks. ${progress.completedSteps} of ${progress.totalSteps} complete.`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={onCollapse}
          onPointerDown={(event) => event.preventDefault()}
        >
          <ListTodoIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="font-medium text-foreground">Tasks</span>
          <span className="tabular-nums">
            {progress.completedSteps}/{progress.totalSteps}
          </span>
          {delegatesLabel ? (
            <span className="inline-flex items-center gap-1 text-foreground/70">
              <UsersIcon aria-hidden className="size-3 shrink-0" />
              <span>{delegatesLabel}</span>
            </span>
          ) : null}
          <ChevronDownIcon aria-hidden className="ml-auto size-3.5 shrink-0" />
        </button>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Dismiss tasks for this turn"
          className="shrink-0"
          onClick={onDismiss}
          onPointerDown={(event) => event.preventDefault()}
        >
          <XIcon aria-hidden className="size-3" />
        </Button>
      </div>
      <div
        aria-label={`Task list. ${progress.completedSteps} of ${progress.totalSteps} complete.`}
        className="max-h-[min(24rem,40dvh)] space-y-px overflow-y-auto overscroll-contain px-3 pb-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 sm:px-4"
        data-composer-tasks-list="true"
        role="list"
        tabIndex={0}
      >
        {keyedTaskProgressSteps(steps).map(({ key, step }) => (
          <div key={key} className="flex items-start gap-2 text-xs leading-5" role="listitem">
            <span className="flex h-5 shrink-0 items-center">
              <TaskStatusIndicator
                aria-hidden
                status={step.status}
                waitingOn={step.status === "waiting" ? step.waitingOn : undefined}
              />
            </span>
            <span className="sr-only">{TASK_PROGRESS_STATUS_LABEL[step.status]}: </span>
            <span
              className={cn(
                "min-w-0 flex-1",
                step.status === "completed"
                  ? "text-muted-foreground/55"
                  : step.status === "inProgress"
                    ? "text-foreground/90"
                    : step.status === "waiting" && step.waitingOn === "user"
                      ? "text-warning"
                      : "text-muted-foreground/70",
              )}
            >
              {step.step}
            </span>
            <span
              className={cn(
                "ml-auto shrink-0 text-right text-[10px] tabular-nums",
                step.status === "waiting" && step.waitingOn === "user"
                  ? "text-warning"
                  : "text-muted-foreground/45",
              )}
              data-composer-task-duration="true"
            >
              {step.status === "waiting"
                ? waitingOwnerLabel(step.waitingOn)
                : step.durationMs !== undefined
                  ? formatDuration(step.durationMs)
                  : step.status === "inProgress"
                    ? "now"
                    : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
