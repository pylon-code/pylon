import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadActions } from "./useThreadActions";
import { threadEnvironment } from "../state/threads";
import { toastManager } from "../components/ui/toast";
import * as ThreadUndo from "./threadUndo";

const commands = vi.hoisted(() => ({
  pin: vi.fn(),
  unpin: vi.fn(),
  archive: vi.fn(),
  delete: vi.fn(),
  unarchive: vi.fn(),
  settle: vi.fn(),
  unsettle: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
}));
const router = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  state: {
    matches: [{ params: {} as Record<string, string> }],
    location: { href: "/initial", state: { __TSR_key: "initial" } },
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));
vi.mock("./useSettings", () => ({ useClientSettings: () => false }));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () =>
    vi.fn(async () => {
      router.state.location.href = "/draft/new";
      router.state.location.state.__TSR_key = "draft-created-by-archive";
      return { draftId: "new", threadId: null };
    }),
}));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
const threadShell = vi.hoisted(() => ({
  title: "Thread",
  pinOrderKey: "a0",
  pinnedAt: null as string | null,
  snoozedUntil: null as string | null,
  snoozedAt: null as string | null,
  settledOverride: null as "settled" | null,
  settledAt: null as string | null,
  projectId: "project",
  environmentId: "undo-env",
  session: null,
}));
const shellState = vi.hoisted(() => ({
  available: true,
  current: null as typeof threadShell | null,
  owner: {},
  shellOwner: null as object | null,
  generation: 1,
  sequence: 0,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsPinReorder: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readThreadShell: () => (shellState.available ? shellState.current : null),
  readThreadActionProjection: () =>
    shellState.available && shellState.shellOwner === shellState.owner
      ? {
          owner: shellState.owner,
          generation: shellState.generation,
          sequence: shellState.sequence,
        }
      : null,
  watchThreadActionProjection: () => () => {},
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    switch (command) {
      case threadEnvironment.pin:
        return commands.pin;
      case threadEnvironment.unpin:
        return commands.unpin;
      case threadEnvironment.archive:
        return commands.archive;
      case threadEnvironment.delete:
        return commands.delete;
      case threadEnvironment.unarchive:
        return commands.unarchive;
      case threadEnvironment.settle:
        return commands.settle;
      case threadEnvironment.unsettle:
        return commands.unsettle;
      case threadEnvironment.snooze:
        return commands.snooze;
      case threadEnvironment.unsnooze:
        return commands.unsnooze;
      default:
        return vi.fn();
    }
  },
}));

const target = {
  environmentId: EnvironmentId.make("undo-env"),
  threadId: ThreadId.make("thread"),
};
const event = {} as Parameters<NonNullable<React.ComponentProps<"button">["onClick"]>>[0];

function undoOf(
  add: { mock: { calls: Array<[Parameters<typeof toastManager.add>[0]]> } },
  index: number,
) {
  const onClick = add.mock.calls[index]?.[0].actionProps?.onClick;
  expect(onClick).toBeTypeOf("function");
  return () => onClick?.(event);
}

