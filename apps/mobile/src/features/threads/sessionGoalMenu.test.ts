import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSessionGoalMenuActions } from "./sessionGoalMenu";

const snapshot = {
  available: true,
  active: true,
  status: "active" as const,
  objective: "Observe the provider-neutral goal without exposing private identifiers",
  tokenBudget: 10_000,
  tokensUsed: 1_250,
  timeUsedSeconds: 125,
  continuationsUsed: 2,
  provider: ProviderDriverKind.make("primeAgent"),
  providerInstanceId: ProviderInstanceId.make("prime-work"),
  updatedAt: "2026-08-10T00:00:00.000Z",
};

describe("session goal menu", () => {
  it("presents bounded read-only goal status and usage", () => {
    const actions = buildSessionGoalMenuActions(snapshot);
    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatchObject({ subtitle: "Objective · Read-only" });
    expect(actions[1]).toMatchObject({ title: "Active" });
    expect(actions[2]).toMatchObject({
      title: "1,250 / 10,000 tokens",
      subtitle: "2m 5s elapsed · 2 continuations",
    });
    expect(actions.every((action) => action.attributes.disabled)).toBe(true);
  });
});
