import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";
import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import {
  handleNavigationHistoryShortcut,
  isProtectedNavigationShortcutTarget,
  observeNavigationHistory,
} from "./navigationHistoryShortcuts";
import type { ShortcutMatchContext } from "./keybindings";

const context: ShortcutMatchContext = {
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  editableFocus: false,
  modelPickerOpen: false,
  isDesktop: true,
  isWeb: false,
};

function keyEvent(key: string, code: string, overrides: Record<string, unknown> = {}) {
  let prevented = false;
  let stopped = false;
  return {
    event: {
      key,
      code,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      isComposing: false,
      repeat: false,
      target: null,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
      ...overrides,
    } as unknown as KeyboardEvent,
    get prevented() {
      return prevented;
    },
    get stopped() {
      return stopped;
    },
  };
}

function navigationHistory() {
  let back = 0;
  let forward = 0;
  return {
    history: {
      back: () => {
        back += 1;
      },
      forward: () => {
        forward += 1;
      },
    },
    get back() {
      return back;
    },
    get forward() {
      return forward;
    },
  };
}

describe("navigation history shortcuts", () => {
  it("keeps native browser brackets and handles a custom nonnative browser binding", () => {
    const history = navigationHistory();
    const native = keyEvent("[", "BracketLeft");
    expect(
      handleNavigationHistoryShortcut(
        native.event,
        DEFAULT_RESOLVED_KEYBINDINGS,
        { ...context, isDesktop: false, isWeb: true },
        2,
        1,
        2,
        history.history,
        false,
        "MacIntel",
      ),
    ).toBe(false);
    expect(native.prevented).toBe(false);

    const custom = compileResolvedKeybindingsConfig([
      { key: "alt+arrowleft", command: "navigation.back" },
    ]);
    const customEvent = keyEvent("ArrowLeft", "ArrowLeft", { metaKey: false, altKey: true });
    expect(
      handleNavigationHistoryShortcut(
        customEvent.event,
        custom,
        { ...context, isDesktop: false, isWeb: true },
        2,
        1,
        2,
        history.history,
        false,
        "MacIntel",
      ),
    ).toBe(true);
    expect(history.back).toBe(1);
  });

  it("truncates an observed forward branch when a new route replaces its index", () => {
    const initial = { keys: new Map([[4, "a"]]), minIndex: 4, maxIndex: 4 };
    const atFive = observeNavigationHistory(initial, 5, "b", "PUSH");
    const atSix = observeNavigationHistory(atFive, 6, "c", "PUSH");
    expect(atSix.maxIndex).toBe(6);
    const returned = observeNavigationHistory(atSix, 5, "b", "BACK");
    const replaced = observeNavigationHistory(returned, 5, "new-b", "REPLACE");
    expect(replaced.maxIndex).toBe(6);
    expect(replaced.keys.has(6)).toBe(true);
    const pushed = observeNavigationHistory(returned, 5, "new-b", "PUSH");
    expect(pushed.maxIndex).toBe(5);
    expect(pushed.minIndex).toBe(4);
    expect(pushed.keys.has(6)).toBe(false);
  });

  it("does not send Back before a nonzero first Pylon history index", () => {
    const history = navigationHistory();
    const first = keyEvent("[", "BracketLeft");
    expect(
      handleNavigationHistoryShortcut(
        first.event,
        DEFAULT_RESOLVED_KEYBINDINGS,
        context,
        4,
        4,
        4,
        history.history,
        true,
        "MacIntel",
      ),
    ).toBe(true);
    expect(first.prevented).toBe(true);
    expect(history.back).toBe(0);
  });

  it("navigates nested route history and leaves the first and last route in place", () => {
    const history = createMemoryHistory({
      initialEntries: ["/", "/settings/general", "/settings/keybindings"],
      initialIndex: 2,
    });
    const back = keyEvent("[", "BracketLeft");
    expect(
      handleNavigationHistoryShortcut(
        back.event,
        DEFAULT_RESOLVED_KEYBINDINGS,
        context,
        2,
        0,
        2,
        history,
        true,
        "MacIntel",
      ),
    ).toBe(true);
    expect(history.location.href).toBe("/settings/general");

    const forward = keyEvent("]", "BracketRight");
    handleNavigationHistoryShortcut(
      forward.event,
      DEFAULT_RESOLVED_KEYBINDINGS,
      context,
      1,
      0,
      2,
      history,
      true,
      "MacIntel",
    );
    expect(history.location.href).toBe("/settings/keybindings");
    handleNavigationHistoryShortcut(
      forward.event,
      DEFAULT_RESOLVED_KEYBINDINGS,
      context,
      2,
      0,
      2,
      history,
      true,
      "MacIntel",
    );
    expect(history.location.href).toBe("/settings/keybindings");
  });

  it("moves between nested routes and consumes back at the app boundary", () => {
    const history = navigationHistory();
    const back = keyEvent("[", "BracketLeft");
    expect(
      handleNavigationHistoryShortcut(
        back.event,
        DEFAULT_RESOLVED_KEYBINDINGS,
        context,
        2,
        0,
        2,
        history.history,
        true,
        "MacIntel",
      ),
    ).toBe(true);
    expect(history.back).toBe(1);
    expect(back.prevented).toBe(true);
    expect(back.stopped).toBe(true);

    const boundary = keyEvent("[", "BracketLeft");
    expect(
      handleNavigationHistoryShortcut(
        boundary.event,
        DEFAULT_RESOLVED_KEYBINDINGS,
        context,
        0,
        0,
        2,
        history.history,
        true,
        "MacIntel",
      ),
    ).toBe(true);
    expect(history.back).toBe(1);
    expect(boundary.prevented).toBe(true);

    const forward = keyEvent("]", "BracketRight");
    expect(
      handleNavigationHistoryShortcut(
        forward.event,
        DEFAULT_RESOLVED_KEYBINDINGS,
        context,
        0,
        0,
        2,
        history.history,
        true,
        "MacIntel",
      ),
    ).toBe(true);
    expect(history.forward).toBe(1);
    const noAppForward = keyEvent("]", "BracketRight");
    expect(
      handleNavigationHistoryShortcut(
        noAppForward.event,
        DEFAULT_RESOLVED_KEYBINDINGS,
        context,
        0,
        0,
        0,
        history.history,
        true,
        "MacIntel",
      ),
    ).toBe(true);
    expect(history.forward).toBe(1);
    expect(noAppForward.prevented).toBe(true);
  });

  it("leaves focused terminal, preview, editor, and captured controls alone", () => {
    const history = navigationHistory();
    for (const focus of [
      "terminalFocus",
      "previewFocus",
      "editableFocus",
      "modelPickerOpen",
    ] as const) {
      const input = keyEvent("[", "BracketLeft");
      expect(
        handleNavigationHistoryShortcut(
          input.event,
          DEFAULT_RESOLVED_KEYBINDINGS,
          { ...context, [focus]: true },
          1,
          0,
          1,
          history.history,
          true,
          "MacIntel",
        ),
      ).toBe(false);
      expect(input.prevented).toBe(false);
    }
    expect(isProtectedNavigationShortcutTarget({ closest: () => ({}) as Element })).toBe(true);
    expect(isProtectedNavigationShortcutTarget({ closest: () => null })).toBe(false);
    expect(history.back).toBe(0);
  });

  it("does not take repeated or already handled keyboard events", () => {
    const history = navigationHistory();
    for (const overrides of [{ repeat: true }, { defaultPrevented: true }, { isComposing: true }]) {
      const input = keyEvent("[", "BracketLeft", overrides);
      expect(
        handleNavigationHistoryShortcut(
          input.event,
          DEFAULT_RESOLVED_KEYBINDINGS,
          context,
          1,
          0,
          1,
          history.history,
          true,
          "MacIntel",
        ),
      ).toBe(false);
      expect(input.prevented).toBe(false);
    }
    expect(history.back).toBe(0);
  });

  it("uses Control on Linux and leaves unrelated keys for other commands", () => {
    const history = navigationHistory();
    const linuxForward = keyEvent("]", "BracketRight", { metaKey: false, ctrlKey: true });
    expect(
      handleNavigationHistoryShortcut(
        linuxForward.event,
        DEFAULT_RESOLVED_KEYBINDINGS,
        context,
        1,
        0,
        2,
        history.history,
        true,
        "Linux",
      ),
    ).toBe(true);
    expect(history.forward).toBe(1);
    const threadJump = keyEvent("1", "Digit1", { metaKey: false, ctrlKey: true });
    expect(
      handleNavigationHistoryShortcut(
        threadJump.event,
        DEFAULT_RESOLVED_KEYBINDINGS,
        context,
        1,
        0,
        2,
        history.history,
        true,
        "Linux",
      ),
    ).toBe(false);
    expect(threadJump.prevented).toBe(false);
  });
});
