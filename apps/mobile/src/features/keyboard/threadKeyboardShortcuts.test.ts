import { describe, expect, it } from "vite-plus/test";
import { visibleThreadJumpCommands } from "./threadKeyboardShortcuts";

describe("visible thread shortcut ownership", () => {
  it("does not register the hidden Home list while a split sidebar owns Cmd-1–9", () => {
    expect(visibleThreadJumpCommands(false)).toEqual([]);
    expect(visibleThreadJumpCommands(true)).toHaveLength(9);
    expect(visibleThreadJumpCommands(true)[0]).toBe("thread.jump.1");
  });
});
