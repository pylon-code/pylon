import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { configureSelectedDeviceEnvironments } from "./deviceIntegrationSettings.logic";

describe("selected environment device setup", () => {
  it("configures local and remote independently and names offline and failed targets", async () => {
    const local = EnvironmentId.make("local");
    const remote = EnvironmentId.make("remote");
    const offline = EnvironmentId.make("offline");
    const configure = vi.fn(async (environmentId: EnvironmentId) => environmentId === local);
    const failed = await configureSelectedDeviceEnvironments(
      [
        { environmentId: local, label: "Local", connected: true, loaded: true },
        { environmentId: remote, label: "Remote", connected: true, loaded: true },
        { environmentId: offline, label: "Offline", connected: false, loaded: true },
      ],
      { enabled: true },
      configure,
    );
    expect(failed).toEqual(["Remote", "Offline"]);
    expect(configure).toHaveBeenCalledTimes(2);
    expect(configure).toHaveBeenCalledWith(local, { enabled: true, onboardingCompleted: true });
    expect(configure).toHaveBeenCalledWith(remote, { enabled: true, onboardingCompleted: true });
  });

  it("does not claim success after a rejected configure command", async () => {
    const local = EnvironmentId.make("local");
    expect(
      await configureSelectedDeviceEnvironments(
        [{ environmentId: local, label: "Local", connected: true, loaded: true }],
        { enabled: false, agentAccessEnabled: false },
        async () => {
          throw new Error("disconnected during request");
        },
      ),
    ).toEqual(["Local"]);
  });
});
