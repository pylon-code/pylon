import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { DotMatrix, type DotMatrixState } from "../ui/dot-matrix";

export type TaskProgressStatus = "pending" | "inProgress" | "waiting" | "completed";
export type TaskProgressWaitingOn = "user" | "delegates" | "external";

export interface TaskProgressStep {
  readonly step: string;
  readonly status: TaskProgressStatus;
  readonly waitingOn?: TaskProgressWaitingOn;
}

function matrixState(
  status: TaskProgressStatus,
  waitingOn?: TaskProgressWaitingOn,
): DotMatrixState {
  switch (status) {
    case "pending":
      return "idle";
    case "inProgress":
      return "loading";
    case "waiting":
      return waitingOn === "user" ? "warning" : "waiting";
    case "completed":
      return "success";
  }
}

function segmentTone(status: TaskProgressStatus, waitingOn?: TaskProgressWaitingOn): string {
  switch (status) {
    case "pending":
      return "bg-muted-foreground/25";
    case "inProgress":
      return "bg-status-active";
    case "waiting":
      return waitingOn === "user" ? "bg-warning" : "bg-muted-foreground/50";
    case "completed":
      return "bg-success";
  }
}

export const TASK_PROGRESS_STATUS_LABEL: Record<TaskProgressStatus, string> = {
  pending: "Pending",
  inProgress: "In progress",
  waiting: "Waiting",
  completed: "Completed",
};

export function keyedTaskProgressSteps<const Step extends TaskProgressStep>(
  steps: readonly Step[],
): ReadonlyArray<{ readonly key: string; readonly step: Step }> {
  const occurrences = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = occurrences.get(step.step) ?? 0;
    occurrences.set(step.step, occurrence + 1);
    return { key: `${step.step}:${occurrence}`, step };
  });
}

export function TaskProgressSegments({
  className,
  fit = false,
  steps,
}: {
  readonly className?: string;
  readonly fit?: boolean;
  readonly steps: readonly TaskProgressStep[];
}) {
  if (steps.length <= 1) return null;

  return (
    <span
      aria-hidden
      className={cn("flex shrink-0 items-center gap-0.5", className)}
      data-task-progress-segments="true"
    >
      {keyedTaskProgressSteps(steps).map(({ key, step }) => (
        <span
          key={key}
          className={cn(
            "h-[3px] rounded-full",
            fit ? "min-w-0 flex-1" : "w-2.5 shrink-0",
            segmentTone(step.status, step.waitingOn),
          )}
          data-task-status={step.status}
        />
      ))}
    </span>
  );
}

export function TaskStatusIndicator({
  className,
  status,
  waitingOn,
  ...props
}: Omit<ComponentProps<typeof DotMatrix>, "state" | "sizeRole"> & {
  readonly status: TaskProgressStatus;
  readonly waitingOn?: TaskProgressWaitingOn | undefined;
}) {
  return (
    <DotMatrix
      sizeRole="compact"
      state={matrixState(status, waitingOn)}
      className={className}
      {...props}
    />
  );
}
