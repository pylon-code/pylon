import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
  type ContextWindowSnapshot,
} from "@t3tools/client-runtime/state/context-window";
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";

type MobileContextWindowProjection = {
  readonly thread: Pick<OrchestrationV2AppThread, "activeProviderThreadId">;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "id" | "contextUsage" | "updatedAt">
  >;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "tokenUsage">
  >;
};

/** Usage belongs to the active provider context, including after a handoff. */
export function deriveMobileThreadContextWindow(
  projection: MobileContextWindowProjection | null | undefined,
  entries: Parameters<typeof deriveLatestContextWindowSnapshot>[0] = [],
): ContextWindowSnapshot | null {
  const providerThreadId = projection?.thread.activeProviderThreadId;
  if (projection == null || providerThreadId == null) return null;
  const usage = projection.providerTurns.findLast(
    (turn) => turn.providerThreadId === providerThreadId && turn.tokenUsage !== undefined,
  )?.tokenUsage;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === providerThreadId,
  );
  return deriveLatestContextWindowSnapshot(
    entries.filter((entry) => entry.item.providerThreadId === providerThreadId),
    usage,
    providerThread,
  );
}

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
  if (snapshot.maxTokens == null || snapshot.usedPercentage === null) {
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
