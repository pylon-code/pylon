import {
  EnvironmentId,
  ProjectId,
  type PullRequestFilesViewedResult,
  type PullRequestRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { act, startTransition, StrictMode, Suspense } from "react";
import { create, type ReactTestRenderer, type TestRendererOptions } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { host, setFilesViewed, toastAdd } = vi.hoisted(() => ({
  host: { data: null as unknown, error: null as string | null, refresh: vi.fn() },
  setFilesViewed: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: { filesViewed: () => null, setFilesViewed: {} },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: host.data,
    error: host.error,
    isPending: false,
    isSuccess: true,
    refresh: host.refresh,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => setFilesViewed }));
vi.mock("../ui/toast", () => ({ toastManager: { add: toastAdd } }));

import {
  usePullRequestFilesViewed,
  type PullRequestFilesViewedView,
} from "./usePullRequestFilesViewed";

const environmentId = EnvironmentId.make("pr-files-viewed-audit");
const reference: PullRequestRef = {
  projectId: ProjectId.make("project-a"),
  repository: "acme/web",
  number: 42,
};
const paths = ["a.ts"];
let evidence = new Map([["a.ts", { digest: "a".repeat(64), cursor: null }]]);
const onWriteRejected = vi.fn();

/** What the host answers, as a fresh object each time: a read is only a read if it is a new one. */
function answer(state: "unviewed" | "viewed" | "dismissed"): PullRequestFilesViewedResult {
  return { viewer: "bilal", files: [{ path: "a.ts", state }], truncated: false };
}

let renderer: ReactTestRenderer | null = null;

function Probe(_props: { readonly view: PullRequestFilesViewedView }) {
  return null;
}

function Surface({ currentReference = reference }: { readonly currentReference?: PullRequestRef }) {
  const view = usePullRequestFilesViewed({
    environmentId,
    reference: currentReference,
    enabled: true,
    paths,
    evidence,
    onWriteRejected,
  });
  return <Probe view={view} />;
}

const otherReference: PullRequestRef = { ...reference, number: 43 };
const neverResolves = new Promise<never>(() => {});
let suspendedRenders = 0;

function SuspendAfterSurface(): never {
  suspendedRenders += 1;
  throw neverResolves;
}

async function show(currentReference: PullRequestRef) {
  await act(async () =>
    renderer!.update(
      <StrictMode>
        <Surface currentReference={currentReference} />
      </StrictMode>,
    ),
  );
}

function view(): PullRequestFilesViewedView {
  return renderer!.root.findByType(Probe).props.view;
}

/** The host's next answer landing, which is what a `refresh` ends in. */
async function reads(state: "unviewed" | "viewed" | "dismissed") {
  host.data = answer(state);
  await act(async () =>
    renderer!.update(
      <StrictMode>
        <Surface />
      </StrictMode>,
    ),
  );
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.data = answer("unviewed");
  host.error = null;
  evidence = new Map([["a.ts", { digest: "a".repeat(64), cursor: null }]]);
  host.refresh.mockReset();
  onWriteRejected.mockReset();
  toastAdd.mockReset();
  suspendedRenders = 0;
  setFilesViewed.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  act(() => {
    renderer = create(
      <StrictMode>
        <Surface />
      </StrictMode>,
    );
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a mark whose file was pushed to before the read that followed it", () => {
  it("gives way to the host and shows the file as changed", async () => {
    view().setViewed("a.ts", true);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(setFilesViewed).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        ...reference,
        expectedViewer: "bilal",
        files: [{ path: "a.ts", viewed: true, digest: "a".repeat(64) }],
      },
    });
    expect(host.refresh).toHaveBeenCalled();

    // The push landed between the write and this read, so the host answers `dismissed` rather
    // than the `viewed` the press asked for.
    await reads("dismissed");

    expect(view().isViewed("a.ts")).toBe(false);
    expect(view().isStale("a.ts")).toBe(true);
    expect(view().viewedCount).toBe(0);
  });

  it("stays given way to on every later read, having nothing left to recover", async () => {
    view().setViewed("a.ts", true);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await reads("dismissed");

    view().refresh();
    await reads("dismissed");

    expect(view().isViewed("a.ts")).toBe(false);
    expect(view().isStale("a.ts")).toBe(true);
  });
});

describe("a mark the host has not answered for yet", () => {
  it("holds the press while the write is still out", async () => {
    let land = (_result: unknown) => {};
    setFilesViewed.mockReturnValueOnce(new Promise((resolve) => (land = resolve)));

    view().setViewed("a.ts", true);
    await act(async () => vi.advanceTimersByTimeAsync(500));

    // An answer already on its way when the box was ticked must not put it back.
    await reads("unviewed");
    expect(view().isViewed("a.ts")).toBe(true);

    await act(async () => land(AsyncResult.success(undefined)));
    expect(view().isViewed("a.ts")).toBe(true);
  });

  it("holds a press made since the read that would otherwise answer for it", async () => {
    view().setViewed("a.ts", true);
    await act(async () => vi.advanceTimersByTimeAsync(500));

    // Pressed again before the post-write read came back. That press is the one on screen, and
    // the read that answers for the first one says nothing about it.
    view().setViewed("a.ts", true);
    await reads("dismissed");

    expect(view().isViewed("a.ts")).toBe(true);
    expect(view().isStale("a.ts")).toBe(false);
  });
});

