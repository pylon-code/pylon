import {
  formatContextWindowTokens,
  type ContextWindowSnapshot,
} from "@t3tools/client-runtime/state/context-window";

export interface MobileContextWindowPresentation {
  readonly compactLabel: string;
  readonly expandedLabel: string;
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
      compactLabel: used,
      expandedLabel: `Context ${used}`,
      accessibilityText: `Context window, ${snapshot.usedTokens.toLocaleString()} tokens used.`,
      warning,
    };
  }
  const maximumTokens = snapshot.maxTokens;
  const maximum = formatContextWindowTokens(maximumTokens);
  const percent = Math.round(snapshot.usedPercentage);
  return {
    compactLabel: `${percent}%`,
    expandedLabel: `Context ${used} / ${maximum} · ${percent}%`,
    accessibilityText: `${percent} percent, ${snapshot.usedTokens.toLocaleString()} of ${maximumTokens.toLocaleString()} tokens used.`,
    warning,
  };
}
