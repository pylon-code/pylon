import { useAtomValue } from "@effect/atom-react";
import {
  presentSessionAgentLiveActivity,
  presentSessionAgentLiveActivityAgentSummary,
  sessionAgentLiveActivityRows,
  sessionAgentLiveActivityUnavailableLabel,
} from "@t3tools/client-runtime/state/session-agent-live-activity";
import {
  RuntimeTaskId,
  type EnvironmentId,
  type ProviderSessionAgentActivitySnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import * as Cause from "effect/Cause";

import { orchestrationEnvironment } from "~/state/orchestration";

export function AgentLiveActivity({
  environmentId,
  threadId,
  agentId,
  agent,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly agentId: string;
  readonly agent: Pick<RuntimeSubagent, "lastToolName" | "usage">;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.sessionAgentLiveActivity({
      environmentId,
      input: { threadId, agentId: RuntimeTaskId.make(agentId) },
    }),
  );

  if (result._tag === "Failure") {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        {sessionAgentLiveActivityUnavailableLabel(Cause.squash(result.cause))}
      </p>
    );
  }
  if (result._tag !== "Success") {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading live activity…
      </p>
    );
  }

  return <AgentLiveActivitySnapshot snapshot={result.value} agent={agent} />;
}

export function AgentLiveActivitySnapshot({
  snapshot,
  agent,
}: {
  readonly snapshot: ProviderSessionAgentActivitySnapshot;
  readonly agent: Pick<RuntimeSubagent, "lastToolName" | "usage">;
}) {
  const presentation = presentSessionAgentLiveActivity(snapshot);
  const summary = presentSessionAgentLiveActivityAgentSummary(agent);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="mx-4 mt-3 shrink-0 rounded-md border border-border/60 bg-muted/30 px-3 py-2"
        aria-live="polite"
      >
        <p className="text-sm font-medium text-foreground">{summary.statusLabel}</p>
        {summary.activityLabel === null ? null : (
          <p className="mt-0.5 text-xs text-muted-foreground">{summary.activityLabel}</p>
        )}
        {summary.usageLabel === null ? null : (
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">{summary.usageLabel}</p>
        )}
      </div>
      {presentation.entries.length === 0 ? (
        <div role="status" className="p-4 text-sm text-muted-foreground">
          <p>No activity yet.</p>
          <p className="mt-1 text-xs">Tool arguments, results, and reasoning are not shown.</p>
        </div>
      ) : (
        <div
          className="max-h-[min(60vh,32rem)] min-h-0 flex-1 overflow-y-auto px-4 py-3"
          aria-live="polite"
        >
          <div className="space-y-3">
            {sessionAgentLiveActivityRows(presentation.entries).map((entry) =>
              entry.kind === "assistant" ? (
                <p
                  key={entry.key}
                  className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground"
                >
                  {entry.text}
                </p>
              ) : (
                <div
                  key={entry.key}
                  aria-label={`${entry.label}: ${entry.statusLabel}`}
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
                >
                  <span
                    aria-hidden="true"
                    className={
                      entry.status === "failed"
                        ? "text-destructive"
                        : entry.status === "completed"
                          ? "text-success"
                          : "text-muted-foreground"
                    }
                  >
                    {entry.status === "completed" ? "✓" : entry.status === "failed" ? "!" : "•"}
                  </span>
                  <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                    {entry.label}
                  </span>
                  <span className="text-xs text-muted-foreground">{entry.statusLabel}</span>
                </div>
              ),
            )}
          </div>
          <p className="mt-4 border-t border-border/60 pt-2 text-xs text-muted-foreground">
            Latest bounded snapshot · Live only
          </p>
        </div>
      )}
    </div>
  );
}
