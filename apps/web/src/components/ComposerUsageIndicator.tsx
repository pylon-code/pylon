import type { ServerProvider } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { memo } from "react";

import { cn } from "../lib/utils";
import { useNowMinute } from "../hooks/useNowMinute";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { ProviderUsageAccounts } from "./providerUsage/ProviderUsageAccounts";
import type { ProviderUsageAccount } from "./providerUsage/ProviderUsageAccounts";
import { getComposerUsageView } from "./ComposerUsageIndicator.logic";

/**
 * Below this the number stops being background information and starts being
 * something to act on, so it picks up emphasis. Deliberately not one of the
 * thread-status colors — this is account capacity, not thread state.
 */
const LOW_REMAINING_PERCENT = 20;

/**
 * A nearly-spent window still shows a sliver rather than an empty track, so
 * the bar reads as "almost gone" instead of as a rendering failure.
 */
const MIN_VISIBLE_FILL_PERCENT = 3;

/**
 * Fixed-width gauge for one window.
 *
 * Drains rather than fills: the number beside it says how much is *left*, and
 * a bar that grew as capacity shrank would make the eye read the opposite of
 * the label. Decorative, so hidden from assistive tech; colors come from
 * `currentColor` so the low-capacity emphasis reaches the bar from one
 * decision.
 */
function UsageBar({ remainingPercent }: { readonly remainingPercent: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-1 w-5 shrink-0 overflow-hidden rounded-full bg-current/15"
    >
      <span
        className="block h-full rounded-full bg-current"
        style={{
          width: `${Math.max(MIN_VISIBLE_FILL_PERCENT, Math.min(100, remainingPercent))}%`,
        }}
      />
    </span>
  );
}

/**
 * Subscription capacity for the account the current thread runs on, at the
 * right of the composer context strip.
 *
 * Shows the account by name, then how long until each window resets and how
 * much is left. The countdown rather than the window length is what a glance
 * is actually asking: "5h" never changes and settles nothing, while "1h 45m"
 * answers whether to keep going or wait.
 *
 * Clicking opens the full per-account breakdown. That lives here rather than
 * in the context popover because capacity is a property of the account and
 * context is a property of the thread; sharing one popover made the reader
 * hunt for whichever half they wanted.
 */
export const ComposerUsageIndicator = memo(function ComposerUsageIndicator({
  provider,
  usageAccounts,
  timestampFormat,
  className,
}: {
  readonly provider: ServerProvider | null | undefined;
  readonly usageAccounts?: readonly ProviderUsageAccount[] | undefined;
  readonly timestampFormat: TimestampFormat;
  readonly className?: string;
}) {
  // Minute resolution keeps the countdown honest without repainting forever,
  // and reuses the app's one shared clock.
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const view = getComposerUsageView(provider, nowMs);
  if (!view) return null;

  const accounts = usageAccounts ?? [];

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Subscription capacity for ${view.accountName ?? "this account"}`}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-sm font-medium text-muted-foreground/70 tabular-nums",
              "hover:bg-muted/40 hover:text-muted-foreground",
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
            {view.accountName ? (
              <span className="max-w-24 truncate text-muted-foreground/80">{view.accountName}</span>
            ) : null}
            {view.entries.map((entry, index) => (
              <span key={entry.detail} className="inline-flex items-center gap-1">
                {index > 0 ? (
                  <span aria-hidden="true" className="text-muted-foreground/40">
                    ·
                  </span>
                ) : null}
                <span className="text-muted-foreground/50">{entry.label}</span>
                {/*
                  Bar and number share one element so the low-capacity color
                  applies to both from a single decision.
                */}
                <span
                  className={cn(
                    "inline-flex items-center gap-1",
                    entry.remainingPercent <= LOW_REMAINING_PERCENT && "text-warning",
                  )}
                >
                  <UsageBar remainingPercent={entry.remainingPercent} />
                  {entry.remainingPercent}%
                </span>
              </span>
            ))}
          </button>
        }
      />
      <PopoverPopup align="end" side="top" className="w-80 p-3">
        <div className="grid gap-2.5">
          <div className="text-xs font-medium text-muted-foreground">Subscription capacity</div>
          {accounts.length > 0 ? (
            <ProviderUsageAccounts
              accounts={accounts}
              timestampFormat={timestampFormat}
              nowMs={nowMs}
            />
          ) : (
            <div className="text-xs text-muted-foreground">
              No capacity reported for this provider.
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
