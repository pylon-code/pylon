import { describe, expect, it } from "vite-plus/test";
import type { ProviderSessionAgentActivitySnapshot, ServerProvider } from "@t3tools/contracts";
import {
  canWatchSessionAgentLiveActivity,
  SESSION_AGENT_LIVE_ACTIVITY_IDLE_TTL_MS,
  presentSessionAgentLiveActivity,
  replaceSessionAgentLiveActivity,
  sessionAgentLiveActivitySelectionIsOpen,
  sessionAgentLiveActivityTextRows,
  sessionAgentLiveActivityUnavailableLabel,
  supportsSessionAgentLiveActivity,
} from "./sessionAgentLiveActivity.ts";

function provider(
  support: "unavailable" | "read-only" | "read-write",
  operations: ReadonlyArray<string>,
): Pick<ServerProvider, "featureCapabilities"> {
  return {
    featureCapabilities: {
      version: 1,
      agents: { support, operations },
    },
  } as Pick<ServerProvider, "featureCapabilities">;
}

function snapshot(
  revision: number,
  entries: ReadonlyArray<{ readonly speaker: "assistant"; readonly text: string }>,
): ProviderSessionAgentActivitySnapshot {
  return {
    agentId: "agent-canonical" as ProviderSessionAgentActivitySnapshot["agentId"],
    revision,
    entries,
  };
}

describe("session agent live activity", () => {
  it("releases an unmounted live-only subscription immediately", () => {
    expect(SESSION_AGENT_LIVE_ACTIVITY_IDLE_TTL_MS).toBe(0);
  });

  it("gates on the provider-advertised operation without provider-name branches", () => {
    expect(supportsSessionAgentLiveActivity(provider("read-write", ["live-activity"]))).toBe(true);
    expect(supportsSessionAgentLiveActivity(provider("read-write", ["message"]))).toBe(false);
    expect(supportsSessionAgentLiveActivity(provider("read-only", ["live-activity"]))).toBe(true);
    expect(supportsSessionAgentLiveActivity(provider("unavailable", ["live-activity"]))).toBe(
      false,
    );
    expect(supportsSessionAgentLiveActivity(null)).toBe(false);
  });

  it("closes stale selections on provider/runtime switches and agent settlement", () => {
    const advertised = provider("read-write", ["live-activity"]);
    expect(
      canWatchSessionAgentLiveActivity(advertised, {
        runtimeMode: "full-access",
        status: "running",
      }),
    ).toBe(true);
    expect(
      canWatchSessionAgentLiveActivity(advertised, {
        runtimeMode: "approval-required",
        status: "running",
      }),
    ).toBe(false);

    const selection = { scopeKey: "provider-a:full-access", agentId: "agent" };
    expect(
      sessionAgentLiveActivitySelectionIsOpen({
        selection,
        currentScopeKey: "provider-b:full-access",
        capabilityEnabled: true,
        agent: { kind: "subagent", status: "running" },
      }),
    ).toBe(false);
    expect(
      sessionAgentLiveActivitySelectionIsOpen({
        selection,
        currentScopeKey: selection.scopeKey,
        capabilityEnabled: true,
        agent: { kind: "subagent", status: "completed" },
      }),
    ).toBe(false);
  });

  it("replaces snapshots and preserves identity for a repeated revision", () => {
    const first = replaceSessionAgentLiveActivity(
      null,
      snapshot(1, [{ speaker: "assistant", text: "first" }]),
    );
    const repeated = replaceSessionAgentLiveActivity(
      first,
      snapshot(1, [{ speaker: "assistant", text: "first" }]),
    );
    const replacement = replaceSessionAgentLiveActivity(
      first,
      snapshot(2, [{ speaker: "assistant", text: "second" }]),
    );
    const reconnectReset = replaceSessionAgentLiveActivity(
      replacement,
      snapshot(1, [{ speaker: "assistant", text: "fresh after reconnect" }]),
    );
    const changedSameRevision = replaceSessionAgentLiveActivity(
      reconnectReset,
      snapshot(1, [{ speaker: "assistant", text: "changed snapshot" }]),
    );

    expect(repeated).toBe(first);
    expect(replacement.entries).toEqual(["second"]);
    expect(replacement.entries).not.toContain("first");
    expect(reconnectReset.entries).toEqual(["fresh after reconnect"]);
    expect(changedSameRevision.entries).toEqual(["changed snapshot"]);
  });

  it("derives safe ephemeral keys while keeping duplicate assistant entries", () => {
    expect(sessionAgentLiveActivityTextRows(["same", "same", "other"])).toEqual([
      { key: "same:1", text: "same" },
      { key: "same:2", text: "same" },
      { key: "other:1", text: "other" },
    ]);
  });

  it("projects only assistant text and drops every envelope field from presentation", () => {
    const wire = {
      ...snapshot(3, [{ speaker: "assistant", text: "Safe update" }]),
      nativeId: "native-secret",
      path: "/private/worktree",
      tool: { input: "secret" },
      thinking: "hidden",
      error: "hidden",
      usage: { cost: 99 },
      metadata: { raw: true },
    } as ProviderSessionAgentActivitySnapshot;

    expect(presentSessionAgentLiveActivity(wire)).toEqual({
      revision: 3,
      entries: ["Safe update"],
    });
  });

  it("formats limit and unavailable states without surfacing raw errors", () => {
    expect(sessionAgentLiveActivityUnavailableLabel({ reason: "limit-reached" })).toContain(
      "limit reached",
    );
    expect(sessionAgentLiveActivityUnavailableLabel({ reason: "agent-not-active" })).toContain(
      "agent has exited",
    );
    expect(sessionAgentLiveActivityUnavailableLabel(new Error("native payload"))).not.toContain(
      "native payload",
    );
  });
});
