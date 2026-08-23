import type { AppearanceContrast } from "@t3tools/contracts/settings";

/**
 * The boost mixes every foreground role toward one shared target, so a full
 * 100% resolves them all to exactly that target and the normal/muted/placeholder
 * hierarchy disappears — an empty composer becomes indistinguishable from a
 * filled one. Measured in a browser against the real tokens: at contrast 200 an
 * unscaled boost puts `--contrast-foreground`, `--contrast-muted-foreground`,
 * `--contrast-placeholder` and `--contrast-icon-muted` all at `oklab(0 0 0)`.
 *
 * Capping the mix keeps the top of the range clearly darker than the default
 * while holding the roles apart. Lightness separation between normal and muted
 * text: 0.278 at the default, 0.111 here, 0 unscaled.
 *
 * Borders are excluded — they carry a single role, so converging on the target
 * costs no hierarchy, and their own quarter-weight already bounds them.
 */
const FOREGROUND_BOOST_RATIO = 0.6;

export function applyAppearanceContrast(root: HTMLElement, contrast: AppearanceContrast): void {
  const overshoot = Math.max(contrast - 100, 0);
  root.style.setProperty("--appearance-contrast-base", `${Math.min(contrast, 100)}%`);
  root.style.setProperty("--appearance-contrast-boost", `${overshoot * FOREGROUND_BOOST_RATIO}%`);
  root.style.setProperty("--appearance-contrast-border-boost", `${overshoot / 4}%`);
}
