import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { ProviderSessionAgentActivitySnapshot } from "@t3tools/contracts";
import { AgentLiveActivitySnapshot } from "./AgentLiveActivity";
import { AgentsPanel } from "./AgentsPanel";

function agent(id: string, title: string, status: RuntimeSubagent["status"]): RuntimeSubagent {
  return {
    id,
    kind: "subagent",
    title,
    role: null,
    model: null,
    effort: null,
    messageable: true,
    status,
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-08-09T00:00:00.000Z",
    startedAt: "2026-08-09T00:00:00.000Z",
    completedAt: status === "completed" ? "2026-08-09T00:00:01.000Z" : null,
    updatedAt: "2026-08-09T00:00:01.000Z",
  };
}

const active = agent("agent-active", "Active reviewer", "running");
const completed = agent("agent-completed", "Finished reviewer", "completed");
const model: AgentPanelModel = {
  workflows: [],
  directAgents: [active, completed],
  runningCount: 1,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 1,
  totalTokens: 0,
  hasAgents: true,
  liveCount: 1,
};

describe("AgentsPanel agent cancellation", () => {
  it("offers cancellation only for active agents when the capability is enabled", () => {
    const markup = renderToStaticMarkup(
      <AgentsPanel
        model={model}
        canCancelAgents
        cancellingAgentIds={new Set()}
        onCancelAgent={async () => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Stop Active reviewer"');
    expect(markup).not.toContain('aria-label="Stop Finished reviewer"');
  });

  it("shows pending cancellation accessibly without changing the agent status", () => {
    const markup = renderToStaticMarkup(
      <AgentsPanel
        model={model}
        canCancelAgents
        cancellingAgentIds={new Set([active.id])}
        onCancelAgent={async () => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Stopping Active reviewer"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Working");
  });

  it("keeps every agent row read-only without an advertised capability", () => {
    const markup = renderToStaticMarkup(<AgentsPanel model={model} />);
    expect(markup).not.toContain('aria-label="Stop ');
  });

  it("offers messaging only for provider-marked active agents when enabled", () => {
    const unmessageable = {
      ...active,
      id: "agent-no-message",
      title: "No messages",
      messageable: false,
    };
    const messageModel = { ...model, directAgents: [active, unmessageable, completed] };
    const markup = renderToStaticMarkup(
      <AgentsPanel
        model={messageModel}
        canMessageAgents
        onMessageAgent={async () => "delivered"}
      />,
    );

    expect(markup).toContain('aria-label="Message Active reviewer"');
    expect(markup).not.toContain('aria-label="Message No messages"');
    expect(markup).not.toContain('aria-label="Message Finished reviewer"');
  });

  it("does not expose messaging without the advertised capability", () => {
    const markup = renderToStaticMarkup(
      <AgentsPanel model={model} onMessageAgent={async () => "queued"} />,
    );
    expect(markup).not.toContain('aria-label="Message ');
  });
  it("offers provider-gated live activity only for active agents and labels settled rows unavailable", () => {
    const markup = renderToStaticMarkup(
      <AgentsPanel
        model={model}
        environmentId={"env" as never}
        threadId={"thread" as never}
        canWatchAgentActivity
      />,
    );
    expect(markup).toContain('aria-label="Open live activity for Active reviewer"');
    expect(markup).toContain("Live activity unavailable");

    const gated = renderToStaticMarkup(
      <AgentsPanel model={model} environmentId={"env" as never} threadId={"thread" as never} />,
    );
    expect(gated).not.toContain("Open live activity");
    expect(gated).not.toContain("Live activity unavailable");
  });

  it("renders safe aggregate status with empty and bounded assistant-only snapshots", () => {
    const liveAgent = {
      ...active,
      lastToolName: "ipython",
      usage: { totalTokens: 65_800, toolUses: 14 },
      progress: "private progress",
    };
    const empty = renderToStaticMarkup(
      <AgentLiveActivitySnapshot
        snapshot={{ agentId: "canonical" as never, revision: 1, entries: [] }}
        agent={liveAgent}
      />,
    );
    expect(empty).toContain("Working");
    expect(empty).toContain('aria-live="polite"');
    expect(empty).toContain("Last tool: ipython");
    expect(empty).toContain("65.8k tokens · 14 tools");
    expect(empty).toContain("No assistant text yet.");
    expect(empty).toContain("Tool arguments, results, and reasoning are not shown.");
    expect(empty).not.toContain("private progress");

    const snapshot = {
      agentId: "canonical",
      revision: 2,
      entries: [{ speaker: "assistant", text: "Safe assistant update" }],
      nativeId: "private-native-id",
      path: "/private/path",
      tool: "private tool data",
      thinking: "private thinking",
      usage: "private usage",
      metadata: "private metadata",
    } as unknown as ProviderSessionAgentActivitySnapshot;
    const markup = renderToStaticMarkup(
      <AgentLiveActivitySnapshot snapshot={snapshot} agent={liveAgent} />,
    );
    expect(markup).toContain("Safe assistant update");
    expect(markup).toContain("Latest bounded snapshot · Live only");
    expect(markup).not.toContain("private-native-id");
    expect(markup).not.toContain("/private/path");
    expect(markup).not.toContain("private tool data");
    expect(markup).not.toContain("private thinking");
    expect(markup).not.toContain("private usage");
    expect(markup).not.toContain("private metadata");
  });
});
