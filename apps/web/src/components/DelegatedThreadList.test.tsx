import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  DelegationSummary,
  DelegatedThreadList,
  type DelegatedThreadRows,
} from "./DelegatedThreadList";
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
  }: {
    children: React.ReactNode;
    params: { environmentId: string; threadId: string };
  }) => <a href={`/${params.environmentId}/${params.threadId}`}>{children}</a>,
}));
const child = {
  threadId: ThreadId.make("delegated:parent:0123456789abcdef"),
  environmentId: EnvironmentId.make("env"),
  title: "Review authentication",
  providerName: "Codex",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  status: "running" as const,
  activity: "Checking session expiry",
};
const render = (rows: DelegatedThreadRows, waiting = false) =>
  renderToStaticMarkup(<DelegationSummary rows={rows} waiting={waiting} onOpenAgents={() => {}} />);
describe("Pylon child visibility", () => {
  it("keeps independent child work visible without claiming the parent waits", () => {
    const html = render([child]);
    expect(html).toContain("1 delegated agent active");
    expect(html).not.toContain("Waiting for");
    expect(html).toContain("Review authentication");
    expect(html).toContain("Checking session expiry");
    expect(html).toContain("/env/delegated:parent:0123456789abcdef");
    expect(html).not.toContain("Cancel");
  });
  it("prioritizes blockers over waiting and clears waiting for terminal children", () => {
    expect(render([child], true)).toContain("Waiting for delegated agent");
    expect(render([{ ...child, status: "needs-input" }], true)).toContain("needs attention");
    expect(render([{ ...child, status: "completed" }], true)).not.toContain("Waiting for");
    expect(render([{ ...child, status: "error" }])).not.toContain("results available");
    expect(render([])).toBe("");
  });
  it("labels completion as a review action rather than verified success", () => {
    const html = renderToStaticMarkup(
      <DelegatedThreadList rows={[{ ...child, status: "completed" }]} />,
    );
    expect(html).toContain("Completed · review result");
    expect(html).not.toContain("verified");
  });
});
