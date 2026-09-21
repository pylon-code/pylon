import { afterEach, describe, expect, it } from "vite-plus/test";

import { subscribeToPreviewFocusChanges } from "./usePreviewFocus";

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: Window }).window;
  } else {
    globalThis.window = originalWindow;
  }
});

describe("subscribeToPreviewFocusChanges", () => {
  it("notifies on focus and blur transitions until unsubscribed", () => {
    const listeners = new Map<string, Set<() => void>>();
    globalThis.window = {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        const callbacks = listeners.get(type) ?? new Set<() => void>();
        callbacks.add(listener as () => void);
        listeners.set(type, callbacks);
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.get(type)?.delete(listener as () => void);
      },
    } as unknown as Window & typeof globalThis;
    let notifications = 0;

    const unsubscribe = subscribeToPreviewFocusChanges(() => {
      notifications += 1;
    });

    for (const listener of listeners.get("focusin") ?? []) listener();
    for (const listener of listeners.get("focusout") ?? []) listener();
    for (const listener of listeners.get("focus") ?? []) listener();
    for (const listener of listeners.get("blur") ?? []) listener();
    expect(notifications).toBe(4);

    unsubscribe();
    for (const listener of listeners.get("focusin") ?? []) listener();
    for (const listener of listeners.get("focusout") ?? []) listener();
    expect(notifications).toBe(4);
  });
});
