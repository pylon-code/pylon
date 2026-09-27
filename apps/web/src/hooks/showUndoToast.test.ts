import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../components/ui/toast";
import { showUndoToast, undoLatestThreadAction } from "./showUndoToast";
import * as ThreadUndo from "./threadUndo";

afterEach(() => vi.restoreAllMocks());

const projection = { owner: Object.freeze({}), generation: 1, sequence: 1 };
function ownedClaim(kind: string, threadKey: string, owner = projection.owner) {
  const scoped = { ...projection, owner };
  return ThreadUndo.begin(kind, threadKey, { projection: scoped, read: () => scoped });
}

function setup() {
  const add = vi.spyOn(toastManager, "add").mockReturnValue("undo-toast");
  const close = vi.spyOn(toastManager, "close").mockImplementation(() => {});
  const undo = vi.fn(async () => AsyncResult.success(undefined));
  const claim = ownedClaim("pin", "env/thread");
  const options = {
    title: "Thread unpinned",
    description: "Thread",
    failureTitle: "Restore failed",
    undo,
    claim,
  };
  return { add, close, undo, claim, options };
}

function click(add: ReturnType<typeof setup>["add"], index = 0) {
  const handler = add.mock.calls[index]?.[0].actionProps?.onClick;
  if (!handler) throw new Error("Undo action is missing");
  return handler({} as Parameters<typeof handler>[0]);
}

describe("showUndoToast", () => {
  it("retires a real Undo claim when no live session owner was observed", () => {
    const { add, options } = setup();
    const claim = ThreadUndo.begin("pin", "env/unowned", {
      projection: null,
      read: () => null,
    });
    showUndoToast({ ...options, claim });
    expect(add).not.toHaveBeenCalled();
    expect(claim.isCurrent()).toBe(false);
  });

  it("ignores a stale toast and lets the latest action run only once", async () => {
    const { add, close, undo, options } = setup();
    showUndoToast(options);
    ThreadUndo.invalidate("pin", "env/thread");
    showUndoToast({ ...options, claim: ownedClaim("pin", "env/thread") });
    await click(add);
    expect(undo).not.toHaveBeenCalled();
    await click(add, 1);
    await click(add, 1);
    expect(undo).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledExactlyOnceWith("undo-toast");
  });

  it("releases the claim on close and rejects a later click", async () => {
    const { add, undo, claim, options } = setup();
    showUndoToast(options);
    add.mock.calls[0]?.[0].onClose?.();
    expect(claim.isCurrent()).toBe(false);
    await click(add);
    expect(undo).not.toHaveBeenCalled();
  });

  it("does not show a toast for a late completion after a newer action", () => {
    const { add, options } = setup();
    ThreadUndo.invalidate("pin", "env/thread");
    showUndoToast(options);
    expect(add).not.toHaveBeenCalled();
  });

  it("reports a failed restore and releases its claim", async () => {
    const { add, claim, options } = setup();
    showUndoToast({
      ...options,
      undo: async () => AsyncResult.failure(Cause.fail(new Error("offline"))),
    });
    await click(add);
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "error", title: "Restore failed", description: "offline" }),
    );
    expect(claim.isCurrent()).toBe(false);
  });

  it("reports a rejected restore promise", async () => {
    const { add, options } = setup();
    showUndoToast({
      ...options,
      undo: async () => {
        throw new Error("disconnected");
      },
    });
    await click(add);
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "error", description: "disconnected" }),
    );
  });

  it("does not report interrupted restores as errors", async () => {
    const { add, options } = setup();
    showUndoToast({ ...options, undo: async () => AsyncResult.failure(Cause.interrupt()) });
    await click(add);
    expect(add).toHaveBeenCalledOnce();
  });
});

describe("undoLatestThreadAction", () => {
  it("does not wake a partly superseded snooze batch", () => {
    const { options } = setup();
    const first = ownedClaim("snooze", "env/first", Object.freeze({ environment: "one" }));
    const second = ownedClaim("snooze", "env/second", Object.freeze({ environment: "two" }));
    const undo = vi.fn(async () => AsyncResult.success(undefined));
    showUndoToast({
      ...options,
      type: "warning",
      claim: {
        isCurrent: () => first.isCurrent() && second.isCurrent(),
        finish: () => {
          first.finish();
          second.finish();
        },
      },
      undo,
    });
    ThreadUndo.invalidate("snooze", "env/first");
    expect(undoLatestThreadAction()).toBe(false);
    expect(undo).not.toHaveBeenCalled();
    second.finish();
  });

  it("runs the newest live Undo once and then reports nothing to undo", () => {
    const { options } = setup();
    const older = vi.fn(async () => AsyncResult.success(undefined));
    const newer = vi.fn(async () => AsyncResult.success(undefined));
    showUndoToast({ ...options, undo: older, claim: ownedClaim("settle", "env/a") });
    showUndoToast({ ...options, undo: newer, claim: ownedClaim("snooze", "env/b") });
    expect(undoLatestThreadAction()).toBe(true);
    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
    expect(undoLatestThreadAction()).toBe(true);
    expect(older).toHaveBeenCalledOnce();
    expect(undoLatestThreadAction()).toBe(false);
  });

  it("skips a superseded toast and a closed toast", () => {
    const { add, options } = setup();
    const superseded = vi.fn(async () => AsyncResult.success(undefined));
    const closed = vi.fn(async () => AsyncResult.success(undefined));
    const live = vi.fn(async () => AsyncResult.success(undefined));
    showUndoToast({ ...options, undo: live, claim: ownedClaim("archive", "env/live") });
    showUndoToast({ ...options, undo: closed, claim: ownedClaim("archive", "env/closed") });
    add.mock.calls[1]?.[0].onClose?.();
    showUndoToast({ ...options, undo: superseded, claim: ownedClaim("pin", "env/stale") });
    ThreadUndo.invalidate("pin", "env/stale");
    expect(undoLatestThreadAction()).toBe(true);
    expect(superseded).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledOnce();
  });
});
