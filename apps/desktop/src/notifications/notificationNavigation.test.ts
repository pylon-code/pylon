import { describe, expect, it, vi } from "vite-plus/test";
import { subscribeNotificationNavigation } from "./notificationNavigation.ts";

const target = { id: 1, environmentId: "remote", threadId: "thread" };
function harness(
  navigate = vi.fn(async (_target: { environmentId: string; threadId: string }) => {}),
) {
  let signal = () => {};
  const acknowledged = Promise.withResolvers<number>();
  const complete = vi.fn(async (id: number) => {
    acknowledged.resolve(id);
  });
  const read = vi.fn(async (): Promise<unknown> => target);
  const stop = vi.fn();
  const subscribe = () =>
    subscribeNotificationNavigation({
      read,
      complete,
      navigate,
      listen: (listener) => {
        signal = listener;
        return stop;
      },
    });
  return { read, complete, navigate, stop, subscribe, signal: () => signal(), acknowledged };
}

describe("notification renderer handoff", () => {
  it("delivers a click that predates the renderer subscription and acknowledges navigation", async () => {
    const h = harness();
    const stop = h.subscribe();
    expect(await h.acknowledged.promise).toBe(1);
    expect(h.navigate).toHaveBeenCalledWith({ environmentId: "remote", threadId: "thread" });
    stop();
    expect(h.stop).toHaveBeenCalledOnce();
  });
  it("leaves an unread click for a replacement renderer when a subscription unmounts", async () => {
    const read = Promise.withResolvers<unknown>();
    const h = harness();
    h.read.mockReturnValueOnce(read.promise);
    const stop = h.subscribe();
    stop();
    read.resolve(target);
    await read.promise;
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    const stopReplacement = h.subscribe();
    await h.acknowledged.promise;
    expect(h.navigate).toHaveBeenCalledOnce();
    stopReplacement();
  });
  it("drains a newer click that arrives while navigation is pending", async () => {
    const navigation = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const h = harness(
      vi.fn(async () => {
        entered.resolve();
        await navigation.promise;
      }),
    );
    h.read
      .mockResolvedValueOnce(target)
      .mockResolvedValue({ ...target, id: 2, threadId: "second" });
    const second = Promise.withResolvers<void>();
    h.complete.mockImplementation(async (id) => {
      if (id === 2) second.resolve();
    });
    const stop = h.subscribe();
    await entered.promise;
    h.signal();
    navigation.resolve();
    await second.promise;
    expect(h.complete.mock.calls).toEqual([[1], [2]]);
    expect(h.navigate).toHaveBeenLastCalledWith({ environmentId: "remote", threadId: "second" });
    stop();
  });
  it("does not acknowledge a failed navigation", async () => {
    const attempted = Promise.withResolvers<void>();
    const h = harness(
      vi.fn(async () => {
        attempted.resolve();
        throw new Error("renderer stopped");
      }),
    );
    const stop = h.subscribe();
    await attempted.promise;
    expect(h.complete).not.toHaveBeenCalled();
    stop();
  });
});