const success = { _tag: "Success" as const, value: { sequence: 1 } };
const failure = { _tag: "Failure" as const, cause: new Error("rejected") };
function deferredResult() {
  let resolve!: (value: typeof success | typeof failure) => void;
  const promise = new Promise<typeof success | typeof failure>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

async function expectDuplicateReceiptHasOneInverse(
  command: (typeof commands)["unpin"],
  run: () => Promise<unknown>,
  inverse: (typeof commands)["pin"],
) {
  const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
  vi.spyOn(toastManager, "close").mockImplementation(() => {});
  const first = deferredResult();
  command.mockImplementationOnce(() => first.promise);
  const firstAttempt = run();
  const duplicateAttempt = run();
  expect(command).toHaveBeenCalledOnce();
  expect(add).not.toHaveBeenCalled();
  first.resolve(success);
  expect(await Promise.all([firstAttempt, duplicateAttempt])).toEqual([success, success]);
  expect(add).toHaveBeenCalledTimes(1);
  await run();
  expect(command).toHaveBeenCalledOnce();
  await undoOf(add, 0)();
  expect(inverse).toHaveBeenCalledOnce();
}

beforeEach(() => {
  ThreadUndo.invalidateThread(scopedThreadKey(target));
  for (const command of Object.values(commands)) {
    command.mockReset().mockResolvedValue(success);
  }
  router.navigate.mockClear();
  router.state.matches[0]!.params = {};
  router.state.location.href = "/initial";
  router.state.location.state.__TSR_key = "initial";
  threadShell.pinnedAt = null;
  threadShell.snoozedUntil = null;
  threadShell.snoozedAt = null;
  threadShell.settledOverride = null;
  threadShell.settledAt = null;
  shellState.available = true;
  shellState.current = threadShell;
  shellState.owner = {};
  shellState.shellOwner = shellState.owner;
  shellState.generation = 1;
  shellState.sequence = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("unpin Undo", () => {
  it("keeps a batch unpin silent while preserving the command", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().unpinThread(target, { undoToast: false });
    expect(commands.unpin).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("keeps a silent successful receipt authoritative until the observed pin changes", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().unpinThread(target, { undoToast: false });
    await useThreadActions().unpinThread(target);
    expect(commands.unpin).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
    await useThreadActions().pinThread(target, { orderKey: "a1" });
    await useThreadActions().unpinThread(target);
    expect(commands.unpin).toHaveBeenCalledTimes(2);
  });

  it("allows a fresh unpin after a remote reverse projection returns the same fields", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    const actions = useThreadActions();
    await actions.unpinThread(target, { undoToast: false });
    expect(commands.unpin).toHaveBeenCalledOnce();
    // The receipt and a subsequent remote reverse have both been projected.
    shellState.sequence = 2;
    shellState.current = { ...threadShell };
    await actions.unpinThread(target, { undoToast: false });
    expect(commands.unpin).toHaveBeenCalledTimes(2);
  });

  it("joins a pending unpin even if an unrelated projection replaces its shell", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    const pending = deferredResult();
    commands.unpin.mockImplementationOnce(() => pending.promise);
    const first = useThreadActions().unpinThread(target, { undoToast: false });
    shellState.current = { ...threadShell, title: "Title changed while unpin waited" };
    const duplicate = useThreadActions().unpinThread(target, { undoToast: false });
    expect(commands.unpin).toHaveBeenCalledOnce();
    pending.resolve(success);
    expect(await Promise.all([first, duplicate])).toEqual([success, success]);
    shellState.current = { ...threadShell, title: "Another title before lifecycle projection" };
    await useThreadActions().unpinThread(target, { undoToast: false });
    expect(commands.unpin).toHaveBeenCalledOnce();
    shellState.sequence = 1;
    shellState.current = { ...threadShell, pinnedAt: null };
    await useThreadActions().unpinThread(target, { undoToast: false });
    expect(commands.unpin).toHaveBeenCalledTimes(2);
  });

  it("does not carry a completed receipt or Undo into a replacement connection", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    await useThreadActions().unpinThread(target);
    const oldUndo = undoOf(add, 0);
    // A reconnected server may reuse lower sequence values for the same ID.
    shellState.owner = {};
    // The connection can be replaced while catalog entry and generation are reused.
    shellState.sequence = 0;
    shellState.current = { ...threadShell };
    await oldUndo();
    expect(commands.pin).not.toHaveBeenCalled();
    // The old A shell may still appear live while B has connected.
    await useThreadActions().unpinThread(target);
    expect(commands.unpin).toHaveBeenCalledTimes(2);
    shellState.shellOwner = shellState.owner;
    await useThreadActions().unpinThread(target);
    expect(commands.unpin).toHaveBeenCalledTimes(3);
  });

  it("ignores an old toast across hook instances and still restores the latest unpin", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const sidebar = useThreadActions();
    const header = useThreadActions();
    await sidebar.unpinThread(target);
    const staleUndo = undoOf(add, 0);
    await header.pinThread(target, { orderKey: "a1" });
    await header.unpinThread(target);
    const latestUndo = undoOf(add, 1);
    await staleUndo();
    expect(commands.pin).toHaveBeenCalledTimes(1);
    await latestUndo();
    expect(commands.pin).toHaveBeenCalledTimes(2);
    expect(commands.pin).toHaveBeenLastCalledWith({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        orderKey: "a0",
        expectedSessionOwner: expect.any(Object),
      },
    });
    await latestUndo();
    expect(commands.pin).toHaveBeenCalledTimes(2);
  });

  it("does not let a duplicate unpin no-op own the inverse", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    await expectDuplicateReceiptHasOneInverse(
      commands.unpin,
      () => useThreadActions().unpinThread(target),
      commands.pin,
    );
  });
});

