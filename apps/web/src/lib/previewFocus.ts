/**
 * Returns true when the user's keyboard focus is somewhere inside the
 * preview panel (URL bar, chrome buttons, the embedded page via Electron
 * `<webview>`, or the floating preview mini-player).
 *
 * Used by the global keybinding handler to gate `preview.refresh` and
 * `preview.focusUrl` to only fire while the preview owns focus, and by the
 * preview chrome/shell to render focus indicators.
 */
export function isPreviewFocused(): boolean {
  if (typeof document === "undefined" || typeof HTMLElement === "undefined") return false;
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  if (activeElement.tagName.toLowerCase() === "webview") return true;
  if (activeElement.closest("[data-preview-panel-mode]") !== null) return true;
  if (activeElement.closest("[data-preview-viewport]") !== null) return true;
  if (activeElement.closest("[data-preview-mini-player]") !== null) return true;
  return false;
}
