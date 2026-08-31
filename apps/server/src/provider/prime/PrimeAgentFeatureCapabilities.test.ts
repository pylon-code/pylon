// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import { makePrimeAgentFeatureCapabilities } from "./PrimeAgentFeatureCapabilities.ts";

describe("PrimeAgentFeatureCapabilities", () => {
  it("advertises only daemon operations already exposed by Pylon", () => {
    const capabilities = makePrimeAgentFeatureCapabilities({
      runtime: "daemon",
      sessionUi: true,
      inputQueue: true,
      inputQueueModes: true,
      inputQueueMutation: true,
      agentCancel: true,
      agentMessage: true,
      agentLiveActivity: true,
      compaction: true,
      autoCompaction: true,
      goals: true,
      sideQuestions: true,
    });

    expect(capabilities.authentication).toMatchObject({
      support: "read-only",
      operations: ["status"],
    });
    expect(capabilities.executionPolicy).toMatchObject({
      support: "read-write",
      operations: ["inspect", "select"],
      runtimeModes: ["approval-required", "full-access"],
      enforcement: "host-gated",
    });
    expect(capabilities.planning).toMatchObject({
      support: "read-only",
      operations: ["observe"],
    });
    expect(capabilities.planning?.reason).toContain("formal Plan interaction mode");
    expect(capabilities.agents).toMatchObject({
      support: "read-write",
      operations: ["observe", "hierarchy", "live-activity", "message", "cancel", "set-depth"],
    });
    expect(capabilities.goals).toMatchObject({
      support: "read-only",
      operations: ["observe"],
    });
    expect(capabilities.automation).toMatchObject({
      support: "read-write",
      operations: ["side-questions"],
    });
    expect(capabilities.automation?.reason).toContain("approval-required");
    expect(capabilities.resources).toMatchObject({
      support: "read-write",
      operations: ["skills", "prompts", "commands", "reload"],
    });
    expect(capabilities.inputQueue?.operations).toEqual([
      "observe",
      "follow-up",
      "steer",
      "clear",
      "remove",
      "set-modes",
    ]);
    expect(capabilities.context).toMatchObject({
      support: "read-write",
      operations: ["observe", "compact", "abort-compaction", "configure-compaction"],
    });
    expect(capabilities.model?.operations).toEqual(["select", "thinking", "service-tier"]);
    expect(capabilities.reasoning).toMatchObject({
      support: "read-only",
      operations: ["final"],
    });
    expect(capabilities.usage?.operations).toEqual(["token-usage", "cost"]);
    expect(capabilities.sessionUi?.operations).toEqual([
      "dialog",
      "notification",
      "status",
      "widget",
    ]);
    expect(capabilities.sessionUi?.reason).toContain("editor replacement");
    expect(capabilities.history?.support).toBe("unavailable");
  });

  it("keeps native input queue controls unavailable without compatible daemon methods", () => {
    const capabilities = makePrimeAgentFeatureCapabilities({
      runtime: "daemon",
      sessionUi: true,
      inputQueue: false,
      inputQueueModes: false,
      inputQueueMutation: false,
      agentCancel: false,
      agentMessage: false,
      agentLiveActivity: false,
      compaction: false,
      autoCompaction: false,
      goals: false,
      sideQuestions: false,
    });
    expect(capabilities.inputQueue).toMatchObject({
      support: "unavailable",
      operations: [],
    });
    expect(capabilities.goals).toMatchObject({ support: "unavailable", operations: [] });
    expect(capabilities.automation).toMatchObject({ support: "unavailable", operations: [] });
    expect(capabilities.agents?.operations).not.toContain("live-activity");
  });

  it("does not advertise per-lane removal without the delivery panel used to select a lane", () => {
    const capabilities = makePrimeAgentFeatureCapabilities({
      runtime: "daemon",
      sessionUi: true,
      inputQueue: true,
      inputQueueModes: false,
      inputQueueMutation: true,
      agentCancel: false,
      agentMessage: false,
      agentLiveActivity: false,
      compaction: false,
      autoCompaction: false,
      goals: false,
      sideQuestions: false,
    });

    expect(capabilities.inputQueue?.operations).toEqual(["observe", "follow-up", "steer", "clear"]);
  });

  it("keeps ACP fallback capabilities narrow and explicit", () => {
    const capabilities = makePrimeAgentFeatureCapabilities({
      runtime: "acp",
      sessionUi: false,
      inputQueue: false,
      inputQueueModes: false,
      inputQueueMutation: false,
      agentCancel: false,
      agentMessage: false,
      agentLiveActivity: false,
      compaction: false,
      autoCompaction: false,
      goals: true,
      sideQuestions: false,
    });

    expect(capabilities.authentication).toMatchObject({
      support: "read-only",
      operations: ["status"],
    });
    expect(capabilities.executionPolicy).toMatchObject({
      support: "read-only",
      runtimeModes: ["full-access"],
      enforcement: "none",
    });
    expect(capabilities.planning).toMatchObject({
      support: "read-only",
      operations: ["observe"],
    });
    expect(capabilities.planning?.reason).toContain("standard ACP PlanUpdated");
    expect(capabilities.model?.operations).toEqual(["select"]);
    expect(capabilities.agents?.support).toBe("unavailable");
    expect(capabilities.goals?.support).toBe("unavailable");
    expect(capabilities.reasoning).toMatchObject({ support: "unavailable", operations: [] });
    expect(capabilities.reasoning?.reason).toContain("not surfaced or retained");
    expect(capabilities.reasoning?.reason).toContain("discarded at the adapter boundary");
    expect(capabilities.usage?.support).toBe("unavailable");
    expect(capabilities.sessionUi?.support).toBe("unavailable");
  });
});
