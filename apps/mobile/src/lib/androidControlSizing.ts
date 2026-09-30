import { DEFAULT_BASE_FONT_SIZE, normalizeBaseFontSize } from "./appearancePreferences";

/** Android controls follow the app's text size; header buttons retain their 44dp touch target. */
export function resolveAndroidControlSizing(baseFontSize: number) {
  const scale = normalizeBaseFontSize(baseFontSize) / DEFAULT_BASE_FONT_SIZE;
  const fabSize = Math.max(48, Math.round(56 * scale));

  return {
    scale,
    iconSize: Math.round(24 * scale),
    smallIconSize: Math.round(16 * scale),
    buttonSize: Math.max(44, Math.round(44 * scale)),
    fabSize,
    menuWidth: Math.round(250 * scale),
    // The floating action, its gap above the inset, and the space above it.
    fabClearance: fabSize + 32,
  };
}
