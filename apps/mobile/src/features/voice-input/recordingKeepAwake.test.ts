import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: vi.fn(),
  deactivateKeepAwake: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: vi.fn() }));

import { holdRecordingAwake } from "./recordingKeepAwake";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("holdRecordingAwake", () => {
  it("releases after a delayed activation without touching a rapid replacement recording", async () => {
    const first = deferred();
    const second = deferred();
    const activate = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const deactivate = vi.fn().mockResolvedValue(undefined);
    const bridge = { activate, deactivate };
    const createId = vi.fn().mockReturnValueOnce("first").mockReturnValueOnce("second");

    const stopFirst = holdRecordingAwake(bridge, createId);
    const firstTag = activate.mock.calls[0]?.[0];
    stopFirst();
    const stopSecond = holdRecordingAwake(bridge, createId);
    const secondTag = activate.mock.calls[1]?.[0];
    expect(firstTag).not.toBe(secondTag);

    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(deactivate).toHaveBeenCalledWith(firstTag);
    expect(deactivate).not.toHaveBeenCalledWith(secondTag);

    second.resolve();
    await second.promise;
    stopSecond();
    await Promise.resolve();
    expect(deactivate).toHaveBeenCalledWith(secondTag);
  });

  it("keeps tags distinct across unmount and remount with late native completion", async () => {
    const oldActivation = deferred();
    const activate = vi
      .fn()
      .mockReturnValueOnce(oldActivation.promise)
      .mockResolvedValue(undefined);
    const deactivate = vi.fn().mockResolvedValue(undefined);
    const bridge = { activate, deactivate };
    const createId = vi.fn().mockReturnValueOnce("old-mount").mockReturnValueOnce("new-mount");

    const unmount = holdRecordingAwake(bridge, createId);
    const oldTag = activate.mock.calls[0]?.[0];
    unmount();
    const stopNewMount = holdRecordingAwake(bridge, createId);
    const newTag = activate.mock.calls[1]?.[0];
    await Promise.resolve();
    oldActivation.resolve();
    await oldActivation.promise;
    await Promise.resolve();
    expect(oldTag).not.toBe(newTag);
    expect(deactivate).toHaveBeenCalledWith(oldTag);
    expect(deactivate).not.toHaveBeenCalledWith(newTag);

    stopNewMount();
    await Promise.resolve();
    expect(deactivate).toHaveBeenCalledWith(newTag);
  });
});
