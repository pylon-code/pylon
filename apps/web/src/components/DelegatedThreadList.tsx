import type { delegatedThreadRows } from "@t3tools/client-runtime/state/delegated-threads";
import { Link } from "@tanstack/react-router";

export type DelegatedThreadRows = ReturnType<typeof delegatedThreadRows>;

const labels = {
  starting: "Starting",
  running: "Running",
  "needs-approval": "Needs approval",
  "needs-input": "Needs input",
  completed: "Completed · review result",
  error: "Failed",
  interrupted: "Interrupted",
  archived: "Archived",
};

/** Shared Pylon roster; controls always address the child thread, never native agent IDs. */
export function DelegatedThreadList({ rows }: { rows: DelegatedThreadRows }) {
  return (
    <div className="grid gap-1">
      {rows.map((row) => (
        <div key={row.threadId} className="rounded-md border border-border/60 px-2.5 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={`size-1.5 shrink-0 rounded-full ${row.status === "error" ? "bg-destructive" : row.status === "completed" ? "bg-success" : "bg-info"}`}
            />
            <span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: row.environmentId, threadId: row.threadId }}
              className="shrink-0 underline underline-offset-2"
            >
              Open thread
            </Link>
          </div>
          <div className="mt-1 truncate text-muted-foreground">
            {row.providerName ?? row.modelSelection.instanceId} · {row.modelSelection.model}
          </div>
          <div className="mt-1">{labels[row.status]}</div>
          {row.activity ? (
            <div className="mt-1 truncate text-muted-foreground">{row.activity}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function DelegationSummary({
  rows,
  waiting,
  onOpenAgents,
}: {
  rows: DelegatedThreadRows;
  waiting: boolean;
  onOpenAgents: () => void;
}) {
  if (rows.length === 0) return null;
  const active = rows.filter((row) =>
    ["starting", "running", "needs-approval", "needs-input"].includes(row.status),
  );
  const blocked = active.filter(
    (row) => row.status === "needs-approval" || row.status === "needs-input",
  ).length;
  return (
    <details className="mx-3 my-1 rounded-md border border-border/60 bg-card/50 px-2.5 py-2 text-xs sm:mx-5">
      <summary className="cursor-pointer font-medium">
        {blocked > 0
          ? `${blocked} delegated ${blocked === 1 ? "agent needs" : "agents need"} attention`
          : waiting && active.length > 0
            ? "Waiting for delegated agent"
            : active.length > 0
              ? `${active.length} delegated ${active.length === 1 ? "agent active" : "agents active"}`
              : `Pylon delegation · ${rows.length} child ${rows.length === 1 ? "thread" : "threads"}`}
      </summary>
      <div className="mt-2 max-h-64 overflow-y-auto">
        <DelegatedThreadList rows={rows} />
      </div>
      <button type="button" className="mt-2 underline underline-offset-2" onClick={onOpenAgents}>
        Open Agents
      </button>
    </details>
  );
}
