// A guest press only surfaces in the host as webview focus. Mark the synthetic
// outside pointer so the theme inspector leaves it to host popup listeners.
const guestFocusPointers = new WeakSet<Event>();

export function dispatchGuestFocusPointerDown(webview: HTMLElement): void {
  const event = new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" });
  guestFocusPointers.add(event);
  webview.dispatchEvent(event);
}

export function isGuestFocusPointerDown(event: Event): boolean {
  return guestFocusPointers.has(event);
}
