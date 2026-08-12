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
import { isUsageElevated, usageBarClassName, usageValueClassName } from "./usageEmphasis";

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
 * Ranked the way the usage page ranks a figure against its detail line: the
 * percentage at full contrast because it is the reason the popover is open, the
 * countdown muted beneath it. The countdown lives in the cell rather than in a
 * footer because each account resets on its own schedule — a single line per row
 * would have to pick one account's time and silently misreport the other. The
 * exact timestamp stays available on hover, where it costs no height.
 */
function UsageCell({
  cell,
  label,
  accentColor,
  nowMs,
  timestampFormat,
}: {
  readonly cell: ProviderUsageCell;
  readonly label: string;
  readonly accentColor: string | undefined;
  readonly nowMs: number;
  readonly timestampFormat: TimestampFormat;
}) {
  if (cell.usedPercent === undefined) {
    return (
      <div
        title={`${label} is not reported for this account`}
        aria-label={`${label}: not reported`}
      >
        <span className="text-sm text-muted-foreground/40">—</span>
        <div className="mt-1.5 h-1 w-full rounded-full bg-muted/40" />
      </div>
    );
  }

  const used = cell.usedPercent;
  const resetsAt = cell.window?.resetsAt;
  const countdown = resetsAt ? formatTimeUntilReset(resetsAt, nowMs) : undefined;
  // The account's own colour ties a bar to the column it belongs to, the way
  // the usage page colours each provider's share. Warning and critical
  // readings give it up: an alarm that changes hue per account is not an alarm.
  const accentFill = isUsageElevated(used) ? undefined : accentColor;

  return (
    <div
      {...(resetsAt
        ? { title: `${label} resets ${formatResetTimestamp(resetsAt, timestampFormat)}` }
        : {})}
    >
      <span className="flex items-baseline gap-1.5">
        <span className={cn("text-sm font-medium tabular-nums", usageValueClassName(used))}>
          {used}%
        </span>
        {countdown ? (
          <span className="truncate text-[11px] tabular-nums text-muted-foreground">
            {countdown}
          </span>
        ) : null}
      </span>
      <div
        className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={`${label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
        aria-valuetext={`${used}% used${countdown ? `, resets in ${countdown}` : ""}`}
      >
        {/* Fills as the window is spent, matching the number beside it. */}
        <div
          className={cn(
            "h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none",
            accentFill ? undefined : usageBarClassName(used),
          )}
          style={{ width: `${used}%`, ...(accentFill ? { backgroundColor: accentFill } : {}) }}
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
 *
 * A table rather than a bare grid, borrowing the usage page's breakdown
 * tables: the ruled header and row separators give each window a band to sit
 * in, and letting the label column size to its own content stops a long window
 * name from crushing the account names down to one character.
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

  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-border">
          <th className="w-px" />
          {matrix.accounts.map((account) => {
            const stale = isUsageReadingStale({ checkedAt: account.usageLimits.checkedAt, nowMs });
            return (
              // Top-aligned, so every account name shares a baseline whether or
              // not the account below it carries a status line.
              <th key={account.instanceId} className="pb-2 pl-4 text-left align-top font-normal">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: account.accentColor ?? "var(--muted-foreground)" }}
                  />
                  <span
                    className={cn(
                      "min-w-0 max-w-28 truncate text-xs text-foreground",
                      account.isActive ? "font-semibold" : "font-medium",
                    )}
                    title={account.displayName}
                  >
                    {account.displayName}
                  </span>
                </span>
                {/* Indented past the marker so the status hangs under the name
                    rather than under the dot. */}
                {account.isActive ? (
                  <span className="block ps-3 text-[10px] font-normal text-muted-foreground/60">
                    this thread
                  </span>
                ) : stale ? (
                  // Said out loud, because the server keeps serving the last
                  // good reading rather than blanking the gauge when a probe
                  // fails.
                  <span className="block ps-3 text-[10px] font-normal text-muted-foreground/50">
                    not current
                  </span>
                ) : null}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {matrix.rows.map((row) => (
          <tr key={row.label} className="border-b border-border/50 last:border-0">
            <td
              className="py-2.5 pr-1 align-top text-xs whitespace-nowrap text-muted-foreground"
              title={row.label}
            >
              {row.label}
            </td>
            {row.cells.map((cell, index) => (
              <td key={`${row.label}:${cell.accountId}`} className="py-2.5 pl-4 align-top">
                <UsageCell
                  cell={cell}
                  label={row.label}
                  accentColor={matrix.accounts[index]?.accentColor}
                  nowMs={nowMs}
                  timestampFormat={timestampFormat}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
