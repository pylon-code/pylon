import type { SessionCompactionUpdatedPayload } from "@t3tools/contracts";
import { useId } from "react";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export type ContextCompactionControlProps = {
  readonly snapshot: SessionCompactionUpdatedPayload;
  readonly pendingAction: "compact" | "abort" | "auto" | null;
  readonly canCompact: boolean;
  readonly canAbort: boolean;
  readonly canSetAuto: boolean;
  readonly onCompact: () => void;
  readonly onAbort: () => void;
  readonly onSetAuto: (enabled: boolean) => void;
};

export type HarnessRefinementControlProps = {
  readonly pending: boolean;
  readonly outcomeUnknown: boolean;
  readonly canRefine: boolean;
  readonly onRefine: () => void;
};

export function HarnessRefinementControls(props: {
  readonly control: HarnessRefinementControlProps;
}) {
  const { control } = props;
  const descriptionId = useId();
  return (
    <div className="mt-1 grid gap-2 border-border/70 border-t pt-2">
      <div className="grid gap-1 text-xs">
        <span className="font-medium text-muted-foreground">Local session harness</span>
        <p id={descriptionId} className="text-pretty text-secondary-label text-[11px] leading-4">
          Improves only this thread&apos;s private session harness. This may take time and cannot be
          cancelled or rolled back here.
        </p>
      </div>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={!control.canRefine || control.pending}
        onClick={control.onRefine}
        aria-describedby={descriptionId}
      >
        <span aria-live="polite">
          {control.pending
            ? "Refining…"
            : control.outcomeUnknown
              ? "Outcome unavailable"
              : "Refine local harness"}
        </span>
      </Button>
    </div>
  );
}

export function ContextCompactionControls(props: {
  readonly control: ContextCompactionControlProps;
}) {
  const { control } = props;
  if (!control.snapshot.available) return null;
  const compactionStatus =
    control.snapshot.status === "starting"
      ? "Starting…"
      : control.snapshot.status === "compacting"
        ? "Compacting…"
        : control.snapshot.status === "abort-requested"
          ? "Stopping…"
          : "Ready";
  return (
    <div className="mt-1 grid gap-2 border-border/70 border-t pt-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-muted-foreground">Context compaction</span>
        <span className="text-secondary-label" aria-live="polite">
          {compactionStatus}
        </span>
      </div>
      <div className="flex gap-2">
        {control.snapshot.status === "idle" ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="flex-1"
            disabled={!control.canCompact || control.pendingAction !== null}
            onClick={control.onCompact}
          >
            {control.pendingAction === "compact" ? "Starting…" : "Compact now"}
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="destructive-outline"
            className="flex-1"
            disabled={!control.canAbort || control.pendingAction !== null}
            onClick={control.onAbort}
          >
            {control.pendingAction === "abort" ? "Stopping…" : "Stop compaction"}
          </Button>
        )}
      </div>
      {control.snapshot.autoCompactionEnabled !== undefined ? (
        <div className="grid gap-1">
          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">Automatic compaction</span>
            <Switch
              checked={control.snapshot.autoCompactionEnabled}
              disabled={!control.canSetAuto || control.pendingAction !== null}
              onCheckedChange={(checked) => control.onSetAuto(Boolean(checked))}
              aria-label="Automatic context compaction"
            />
          </label>
          <p className="text-pretty text-secondary-label text-[11px] leading-4">
            Changes the current session and this provider's default for future sessions.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  providerDisplayName?: string | null;
  timestampFormat: TimestampFormat;
  compaction?: ContextCompactionControlProps | null;
  harnessRefinement?: HarnessRefinementControlProps | null;
}) {
  const { usage, providerDisplayName } = props;
  const usedPercentage = formatPercentage(usage?.usedPercentage ?? null);
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage?.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={
              usage?.maxTokens !== null && usage !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : usage !== null
                  ? `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
                  : props.compaction && props.harnessRefinement
                    ? "Context window, compaction, and harness controls"
                    : props.harnessRefinement
                      ? "Context window and harness controls"
                      : "Context window and compaction controls"
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="overflow-y-auto p-0"
        className="w-64 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage?.maxTokens !== null && usage !== null && usedPercentage ? (
              <div className="text-secondary-label text-[11px] tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {usage === null
                    ? "Usage unavailable"
                    : formatContextWindowTokens(usage.usedTokens)}
                  /{formatContextWindowTokens(usage.maxTokens)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-[11px] tabular-nums">
                {usage === null ? "Usage unavailable" : formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage?.maxTokens != null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage?.compactsAutomatically && !props.compaction ? (
            <div className="mt-1 text-pretty text-secondary-label text-[11px] font-medium">
              {providerDisplayName ?? "It"} automatically compacts its context when needed.
            </div>
          ) : null}
          {props.compaction ? <ContextCompactionControls control={props.compaction} /> : null}
          {props.harnessRefinement ? (
            <HarnessRefinementControls control={props.harnessRefinement} />
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
