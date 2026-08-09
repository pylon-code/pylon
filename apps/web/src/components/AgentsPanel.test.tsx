import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { AgentsPanel } from "./AgentsPanel";

function agent(id: string, title: string, status: RuntimeSubagent["status"]): RuntimeSubagent {
  return {
    id,
    kind: "subagent",
    title,
    role: null,
    model: null,
    effort: null,
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
});
