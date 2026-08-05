import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  areAvailableFollowUpShellsBootstrapped,
  availableFollowUpEnvironmentIds,
  hasAvailableFollowUpEnvironment,
  isFollowUpEnvironmentAvailable,
  resolveFollowUpAvailability,
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

  it.each([
    {
      label: "catalog bootstrap",
      catalogReady: false,
      environments: [],
      expected: "pending",
    },
    {
      label: "connection bootstrap",
      catalogReady: true,
      environments: [
        {
          connection: { phase: "connecting" as const },
          serverConfig: null,
        },
      ],
      expected: "pending",
    },
    {
      label: "available connection awaiting startup",
      catalogReady: true,
      environments: [
        {
          connection: { phase: "available" as const },
          serverConfig: null,
        },
      ],
      expected: "pending",
    },
    {
      label: "reconnection bootstrap",
      catalogReady: true,
      environments: [reconnectingEnabled],
      expected: "pending",
    },
    {
      label: "config bootstrap",
      catalogReady: true,
      environments: [
        {
          connection: { phase: "connected" as const },
          serverConfig: null,
        },
      ],
      expected: "pending",
    },
    {
      label: "enabled environment",
      catalogReady: true,
      environments: [connectedEnabled],
      expected: "available",
    },
    {
      label: "available wins over pending",
      catalogReady: true,
      environments: [reconnectingEnabled, connectedEnabled],
      expected: "available",
    },
    {
      label: "settled disabled environment",
      catalogReady: true,
      environments: [connectedDisabled],
      expected: "unavailable",
    },
    {
      label: "no configured environments",
      catalogReady: true,
      environments: [],
      expected: "unavailable",
    },
  ] as const)("reports $expected during $label", ({ catalogReady, environments, expected }) => {
    expect(resolveFollowUpAvailability(catalogReady, environments)).toBe(expected);
  });

  it("does not let an ineligible environment block eligible shell bootstrap", () => {
    expect(
      areAvailableFollowUpShellsBootstrapped([
        { available: true, shellBootstrapped: true },
        { available: false, shellBootstrapped: false },
      ]),
    ).toBe(true);
    expect(
      areAvailableFollowUpShellsBootstrapped([
        { available: true, shellBootstrapped: false },
        { available: false, shellBootstrapped: true },
      ]),
    ).toBe(false);
  });
});
