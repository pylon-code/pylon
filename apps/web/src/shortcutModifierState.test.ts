import { describe, expect, it, vi } from "vite-plus/test";

import {
  areShortcutModifierStatesEqual,
  shortcutModifierStateAfterKeyboardEvent,
  createShortcutModifierTracker,
  type ShortcutModifierState,
} from "./shortcutModifierState";

const emptyState = (): ShortcutModifierState => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
});

describe("createShortcutModifierTracker", () => {
  it.each(["keyup", "paste-or-blur"] as const)(
    "does not report unchanged modifiers after %s resets the state",
    (reset) => {
      const onChange = vi.fn();
      const tracker = createShortcutModifierTracker(onChange);

      tracker.handleKeyboardEvent(keyboardEventLike("keydown", { key: "Shift", shiftKey: true }));
      expect(onChange).toHaveBeenLastCalledWith({ ...emptyState(), shiftKey: true });
      if (reset === "keyup") {
        tracker.handleKeyboardEvent(keyboardEventLike("keyup", { key: "Shift" }));
      } else {
        tracker.reset();
      }
      expect(onChange).toHaveBeenLastCalledWith(emptyState());
      onChange.mockClear();

      for (const key of "typing") {
        tracker.handleKeyboardEvent(keyboardEventLike("keydown", { key }));
        tracker.handleKeyboardEvent(keyboardEventLike("keyup", { key }));
      }
      tracker.reset();
      tracker.reset();
      expect(onChange).not.toHaveBeenCalled();

      tracker.handleKeyboardEvent(keyboardEventLike("keydown", { key: "Shift", shiftKey: true }));
      expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...emptyState(), shiftKey: true });
    },
  );
});

function keyboardEventLike(type: "keydown" | "keyup", init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type,
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("shortcutModifierState", () => {
  it("compares modifier states by value", () => {
    expect(
      areShortcutModifierStatesEqual(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
      ),
    ).toBe(true);
    expect(
      areShortcutModifierStatesEqual(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        { metaKey: false, ctrlKey: false, altKey: false, shiftKey: true },
      ),
    ).toBe(false);
  });

  it("preserves the current object when modifier values do not change", () => {
    const initialState = emptyState();
    const nextState = shortcutModifierStateAfterKeyboardEvent(
      initialState,
      keyboardEventLike("keyup", { key: "Shift" }),
    );
    expect(nextState).toBe(initialState);
  });

  it("tracks bare modifier keydown and keyup events explicitly", () => {
    let state = emptyState();
    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Meta",
        metaKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Shift",
        metaKey: true,
        shiftKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Meta",
        metaKey: true,
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Shift",
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
  });

  it("ignores poisoned modifier flags on non-modifier keys", () => {
    // A dictation paste (synthetic ⌘V) can leave the browser reporting
    // metaKey=true on later real key events. Enter to submit must not
    // re-mark ⌘ as held.
    const state = shortcutModifierStateAfterKeyboardEvent(
      emptyState(),
      keyboardEventLike("keydown", { key: "Enter", metaKey: true }),
    );
    expect(state).toEqual(emptyState());
  });

  it("clears a held modifier when a non-modifier key reports it released", () => {
    const heldMeta: ShortcutModifierState = {
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    const state = shortcutModifierStateAfterKeyboardEvent(
      heldMeta,
      keyboardEventLike("keydown", { key: "a", metaKey: false }),
    );
    expect(state).toEqual(emptyState());
  });
});
