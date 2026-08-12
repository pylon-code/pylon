import type { ServerProvider } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { memo } from "react";

import { cn } from "../lib/utils";
import { useNowMinute } from "../hooks/useNowMinute";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { ProviderUsageAccounts } from "./providerUsage/ProviderUsageAccounts";
import type { ProviderUsageAccount } from "./providerUsage/ProviderUsageAccounts";
import { usageEmphasisClassName } from "./providerUsage/usageEmphasis";
import { getComposerUsageView } from "./ComposerUsageIndicator.logic";

/**
 * Subscription capacity for the account the current thread runs on, at the
 * right of the composer context strip.
 *
 * Carries only what a glance can act on: which account, how much of each
 * window is spent, and how long until it resets. No bars — a coloured number
 * and a 20px bar encode the same value twice, and the colour is the part that
 * registers without being read.
 *
 * The account name stays because it is the one thing here that cannot be
 * inferred. A coloured dot identifies an account only if you remember which
 * colour is which, and not at all if you cannot separate the colours.
 *
 * Clicking opens the full per-account breakdown. That lives here rather than
 * in the context popover because capacity belongs to the account and context
 * belongs to the thread.
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
              "inline-flex shrink-0 items-center gap-2 rounded-md px-1 py-0.5 text-sm tabular-nums",
              "hover:bg-muted/40",
              className,
            )}
          >
            <span className="inline-flex min-w-0 items-center gap-1">
              {view.accentColor ? (
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: view.accentColor }}
                />
              ) : null}
              {view.accountName ? (
                <span className="max-w-24 truncate text-xs text-muted-foreground/50">
                  {view.accountName}
                </span>
              ) : null}
            </span>
            {/*
              Spacing separates the two windows rather than punctuation: with
              the bars gone there is little enough here that a gap reads more
              cleanly than another glyph.
            */}
            {view.entries.map((entry) => (
              <span key={entry.detail} className="inline-flex items-baseline gap-1">
                <span className={cn("font-medium", usageEmphasisClassName(entry.usedPercent))}>
                  {entry.usedPercent}%
                </span>
                <span className="text-xs text-muted-foreground/45">{entry.label}</span>
              </span>
            ))}
          </button>
        }
      />
      {/*
        Wide enough that a long window name down the left cannot squeeze the
        account names beside it into initials, and capped so a narrow phone
        viewport still gets the whole card.
      */}
      <PopoverPopup align="end" side="top" className="w-[min(25rem,calc(100vw-2rem))] p-3.5">
        <div className="grid gap-3">
          <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Subscription capacity
          </div>
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
