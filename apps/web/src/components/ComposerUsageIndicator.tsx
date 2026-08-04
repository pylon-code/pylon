import type { ServerProvider } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "../lib/utils";
import { formatRelativeTimeUntilLabel } from "../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { getComposerUsageView } from "./ComposerUsageIndicator.logic";

/**
 * Above this the number stops being background information and starts being
 * something to act on, so it picks up emphasis. Deliberately not one of the
 * thread-status colors — this is account capacity, not thread state.
 */
const NEAR_LIMIT_PERCENT = 80;

/**
 * A nearly-empty window still shows a sliver, so the bar reads as "barely
 * used" rather than as a rendering failure.
 */
const MIN_VISIBLE_FILL_PERCENT = 3;

/**
 * Fixed-width fill bar for one window.
 *
 * Decorative — the percentage sits next to it — so it is hidden from
 * assistive tech. Colors come from `currentColor`, which keeps the fill in
 * step with the near-limit emphasis on the number without a second decision.
 */
function UsageBar({ percent }: { readonly percent: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-1 w-5 shrink-0 overflow-hidden rounded-full bg-current/15"
    >
      <span
        className="block h-full rounded-full bg-current"
        style={{ width: `${Math.max(MIN_VISIBLE_FILL_PERCENT, Math.min(100, percent))}%` }}
      />
    </span>
  );
}

/**
 * Subscription usage for the account the current thread runs on, sitting at
 * the right of the composer context strip.
 *
 * Session and weekly only, as plain percentages — the strip shares a row with
 * the branch selector, and the context popover already carries every window
 * with its reset time.
 */
export const ComposerUsageIndicator = memo(function ComposerUsageIndicator({
  provider,
  className,
}: {
  readonly provider: ServerProvider | null | undefined;
  readonly className?: string;
}) {
  const view = getComposerUsageView(provider);
  if (!view) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-muted-foreground/70 tabular-nums",
              className,
            )}
          >
            {view.accentColor ? (
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: view.accentColor }}
              />
            ) : null}
            {view.entries.map((entry, index) => (
              <span key={entry.label} className="inline-flex items-center gap-1">
                {index > 0 ? (
                  <span aria-hidden="true" className="text-muted-foreground/40">
                    ·
                  </span>
                ) : null}
                <span className="text-muted-foreground/50">{entry.label}</span>
                {/*
                  Bar and number share one element so the near-limit color
                  applies to both from a single decision.
                */}
                <span
                  className={cn(
                    "inline-flex items-center gap-1",
                    entry.usedPercent >= NEAR_LIMIT_PERCENT && "text-warning",
                  )}
                >
                  <UsageBar percent={entry.usedPercent} />
                  {entry.usedPercent}%
                </span>
              </span>
            ))}
          </span>
        }
      />
      <TooltipPopup side="top">
        <span className="flex flex-col gap-0.5">
          {view.accountName ? <span>{view.accountName}</span> : null}
          {view.entries.map((entry) => (
            <span key={entry.label} className="text-muted-foreground">
              {entry.detail} · {entry.usedPercent}% used
              {entry.resetsAt ? ` · resets ${formatRelativeTimeUntilLabel(entry.resetsAt)}` : ""}
            </span>
          ))}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
});
