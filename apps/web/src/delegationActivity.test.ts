import { describe, expect, it } from "vite-plus/test";
import { delegationActivity } from "./delegationActivity";

const base = {
  id: "call",
  createdAt: "2026-09-17T00:00:00Z",
  label: "MCP tool call",
  tone: "tool" as const,
};
describe("delegation activity", () => {
  it("requires structured identity and a positive live wait budget", () => {
    expect(delegationActivity({ ...base, label: "delegated_thread_status" })).toBeNull();
    for (const data of [
      { toolName: "mcp__t3_code__delegated_thread_status", input: { waitSeconds: 45 } },
      { server: "t3-code", tool: "delegated_thread_status", arguments: '{"waitSeconds":45}' },
    ]) {
      expect(
        delegationActivity({ ...base, toolData: data, toolLifecycleStatus: "inProgress" })?.waiting,
      ).toBe(true);
      expect(
        delegationActivity({ ...base, toolData: data, toolLifecycleStatus: "completed" })?.waiting,
      ).toBe(false);
    }
    for (const args of [
      {},
      { waitSeconds: 0 },
      { waitSeconds: -1 },
      { waitSeconds: "45" },
      "bad JSON",
    ]) {
      expect(
        delegationActivity({
          ...base,
          toolData: { server: "t3-code", tool: "delegated_thread_status", arguments: args },
          toolLifecycleStatus: "inProgress",
        })?.waiting,
      ).toBe(false);
    }
  });
  it("recovers a child only from structured tool results", () => {
    const data = {
      server: "t3-code",
      tool: "delegate_thread",
      result: { content: [{ type: "text", text: '{"threadId":"child"}' }] },
    };
    expect(delegationActivity({ ...base, toolData: data })?.threadId).toBe("child");
    expect(
      delegationActivity({
        ...base,
        toolData: { ...data, result: { content: '{"threadId":"child"}' } },
      })?.threadId,
    ).toBe("child");
    expect(
      delegationActivity({ ...base, toolData: { ...data, result: "child completed" } })?.threadId,
    ).toBeNull();
  });
  it("does not classify another MCP server or arbitrary names as Pylon", () => {
    expect(
      delegationActivity({ ...base, toolData: { toolName: "mcp__other__delegate_thread" } }),
    ).toBeNull();
    expect(
      delegationActivity({ ...base, toolData: { toolName: "read_delegation_skill" } }),
    ).toBeNull();
    expect(
      delegationActivity({
        ...base,
        toolData: {
          server: "other",
          tool: "delegated_thread_status",
          arguments: { waitSeconds: 45 },
        },
        toolLifecycleStatus: "inProgress",
      }),
    ).toBeNull();
  });
});
