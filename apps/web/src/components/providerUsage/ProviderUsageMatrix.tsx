import { cn } from "~/lib/utils";
import { getTimestampFormatOptions, parseTimestampDate } from "~/timestampFormat";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import type { ProviderUsageAccount } from "./ProviderUsageAccounts";
import {
  buildProviderUsageMatrix,
  isUsageReadingStale,
  type ProviderUsageCell,
} from "./ProviderUsageMatrix.logic";

/**
 * Colour follows how little is left, not how much is used.
 *
 * The label says "remaining" and the bar drains, so the warning has to key off
 * the same direction or the three cues disagree.
 */
function remainingColor(remainingPercent: number): string {
  if (remainingPercent <= 10) return "bg-red-500";
  if (remainingPercent <= 30) return "bg-amber-500";
  return "bg-blue-500";
}

function formatResetTimestamp(resetsAt: string, timestampFormat: TimestampFormat): string {
  const date = parseTimestampDate(resetsAt);
  if (!date) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...getTimestampFormatOptions(timestampFormat, false),
  }).format(date);
}

function UsageCell({ cell, label }: { readonly cell: ProviderUsageCell; readonly label: string }) {
  if (cell.remainingPercent === undefined) {
    return (
      <div className="flex flex-col items-end gap-1" aria-label={`${label}: not reported`}>
        <span className="text-xs text-muted-foreground/50">—</span>
        <div className="h-1 w-full rounded-full bg-muted/30" />
      </div>
    );
  }

  const remaining = cell.remainingPercent;
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="text-xs tabular-nums text-foreground">{remaining}%</span>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-label={`${label} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining}
        aria-valuetext={`${remaining}% remaining`}
      >
        {/* Drains left to right: the bar and the number now say the same thing. */}
        <div
          className={cn(
            "h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none",
            remainingColor(remaining),
          )}
          style={{ width: `${remaining}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Several accounts' usage as one comparison.
 *
 * Window labels appear once down the left with an account per column, so
 * "which account has more left" is a horizontal glance rather than a scroll
 * between two stacked lists.
 */
export function ProviderUsageMatrix({
  accounts,
  timestampFormat,
  nowMs,
}: {
  readonly accounts: ReadonlyArray<ProviderUsageAccount>;
  readonly timestampFormat: TimestampFormat;
  readonly nowMs: number;
}) {
  const matrix = buildProviderUsageMatrix(accounts);
  if (matrix.rows.length === 0) return null;

  const columns = `minmax(0,1fr) ${matrix.accounts.map(() => "minmax(3.5rem,auto)").join(" ")}`;

  return (
    <div className="grid gap-2">
      <div className="grid items-end gap-x-3 gap-y-1" style={{ gridTemplateColumns: columns }}>
        <span />
        {matrix.accounts.map((account) => {
          const stale = isUsageReadingStale({
            checkedAt: account.usageLimits.checkedAt,
            nowMs,
          });
          return (
            <div key={account.instanceId} className="flex flex-col items-end gap-0.5">
              <span className="flex min-w-0 items-center gap-1">
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: account.accentColor ?? "var(--muted-foreground)" }}
                />
                <span className="truncate text-xs font-medium text-foreground">
                  {account.displayName}
                </span>
              </span>
              {account.isActive ? (
                <span className="text-[10px] text-muted-foreground/70">this thread</span>
              ) : stale ? (
                // Said out loud, because the server keeps serving the last good
                // reading rather than blanking the gauge when a probe fails.
                <span className="text-[10px] text-muted-foreground/60">not current</span>
              ) : null}
            </div>
          );
        })}

        {matrix.rows.map((row) => (
          <div key={row.label} className="contents">
            <span className="min-w-0 truncate text-xs text-muted-foreground">{row.label}</span>
            {row.cells.map((cell) => (
              <UsageCell key={`${row.label}:${cell.accountId}`} cell={cell} label={row.label} />
            ))}
          </div>
        ))}
      </div>

      {/* One reset line for the whole block: the soonest one is what changes the answer first. */}
      {matrix.rows.some((row) => row.resetsAt) ? (
        <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground/60">
          {matrix.rows.map((row) =>
            row.resetsAt ? (
              <span key={`${row.label}:reset`}>
                {row.label} resets {formatResetTimestamp(row.resetsAt, timestampFormat)}
              </span>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}
