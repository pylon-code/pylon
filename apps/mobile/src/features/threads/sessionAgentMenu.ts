import {
  isActiveSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";

export type SessionAgentMenuActionKind = "live-activity" | "message" | "cancel";

export interface SessionAgentMenuAction {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly image: string;
  readonly attributes?: { readonly destructive?: boolean; readonly disabled?: boolean };
}

const LIVE_ACTIVITY_PREFIX = "watch-session-agent:";
const MESSAGE_PREFIX = "message-session-agent:";
const CANCEL_PREFIX = "cancel-session-agent:";

export function buildSessionAgentMenuActions(input: {
  readonly scopeKey: string;
  readonly agents: ReadonlyArray<RuntimeSubagent>;
  readonly canMessage: boolean;
  readonly canCancel: boolean;
  readonly canWatchLiveActivity: boolean;
  readonly cancellingAgentIds: ReadonlySet<string>;
}): ReadonlyArray<SessionAgentMenuAction> {
  return input.agents.flatMap((agent) => {
    if (!isActiveSubagentStatus(agent.status)) return [];
    const actions: SessionAgentMenuAction[] = [];
    if (input.canWatchLiveActivity && agent.kind !== "workflow") {
      actions.push({
        id: `${LIVE_ACTIVITY_PREFIX}${encodeURIComponent(input.scopeKey)}:${encodeURIComponent(agent.id)}`,
        title: `Live activity · ${agent.title}`,
        subtitle: "Live only · Assistant updates",
        image: "eye",
      });
    }
    if (input.canMessage && agent.messageable && agent.kind !== "workflow") {
      actions.push({
        id: `${MESSAGE_PREFIX}${encodeURIComponent(input.scopeKey)}:${encodeURIComponent(agent.id)}`,
        title: `Message ${agent.title}`,
        subtitle: "Send a direct instruction",
        image: "text.bubble",
      });
    }
    if (input.canCancel) {
      const stopping = input.cancellingAgentIds.has(agent.id);
      actions.push({
        id: `${CANCEL_PREFIX}${encodeURIComponent(input.scopeKey)}:${encodeURIComponent(agent.id)}`,
        title: stopping ? `Stopping ${agent.title}` : `Stop ${agent.title}`,
        subtitle: stopping ? "Waiting for provider confirmation" : "End this agent's current work",
        image: "stop.fill",
        attributes: stopping ? { destructive: true, disabled: true } : { destructive: true },
      });
    }
    return actions;
  });
}

export function parseSessionAgentMenuAction(eventId: string): {
  readonly kind: SessionAgentMenuActionKind;
  readonly scopeKey: string;
  readonly agentId: string;
} | null {
  const parse = (kind: SessionAgentMenuActionKind, encoded: string) => {
    const separator = encoded.indexOf(":");
    if (separator <= 0 || separator === encoded.length - 1) return null;
    try {
      const scopeKey = decodeURIComponent(encoded.slice(0, separator));
      const agentId = decodeURIComponent(encoded.slice(separator + 1));
      return scopeKey.length > 0 && agentId.length > 0 ? { kind, scopeKey, agentId } : null;
    } catch {
      return null;
    }
  };
  if (eventId.startsWith(LIVE_ACTIVITY_PREFIX)) {
    return parse("live-activity", eventId.slice(LIVE_ACTIVITY_PREFIX.length));
  }
  if (eventId.startsWith(MESSAGE_PREFIX)) {
    return parse("message", eventId.slice(MESSAGE_PREFIX.length));
  }
  if (eventId.startsWith(CANCEL_PREFIX)) {
    return parse("cancel", eventId.slice(CANCEL_PREFIX.length));
  }
  return null;
}
