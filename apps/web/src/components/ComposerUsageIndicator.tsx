import { type EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { memo, useCallback, useState } from "react";

import { cn } from "../lib/utils";
import { useNowMinute } from "../hooks/useNowMinute";
import type { ComposerUsage, ComposerUsageBackend } from "../providerUsageAccounts";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { ProviderUsageAccounts } from "./providerUsage/ProviderUsageAccounts";
import { usageEmphasisClassName } from "./providerUsage/usageEmphasis";
import { getComposerUsageView } from "./ComposerUsageIndicator.logic";

/**
 * One line on whose capacity a Prime thread is showing, and how sure that is.
 * Verified cases are stated as fact; the assumed case names the assumption so
 * a user running Prime on a different account knows the number is not theirs.
 */
function describeBackend(backend: ComposerUsageBackend, accountCount: number): string {
  const runs = `Prime Agent runs ${backend.model} on ${backend.label}.`;
  switch (backend.verification) {
    case "own":
      return `${runs} This is Prime Agent's own ${backend.label} capacity, read from its sign-in.`;
    case "matched":
      return `${runs} Prime Agent is signed in to this ${backend.label} account.`;
    case "mismatch":
      return `${runs} Prime Agent is signed in to a different ${backend.label} account than any configured here, so its capacity cannot be shown.`;
    case "assumed":
      return `${runs} Its ${backend.label} sign-in could not be read; this assumes it is the same ${
        accountCount === 1 ? "account" : "subscription"
      } as ${backend.label} here.`;
  }
}

/**
 * Subscription capacity for the account the composer will send to, at the
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
 * A reading that has fallen behind the server's own poll dims rather than
 * disappears: a slightly old number still beats no number when deciding
 * where to send work, and the popover says exactly how old and offers a
 * refresh.
 *
 * Clicking opens the full per-account breakdown. That lives here rather than
 * in the context popover because capacity belongs to the account and context
 * belongs to the thread.
 */
export const ComposerUsageIndicator = memo(function ComposerUsageIndicator({
  environmentId,
  usage,
  timestampFormat,
  staleAfterMs,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly usage: ComposerUsage;
  readonly timestampFormat: TimestampFormat;
  readonly staleAfterMs: number;
  readonly className?: string;
}) {
  // Minute resolution keeps the countdown honest without repainting forever,
  // and reuses the app's one shared clock.
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const view = getComposerUsageView(usage.primary, nowMs, staleAfterMs);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const accounts = usage.accounts;
  // One instance at a time: the command is single-flight per environment, so
  // firing every account at once would refresh only the first.
  const refresh = useCallback(() => {
    if (isRefreshing || accounts.length === 0) return;
    setIsRefreshing(true);
    void (async () => {
      try {
        for (const account of accounts) {
          await refreshProviders({
            environmentId,
            input: { instanceId: ProviderInstanceId.make(account.instanceId) },
          });
        }
      } finally {
        setIsRefreshing(false);
      }
    })();
  }, [accounts, environmentId, isRefreshing, refreshProviders]);

  // Prime is signed in to an account that is not configured here: there is
  // no number to show, but silence would read as the gauge being broken.
  if (!view && usage.backend?.verification !== "mismatch") return null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={
              view
                ? `Subscription capacity for ${view.accountName ?? "this account"}${
                    view.stale ? ", last checked " + (view.age ?? "a while") + " ago" : ""
                  }`
                : "Subscription capacity unavailable"
            }
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-md px-1 py-0.5 text-sm tabular-nums",
              "hover:bg-muted/40",
              className,
            )}
          >
            {view ? (
              <>
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
                  Spacing separates the two windows rather than punctuation:
                  with the bars gone there is little enough here that a gap
                  reads more cleanly than another glyph.
                */}
                {view.entries.map((entry) => (
                  <span
                    key={entry.detail}
                    className={cn("inline-flex items-baseline gap-1", view.stale && "opacity-50")}
                  >
                    <span className={cn("font-medium", usageEmphasisClassName(entry.usedPercent))}>
                      {entry.usedPercent}%
                    </span>
                    <span className="text-xs text-muted-foreground/45">{entry.label}</span>
                  </span>
                ))}
              </>
            ) : (
              <span className="text-xs text-muted-foreground/50">Capacity unavailable</span>
            )}
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
          {usage.backend ? (
            // Prime signs in on its own; say whose capacity this is and how
            // sure that is, since the account names below may not be Prime's.
            <div className="text-xs text-muted-foreground">
              {describeBackend(usage.backend, accounts.length)}
            </div>
          ) : null}
          {accounts.length > 0 ? (
            <ProviderUsageAccounts
              accounts={accounts}
              timestampFormat={timestampFormat}
              nowMs={nowMs}
              staleAfterMs={staleAfterMs}
            />
          ) : (
            <div className="text-xs text-muted-foreground">
              No capacity reported for this provider.
            </div>
          )}
          {/*
            The age lives here rather than in the strip: it matters only once
            you are deciding whether to trust the number, which is what opening
            the popover means. Refresh is offered only once the reading is
            stale — inside that bound the server serves its cached reading, so
            the button would fetch nothing, and the usage endpoints are rate
            limited enough that it must not invite hammering them anyway.
          */}
          {view ? (
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground/70">
              <span>
                {isRefreshing
                  ? "Checking…"
                  : view.age
                    ? `Checked ${view.age} ago`
                    : "Checked just now"}
              </span>
              {view.stale && !isRefreshing ? (
                <button
                  type="button"
                  onClick={refresh}
                  className="rounded px-1.5 py-0.5 text-foreground/80 hover:bg-muted/60"
                >
                  Refresh
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
