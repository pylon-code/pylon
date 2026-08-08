// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import { makePrimeAgentFeatureCapabilities } from "./PrimeAgentFeatureCapabilities.ts";

describe("PrimeAgentFeatureCapabilities", () => {
  it("advertises only daemon operations already exposed by Pylon", () => {
    const capabilities = makePrimeAgentFeatureCapabilities({ runtime: "daemon", sessionUi: true });

    expect(capabilities.executionPolicy).toMatchObject({
      support: "read-only",
      runtimeModes: ["full-access"],
      enforcement: "none",
    });
    expect(capabilities.agents?.operations).toEqual(["observe", "hierarchy"]);
    expect(capabilities.model?.operations).toEqual(["select"]);
    expect(capabilities.reasoning?.support).toBe("unavailable");
    expect(capabilities.usage?.operations).toEqual(["token-usage"]);
    expect(capabilities.sessionUi?.operations).toEqual([
      "dialog",
      "notification",
      "status",
      "widget",
    ]);
    expect(capabilities.history?.support).toBe("unavailable");
  });

  it("keeps ACP fallback capabilities narrow and explicit", () => {
    const capabilities = makePrimeAgentFeatureCapabilities({ runtime: "acp", sessionUi: false });

    expect(capabilities.model?.operations).toEqual(["select"]);
    expect(capabilities.agents?.support).toBe("unavailable");
    expect(capabilities.reasoning?.support).toBe("unavailable");
    expect(capabilities.usage?.support).toBe("unavailable");
    expect(capabilities.sessionUi?.support).toBe("unavailable");
  });
});
