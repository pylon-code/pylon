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
const shellState = vi.hoisted(() => ({ available: true }));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsPinReorder: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readThreadShell: () => (shellState.available ? threadShell : null),
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

beforeEach(() => {
  for (const command of Object.values(commands)) {
    command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
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
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    await latestUndo();
    expect(commands.pin).toHaveBeenCalledTimes(2);
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
      input: { threadId: target.threadId },
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
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    expect(commands.snooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil },
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
    const claim = ThreadUndo.begin("settle", scopedThreadKey(target));
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
      input: { threadId: target.threadId, reason: "user" },
    });
  });
});
