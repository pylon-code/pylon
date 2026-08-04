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
                <span className={cn(entry.usedPercent >= NEAR_LIMIT_PERCENT && "text-warning")}>
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
