import {
  boundSessionGoalObjective,
  formatSessionGoalElapsed,
  formatSessionGoalStatus,
  formatSessionGoalTokenUsage,
  type SessionGoalSnapshot,
} from "@t3tools/client-runtime/state/session-goal";
import { TargetIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function SessionGoalControl(props: { readonly snapshot: SessionGoalSnapshot }) {
  const { snapshot } = props;
  const status = formatSessionGoalStatus(snapshot.status);
  const objective = snapshot.objective
    ? boundSessionGoalObjective(snapshot.objective)
    : snapshot.active
      ? "Objective unavailable"
      : "No active objective";
  const accessibilityObjective = boundSessionGoalObjective(objective, 120);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border border-transparent px-2 text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={`Goal ${status.toLowerCase()}: ${accessibilityObjective}. Read-only.`}
          >
            <TargetIcon className="size-3.5" aria-hidden="true" />
            <span className="max-w-20 truncate text-[11px] font-medium">{status}</span>
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="overflow-y-auto p-0"
        className="w-72 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2.5 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Session goal</div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="font-medium text-foreground">{status}</span>
              <span className="text-secondary-label">· Read-only</span>
            </div>
          </div>
          <p className="line-clamp-5 break-words text-pretty text-xs leading-4 text-foreground">
            {objective}
          </p>
          <dl className="grid gap-1.5 border-border/70 border-t pt-2 text-[11px] leading-4">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-secondary-label">Tokens</dt>
              <dd className="font-medium tabular-nums text-muted-foreground">
                {formatSessionGoalTokenUsage(snapshot)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-secondary-label">Elapsed</dt>
              <dd className="font-medium tabular-nums text-muted-foreground">
                {formatSessionGoalElapsed(snapshot.timeUsedSeconds)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-secondary-label">Continuations</dt>
              <dd className="font-medium tabular-nums text-muted-foreground">
                {snapshot.continuationsUsed.toLocaleString()}
              </dd>
            </div>
          </dl>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
