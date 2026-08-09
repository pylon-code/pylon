import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boundSessionGoalObjective,
  deriveActiveSessionGoal,
  formatSessionGoalElapsed,
  formatSessionGoalTokenUsage,
  supportsSessionGoalObservation,
} from "./sessionGoal.ts";

const provider = {
  featureCapabilities: {
    version: 1 as const,
    goals: {
      support: "read-only" as const,
      operations: ["observe" as const],
    },
  },
};

const goalActivity = (input: {
  readonly id: string;
  readonly instanceId: string;
  readonly available?: boolean;
  readonly objective?: string;
  readonly tokensUsed?: number;
}) =>
  ({
    id: EventId.make(input.id),
    kind: "session.goal.updated",
    tone: "info",
    summary: "Session goal updated",
    turnId: null,
    createdAt: `2026-08-10T00:00:0${input.id.length}.000Z`,
    payload: {
      provider: ProviderDriverKind.make("primeAgent"),
      providerInstanceId: ProviderInstanceId.make(input.instanceId),
      available: input.available ?? true,
      active: input.available ?? true,
      status: input.available === false ? "idle" : "active",
      ...(input.objective ? { objective: input.objective } : {}),
      tokenBudget: 10_000,
      tokensUsed: input.tokensUsed ?? 1_000,
      timeUsedSeconds: 125,
      continuationsUsed: 2,
    },
  }) as OrchestrationThreadActivity;

const derive = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  overrides?: Partial<Parameters<typeof deriveActiveSessionGoal>[0]>,
) =>
  deriveActiveSessionGoal({
    activities,
    provider,
    providerInstanceId: ProviderInstanceId.make("prime-work"),
    runtimeMode: "full-access",
    sessionStatus: "ready",
    ...overrides,
  });

describe("session goal state", () => {
  it("selects the latest stable snapshot for the active provider instance", () => {
    const snapshot = derive([
      goalActivity({ id: "old", instanceId: "prime-work", objective: "Old", tokensUsed: 100 }),
      goalActivity({ id: "other", instanceId: "other", objective: "Wrong provider" }),
      goalActivity({
        id: "latest",
        instanceId: "prime-work",
        objective: "Ship safely",
        tokensUsed: 2_500,
      }),
    ]);

    expect(snapshot).toMatchObject({
      objective: "Ship safely",
      tokensUsed: 2_500,
      status: "active",
    });
    expect(JSON.stringify(snapshot)).not.toContain("summary");
  });

  it("retracts stale state for unavailable, supervised, stopped, and unsupported sessions", () => {
    const active = goalActivity({ id: "active", instanceId: "prime-work", objective: "Old goal" });
    const unavailable = goalActivity({
      id: "barrier",
      instanceId: "prime-work",
      available: false,
    });

    expect(derive([active, unavailable])).toBeNull();
    expect(derive([active], { runtimeMode: "approval-required" })).toBeNull();
    expect(derive([active], { sessionStatus: "stopped" })).toBeNull();
    expect(derive([active], { provider: {} })).toBeNull();
    expect(derive([active], { provider: { ...provider, availability: "unavailable" } })).toBeNull();
  });

  it("requires provider-advertised goal observation", () => {
    expect(supportsSessionGoalObservation(provider)).toBe(true);
    expect(
      supportsSessionGoalObservation({
        featureCapabilities: {
          version: 1 as const,
          goals: { support: "read-only" as const, operations: [] },
        },
      }),
    ).toBe(false);
    expect(
      supportsSessionGoalObservation({
        featureCapabilities: {
          version: 1 as const,
          goals: { support: "unavailable" as const, operations: ["observe" as const] },
        },
      }),
    ).toBe(false);
  });

  it("bounds and formats safe presentation fields", () => {
    expect(boundSessionGoalObjective("abcdefgh", 6)).toBe("abcde…");
    expect(boundSessionGoalObjective("🧭🧭🧭", 3)).toBe("🧭🧭🧭");
    expect(boundSessionGoalObjective("🧭🧭🧭", 2)).toBe("🧭…");
    expect(formatSessionGoalTokenUsage({ tokensUsed: 1_250, tokenBudget: 10_000 })).toBe(
      "1,250 / 10,000 tokens",
    );
    expect(formatSessionGoalElapsed(125)).toBe("2m 5s");
  });
});
