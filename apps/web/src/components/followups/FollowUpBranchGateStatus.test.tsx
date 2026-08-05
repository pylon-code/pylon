import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  FollowUpBranchGateBadge,
  FollowUpBranchGateUnavailable,
  resolveFollowUpBranchGatePresentation,
} from "./FollowUpBranchGateStatus";

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

describe("FollowUpBranchGateUnavailable", () => {
  it("renders an accessible static unavailable state without prior blocker data", () => {
    const markup = renderToStaticMarkup(
      <FollowUpBranchGateUnavailable branchRef="release" lastKnownBlockerCount={null} />,
    );

    expect(markup).toContain('data-testid="follow-up-branch-gate-unavailable"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Gate status unavailable for release"');
    expect(markup).toContain(">?<");
  });

  it("retains the last synchronized blocker count when the subscription fails", () => {
    const markup = renderToStaticMarkup(
      <FollowUpBranchGateUnavailable branchRef="release" lastKnownBlockerCount={2} />,
    );

    expect(markup).toContain(
      'aria-label="Gate status unavailable for release; last synchronized count was 2 blockers"',
    );
    expect(markup).toContain(">2<");
  });

  it("remains visibly unavailable when the retained blocker count is zero", () => {
    const presentation = resolveFollowUpBranchGatePresentation({
      failed: true,
      synchronized: true,
      blockerCount: 0,
    });
    const markup = renderToStaticMarkup(
      <FollowUpBranchGateUnavailable branchRef="release" lastKnownBlockerCount={0} />,
    );

    expect(presentation).toEqual({ kind: "unavailable", lastKnownBlockerCount: 0 });
    expect(markup).toContain("Gate status unavailable");
    expect(markup).toContain(">0<");
  });

  it("selects the unavailable treatment on failure with or without prior state", () => {
    expect(
      resolveFollowUpBranchGatePresentation({
        failed: true,
        synchronized: false,
        blockerCount: 0,
      }),
    ).toEqual({ kind: "unavailable", lastKnownBlockerCount: null });
    expect(
      resolveFollowUpBranchGatePresentation({
        failed: true,
        synchronized: true,
        blockerCount: 2,
      }),
    ).toEqual({ kind: "unavailable", lastKnownBlockerCount: 2 });
  });
});
