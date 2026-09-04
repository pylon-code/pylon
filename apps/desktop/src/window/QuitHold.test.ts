import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  makeQuitHoldHandler,
  QUIT_DOUBLE_TAP_MS,
  QUIT_HOLD_DURATION_MS,
  QUIT_HOLD_RELEASE_GRACE_MS,
} from "./QuitHold.ts";
import type { QuitHoldKeyInput, QuitHoldState } from "./QuitHold.ts";

function makeInput(overrides: Partial<QuitHoldKeyInput>): QuitHoldKeyInput {
  return {
    type: "keyDown",
    key: "q",
    meta: true,
    control: false,
    alt: false,
    shift: false,
    isAutoRepeat: false,
    ...overrides,
  };
}

function makeHarness(options?: {
  enabled?: boolean;
  platform?: NodeJS.Platform;
  isEnabled?: () => Promise<boolean>;
}) {
  const notifications: Array<QuitHoldState> = [];
  const concealWindow = vi.fn();
  const quit = vi.fn();
  const handler = makeQuitHoldHandler({
    platform: options?.platform ?? "darwin",
    isEnabled: options?.isEnabled ?? (() => Promise.resolve(options?.enabled ?? true)),
    notify: (state) => notifications.push(state),
    concealWindow,
    quit,
  });
  const preventDefault = vi.fn();
  const send = async (input: QuitHoldKeyInput) => {
    handler({ preventDefault }, input);
    // Let the isEnabled promise settle.
    await Promise.resolve();
    await Promise.resolve();
  };
  // Simulates the OS auto-repeating the held shortcut every `intervalMs`.
  const holdFor = async (
    durationMs: number,
    repeatOverrides: Partial<QuitHoldKeyInput> = {},
    intervalMs = 100,
  ) => {
    for (let elapsed = 0; elapsed < durationMs; elapsed += intervalMs) {
      vi.advanceTimersByTime(intervalMs);
      await send(makeInput({ isAutoRepeat: true, ...repeatOverrides }));
    }
  };
  return { notifications, concealWindow, quit, preventDefault, send, holdFor };
}

