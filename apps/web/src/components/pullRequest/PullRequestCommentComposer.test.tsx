import { EnvironmentId, ProjectId, type PullRequestDetailView } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ post: vi.fn(), toast: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.post }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: { comment: {} } }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../ui/popover", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Popover: Container,
    PopoverTrigger: Container,
    PopoverPopup: Container,
    PopoverTitle: Container,
    PopoverClose: Container,
  };
});
import { PullRequestCommentComposer } from "./PullRequestCommentComposer";

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
  viewer: "author",
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
  checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
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
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: true },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

let renderer: ReactTestRenderer;
const onCommentAction = vi.fn();
const onCommented = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.post.mockResolvedValue({ _tag: "Success" });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
async function render(actionPending = false) {
  await act(async () => {
    renderer = create(
      <PullRequestCommentComposer
        environmentId={EnvironmentId.make("isolated")}
        reference={detail}
        detail={{
          ...detail,
          capabilities: { ...detail.capabilities, actions: ["close"] },
          viewerPermissions: { ...detail.viewerPermissions, actions: ["close"] },
        }}
        actionPending={actionPending}
        onCommentAction={onCommentAction}
        onCommented={onCommented}
      />,
    );
  });
}
function textarea() {
  return renderer.root.findByType("textarea");
}
async function type(body: string) {
  await act(async () =>
    textarea().props.onChange({
      target: { value: body },
      currentTarget: { value: body },
      nativeEvent: {},
    }),
  );
}
async function key(overrides: Record<string, unknown> = {}) {
  const event = {
    target: { tagName: "TEXTAREA" },
    currentTarget: { tagName: "TEXTAREA" },
    key: "Enter",
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    keyCode: 13,
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  };
  await act(async () => textarea().props.onKeyDown(event));
  return event;
}
it.each(["metaKey", "ctrlKey"])(
  "%s+Enter posts a trimmed comment without closing the PR",
  async (modifier) => {
    await render();
    await type("  Useful review feedback  ");
    const event = await key({ metaKey: false, [modifier]: true });
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith({
      environmentId: "isolated",
      input: { ...detail, body: "Useful review feedback" },
    });
    expect(onCommentAction).not.toHaveBeenCalled();
    expect(onCommented).toHaveBeenCalledOnce();
    expect(textarea().props.value).toBe("");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  },
);
it.each([
  { metaKey: false },
  { shiftKey: true },
  { altKey: true },
  { repeat: true },
  { nativeEvent: { isComposing: true } },
  { keyCode: 229 },
  { key: "a" },
])("ignores unsupported or composing key input %j", async (event) => {
  await render();
  await type("Keep this draft");
  await key(event);
  expect(mocks.post).not.toHaveBeenCalled();
  expect(onCommentAction).not.toHaveBeenCalled();
  expect(textarea().props.value).toBe("Keep this draft");
});
it("does not submit blank text or while another PR action is pending", async () => {
  await render(true);
  await type("Draft");
  await key();
  expect(mocks.post).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
  await render();
  await type("   ");
  await key();
  expect(mocks.post).not.toHaveBeenCalled();
});
it("keeps a failed draft and permits an explicit retry", async () => {
  mocks.post.mockResolvedValueOnce({ _tag: "Failure" });
  await render();
  await type("Recoverable draft");
  await key();
  expect(textarea().props.value).toBe("Recoverable draft");
  expect(onCommented).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledOnce();
  await key();
  expect(mocks.post).toHaveBeenCalledTimes(2);
  expect(textarea().props.value).toBe("");
});
it("blocks a second submission until the first command settles", async () => {
  let finish: ((value: { _tag: "Success" }) => void) | undefined;
  mocks.post.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await type("Only once");
  await key();
  expect(textarea().props.disabled).toBe(true);
  await key();
  expect(mocks.post).toHaveBeenCalledOnce();
  await act(async () => finish?.({ _tag: "Success" }));
  expect(onCommented).toHaveBeenCalledOnce();
});
