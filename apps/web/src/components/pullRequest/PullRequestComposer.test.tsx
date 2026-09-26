import { EnvironmentId, ProjectId, type PullRequestDetailView } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div data-testid="popover">{children}</div>,
  PopoverTrigger: ({
    children,
    "aria-label": label,
  }: {
    children: ReactNode;
    "aria-label"?: string;
  }) => <div aria-label={label}>{children}</div>,
  PopoverPopup: ({ children, keepMounted }: { children: ReactNode; keepMounted: boolean }) => (
    <div data-testid="popup" data-keep-mounted={keepMounted}>
      {children}
    </div>
  ),
  PopoverTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverClose: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/toggle-group", () => ({
  ToggleGroup: ({ children, value }: { children: ReactNode; value: string[] }) => (
    <div data-testid="mode" data-mode={value[0]}>
      {children}
    </div>
  ),
  Toggle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./PullRequestCommentForm", () => ({
  PullRequestCommentForm: () => <div data-testid="comment-form" />,
}));
vi.mock("./PullRequestReviewForm", () => ({
  PullRequestReviewForm: () => <div data-testid="review-form" />,
}));

import { PullRequestComposer } from "./PullRequestComposer";
import { pullRequestReviewKey, usePullRequestReviewStore } from "./pullRequestReviewStore";
import { Popover, PopoverTrigger } from "../ui/popover";
import { ToggleGroup } from "../ui/toggle-group";

const detail: PullRequestDetailView = {
  provider: "github",
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "Original description",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "reviewer",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: true,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: true, reply: true, resolve: true, verdicts: ["comment", "approve"] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: true },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: ["comment", "approve"],
    requestReviewers: false,
  },
};

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  usePullRequestReviewStore.setState({ drafts: {}, summaries: {} });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
async function render(value: PullRequestDetailView = detail) {
  await act(async () => {
    renderer = create(
      <PullRequestComposer
        environmentId={EnvironmentId.make("env-1")}
        reference={value}
        detail={value}
        actionPending={false}
        onCommentAction={vi.fn()}
        onCommented={vi.fn()}
        onReviewSubmitted={vi.fn()}
      />,
    );
  });
}

it("opens on a pending review, retains both modes, and leaves drafts unchanged when toggling", async () => {
  await render();
  const key = pullRequestReviewKey(EnvironmentId.make("env-1"), detail);
  await act(async () => usePullRequestReviewStore.getState().setSummary(key, "Pending summary"));
  await act(async () => renderer.root.findByType(Popover).props.onOpenChange(true));
  expect(renderer.root.findByProps({ "data-testid": "mode" }).props["data-mode"]).toBe("review");
  expect(renderer.root.findByProps({ "data-testid": "popup" }).props["data-keep-mounted"]).toBe(
    true,
  );
  expect(renderer.root.findAllByProps({ "data-testid": "comment-form" })).toHaveLength(1);
  expect(renderer.root.findAllByProps({ "data-testid": "review-form" })).toHaveLength(1);
  await act(async () => renderer.root.findByType(ToggleGroup).props.onValueChange(["comment"]));
  expect(renderer.root.findByProps({ "data-testid": "mode" }).props["data-mode"]).toBe("comment");
  expect(usePullRequestReviewStore.getState().summaries[key]).toBe("Pending summary");
});

it("offers only the actions allowed by both host capability and viewer permission", async () => {
  await render({ ...detail, viewerPermissions: { ...detail.viewerPermissions, comment: false } });
  expect(renderer.root.findAllByProps({ "data-testid": "review-form" })).toHaveLength(1);
  expect(renderer.root.findAllByProps({ "data-testid": "comment-form" })).toHaveLength(0);
  await act(async () => renderer.unmount());
  await render({
    ...detail,
    viewerPermissions: { ...detail.viewerPermissions, comment: false, verdicts: [] },
  });
  expect(renderer.toJSON()).toBeNull();
});

it("does not advertise an unavailable review when a pending draft outlives verdict permission", async () => {
  const key = pullRequestReviewKey(EnvironmentId.make("env-1"), detail);
  usePullRequestReviewStore.getState().setSummary(key, "Held review");
  await render({
    ...detail,
    viewerPermissions: { ...detail.viewerPermissions, verdicts: [] },
  });
  expect(renderer.root.findByType(PopoverTrigger).props["aria-label"]).toBe(
    "Comment on pull request",
  );
  expect(renderer.root.findAllByProps({ "data-testid": "review-form" })).toHaveLength(0);
  expect(renderer.root.findAllByProps({ "data-testid": "comment-form" })).toHaveLength(1);
});
