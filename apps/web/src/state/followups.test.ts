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
    serverConfigSynchronized: true,
  };
  const connectedDisabled = {
    environmentId: EnvironmentId.make("environment-disabled"),
    connection: { phase: "connected" as const },
    serverConfig: { settings: { followUpsEnabled: false } },
    serverConfigSynchronized: true,
  };
  const reconnectingEnabled = {
    environmentId: EnvironmentId.make("environment-reconnecting"),
    connection: { phase: "reconnecting" as const },
    serverConfig: { settings: { followUpsEnabled: true } },
    serverConfigSynchronized: true,
  };

  it("requires both a connected environment and its enabled setting", () => {
    expect(isFollowUpEnvironmentAvailable(connectedEnabled)).toBe(true);
    expect(isFollowUpEnvironmentAvailable(connectedDisabled)).toBe(false);
    expect(isFollowUpEnvironmentAvailable(reconnectingEnabled)).toBe(false);
    expect(
      isFollowUpEnvironmentAvailable({
        connection: { phase: "connected" },
        serverConfig: null,
        serverConfigSynchronized: false,
      }),
    ).toBe(false);
  });

  it("waits for current-generation config instead of trusting cached feature settings", () => {
    const cachedDisabled = {
      connection: { phase: "connected" as const },
      serverConfig: { settings: { followUpsEnabled: false } },
      serverConfigSynchronized: false,
    };
    const cachedEnabled = {
      connection: { phase: "connected" as const },
      serverConfig: { settings: { followUpsEnabled: true } },
      serverConfigSynchronized: false,
    };

    expect(resolveFollowUpAvailability(true, [cachedDisabled])).toEqual({
      status: "pending",
      reason: "server-config",
    });
    expect(resolveFollowUpAvailability(true, [cachedEnabled])).toEqual({
      status: "pending",
      reason: "server-config",
    });
    expect(isFollowUpEnvironmentAvailable(cachedEnabled)).toBe(false);

    expect(
      resolveFollowUpAvailability(true, [
        {
          ...cachedDisabled,
          serverConfig: { settings: { followUpsEnabled: true } },
          serverConfigSynchronized: true,
        },
      ]),
    ).toEqual({ status: "available" });
    expect(
      resolveFollowUpAvailability(true, [
        {
          ...cachedEnabled,
          serverConfig: { settings: { followUpsEnabled: false } },
          serverConfigSynchronized: true,
        },
      ]),
    ).toEqual({ status: "unavailable", reason: "disabled" });
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
      expected: { status: "pending", reason: "catalog" },
    },
    {
      label: "connection bootstrap",
      catalogReady: true,
      environments: [
        {
          connection: { phase: "connecting" as const },
          serverConfig: null,
          serverConfigSynchronized: false,
        },
      ],
      expected: { status: "pending", reason: "connecting" },
    },
    {
      label: "available connection awaiting startup",
      catalogReady: true,
      environments: [
        {
          connection: { phase: "available" as const },
          serverConfig: null,
          serverConfigSynchronized: false,
        },
      ],
      expected: { status: "pending", reason: "connecting" },
    },
    {
      label: "persistent reconnect backoff",
      catalogReady: true,
      environments: [reconnectingEnabled],
      expected: { status: "pending", reason: "reconnecting" },
    },
    {
      label: "recoverable offline environment",
      catalogReady: true,
      environments: [
        {
          connection: { phase: "offline" as const },
          serverConfig: { settings: { followUpsEnabled: true } },
          serverConfigSynchronized: true,
        },
      ],
      expected: { status: "pending", reason: "offline" },
    },
    {
      label: "config bootstrap",
      catalogReady: true,
      environments: [
        {
          connection: { phase: "connected" as const },
          serverConfig: null,
          serverConfigSynchronized: false,
        },
      ],
      expected: { status: "pending", reason: "server-config" },
    },
    {
      label: "enabled environment",
      catalogReady: true,
      environments: [connectedEnabled],
      expected: { status: "available" },
    },
    {
      label: "available wins over pending",
      catalogReady: true,
      environments: [reconnectingEnabled, connectedEnabled],
      expected: { status: "available" },
    },
    {
      label: "settled disabled environment",
      catalogReady: true,
      environments: [connectedDisabled],
      expected: { status: "unavailable", reason: "disabled" },
    },
    {
      label: "settled connection error",
      catalogReady: true,
      environments: [
        {
          connection: { phase: "error" as const },
          serverConfig: null,
          serverConfigSynchronized: false,
        },
      ],
      expected: { status: "unavailable", reason: "connection-error" },
    },
    {
      label: "no configured environments",
      catalogReady: true,
      environments: [],
      expected: { status: "unavailable", reason: "no-environments" },
    },
  ] as const)(
    "reports the truthful state during $label",
    ({ catalogReady, environments, expected }) => {
      expect(resolveFollowUpAvailability(catalogReady, environments)).toEqual(expected);
    },
  );

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
