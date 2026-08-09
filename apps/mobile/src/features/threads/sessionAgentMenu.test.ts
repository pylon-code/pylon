import { describe, expect, it } from "vite-plus/test";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { buildSessionAgentMenuActions, parseSessionAgentMenuAction } from "./sessionAgentMenu";

const agent = (overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent => ({
  id: "child:nested",
  kind: "subagent",
  title: "Nested reviewer",
  role: null,
  model: null,
  effort: null,
  messageable: true,
  status: "running",
  activationCount: 1,
  usage: null,
  progress: null,
  lastToolName: null,
  result: null,
  error: null,
  outputFile: null,
  parentAgentId: "parent",
  agentIndex: null,
  phaseIndex: null,
  phaseTitle: null,
  attempt: null,
  workflowName: null,
  phases: [],
  runHandles: null,
  recentActivity: [],
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("session agent menu", () => {
  it("offers Message and Stop for a messageable live nested agent", () => {
    const actions = buildSessionAgentMenuActions({
      scopeKey: "remote:thread-1",
      agents: [agent()],
      canMessage: true,
      canCancel: true,
      cancellingAgentIds: new Set(),
    });
    expect(actions.map((action) => action.title)).toEqual([
      "Message Nested reviewer",
      "Stop Nested reviewer",
    ]);
  });

  it("hides Message for settled, unmessageable, and workflow coordinator rows", () => {
    const actions = buildSessionAgentMenuActions({
      scopeKey: "remote:thread-1",
      agents: [
        agent({ id: "settled", status: "completed" }),
        agent({ id: "private", messageable: false }),
        agent({ id: "workflow", kind: "workflow" }),
      ],
      canMessage: true,
      canCancel: false,
      cancellingAgentIds: new Set(),
    });
    expect(actions).toEqual([]);
  });

  it("round-trips agent ids containing colons", () => {
    const scopeKey = JSON.stringify(["remote:one", "thread:one"]);
    const actions = buildSessionAgentMenuActions({
      scopeKey,
      agents: [agent()],
      canMessage: true,
      canCancel: true,
      cancellingAgentIds: new Set(),
    });
    expect(parseSessionAgentMenuAction(actions[0]?.id ?? "")).toEqual({
      kind: "message",
      scopeKey,
      agentId: "child:nested",
    });
    expect(parseSessionAgentMenuAction(actions[1]?.id ?? "")).toEqual({
      kind: "cancel",
      scopeKey,
      agentId: "child:nested",
    });
    expect(parseSessionAgentMenuAction("message-session-agent:bad%ZZ:value")).toBeNull();
  });
});
