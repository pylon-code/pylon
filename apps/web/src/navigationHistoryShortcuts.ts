import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { resolveShortcutCommand, type ShortcutMatchContext } from "./keybindings";
import { isMacPlatform } from "./lib/utils";

type NavigationHistory = Pick<History, "back" | "forward">;
type NavigationHistoryAction = "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO";

export interface ObservedNavigationHistory {
  readonly keys: ReadonlyMap<number, string>;
  readonly minIndex: number;
  readonly maxIndex: number;
}

export function observeNavigationHistory(
  previous: ObservedNavigationHistory,
  index: number,
  key: string,
  action: NavigationHistoryAction,
): ObservedNavigationHistory {
  if (previous.keys.get(index) === key && action !== "PUSH") return previous;
  const keys = new Map(previous.keys);
  // PUSH truncates the forward branch; REPLACE preserves it.
  if (action === "PUSH") {
    for (const knownIndex of keys.keys()) {
      if (knownIndex > index) keys.delete(knownIndex);
    }
  }
  keys.set(index, key);
  return { keys, minIndex: previous.minIndex, maxIndex: Math.max(...keys.keys()) };
}

export function isProtectedNavigationShortcutTarget(
  target: { closest: (selector: string) => Element | null } | null,
): boolean {
  return (
    target?.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-keybinding-capture]',
    ) !== null && target !== null
  );
}

export function handleNavigationHistoryShortcut(
  event: KeyboardEvent,
  keybindings: ResolvedKeybindingsConfig,
  context: ShortcutMatchContext,
  historyIndex: number,
  minObservedHistoryIndex: number,
  maxObservedHistoryIndex: number,
  history: NavigationHistory,
  isDesktop: boolean,
  platform?: string,
): boolean {
  if (event.defaultPrevented || event.isComposing || event.repeat) return false;
  if (context.modelPickerOpen) return false;
  if (
    typeof Element !== "undefined" &&
    event.target instanceof Element &&
    isProtectedNavigationShortcutTarget(event.target)
  ) {
    return false;
  }

  const command = resolveShortcutCommand(event, keybindings, {
    context,
    ...(platform ? { platform } : {}),
  });
  if (command !== "navigation.back" && command !== "navigation.forward") return false;

  const resolvedPlatform = platform ?? navigator.platform;
  const nativeModifier = isMacPlatform(resolvedPlatform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  const nativeBracket =
    event.code === "BracketLeft" ||
    event.code === "BracketRight" ||
    event.key === "[" ||
    event.key === "]";
  if (!isDesktop && nativeModifier && nativeBracket && !event.altKey && !event.shiftKey) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  if (command === "navigation.back") {
    // The first observed entry may have a nonzero browser index.
    if (historyIndex > minObservedHistoryIndex) history.back();
  } else {
    // A global forward entry may belong to a different site. Only follow a
    // route index Pylon has actually observed in this mounted session.
    if (historyIndex < maxObservedHistoryIndex) history.forward();
  }
  return true;
}
