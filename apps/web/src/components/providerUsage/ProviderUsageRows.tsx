import type { ServerProviderUsageLimits } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { usageBarClassName, usageEmphasisClassName, usageValueClassName } from "./usageEmphasis";
import { getTimestampFormatOptions, parseTimestampDate } from "~/timestampFormat";
import type { TimestampFormat } from "@t3tools/contracts/settings";

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
 * One account's windows as a stacked list.
 *
 * `compact` is the capacity popover, where this stands in for the multi-account
 * matrix and has to read like it: window name muted on the left, the percentage
 * at full contrast on the right, and a ruled band per window so the two layouts
 * are recognisably the same table. Without it this is the settings instance
 * card, which keeps its own denser look.
 */
export function ProviderUsageRows(props: {
  readonly usageLimits: ServerProviderUsageLimits;
  readonly timestampFormat: TimestampFormat;
  readonly compact?: boolean;
}) {
  const compact = props.compact ?? false;
  return (
    <div className={cn("grid", compact ? undefined : "gap-3")}>
      {props.usageLimits.windows.map((window) => {
        const usedPercent = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
        const resetLabel = window.resetsAt
          ? formatResetTimestamp(window.resetsAt, props.timestampFormat)
          : "";
        return (
          <div
            key={`${window.label}:${window.windowDurationMins ?? "unknown"}:${window.resetsAt ?? "unknown"}`}
            className={cn(
              "grid gap-1.5",
              compact && "border-b border-border/50 py-2.5 first:pt-0 last:border-0 last:pb-0",
            )}
          >
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span
                className={cn(
                  "min-w-0 truncate",
                  compact ? "text-muted-foreground" : "font-medium text-foreground",
                )}
              >
                {window.label}
              </span>
              <span className="shrink-0 tabular-nums">
                <span
                  className={cn(
                    compact
                      ? cn("text-sm font-medium", usageValueClassName(usedPercent))
                      : usageEmphasisClassName(usedPercent),
                  )}
                >
                  {usedPercent}%
                </span>
                <span className={cn(compact && "text-muted-foreground")}> used</span>
              </span>
            </div>
            <div
              className={cn(
                "w-full overflow-hidden rounded-full",
                compact ? "h-1 bg-muted" : "h-1.5 bg-muted/60",
              )}
              role="progressbar"
              aria-label={`${window.label} usage`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={usedPercent}
              aria-valuetext={`${usedPercent}% used`}
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none",
                  usageBarClassName(usedPercent),
                )}
                style={{ width: `${usedPercent}%` }}
              />
            </div>
            {resetLabel ? (
              <div
                className={cn(
                  "text-[11px]",
                  compact ? "text-muted-foreground" : "text-muted-foreground/70",
                )}
              >
                Resets at {resetLabel}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function ProviderUsageSummary(props: { readonly usageLimits: ServerProviderUsageLimits }) {
  const summaryItems = props.usageLimits.windows.map((window) => ({
    key: `${window.label}:${window.windowDurationMins ?? "unknown"}:${window.resetsAt ?? "unknown"}`,
    label: window.label,
    usedPercent: Math.max(0, Math.min(100, Math.round(window.usedPercent))),
  }));
  // A span, not a paragraph: the provider list renders this inside the row's
  // select button, and a <p> there is invalid DOM nesting. It truncates because
  // an account with three usage windows is wider than the list column, and
  // without clipping the text runs under the enable switch beside it.
  return (
    <span className="block min-w-0 truncate text-[11px] text-muted-foreground/80">
      {summaryItems.map((item, index) => (
        <span key={item.key} className="whitespace-nowrap">
          {index > 0 ? <span className="mx-1.5 text-muted-foreground/40">·</span> : null}
          <span>{item.label}</span>{" "}
          <span className="tabular-nums text-muted-foreground">{item.usedPercent}%</span>
        </span>
      ))}
      <span className="text-muted-foreground/60"> used</span>
    </span>
  );
}
