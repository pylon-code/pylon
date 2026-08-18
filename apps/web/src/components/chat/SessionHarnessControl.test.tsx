import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SessionHarnessControl } from "./SessionHarnessControl";

const agentDepth = {
  provider: ProviderDriverKind.make("primeAgent"),
  providerInstanceId: ProviderInstanceId.make("prime-work"),
  maxDepth: 1,
  source: "session" as const,
  maxSettableDepth: 4,
  writable: true,
  settable: true,
  updatedAt: "2026-08-18T00:00:00.000Z",
};

describe("SessionHarnessControl", () => {
  it("consolidates session controls behind one descriptive trigger", () => {
    const html = renderToStaticMarkup(
      <SessionHarnessControl
        agentDepth={agentDepth}
        agentDepthDisabled={false}
        agentDepthAccessibleLabel="Agent spawn depth 1"
        resourceInventory={null}
        showResourceReload
        resourceReloadDisabled={false}
        isReloadingResources={false}
        onSetAgentDepth={() => undefined}
        onOpenResources={() => undefined}
        onReloadResources={() => undefined}
      />,
    );

    expect(html).toContain("Harness");
    expect(html).toContain("Session harness controls. Agent spawn depth 1.");
    expect(html).not.toContain("Reload session commands and resources");
  });
});
