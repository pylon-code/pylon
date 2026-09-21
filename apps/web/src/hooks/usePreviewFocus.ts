import { useSyncExternalStore } from "react";

import { isPreviewFocused } from "../lib/previewFocus";

export function subscribeToPreviewFocusChanges(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("focusin", listener, true);
  window.addEventListener("focusout", listener, true);
  window.addEventListener("focus", listener, true);
  window.addEventListener("blur", listener, true);
  return () => {
    window.removeEventListener("focusin", listener, true);
    window.removeEventListener("focusout", listener, true);
    window.removeEventListener("focus", listener, true);
    window.removeEventListener("blur", listener, true);
  };
}

export function usePreviewFocus(): boolean {
  return useSyncExternalStore(subscribeToPreviewFocusChanges, isPreviewFocused, () => false);
}
