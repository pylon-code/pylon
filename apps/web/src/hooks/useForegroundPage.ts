import { useSyncExternalStore } from "react";

const isForeground = () =>
  typeof document === "undefined" || (document.visibilityState !== "hidden" && document.hasFocus());

const subscribe = (notify: () => void) => {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};
  document.addEventListener("visibilitychange", notify);
  window.addEventListener("focus", notify);
  window.addEventListener("blur", notify);
  return () => {
    document.removeEventListener("visibilitychange", notify);
    window.removeEventListener("focus", notify);
    window.removeEventListener("blur", notify);
  };
};

/** Stop media work and decorative motion when the page cannot be watched. */
export function useForegroundPage(): boolean {
  return useSyncExternalStore(subscribe, isForeground, () => false);
}
