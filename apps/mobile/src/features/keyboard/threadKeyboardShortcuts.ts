import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { THREAD_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { useCallback } from "react";

import type { HomeListItem } from "../home/homeListItems";
import type { ThreadListV2ListItem } from "../threads/threadListV2";
import {
  useHardwareKeyboardCommand,
  type HardwareKeyboardCommand,
} from "./hardwareKeyboardCommands";

type ThreadShortcutListItem =
  | HomeListItem
  | ThreadListV2ListItem
  | { readonly type: "v2-show-more" };

const NO_THREAD_JUMP_COMMANDS: ReadonlyArray<HardwareKeyboardCommand> = [];

export function visibleThreadJumpCommands(
  visible: boolean,
): ReadonlyArray<HardwareKeyboardCommand> {
  return visible ? THREAD_JUMP_KEYBINDING_COMMANDS : NO_THREAD_JUMP_COMMANDS;
}

export function threadJumpIndex(command: HardwareKeyboardCommand) {
  return THREAD_JUMP_KEYBINDING_COMMANDS.findIndex((candidate) => candidate === command);
}

/** Uses the rendered list so filters, collapsed groups and shelves keep their order. */
export function threadJumpTarget(
  items: ReadonlyArray<ThreadShortcutListItem>,
  command: HardwareKeyboardCommand,
) {
  let index = threadJumpIndex(command);
  if (index < 0) return null;
  for (const item of items) {
    const thread =
      item.type === "thread" ? item.thread : item.type === "v2-thread" ? item.item.thread : null;
    if (thread !== null && index-- === 0) return thread;
  }
  return null;
}

export function useThreadJumpShortcuts(
  items: ReadonlyArray<ThreadShortcutListItem>,
  onSelectThread: (thread: EnvironmentThreadShell) => void,
  visible = true,
) {
  const jumpToThread = useCallback(
    (command: HardwareKeyboardCommand) => {
      const thread = threadJumpTarget(items, command);
      if (thread !== null) onSelectThread(thread);
      return true;
    },
    [items, onSelectThread],
  );
  useHardwareKeyboardCommand(visibleThreadJumpCommands(visible), jumpToThread);
}
