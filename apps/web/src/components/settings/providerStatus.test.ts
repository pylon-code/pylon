import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderDistributionLabel, getProviderSummary } from "./providerStatus";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", label: "ChatGPT" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getProviderSummary", () => {
  it("reports ready providers with unknown authentication as available", () => {
    expect(getProviderSummary({ ...provider, auth: { status: "unknown" } })).toEqual({
      headline: "Available",
      detail: null,
    });
  });

  it("does not hide a provider error behind a previous authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        message: "The provider process failed to start.",
      }),
    ).toEqual({
      headline: "Unavailable",
      detail: "The provider process failed to start.",
    });
  });

  it("does not hide a provider warning behind an authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "warning",
        message: "The provider version is unsupported.",
      }),
    ).toEqual({
      headline: "Needs attention",
      detail: "The provider version is unsupported.",
    });
  });

  it("keeps authentication failures actionable when their provider status is error", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Run codex login.",
      }),
    ).toEqual({
      headline: "Not authenticated",
      detail: "Run codex login.",
    });
  });

  it("treats a disabled provider status as disabled even before its enabled flag updates", () => {
    expect(getProviderSummary({ ...provider, status: "disabled" }).headline).toBe("Disabled");
  });
});

describe("getProviderDistributionLabel", () => {
  it("keeps stock providers quiet and labels managed, manual, and invalid proof", () => {
    expect(getProviderDistributionLabel(undefined)).toBeNull();
    expect(
      getProviderDistributionLabel({
        classification: "stock-or-custom",
        channel: null,
        buildId: null,
        sequence: null,
        latestBuildId: null,
        latestSequence: null,
        updateAvailable: false,
        checkedAt: null,
        message: null,
      }),
    ).toBeNull();
    expect(
      getProviderDistributionLabel({
        classification: "pylon-managed",
        channel: "preview",
        buildId: "pylon-build-g0123456789ab-r1",
        sequence: 9,
        latestBuildId: "pylon-build-g0123456789ab-r1",
        latestSequence: 9,
        updateAvailable: false,
        checkedAt: null,
        message: null,
      }),
    ).toBe("Pylon managed · preview #9");
    expect(
      getProviderDistributionLabel({
        classification: "pylon-unmanaged",
        channel: null,
        buildId: "pylon-build-g0123456789ab-r1",
        sequence: null,
        latestBuildId: null,
        latestSequence: null,
        updateAvailable: false,
        checkedAt: null,
        message: null,
      }),
    ).toBe("Pylon build · manual");
    expect(
      getProviderDistributionLabel({
        classification: "invalid-receipt",
        channel: null,
        buildId: null,
        sequence: null,
        latestBuildId: null,
        latestSequence: null,
        updateAvailable: false,
        checkedAt: null,
        message: null,
      }),
    ).toBe("Managed receipt invalid");
  });
});
