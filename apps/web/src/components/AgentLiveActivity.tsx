import { useAtomValue } from "@effect/atom-react";
import {
  presentSessionAgentLiveActivity,
  sessionAgentLiveActivityTextRows,
  sessionAgentLiveActivityUnavailableLabel,
} from "@t3tools/client-runtime/state/session-agent-live-activity";
import {
  RuntimeTaskId,
  type EnvironmentId,
  type ProviderSessionAgentActivitySnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { orchestrationEnvironment } from "~/state/orchestration";

export function AgentLiveActivity({
  environmentId,
  threadId,
  agentId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly agentId: string;
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

  return <AgentLiveActivitySnapshot snapshot={result.value} />;
}

export function AgentLiveActivitySnapshot({
  snapshot,
}: {
  readonly snapshot: ProviderSessionAgentActivitySnapshot;
}) {
  const presentation = presentSessionAgentLiveActivity(snapshot);
  if (presentation.entries.length === 0) {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        No assistant activity yet.
      </p>
    );
  }

  return (
    <div className="max-h-[min(60vh,32rem)] overflow-y-auto px-4 py-3" aria-live="polite">
      <div className="space-y-3">
        {sessionAgentLiveActivityTextRows(presentation.entries).map((entry) => (
          <p
            // Keys derive only from safe assistant text plus its occurrence
            // within this complete replacement snapshot.
            key={entry.key}
            className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground"
          >
            {entry.text}
          </p>
        ))}
      </div>
      <p className="mt-4 border-t border-border/60 pt-2 text-xs text-muted-foreground">
        Latest bounded snapshot · Live only
      </p>
    </div>
  );
}
