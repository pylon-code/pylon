import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countEnabledConfiguredInstances,
  getDriverMultipleInstancePresentation,
  validatePrimeAgentAddHome,
} from "./providerMultipleInstances";

const snapshot = (
  input: Partial<ServerProvider> & Pick<ServerProvider, "instanceId" | "driver">,
): ServerProvider => ({
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...input,
});

describe("provider multiple-instance presentation", () => {
  it("fails closed when the current server omits support and propagates its reason", () => {
    const driver = ProviderDriverKind.make("primeAgent");
    expect(
      getDriverMultipleInstancePresentation({
        driver,
        providers: [snapshot({ instanceId: ProviderInstanceId.make("primeAgent"), driver })],
      }),
    ).toMatchObject({ supported: false, reason: expect.stringContaining("has not proved") });

    const reason = "Run the host server inside WSL2.";
    expect(
      getDriverMultipleInstancePresentation({
        driver,
        providers: [
          snapshot({
            instanceId: ProviderInstanceId.make("primeAgent"),
            driver,
            supportsMultipleInstances: false,
            multipleInstancesUnavailableReason: reason,
          }),
        ],
      }),
    ).toEqual({ supported: false, reason });
  });

  it("requires a separate known Prime home and detects textual nesting before save", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("primeAgent")]: {
          driver: ProviderDriverKind.make("primeAgent"),
          enabled: true,
          config: { agentHomePath: "~/prime/account-a" },
        },
      },
    };
    expect(countEnabledConfiguredInstances(settings, "primeAgent")).toBe(1);
    expect(validatePrimeAgentAddHome({ draftConfig: {}, settings })).toContain("explicit");
    expect(
      validatePrimeAgentAddHome({
        draftConfig: { agentHomePath: "~/prime/account-a/nested" },
        settings,
      }),
    ).toContain("nested");
    expect(
      validatePrimeAgentAddHome({
        draftConfig: { agentHomePath: "~/prime/account-b" },
        settings,
      }),
    ).toBeNull();
  });
});
