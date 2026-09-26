import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSubscriptionUsageSnapshot,
  subscriptionUsageTimeline,
} from "./subscriptionUsageSnapshot";

const checkedAt = "2026-09-24T12:00:00.000Z";
const observedAt = Date.parse(checkedAt);
const deepLink = "pylon-code-dev://settings/usage?tab=limits";
const sessionWindow = {
  id: "session",
  kind: "session",
  label: "Secret model name",
  usedPercent: 40,
  resetsAt: "2026-09-24T12:10:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex-personal"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "private@example.com" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt, windows: [sessionWindow] },
    ...overrides,
  };
}

function presentations(
  providers: readonly ServerProvider[] = [provider()],
  phase: EnvironmentPresentation["connection"]["phase"] = "connected",
) {
  return new Map([
    [
      EnvironmentId.make("remote"),
      {
        entry: { target: { label: "Private server" } },
        connection: { phase },
        serverConfig: { providers },
      } as EnvironmentPresentation,
    ],
  ]);
}

describe("subscription usage widget snapshot", () => {
  it("publishes only display quotas with canonical labels and an observed-time expiry", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ displayName: "Private account name" })]),
      deepLink,
      observedAt,
    );
    expect(snapshot.checkedAt).toBe(observedAt);
    expect(snapshot.providers[0]).toMatchObject({
      name: "Codex",
      windows: [{ label: "Session", remaining: 60 }],
      expiresAt: observedAt + 10 * 60_000,
    });
    expect(snapshot.url).toBe(deepLink);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /private@example|Private account|Private server|Secret model/,
    );
  });

  it("clears disconnected, signed-out, disabled, and removed environments", () => {
    for (const input of [
      presentations([provider()], "offline"),
      presentations([provider({ auth: { status: "unauthenticated" } })]),
      presentations([provider({ auth: { status: "unknown" } })]),
      presentations([provider({ auth: { status: "authenticated" } })]),
      presentations([provider({ enabled: false })]),
      new Map<EnvironmentId, EnvironmentPresentation>(),
    ]) {
      const snapshot = buildSubscriptionUsageSnapshot(input, deepLink, observedAt);
      expect(snapshot.providers.every((entry) => entry.windows.length === 0)).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain("private@example.com");
    }
  });

  it("replaces the previous account reading when the connected identity changes", () => {
    const before = buildSubscriptionUsageSnapshot(presentations(), deepLink, observedAt);
    const after = buildSubscriptionUsageSnapshot(
      presentations([
        provider({
          auth: { status: "authenticated", email: "other@example.com" },
          usageLimits: {
            checkedAt,
            windows: [{ ...sessionWindow, usedPercent: 80 }],
          },
        }),
      ]),
      deepLink,
      observedAt,
    );
    expect(before.providers[0]?.windows[0]?.remaining).toBe(60);
    expect(after.providers[0]?.windows[0]?.remaining).toBe(20);
    expect(JSON.stringify(after)).not.toMatch(/private@example|other@example/);
  });

  it("does not renew an old reading when unrelated config changes republish it", () => {
    const input = presentations();
    const current = buildSubscriptionUsageSnapshot(input, deepLink, observedAt + 9 * 60_000);
    const expired = buildSubscriptionUsageSnapshot(input, deepLink, observedAt + 10 * 60_000);
    expect(current.providers[0]?.windows).toHaveLength(1);
    expect(expired.providers[0]?.windows).toEqual([]);
    expect(expired.providers[0]?.expiresAt).toBe(0);
  });

  it("fails closed for an unknown observation time and never publishes provider errors", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([
        provider({
          usageLimits: {
            checkedAt: "invalid",
            windows: [sessionWindow],
          },
        }),
      ]),
      deepLink,
      observedAt,
    );
    expect(snapshot.checkedAt).toBe(0);
    expect(snapshot.providers[0]?.windows).toEqual([]);
    const failed = buildSubscriptionUsageSnapshot(
      presentations([
        provider({
          usageLimits: {
            checkedAt,
            windows: [sessionWindow],
            unavailable: { reason: "probeFailed", message: "private token" },
          },
        }),
      ]),
      deepLink,
      observedAt,
    );
    expect(JSON.stringify(failed)).not.toContain("private token");
  });

  it("does not publish a future-dated reading as recent", () => {
    const future = buildSubscriptionUsageSnapshot(
      presentations([
        provider({
          usageLimits: {
            checkedAt: "2026-09-24T12:01:00.000Z",
            windows: [sessionWindow],
          },
        }),
      ]),
      deepLink,
      observedAt,
    );
    expect(future.checkedAt).toBe(0);
    expect(future.providers[0]?.windows).toEqual([]);
  });

  it("expires at the provider reset boundary without fabricating a refill", () => {
    const snapshot = buildSubscriptionUsageSnapshot(presentations(), deepLink, observedAt);
    const timeline = subscriptionUsageTimeline(snapshot, observedAt);
    expect(timeline.map((entry) => entry.date.getTime())).toEqual([
      observedAt,
      observedAt + 10 * 60_000,
    ]);
    expect(timeline[1]?.props.providers[0]?.windows).toEqual([]);
  });
});
