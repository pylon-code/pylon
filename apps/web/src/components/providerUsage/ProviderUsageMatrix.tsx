import { cn } from "~/lib/utils";
import { getTimestampFormatOptions, parseTimestampDate } from "~/timestampFormat";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import type { ProviderUsageAccount } from "./ProviderUsageAccounts";
import {
  buildProviderUsageMatrix,
  isUsageReadingStale,
  type ProviderUsageCell,
} from "./ProviderUsageMatrix.logic";
import { formatTimeUntilReset } from "./usageTime";

/**
 * Colour follows how little is left, not how much is used.
 *
 * The label says "remaining" and the bar drains, so the warning has to key off
 * the same direction or the three cues disagree.
 */
function remainingColor(remainingPercent: number): string {
  if (remainingPercent <= 10) return "bg-red-500";
  if (remainingPercent <= 30) return "bg-amber-500";
  return "bg-sky-500";
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

/**
 * One account's standing in one window.
 *
 * The countdown lives in the cell rather than in a footer because each account
 * resets on its own schedule — a single line per row would have to pick one
 * account's time and silently misreport the other. The exact timestamp stays
 * available on hover, where it costs no height.
 */
function UsageCell({
  cell,
  label,
  nowMs,
  timestampFormat,
}: {
  readonly cell: ProviderUsageCell;
  readonly label: string;
  readonly nowMs: number;
  readonly timestampFormat: TimestampFormat;
}) {
  if (cell.remainingPercent === undefined) {
    return (
      <div
        className="flex flex-col gap-1"
        title={`${label} is not reported for this account`}
        aria-label={`${label}: not reported`}
      >
        <span className="text-xs text-muted-foreground/40">—</span>
        <div className="h-1 w-full rounded-full bg-muted/30" />
      </div>
    );
  }

  const remaining = cell.remainingPercent;
  const resetsAt = cell.window?.resetsAt;
  const countdown = resetsAt ? formatTimeUntilReset(resetsAt, nowMs) : undefined;

  return (
    <div
      className="flex flex-col gap-1"
      {...(resetsAt
        ? { title: `${label} resets ${formatResetTimestamp(resetsAt, timestampFormat)}` }
        : {})}
    >
      <span className="flex items-baseline gap-1.5">
        <span className="text-xs tabular-nums text-foreground">{remaining}%</span>
        {countdown ? (
          <span className="text-[11px] tabular-nums text-muted-foreground/60">{countdown}</span>
        ) : null}
      </span>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-label={`${label} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining}
        aria-valuetext={`${remaining}% remaining${countdown ? `, resets in ${countdown}` : ""}`}
      >
        {/* Drains left to right: the bar and the number say the same thing. */}
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
 * Several accounts' capacity as one comparison.
 *
 * Window labels once down the left, an account per column, so "which account
 * has more left" is a horizontal glance rather than a scroll between two
 * stacked lists.
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

  const columns = `minmax(0,auto) ${matrix.accounts.map(() => "minmax(4.5rem,1fr)").join(" ")}`;

  return (
    <div className="grid gap-x-4 gap-y-2" style={{ gridTemplateColumns: columns }}>
      <span />
      {matrix.accounts.map((account) => {
        const stale = isUsageReadingStale({ checkedAt: account.usageLimits.checkedAt, nowMs });
        return (
          // One line, so every account name sits on the same baseline. A
          // second line under one of them pushes the others out of alignment.
          <div key={account.instanceId} className="flex min-w-0 items-center gap-1">
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: account.accentColor ?? "var(--muted-foreground)" }}
            />
            <span
              className={cn(
                "min-w-0 truncate text-xs",
                account.isActive ? "font-semibold text-foreground" : "font-medium text-foreground",
              )}
            >
              {account.displayName}
            </span>
            {account.isActive ? (
              <span className="shrink-0 text-[10px] text-muted-foreground/60">· this thread</span>
            ) : stale ? (
              // Said out loud, because the server keeps serving the last good
              // reading rather than blanking the gauge when a probe fails.
              <span className="shrink-0 text-[10px] text-muted-foreground/50">· not current</span>
            ) : null}
          </div>
        );
      })}

      {matrix.rows.map((row) => (
        <div key={row.label} className="contents">
          <span
            className="min-w-0 self-start truncate pt-px text-xs text-muted-foreground"
            title={row.label}
          >
            {row.label}
          </span>
          {row.cells.map((cell) => (
            <UsageCell
              key={`${row.label}:${cell.accountId}`}
              cell={cell}
              label={row.label}
              nowMs={nowMs}
              timestampFormat={timestampFormat}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