describe("archive Undo", () => {
  it("unarchives and returns to the thread when archiving left it", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    const actions = useThreadActions();
    await actions.archiveThread(target);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: "Thread archived" }));
    await undoOf(add, 0)();
    expect(commands.unarchive).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, expectedSessionOwner: expect.any(Object) },
    });
    expect(router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        params: { environmentId: target.environmentId, threadId: target.threadId },
      }),
    );
  });

  it("stays put when the archived thread was not open", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const actions = useThreadActions();
    await actions.archiveThread(target);
    await undoOf(add, 0)();
    expect(commands.unarchive).toHaveBeenCalledOnce();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("restores without navigating when the user left the archive-created draft", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    await useThreadActions().archiveThread(target);
    router.state.location.href = "/another-thread";
    await undoOf(add, 0)();
    expect(commands.unarchive).toHaveBeenCalledOnce();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("does not hijack a later visit to the same draft URL", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    await useThreadActions().archiveThread(target);
    router.state.location.href = "/another-thread";
    router.state.location.state.__TSR_key = "another-thread";
    router.state.location.href = "/draft/new";
    router.state.location.state.__TSR_key = "later-draft-visit";
    await undoOf(add, 0)();
    expect(commands.unarchive).toHaveBeenCalledOnce();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("shows no Undo when the archive failed", async () => {
    commands.archive.mockResolvedValue({ _tag: "Failure", cause: new Error("nope") });
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().archiveThread(target);
    expect(add).not.toHaveBeenCalled();
  });
});

describe("settle and snooze Undo", () => {
  it("shares a failed receipt across duplicate hook instances without reporting success", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    const pending = deferredResult();
    commands.unpin.mockImplementationOnce(() => pending.promise);
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const first = useThreadActions().unpinThread(target);
    const duplicate = useThreadActions().unpinThread(target);
    expect(commands.unpin).toHaveBeenCalledOnce();
    pending.resolve(failure);
    expect(await Promise.all([first, duplicate])).toEqual([failure, failure]);
    expect(add).not.toHaveBeenCalled();
    await useThreadActions().unpinThread(target);
    expect(commands.unpin).toHaveBeenCalledTimes(2);
  });

  it("does not let a duplicate settle no-op own the inverse", async () => {
    await expectDuplicateReceiptHasOneInverse(
      commands.settle,
      () => useThreadActions().settleThread(target),
      commands.unsettle,
    );
  });

  it("does not let a duplicate snooze no-op own the inverse", async () => {
    await expectDuplicateReceiptHasOneInverse(
      commands.snooze,
      () => useThreadActions().snoozeThread(target, "2030-01-01T00:00:00.000Z"),
      commands.unsnooze,
    );
  });
  it("un-settles from the toast and expires the Undo after a manual un-settle", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const actions = useThreadActions();
    await actions.settleThread(target);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: "Thread settled" }));
    const undo = undoOf(add, 0);
    await actions.unsettleThread(target);
    await undo();
    expect(commands.unsettle).toHaveBeenCalledOnce();
  });

  it("re-pins and re-snoozes a thread that settling had cleared", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const snoozedUntil = "2030-01-01T09:00:00.000Z";
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = snoozedUntil;
    const actions = useThreadActions();
    await actions.settleThread(target);
    await undoOf(add, 0)();
    expect(commands.unsettle).toHaveBeenCalledOnce();
    expect(commands.pin).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        orderKey: "a0",
        expectedSessionOwner: expect.any(Object),
      },
    });
    expect(commands.snooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil, expectedSessionOwner: expect.any(Object) },
    });
  });

  it("expires an older unpin Undo when the thread is settled", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const actions = useThreadActions();
    await actions.unpinThread(target);
    const staleUnpinUndo = undoOf(add, 0);
    await actions.settleThread(target);
    await staleUnpinUndo();
    expect(commands.pin).not.toHaveBeenCalled();
  });

  it("expires a settle inverse when a newer snooze changes the same thread", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const actions = useThreadActions();
    await actions.settleThread(target);
    const oldUndo = undoOf(add, 0);
    await actions.snoozeThread(target, "2030-01-01T00:00:00.000Z");
    await oldUndo();
    expect(commands.unsettle).not.toHaveBeenCalled();
  });

  it("expires every older inverse after a successful delete", async () => {
    const projection = {
      owner: shellState.owner,
      generation: shellState.generation,
      sequence: shellState.sequence,
    };
    const claim = ThreadUndo.begin("settle", scopedThreadKey(target), {
      projection,
      read: () => projection,
    });
    shellState.available = false;
    await useThreadActions().deleteThread(target);
    expect(commands.delete).toHaveBeenCalledOnce();
    expect(claim.isCurrent()).toBe(false);
  });

  it("does not offer an inverse for an already-settled success receipt", async () => {
    threadShell.settledOverride = "settled";
    threadShell.settledAt = "2026-01-01T00:00:00.000Z";
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().settleThread(target);
    expect(commands.settle).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
  });

  it("does not offer an inverse for an already-unpinned success receipt", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().unpinThread(target);
    expect(commands.unpin).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
  });

  it("does not offer an inverse for an unchanged snooze receipt", async () => {
    const snoozedUntil = "2030-01-01T00:00:00.000Z";
    threadShell.snoozedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = snoozedUntil;
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().snoozeThread(target, snoozedUntil);
    expect(commands.snooze).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
  });

  it("stays silent for batch settles", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().settleThread(target, { undoToast: false });
    expect(add).not.toHaveBeenCalled();
  });

  it("keeps a batch snooze silent so its caller can show one partial-result Undo", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().snoozeThread(target, new Date(Date.now() + 60_000).toISOString(), {
      undoToast: false,
    });
    expect(commands.snooze).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
  });

  it("keeps a bulk snooze receipt coalesced while its aggregate Undo owns the claim", async () => {
    const snoozedUntil = new Date(Date.now() + 60_000).toISOString();
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().snoozeThread(target, snoozedUntil, {
      undoToast: false,
      claimForBatch: true,
    });
    // Sidebar claims the confirmed member for its one aggregate toast.
    const bulkClaim = ThreadUndo.takeBatchClaim(
      "snooze",
      scopedThreadKey(target),
      success.value.sequence,
    );
    expect(bulkClaim?.isCurrent()).toBe(true);
    expect(
      ThreadUndo.takeBatchClaim("snooze", scopedThreadKey(target), success.value.sequence),
    ).toBeNull();
    await useThreadActions().snoozeThread(target, snoozedUntil);
    expect(commands.snooze).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
    // A later projected remote wake permits a genuinely new snooze.
    shellState.sequence = 2;
    shellState.current = { ...threadShell };
    await useThreadActions().snoozeThread(target, snoozedUntil);
    expect(commands.snooze).toHaveBeenCalledTimes(2);
    expect(bulkClaim?.isCurrent()).toBe(false);
  });

  it("does not transfer a failed batch member into the aggregate Undo", async () => {
    const snoozedUntil = new Date(Date.now() + 60_000).toISOString();
    commands.snooze.mockResolvedValueOnce(failure);
    const result = await useThreadActions().snoozeThread(target, snoozedUntil, {
      undoToast: false,
      claimForBatch: true,
    });
    expect(result).toBe(failure);
    expect(
      ThreadUndo.takeBatchClaim("snooze", scopedThreadKey(target), success.value.sequence),
    ).toBeNull();
  });

  it("wakes the thread from the snooze toast", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const actions = useThreadActions();
    await actions.snoozeThread(target, new Date(Date.now() + 60_000).toISOString());
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/^Snoozed until /) }),
    );
    await undoOf(add, 0)();
    expect(commands.unsnooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        reason: "user",
        expectedSessionOwner: expect.any(Object),
      },
    });
  });
});
