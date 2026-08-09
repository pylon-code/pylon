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
      agentCancel: true,
      agentMessage: true,
      compaction: true,
      autoCompaction: true,
    });

    expect(capabilities.executionPolicy).toMatchObject({
      support: "read-write",
      operations: ["inspect", "select"],
      runtimeModes: ["approval-required", "full-access"],
      enforcement: "host-gated",
    });
    expect(capabilities.agents).toMatchObject({
      support: "read-write",
      operations: ["observe", "hierarchy", "message", "cancel", "set-depth"],
    });
    expect(capabilities.resources).toMatchObject({
      support: "read-write",
      operations: ["commands", "reload"],
    });
    expect(capabilities.inputQueue?.operations).toEqual([
      "observe",
      "follow-up",
      "steer",
      "clear",
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
    expect(capabilities.history?.support).toBe("unavailable");
  });

  it("keeps native input queue controls unavailable without compatible daemon methods", () => {
    const capabilities = makePrimeAgentFeatureCapabilities({
      runtime: "daemon",
      sessionUi: true,
      inputQueue: false,
      inputQueueModes: false,
      agentCancel: false,
      agentMessage: false,
      compaction: false,
      autoCompaction: false,
    });
    expect(capabilities.inputQueue).toMatchObject({
      support: "unavailable",
      operations: [],
    });
  });

  it("keeps ACP fallback capabilities narrow and explicit", () => {
    const capabilities = makePrimeAgentFeatureCapabilities({
      runtime: "acp",
      sessionUi: false,
      inputQueue: false,
      inputQueueModes: false,
      agentCancel: false,
      agentMessage: false,
      compaction: false,
      autoCompaction: false,
    });

    expect(capabilities.executionPolicy).toMatchObject({
      support: "read-only",
      runtimeModes: ["full-access"],
      enforcement: "none",
    });
    expect(capabilities.model?.operations).toEqual(["select"]);
    expect(capabilities.agents?.support).toBe("unavailable");
    expect(capabilities.reasoning?.support).toBe("unavailable");
    expect(capabilities.usage?.support).toBe("unavailable");
    expect(capabilities.sessionUi?.support).toBe("unavailable");
  });
});