describe("makeQuitHoldHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the hint on a tap without quitting, even when the release is never seen", async () => {
    // macOS suppresses the letter's keyUp while Cmd is held, so a tap may
    // produce no keyUp at all. Quit must still not fire.
    const harness = makeHarness();
    await harness.send(makeInput({}));
    expect(harness.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual(["down"]);

    vi.advanceTimersByTime(QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS);
    expect(harness.quit).not.toHaveBeenCalled();
    // The watchdog dismisses the hint once the press is clearly over.
    expect(harness.notifications).toEqual(["down", "up"]);
  });

  it("conceals a completed hold, then quits after release", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(QUIT_HOLD_DURATION_MS + 200);
    expect(harness.concealWindow).toHaveBeenCalledTimes(1);
    expect(harness.quit).not.toHaveBeenCalled();
    await harness.send(makeInput({ type: "keyUp", key: "Meta", meta: false }));
    expect(harness.quit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(QUIT_HOLD_RELEASE_GRACE_MS);
    expect(harness.quit).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual(["down", "up"]);
  });

  it("keeps a concealed hold committed when another key is pressed", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(QUIT_HOLD_DURATION_MS);

    await harness.send(makeInput({ key: "Shift", shift: true }));
    expect(harness.concealWindow).toHaveBeenCalledTimes(1);
    expect(harness.quit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(QUIT_HOLD_RELEASE_GRACE_MS);
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("keeps a concealed hold committed through a fresh Cmd+Q press", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(QUIT_HOLD_DURATION_MS);

    await harness.send(makeInput({}));
    expect(harness.concealWindow).toHaveBeenCalledTimes(1);
    expect(harness.quit).not.toHaveBeenCalled();

    await harness.send(makeInput({ type: "keyUp" }));
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("quits when a completed hold goes quiet without release events", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS * 2);

    // If neither keyUp reaches the handler, continued repeats must keep the
    // app alive. Once they stop, the quiet period is the release signal.
    expect(harness.quit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(QUIT_HOLD_RELEASE_GRACE_MS);

    expect(harness.quit).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual(["down", "up"]);
  });

  it("waits for slow repeats to stop before quitting", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));

    vi.advanceTimersByTime(300);
    await harness.send(makeInput({ isAutoRepeat: true }));
    vi.advanceTimersByTime(900);
    await harness.send(makeInput({ isAutoRepeat: true }));

    vi.advanceTimersByTime(QUIT_HOLD_RELEASE_GRACE_MS);
    expect(harness.quit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await harness.send(makeInput({ isAutoRepeat: true }));
    vi.advanceTimersByTime(1_799);
    expect(harness.quit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("uses the initial repeat delay when the first repeat completes the hold", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));

    vi.advanceTimersByTime(QUIT_HOLD_DURATION_MS + 100);
    await harness.send(makeInput({ isAutoRepeat: true }));

    vi.advanceTimersByTime(QUIT_HOLD_RELEASE_GRACE_MS);
    expect(harness.quit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_999);
    expect(harness.quit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("waits for Q release when Cmd is released first", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(QUIT_HOLD_DURATION_MS + 200);
    await harness.send(makeInput({ type: "keyUp", key: "Meta", meta: false }));
    harness.preventDefault.mockClear();
    await harness.send(makeInput({ meta: false, isAutoRepeat: true }));
    expect(harness.preventDefault).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(QUIT_HOLD_RELEASE_GRACE_MS * 2);
    expect(harness.quit).not.toHaveBeenCalled();
    await harness.send(makeInput({ type: "keyUp", meta: false }));
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("does not quit when the hold stops before the duration", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(500);
    await harness.send(makeInput({ type: "keyUp" }));
    expect(harness.notifications).toEqual(["down", "up"]);
    vi.advanceTimersByTime((QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS) * 2);
    expect(harness.concealWindow).not.toHaveBeenCalled();
    expect(harness.quit).not.toHaveBeenCalled();
  });

  it("cancels the hold when the modifier is released first", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp", key: "Meta", meta: false }));
    expect(harness.notifications).toEqual(["down", "up"]);
    vi.advanceTimersByTime((QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS) * 2);
    expect(harness.quit).not.toHaveBeenCalled();
  });

  it("quits without showing a hint when hold-to-quit is disabled", async () => {
    const harness = makeHarness({ enabled: false });
    await harness.send(makeInput({}));
    expect(harness.concealWindow).not.toHaveBeenCalled();
    expect(harness.quit).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual([]);
  });

  it("discards a stale isEnabled resolution from a superseded press", async () => {
    // Press #1's isEnabled is still pending when the user releases and
    // presses again; its late resolution must not act for press #2.
    const resolvers: Array<(enabled: boolean) => void> = [];
    const harness = makeHarness({
      isEnabled: () => new Promise((resolve) => resolvers.push(resolve)),
    });
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));
    // Outside the double-tap window, so the second press starts a new hold.
    vi.advanceTimersByTime(QUIT_DOUBLE_TAP_MS + 100);
    await harness.send(makeInput({}));
    expect(resolvers).toHaveLength(2);

    // Press #1 resolves late with "disabled" — it must not quit press #2.
    resolvers[0]?.(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.quit).not.toHaveBeenCalled();

    // Press #2 resolves enabled and completes a full hold.
    resolvers[1]?.(true);
    await harness.holdFor(QUIT_HOLD_DURATION_MS + 200);
    await harness.send(makeInput({ type: "keyUp" }));
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("quits on a quick double tap, even when the first release was never seen", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    vi.advanceTimersByTime(QUIT_DOUBLE_TAP_MS - 100);
    await harness.send(makeInput({}));
    expect(harness.concealWindow).not.toHaveBeenCalled();
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it("treats two slow taps as separate presses", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));
    vi.advanceTimersByTime(QUIT_DOUBLE_TAP_MS + 100);
    await harness.send(makeInput({}));
    expect(harness.quit).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual(["down", "up", "down"]);
  });

  it("cancels the hold when another key interrupts it", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(500);
    // Shift pressed mid-hold breaks the gesture...
    await harness.send(makeInput({ shift: true }));
    expect(harness.notifications).toEqual(["down", "up"]);
    // ...so later repeats past the threshold must not quit.
    await harness.holdFor(QUIT_HOLD_DURATION_MS);
    expect(harness.quit).not.toHaveBeenCalled();
  });

  it("does not count an interrupted press toward a double tap", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.send(makeInput({ shift: true }));
    // A fresh press right after the interruption starts a new hold, not a
    // double-tap quit.
    await harness.send(makeInput({}));
    expect(harness.quit).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual(["down", "up", "down"]);
  });

  it("ignores other shortcuts", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({ key: "w" }));
    await harness.send(makeInput({ shift: true }));
    await harness.send(makeInput({ meta: false }));
    expect(harness.preventDefault).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual([]);
  });

  it("uses control on non-mac platforms", async () => {
    const harness = makeHarness({ platform: "linux" });
    await harness.send(makeInput({ meta: false, control: true }));
    expect(harness.preventDefault).toHaveBeenCalledTimes(1);
    await harness.holdFor(QUIT_HOLD_DURATION_MS + 200, { meta: false, control: true });
    await harness.send(makeInput({ type: "keyUp", meta: false, control: true }));
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });
  it("does not count auto-repeat as a second press", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.holdFor(QUIT_DOUBLE_TAP_MS - 100);

    expect(harness.quit).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual(["down"]);
  });

  it("does not count a released tap after another shortcut interrupts it", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));
    await harness.send(makeInput({ key: "c" }));
    vi.advanceTimersByTime(100);
    await harness.send(makeInput({}));

    expect(harness.quit).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual(["down", "up", "down"]);
  });

  it("accepts a second full shortcut after the modifier is released and pressed again", async () => {
    const harness = makeHarness();
    await harness.send(makeInput({}));
    await harness.send(makeInput({ type: "keyUp" }));
    await harness.send(makeInput({ type: "keyUp", key: "Meta", meta: false }));
    vi.advanceTimersByTime(100);

    await harness.send(makeInput({ key: "Meta" }));
    await harness.send(makeInput({}));

    expect(harness.quit).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toEqual(["down", "up"]);
  });
});
