import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { FollowUpBranchGateBadge } from "./FollowUpBranchGateStatus";

describe("FollowUpBranchGateBadge", () => {
  it("presents an accessible unresolved-blocker count", () => {
    const markup = renderToStaticMarkup(
      <FollowUpBranchGateBadge blockerCount={2} branchRef="release" />,
    );

    expect(markup).toContain('data-testid="follow-up-branch-gate-status"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="release is blocked by 2 unresolved follow-up blockers"');
    expect(markup).toContain(">2<");
    expect(markup).toContain("bg-destructive/8");
  });

  it("uses singular blocker copy", () => {
    const markup = renderToStaticMarkup(
      <FollowUpBranchGateBadge blockerCount={1} branchRef="main" />,
    );

    expect(markup).toContain('aria-label="main is blocked by 1 unresolved follow-up blocker"');
  });
});
