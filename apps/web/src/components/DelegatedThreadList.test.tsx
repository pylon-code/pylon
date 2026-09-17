import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { DelegatedThreadList } from "./DelegatedThreadList";
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
describe("Pylon child visibility", () => {
  it("labels completion as a review action rather than verified success", () => {
    const html = renderToStaticMarkup(
      <DelegatedThreadList rows={[{ ...child, status: "completed" }]} />,
    );
    expect(html).toContain("Completed · review result");
    expect(html).not.toContain("verified");
  });
});