it("never shows the old mark or pending press as viewed over a newly displayed file", async () => {
  host.data = {
    viewer: "bilal",
    files: [{ path: "a.ts", state: "viewed", digest: "a".repeat(64) }],
    truncated: false,
  } satisfies PullRequestFilesViewedResult;
  await act(async () =>
    renderer!.update(
      <StrictMode>
        <Surface />
      </StrictMode>,
    ),
  );
  expect(view().isViewed("a.ts")).toBe(true);

  view().setViewed("a.ts", true);
  evidence = new Map([["a.ts", { digest: "b".repeat(64), cursor: null }]]);
  await act(async () =>
    renderer!.update(
      <StrictMode>
        <Surface />
      </StrictMode>,
    ),
  );
  expect(view().isViewed("a.ts")).toBe(false);
  expect(view().isStale("a.ts")).toBe(true);
  expect(view().viewedCount).toBe(0);
});

it("reverses the coupled file fold when a mark is rejected", async () => {
  setFilesViewed.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("denied"))));
  view().setViewed("a.ts", true);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(view().isViewed("a.ts")).toBe(false);
  expect(onWriteRejected).toHaveBeenCalledExactlyOnceWith(["a.ts"]);
});

it("sends the account that owned a queued press even after the next account's answer arrives", async () => {
  view().setViewed("a.ts", true);
  host.data = {
    viewer: "new-account",
    files: [],
    truncated: false,
  } satisfies PullRequestFilesViewedResult;
  await act(async () =>
    renderer!.update(
      <StrictMode>
        <Surface />
      </StrictMode>,
    ),
  );
  expect(setFilesViewed).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      ...reference,
      expectedViewer: "bilal",
      files: [{ path: "a.ts", viewed: true, digest: "a".repeat(64) }],
    },
  });
  expect(view().isViewed("a.ts")).toBe(false);
});

it("flushes the committed old request on a switch and rejects an old callback after A → B → A", async () => {
  const firstA = view().setViewed;
  firstA("a.ts", true);
  await show(otherReference);
  expect(setFilesViewed).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      ...reference,
      expectedViewer: "bilal",
      files: [{ path: "a.ts", viewed: true, digest: "a".repeat(64) }],
    },
  });

  firstA("a.ts", false);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(setFilesViewed).toHaveBeenCalledTimes(1);

  await show(reference);
  firstA("a.ts", false);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(setFilesViewed).toHaveBeenCalledTimes(1);

  view().setViewed("a.ts", false);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(setFilesViewed).toHaveBeenCalledTimes(2);
  expect(setFilesViewed).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      ...reference,
      expectedViewer: "bilal",
      files: [{ path: "a.ts", viewed: false, digest: "a".repeat(64) }],
    },
  });
});

it("rejects a retained press handler after unmount", async () => {
  const oldHandler = view().setViewed;
  await act(async () => renderer?.unmount());
  renderer = null;
  oldHandler("a.ts", true);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(setFilesViewed).not.toHaveBeenCalled();
});

it("keeps a queued press on A when a concurrent B render suspends before commit", async () => {
  await act(async () => renderer?.unmount());
  // react-test-renderer's type declaration omits this supported concurrent-root test option.
  const concurrent = { unstable_isConcurrent: true } as unknown as TestRendererOptions;
  await act(async () => {
    renderer = create(
      <StrictMode>
        <Suspense fallback={null}>
          <Surface />
        </Suspense>
      </StrictMode>,
      concurrent,
    );
  });

  view().setViewed("a.ts", true);
  await act(async () => {
    startTransition(() =>
      renderer!.update(
        <StrictMode>
          <Suspense fallback={null}>
            <Surface currentReference={otherReference} />
            <SuspendAfterSurface />
          </Suspense>
        </StrictMode>,
      ),
    );
  });
  expect(suspendedRenders).toBeGreaterThan(0);
  expect(view().enabled).toBe(true); // A is still the committed view.
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(setFilesViewed).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      ...reference,
      expectedViewer: "bilal",
      files: [{ path: "a.ts", viewed: true, digest: "a".repeat(64) }],
    },
  });
});

it("hides cached marks and disables writes after an account read fails", async () => {
  host.data = {
    viewer: "bilal",
    files: [{ path: "a.ts", state: "viewed" }],
    truncated: false,
  } satisfies PullRequestFilesViewedResult;
  await act(async () =>
    renderer!.update(
      <StrictMode>
        <Surface />
      </StrictMode>,
    ),
  );
  expect(view().isViewed("a.ts")).toBe(true);
  host.error = "account lookup failed";
  await act(async () =>
    renderer!.update(
      <StrictMode>
        <Surface />
      </StrictMode>,
    ),
  );
  expect(view().enabled).toBe(false);
  expect(view().isViewed("a.ts")).toBe(false);
  view().setViewed("a.ts", true);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(setFilesViewed).not.toHaveBeenCalled();
});
