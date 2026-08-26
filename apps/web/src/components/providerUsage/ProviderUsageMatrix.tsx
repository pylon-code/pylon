import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { getTimestampFormatOptions, parseTimestampDate } from "~/timestampFormat";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import type { ProviderUsageAccount } from "./ProviderUsageAccounts";
import {
  buildProviderUsageMatrix,
  isUsageReadingStale,
  type ProviderUsageCell,
} from "./ProviderUsageMatrix.logic";
import { formatTimeSinceChecked, formatTimeUntilReset } from "./usageTime";
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
      <Tooltip>
        <TooltipTrigger
          render={
            <div aria-label={`${label}: not reported`}>
              <span className="text-sm text-muted-foreground/40">—</span>
              <div className="mt-1.5 h-1 w-full rounded-full bg-muted/40" />
            </div>
          }
        />
        <TooltipPopup>{`${label} is not reported for this account`}</TooltipPopup>
      </Tooltip>
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
 *
 * The thread's own account is a tinted column rather than a louder label, the
 * same way the model picker marks its selected row. Which column matters is
 * then answered by shape, before any text is read, and it survives greyscale
 * and colour blindness in a way the accent dot alone cannot.
 */
export function ProviderUsageMatrix({
  accounts,
  timestampFormat,
  nowMs,
  staleAfterMs,
}: {
  readonly accounts: ReadonlyArray<ProviderUsageAccount>;
  readonly timestampFormat: TimestampFormat;
  readonly nowMs: number;
  /** How old a reading may get before its column says so; see `isUsageReadingStale`. */
  readonly staleAfterMs?: number | undefined;
}) {
  const matrix = buildProviderUsageMatrix(accounts);
  if (matrix.rows.length === 0) return null;

  const lastRowIndex = matrix.rows.length - 1;

  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-border">
          <th className="w-px" />
          {matrix.accounts.map((account) => {
            const age = formatTimeSinceChecked(account.usageLimits.checkedAt, nowMs);
            const stale =
              isUsageReadingStale({
                checkedAt: account.usageLimits.checkedAt,
                nowMs,
                staleAfterMs,
              }) && age !== undefined;
            return (
              // Top-aligned, so every account name shares a baseline whether or
              // not the account below it carries a status line.
              <th
                key={account.instanceId}
                className={cn(
                  "px-3 pb-2 text-left align-top font-normal",
                  account.isActive && "rounded-t-md bg-foreground/[0.045]",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: account.accentColor ?? "var(--muted-foreground)" }}
                  />
                  {/* Only the thread's account holds full contrast. Weight alone
                      cannot carry this when both names are foreground. */}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          className={cn(
                            "min-w-0 max-w-28 truncate text-xs",
                            account.isActive
                              ? "font-semibold text-foreground"
                              : "font-medium text-muted-foreground",
                          )}
                        >
                          {account.displayName}
                        </span>
                      }
                    />
                    <TooltipPopup>{account.displayName}</TooltipPopup>
                  </Tooltip>
                </span>
                {/* Indented past the marker so the status hangs under the name
                    rather than under the dot. Kept even though the tint says the
                    same thing, so the column is still identifiable in greyscale.
                */}
                {account.isActive ? (
                  <span className="block ps-3 text-[10px] font-normal text-muted-foreground">
                    this thread
                  </span>
                ) : null}
                {/*
                  Staleness belongs to the probe, not to the account, so it is
                  its own line and can appear on the active column too. The
                  server keeps serving the last good reading rather than blanking
                  the gauge, which is only honest if the age is said out loud.
                */}
                {stale ? (
                  // Terse because the column is only as wide as an account
                  // name: "checked 7m ago" wraps here and pushes the whole card
                  // taller. The full phrasing lives in the tooltip.
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="block ps-3 text-[10px] font-normal whitespace-nowrap text-muted-foreground/50">
                          {age} old
                        </span>
                      }
                    />
                    <TooltipPopup>{`Last successful reading ${age} ago`}</TooltipPopup>
                  </Tooltip>
                ) : null}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {matrix.rows.map((row, rowIndex) => (
          <tr key={row.label} className="border-b border-border/50 last:border-0">
            <td className="py-2.5 pr-2 align-top text-xs whitespace-nowrap text-muted-foreground">
              {row.label}
            </td>
            {row.cells.map((cell, index) => {
              const account = matrix.accounts[index];
              return (
                <td
                  key={`${row.label}:${cell.accountId}`}
                  className={cn(
                    "px-3 py-2.5 align-top",
                    account?.isActive && "bg-foreground/[0.045]",
                    account?.isActive && rowIndex === lastRowIndex && "rounded-b-md",
                  )}
                >
                  <UsageCell
                    cell={cell}
                    label={row.label}
                    accentColor={account?.accentColor}
                    nowMs={nowMs}
                    timestampFormat={timestampFormat}
                  />
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
