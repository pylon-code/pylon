import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProviderContinuationTransition } from "./providerContinuation.ts";

function provider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly continuationGroupKey?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.continuationGroupKey === undefined
      ? {}
      : { continuation: { groupKey: input.continuationGroupKey } }),
  };
}

const id = ProviderInstanceId.make;

describe("resolveProviderContinuationTransition", () => {
  it("accepts the exact current instance without continuation metadata", () => {
    expect(
      resolveProviderContinuationTransition({
        providers: [],
        currentInstanceId: id("codex"),
        targetInstanceId: id("codex"),
      }),
    ).toEqual({ compatible: true });
  });

  it("accepts only same-driver instances with an exact non-empty continuation identity", () => {
    const providers = [
      provider({ instanceId: "codex", driver: "codex", continuationGroupKey: "codex:home:a" }),
      provider({
        instanceId: "codex_personal",
        driver: "codex",
        continuationGroupKey: "codex:home:a",
      }),
      provider({
        instanceId: "codex_other",
        driver: "codex",
        continuationGroupKey: "codex:home:b",
      }),
      provider({
        instanceId: "claude",
        driver: "claudeAgent",
        continuationGroupKey: "codex:home:a",
      }),
    ];

    expect(
      resolveProviderContinuationTransition({
        providers,
        currentInstanceId: id("codex"),
        targetInstanceId: id("codex_personal"),
      }),
    ).toEqual({ compatible: true });
    expect(
      resolveProviderContinuationTransition({
        providers,
        currentInstanceId: id("codex"),
        targetInstanceId: id("codex_other"),
      }),
    ).toMatchObject({ compatible: false });
    expect(
      resolveProviderContinuationTransition({
        providers,
        currentInstanceId: id("codex"),
        targetInstanceId: id("claude"),
      }),
    ).toMatchObject({ compatible: false });
  });

  it("rejects unresolved and missing continuation identities with a concrete reason", () => {
    const providers = [
      provider({ instanceId: "codex", driver: "codex" }),
      provider({ instanceId: "codex_personal", driver: "codex" }),
    ];
    const unresolved = resolveProviderContinuationTransition({
      providers,
      currentInstanceId: id("missing"),
      targetInstanceId: id("codex"),
    });
    const unproven = resolveProviderContinuationTransition({
      providers,
      currentInstanceId: id("codex"),
      targetInstanceId: id("codex_personal"),
    });

    expect(unresolved).toMatchObject({
      compatible: false,
      reason: expect.stringContaining("cannot be resolved"),
    });
    expect(unproven).toMatchObject({
      compatible: false,
      reason: expect.stringContaining("does not prove"),
    });
  });
});
