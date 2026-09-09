import {
  formatContextWindowTokens,
  type ContextWindowSnapshot,
} from "@t3tools/client-runtime/state/context-window";

export interface MobileContextWindowPresentation {
  /** Drives the ring's arc. null when the model's window size is unknown. */
  readonly percent: number | null;
  /** Token counts for the menu that reveals them, since the ring carries no text. */
  readonly detailLabel: string;
  readonly accessibilityText: string;
  readonly warning: boolean;
}

export function presentMobileContextWindow(
  snapshot: ContextWindowSnapshot | null,
): MobileContextWindowPresentation | null {
  if (snapshot === null) return null;
  const used = formatContextWindowTokens(snapshot.usedTokens);
  const warning = snapshot.usedPercentage !== null && snapshot.usedPercentage > 90;
  if (snapshot.maxTokens === null || snapshot.usedPercentage === null) {
    return {
      percent: null,
      detailLabel: `${used} used · window size unknown`,
      accessibilityText: `Context window, ${snapshot.usedTokens.toLocaleString()} tokens used.`,
      warning,
    };
  }
  const maximumTokens = snapshot.maxTokens;
  const maximum = formatContextWindowTokens(maximumTokens);
  const percent = Math.round(snapshot.usedPercentage);
  return {
    percent,
    detailLabel: `${used} / ${maximum} · ${percent}%`,
    accessibilityText: `${percent} percent, ${snapshot.usedTokens.toLocaleString()} of ${maximumTokens.toLocaleString()} tokens used.`,
    warning,
  };
}
