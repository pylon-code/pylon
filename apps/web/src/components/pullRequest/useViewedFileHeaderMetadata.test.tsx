import { parsePatchFiles, type CodeViewItem } from "@pierre/diffs";
import { act, memo, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/checkbox", () => ({
  Checkbox: ({ checked }: { checked: boolean }) => (
    <input type="checkbox" checked={checked} readOnly />
  ),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./pullRequestPresentation", () => ({
  PullRequestDiffStat: () => <span>stat</span>,
}));

import type { PullRequestFilesViewedView } from "./usePullRequestFilesViewed";
import { useViewedFileHeaderMetadata } from "./useViewedFileHeaderMetadata";

const fileDiff = parsePatchFiles(
  "diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
)[0]!.files[0]!;
const item = { id: "file-a", type: "diff", fileDiff } satisfies CodeViewItem;
const omitted = new Map();
const setFileViewed = vi.fn();
let portalRenders = 0;
let renderer: ReactTestRenderer | null = null;

function answer(enabled: boolean, viewed: boolean): PullRequestFilesViewedView {
  return {
    enabled,
    isViewed: () => viewed,
    isTrackable: () => true,
    isStale: () => false,
    setViewed: vi.fn(),
    viewedCount: viewed ? 1 : 0,
    truncated: false,
    error: null,
    refresh: vi.fn(),
  };
}

// Pierre's SlotPortals memoizes its children by renderer identity and item key. This models
// that boundary without starting its DOM/worker renderer in a react-test-renderer test.
const Portal = memo(function Portal({
  render,
}: {
  render: (item: CodeViewItem) => React.ReactNode;
}) {
  portalRenders += 1;
  return render(item);
});

function Surface({ state }: { state: PullRequestFilesViewedView }) {
  const render = useViewedFileHeaderMetadata(state, omitted, setFileViewed);
  return <Portal render={render} />;
}

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  portalRenders = 0;
});

it("repaints a memoized file header on viewed and account-disabled answers", async () => {
  act(() => {
    renderer = create(
      <StrictMode>
        <Surface state={answer(true, false)} />
      </StrictMode>,
    );
  });
  expect(renderer!.root.findByType("input").props.checked).toBe(false);
  const initialRenders = portalRenders;

  await act(async () =>
    renderer!.update(
      <StrictMode>
        <Surface state={answer(true, true)} />
      </StrictMode>,
    ),
  );
  expect(portalRenders).toBeGreaterThan(initialRenders);
  expect(renderer!.root.findByType("input").props.checked).toBe(true);

  await act(async () =>
    renderer!.update(
      <StrictMode>
        <Surface state={answer(false, false)} />
      </StrictMode>,
    ),
  );
  expect(renderer!.root.findAllByType("input")).toHaveLength(0);
});
