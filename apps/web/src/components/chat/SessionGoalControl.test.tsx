import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SessionGoalControl } from "./SessionGoalControl";

const snapshot = {
  provider: ProviderDriverKind.make("primeAgent"),
  providerInstanceId: ProviderInstanceId.make("prime-work"),
  available: true,
  active: false,
  status: "budget-limited" as const,
  objective: "Finish the provider integration without exposing native goal identity",
  tokenBudget: 10_000,
  tokensUsed: 7_500,
  timeUsedSeconds: 125,
  continuationsUsed: 2,
  updatedAt: "2026-08-09T00:00:00.000Z",
};

describe("SessionGoalControl", () => {
  it("renders a provider-neutral, read-only goal trigger", () => {
    const html = renderToStaticMarkup(<SessionGoalControl snapshot={snapshot} />);

    expect(html).toContain("Session goal budget limited");
    expect(html).toContain("Finish the provider integration");
    expect(html).toContain("Managed in chat");
    expect(html).toContain("Budget limited");
    expect(html).not.toContain("goalId");
    expect(html).not.toContain("lastError");
  });

  it("explains how to start an idle goal without showing empty usage metrics", () => {
    const html = renderToStaticMarkup(
      <SessionGoalControl
        snapshot={{
          ...snapshot,
          active: false,
          status: "idle",
          objective: "",
          tokensUsed: 0,
          timeUsedSeconds: 0,
          continuationsUsed: 0,
        }}
      />,
    );

    expect(html).toContain("No goal");
    expect(html).toContain("Ask the agent to start a persistent goal");
    expect(html).not.toContain(">Tokens<");
    expect(html).not.toContain(">Elapsed<");
  });
});
