import { describe, expect, it } from "vite-plus/test";
import type { ProviderSessionAgentActivitySnapshot, ServerProvider } from "@t3tools/contracts";
import {
  canWatchSessionAgentLiveActivity,
  SESSION_AGENT_LIVE_ACTIVITY_IDLE_TTL_MS,
  presentSessionAgentLiveActivity,
  presentSessionAgentLiveActivityAgentSummary,
  replaceSessionAgentLiveActivity,
  sessionAgentLiveActivitySelectionIsOpen,
  sessionAgentLiveActivityRows,
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
  entries: ProviderSessionAgentActivitySnapshot["entries"],
  activity?: ProviderSessionAgentActivitySnapshot["activity"],
): ProviderSessionAgentActivitySnapshot {
  return {
    agentId: "agent-canonical" as ProviderSessionAgentActivitySnapshot["agentId"],
    revision,
    entries,
    ...(activity === undefined ? {} : { activity }),
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

  it("presents only the safe aggregate activity already visible in the roster", () => {
    expect(
      presentSessionAgentLiveActivityAgentSummary({
        lastToolName: "ipython",
        usage: { totalTokens: 65_800, toolUses: 14 },
      }),
    ).toEqual({
      statusLabel: "Working",
      activityLabel: "Last tool: ipython",
      usageLabel: "65.8k tokens · 14 tools",
    });
    expect(
      presentSessionAgentLiveActivityAgentSummary({ lastToolName: null, usage: null }),
    ).toEqual({ statusLabel: "Working", activityLabel: null, usageLabel: null });
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
    expect(replacement.entries).toEqual([{ kind: "assistant", text: "second" }]);
    expect(reconnectReset.entries).toEqual([{ kind: "assistant", text: "fresh after reconnect" }]);
    expect(changedSameRevision.entries).toEqual([{ kind: "assistant", text: "changed snapshot" }]);
  });

  it("presents additive tool rows with stable safe keys across status changes", () => {
    const started = presentSessionAgentLiveActivity(
      snapshot(
        2,
        [{ speaker: "assistant", text: "same" }],
        [
          { speaker: "assistant", text: "same" },
          { kind: "tool", activityId: 1, label: "Code", status: "started" },
          { kind: "tool", activityId: 2, label: "Code", status: "completed" },
        ],
      ),
    );
    expect(sessionAgentLiveActivityRows(started.entries)).toEqual([
      { key: "assistant:same:1", kind: "assistant", text: "same" },
      {
        key: "tool:1",
        kind: "tool",
        activityId: 1,
        label: "Code",
        status: "started",
        statusLabel: "Started",
      },
      {
        key: "tool:2",
        kind: "tool",
        activityId: 2,
        label: "Code",
        status: "completed",
        statusLabel: "Completed",
      },
    ]);
    const completed = presentSessionAgentLiveActivity(
      snapshot(
        3,
        [{ speaker: "assistant", text: "same" }],
        [
          { speaker: "assistant", text: "same" },
          { kind: "tool", activityId: 1, label: "Code", status: "completed" },
          { kind: "tool", activityId: 2, label: "Code", status: "completed" },
        ],
      ),
    );
    expect(sessionAgentLiveActivityRows(completed.entries)[1]?.key).toBe("tool:1");
  });

  it("projects only display-safe assistant and tool fields", () => {
    const wire = {
      ...snapshot(
        3,
        [{ speaker: "assistant", text: "Safe update" }],
        [
          { speaker: "assistant", text: "Safe update" },
          { kind: "tool", activityId: 1, label: "Code", status: "failed" },
        ],
      ),
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
      entries: [
        { kind: "assistant", text: "Safe update" },
        {
          kind: "tool",
          activityId: 1,
          label: "Code",
          status: "failed",
          statusLabel: "Failed",
        },
      ],
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
