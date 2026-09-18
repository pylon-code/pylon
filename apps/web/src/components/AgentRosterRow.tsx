import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/** Shared three-line agent presentation; each transport supplies its own supported actions. */
export function AgentRosterRow({
  children,
  activity,
  metadata,
  failed = false,
}: {
  children: ReactNode;
  activity: ReactNode;
  metadata: ReactNode;
  failed?: boolean;
}) {
  return (
    <div className="grid h-[3.875rem] grid-cols-[0.375rem_minmax(0,1fr)_auto_auto_1.75rem_1.75rem] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1">
      {children}
      <span
        className={cn(
          "col-start-2 col-end-7 row-start-2 block truncate text-xs",
          failed ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {activity}
      </span>
      <span className="col-start-2 col-end-7 row-start-3 truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70">
        {metadata}
      </span>
    </div>
  );
}
