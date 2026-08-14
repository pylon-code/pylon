import type { ProviderSessionAgentActivitySnapshot, ServerProvider } from "@t3tools/contracts";

import { formatSubagentTokenCount, type RuntimeSubagent } from "./subagentRuntime.ts";

/** Zero retention ensures closing the detail immediately releases its RPC owner. */
export const SESSION_AGENT_LIVE_ACTIVITY_IDLE_TTL_MS = 0;

/** Provider-neutral capability gate for the live-only agent activity stream. */
export function supportsSessionAgentLiveActivity(
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
): boolean {
  const agents = provider?.featureCapabilities?.agents;
  return (
    (agents?.support === "read-only" || agents?.support === "read-write") &&
    agents.operations.includes("live-activity")
  );
}

export function canWatchSessionAgentLiveActivity(
  provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined,
  session: { readonly runtimeMode: string; readonly status: string } | null | undefined,
): boolean {
  return (
    session?.runtimeMode === "full-access" &&
    (session.status === "ready" || session.status === "running") &&
    supportsSessionAgentLiveActivity(provider)
  );
}

export interface SessionAgentLiveActivitySelection {
  readonly agentId: string;
  readonly scopeKey: string;
}

export function sessionAgentLiveActivitySelectionIsOpen(input: {
  readonly selection: SessionAgentLiveActivitySelection | null;
  readonly currentScopeKey: string;
  readonly capabilityEnabled: boolean;
  readonly agent: { readonly kind: string; readonly status: string } | null | undefined;
}): boolean {
  return (
    input.selection !== null &&
    input.selection.scopeKey === input.currentScopeKey &&
    input.capabilityEnabled &&
    input.agent !== null &&
    input.agent !== undefined &&
    input.agent.kind !== "workflow" &&
    (input.agent.status === "pending" ||
      input.agent.status === "running" ||
      input.agent.status === "waiting")
  );
}

export interface SessionAgentLiveActivityPresentation {
  readonly revision: number;
  readonly entries: ReadonlyArray<string>;
}

export interface SessionAgentLiveActivityAgentSummary {
  readonly statusLabel: "Working";
  readonly activityLabel: string | null;
  readonly usageLabel: string | null;
}

/**
 * Reuses only the safe aggregate fields already visible in the agent roster.
 * Prompts, tool arguments and results, reasoning, and native identifiers never
 * enter this presentation.
 */
export function presentSessionAgentLiveActivityAgentSummary(
  agent: Pick<RuntimeSubagent, "lastToolName" | "usage">,
): SessionAgentLiveActivityAgentSummary {
  const usage = agent.usage;
  const usageLabel =
    usage === null
      ? null
      : [
          `${formatSubagentTokenCount(usage.totalTokens)} tokens`,
          ...(usage.toolUses === undefined
            ? []
            : [`${usage.toolUses} ${usage.toolUses === 1 ? "tool" : "tools"}`]),
        ].join(" · ");
  return {
    statusLabel: "Working",
    activityLabel: agent.lastToolName === null ? null : `Last tool: ${agent.lastToolName}`,
    usageLabel,
  };
}

/**
 * Reduces the wire snapshot to the only fields a client is allowed to render.
 * Native ids and any future envelope metadata never enter presentation state.
 */
export function presentSessionAgentLiveActivity(
  snapshot: ProviderSessionAgentActivitySnapshot,
): SessionAgentLiveActivityPresentation {
  return {
    revision: snapshot.revision,
    entries: snapshot.entries.map((entry) => entry.text),
  };
}

/**
 * A watch frame is a complete bounded replacement, never a transcript delta.
 * Identical frames preserve identity to avoid duplicate renders. Revisions are
 * stream-local, so changed text always replaces even when a revision repeats.
 */
export function replaceSessionAgentLiveActivity(
  current: SessionAgentLiveActivityPresentation | null,
  snapshot: ProviderSessionAgentActivitySnapshot,
): SessionAgentLiveActivityPresentation {
  const next = presentSessionAgentLiveActivity(snapshot);
  if (
    current?.revision === next.revision &&
    current.entries.length === next.entries.length &&
    current.entries.every((entry, index) => entry === next.entries[index])
  ) {
    return current;
  }
  return next;
}

export function sessionAgentLiveActivityTextRows(
  entries: ReadonlyArray<string>,
): ReadonlyArray<{ readonly key: string; readonly text: string }> {
  const occurrences = new Map<string, number>();
  return entries.map((text) => {
    const occurrence = (occurrences.get(text) ?? 0) + 1;
    occurrences.set(text, occurrence);
    return { key: `${text}:${occurrence}`, text };
  });
}

export type SessionAgentLiveActivityFailureReason =
  | "agent-not-active"
  | "limit-reached"
  | "request-failed"
  | "session-not-ready"
  | "unsupported";

export function sessionAgentLiveActivityFailureReason(
  error: unknown,
): SessionAgentLiveActivityFailureReason | null {
  if (typeof error !== "object" || error === null || !("reason" in error)) return null;
  const reason = error.reason;
  return reason === "agent-not-active" ||
    reason === "limit-reached" ||
    reason === "request-failed" ||
    reason === "session-not-ready" ||
    reason === "unsupported"
    ? reason
    : null;
}

export function sessionAgentLiveActivityUnavailableLabel(error: unknown): string {
  switch (sessionAgentLiveActivityFailureReason(error)) {
    case "limit-reached":
      return "Live activity limit reached. Close and reopen the view to continue.";
    case "agent-not-active":
      return "Live activity is unavailable because this agent has exited.";
    case "session-not-ready":
      return "Live activity is unavailable while the session is not ready.";
    case "unsupported":
      return "Live activity is unavailable for this session.";
    case "request-failed":
    default:
      return "Live activity is temporarily unavailable.";
  }
}
