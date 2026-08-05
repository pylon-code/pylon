import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  availableFollowUpEnvironmentIds,
  hasAvailableFollowUpEnvironment,
  isFollowUpEnvironmentAvailable,
} from "./followups";

describe("follow-up environment availability", () => {
  const connectedEnabled = {
    environmentId: EnvironmentId.make("environment-enabled"),
    connection: { phase: "connected" as const },
    serverConfig: { settings: { followUpsEnabled: true } },
  };
  const connectedDisabled = {
    environmentId: EnvironmentId.make("environment-disabled"),
    connection: { phase: "connected" as const },
    serverConfig: { settings: { followUpsEnabled: false } },
  };
  const reconnectingEnabled = {
    environmentId: EnvironmentId.make("environment-reconnecting"),
    connection: { phase: "reconnecting" as const },
    serverConfig: { settings: { followUpsEnabled: true } },
  };

  it("requires both a connected environment and its enabled setting", () => {
    expect(isFollowUpEnvironmentAvailable(connectedEnabled)).toBe(true);
    expect(isFollowUpEnvironmentAvailable(connectedDisabled)).toBe(false);
    expect(isFollowUpEnvironmentAvailable(reconnectingEnabled)).toBe(false);
    expect(
      isFollowUpEnvironmentAvailable({
        connection: { phase: "connected" },
        serverConfig: null,
      }),
    ).toBe(false);
  });

  it("filters project environments and exposes the route when any environment qualifies", () => {
    const environments = [connectedDisabled, reconnectingEnabled, connectedEnabled];

    expect([...availableFollowUpEnvironmentIds(environments)]).toEqual([
      connectedEnabled.environmentId,
    ]);
    expect(hasAvailableFollowUpEnvironment(environments)).toBe(true);
    expect(hasAvailableFollowUpEnvironment([connectedDisabled, reconnectingEnabled])).toBe(false);
  });
});
