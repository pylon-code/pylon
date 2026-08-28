import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { DotMatrix, type DotMatrixState } from "../ui/dot-matrix";

export type TaskProgressStatus = "pending" | "inProgress" | "completed";

export interface TaskProgressStep {
  readonly step: string;
  readonly status: TaskProgressStatus;
}

const MATRIX_BY_STATUS: Record<TaskProgressStatus, DotMatrixState> = {
  pending: "idle",
  inProgress: "loading",
  completed: "success",
};

const SEGMENT_TONE_BY_STATUS: Record<TaskProgressStatus, string> = {
  pending: "bg-muted-foreground/25",
  inProgress: "bg-status-active",
  completed: "bg-success",
};

export const TASK_PROGRESS_STATUS_LABEL: Record<TaskProgressStatus, string> = {
  pending: "Pending",
  inProgress: "In progress",
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
            SEGMENT_TONE_BY_STATUS[step.status],
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
  ...props
}: Omit<ComponentProps<typeof DotMatrix>, "state" | "sizeRole"> & {
  readonly status: TaskProgressStatus;
}) {
  return (
    <DotMatrix
      sizeRole="compact"
      state={MATRIX_BY_STATUS[status]}
      className={className}
      {...props}
    />
  );
}
