import { ListTodoIcon, UsersIcon } from "lucide-react";
import { memo, type ComponentProps } from "react";

import { formatDuration } from "../../session-logic";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";
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

/**
 * A `waiting` step names who the turn is blocked on, which upstream's badge has
 * no concept of. The union keeps `waitingOn` unreachable for other statuses.
 */
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

/**
 * A dismissal holds only for the turn it was made in, and only while the badge
 * waits on the same thing: a fresh blocking question re-opens it rather than
 * staying hidden behind an earlier dismissal.
 */
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

function tasksAriaLabel(input: {
  readonly expanded: boolean;
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
  readonly delegatesLabel: string | null;
}): string {
  const currentStep = input.steps.find((step) => step.status === "inProgress");
  const waitingStep = input.steps.find((step) => step.status === "waiting");
  const allDone = input.progress.completedSteps >= input.progress.totalSteps;
  // "Current task" is a lie for a plan that is waiting, finished, or not started.
  const labelContext = currentStep
    ? "Current task"
    : waitingStep
      ? "Waiting task"
      : allDone
        ? "Completed plan"
        : "Next task";
  return [
    `${input.expanded ? "Collapse tasks" : "Tasks"}: ${input.progress.completedSteps} of ${input.progress.totalSteps} complete. ${labelContext}: ${input.progress.step}.`,
    waitingStep ? `${waitingOwnerLabel(waitingStep.waitingOn)}.` : null,
    input.delegatesLabel ? `${input.delegatesLabel}.` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

function TaskSummary({
  expanded,
  progress,
  steps,
  delegatesLabel,
}: {
  readonly expanded: boolean;
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
  readonly delegatesLabel: string | null;
}) {
  return (
    <>
      <ComposerBanner.Icon>
        <ListTodoIcon />
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span className="shrink-0 text-muted-foreground">Tasks</span>
        <span
          className="min-w-0 flex-1 truncate text-left font-medium text-foreground/80"
          data-composer-task-current="true"
        >
          {progress.step}
        </span>
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        <ComposerBanner.Count
          className={progress.completedSteps >= progress.totalSteps ? "text-success" : undefined}
          data-composer-task-progress="true"
        >
          {progress.completedSteps}/{progress.totalSteps}
        </ComposerBanner.Count>
        {delegatesLabel ? (
          <span
            className="hidden shrink-0 items-center gap-1 text-foreground/70 sm:inline-flex"
            data-composer-task-delegates="true"
          >
            <UsersIcon aria-hidden className="size-3 shrink-0" />
            <span>{delegatesLabel}</span>
          </span>
        ) : null}
        {/* The expanded list already shows every step; the bar would repeat it. */}
        {expanded ? null : (
          <TaskProgressSegments fit className="hidden w-20 sm:flex" steps={steps} />
        )}
        <ComposerBanner.ToggleIcon expanded={expanded} />
      </ComposerBanner.Actions>
    </>
  );
}

export const ComposerTasksBadge = memo(function ComposerTasksBadge({
  expanded,
  onToggle,
  onDismiss,
  placement = "tab",
  progress,
  steps,
  delegatedWork,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onDismiss?: (() => void) | undefined;
  readonly placement?: "inline" | "tab";
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
  readonly delegatedWork?: ComposerDelegatedWorkSummary | null;
}) {
  if (progress.totalSteps <= 0) return null;

  const delegatesLabel = delegatedWorkLabel(delegatedWork);
  const row = (
    <ComposerBanner.Row
      render={<button type="button" />}
      aria-expanded={expanded}
      aria-label={tasksAriaLabel({ expanded, progress, steps, delegatesLabel })}
      className={onDismiss ? "pe-7" : undefined}
      data-composer-tasks-badge="true"
      onClick={onToggle}
      onPointerDown={(event) => event.preventDefault()}
    >
      <TaskSummary
        expanded={expanded}
        progress={progress}
        steps={steps}
        delegatesLabel={delegatesLabel}
      />
    </ComposerBanner.Row>
  );
  // The row is itself the disclosure button, so dismiss cannot nest inside it.
  const dismiss = onDismiss ? (
    <ComposerBanner.Dismiss
      aria-label="Dismiss tasks for this turn"
      className="absolute end-1 top-1/2 -translate-y-1/2"
      onClick={onDismiss}
      onPointerDown={(event) => event.preventDefault()}
    />
  ) : null;

  if (placement === "inline") {
    return dismiss ? (
      <div className="relative">
        {row}
        {dismiss}
      </div>
    ) : (
      row
    );
  }
  return (
    <ComposerBanner.Root className={dismiss ? "relative" : undefined} data-composer-shoulder-tab>
      {row}
      {dismiss}
    </ComposerBanner.Root>
  );
});

export const ComposerTasksContent = memo(function ComposerTasksContent({
  expanded,
  onToggle,
  onDismiss,
  progress,
  steps,
  delegatedWork,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onDismiss?: (() => void) | undefined;
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
  readonly delegatedWork?: ComposerDelegatedWorkSummary | null;
}) {
  return (
    <div
      data-chat-composer-collapsed-controls="true"
      data-chat-composer-tasks-drawer={expanded ? "true" : undefined}
    >
      <ComposerTasksBadge
        expanded={expanded}
        onToggle={onToggle}
        {...(onDismiss ? { onDismiss } : {})}
        placement="inline"
        progress={progress}
        steps={steps}
        {...(delegatedWork === undefined ? {} : { delegatedWork })}
      />
      {expanded ? (
        <ComposerBanner.Scroll data-composer-tasks-scroll="true">
          <ComposerBanner.Children
            render={<ul role="list" />}
            aria-label={`Task list. ${progress.completedSteps} of ${progress.totalSteps} complete.`}
            data-composer-tasks-list="true"
          >
            {keyedTaskProgressSteps(steps).map(({ key, step }) => (
              <ComposerBanner.Row key={key} render={<li />}>
                <ComposerBanner.Icon>
                  <TaskStatusIndicator
                    aria-hidden
                    status={step.status}
                    waitingOn={step.status === "waiting" ? step.waitingOn : undefined}
                  />
                </ComposerBanner.Icon>
                <span className="sr-only">{TASK_PROGRESS_STATUS_LABEL[step.status]}: </span>
                <ComposerBanner.Content
                  className={cn(
                    step.status === "completed"
                      ? "text-muted-foreground/55"
                      : step.status === "inProgress"
                        ? "text-foreground/90"
                        : step.status === "waiting"
                          ? "text-foreground/80"
                          : "text-muted-foreground/70",
                  )}
                >
                  {step.step}
                </ComposerBanner.Content>
                <ComposerBanner.Actions>
                  <span
                    className="w-10 text-right text-[10px] text-muted-foreground/45 tabular-nums"
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
                </ComposerBanner.Actions>
              </ComposerBanner.Row>
            ))}
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      ) : null}
    </div>
  );
});

export const ComposerTasksDrawer = memo(function ComposerTasksDrawer({
  onCollapse,
  ...props
}: Omit<ComponentProps<typeof ComposerTasksContent>, "expanded" | "onToggle"> & {
  readonly onCollapse: () => void;
}) {
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root>
        <ComposerTasksContent {...props} expanded onToggle={onCollapse} />
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
