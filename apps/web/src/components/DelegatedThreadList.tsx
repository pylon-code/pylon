import type { delegatedThreadRows } from "@t3tools/client-runtime/state/delegated-threads";
import { Link } from "@tanstack/react-router";
import { AgentRosterRow } from "./AgentRosterRow";
import { cn } from "~/lib/utils";

export type DelegatedThreadRows = ReturnType<typeof delegatedThreadRows>;

const labels = {
  starting: "Starting",
  running: "Working",
  "needs-approval": "Needs approval",
  "needs-input": "Needs input",
  completed: "Completed · review result",
  error: "Failed",
  interrupted: "Interrupted",
  archived: "Archived",
};

/** Same roster presentation as native agents, with actions addressed to the child thread. */
export function DelegatedThreadList({ rows }: { rows: DelegatedThreadRows }) {
  return rows.map((row) => (
    <AgentRosterRow
      key={row.threadId}
      activity={row.activity ? `${labels[row.status]} · ${row.activity}` : labels[row.status]}
      metadata={`${row.providerName ?? row.modelSelection.instanceId} · ${row.modelSelection.model}`}
      failed={row.status === "error"}
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            row.status === "error"
              ? "bg-destructive"
              : row.status === "completed"
                ? "bg-success"
                : row.status === "archived" || row.status === "interrupted"
                  ? "bg-muted-foreground/60"
                  : "bg-info",
          )}
        />
      </span>
      <span className="col-start-2 row-start-1 min-w-0 truncate text-sm font-medium">
        {row.title}
      </span>
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId: row.environmentId, threadId: row.threadId }}
        className="col-start-3 col-end-7 row-start-1 justify-self-end rounded-sm px-1.5 py-1 text-[.65rem] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        Open thread
      </Link>
    </AgentRosterRow>
  ));
}
