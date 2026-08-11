import { ArrowRightLeftIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { formatRelativeTimeUntilLabel } from "../../timestampFormat";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Button } from "../ui/button";
import type { ThreadHandoffOffer } from "./ThreadHandoff.logic";

/**
 * Matches the drain pill's cadence. The reset time is the only thing here that
 * ages, and it is written coarsely enough that a minute is plenty.
 */
const RESET_TICK_MS = 60_000;

/**
 * Tab on the composer's top edge offering to continue a spent thread on
 * another account.
 *
 * Absent unless the thread's account is actually out of capacity and another
 * one can take the work, so it costs nothing at rest. It never acts on its
 * own: waiting for the window to reset is free, and the panel exists to make
 * that comparison — what crosses over, and what it costs — before anything is
 * spent.
 */
export const ThreadHandoffTab = memo(function ThreadHandoffTab({
  offer,
  onContinue,
  isBusy = false,
}: {
  readonly offer: ThreadHandoffOffer | null;
  readonly onContinue: () => void;
  readonly isBusy?: boolean;
}) {
  // Only ticks while the tab is showing, and only to re-label the reset.
  const [, setTick] = useState(0);
  const isShowing = offer !== null;
  useEffect(() => {
    if (!isShowing) return;
    const intervalId = window.setInterval(() => setTick((value) => value + 1), RESET_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, [isShowing]);

  if (!offer) return null;

  const resetLabel = offer.resetsAt ? formatRelativeTimeUntilLabel(offer.resetsAt) : null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${offer.spentAccountName} is out of capacity — continue on ${offer.targetAccountName}`}
            className={cn(
              // The composer frame is rounded-[22px], so the inset has to clear
              // that radius: anything smaller lands the tab on the curve, where
              // its square bottom edge cannot sit flush and it reads as floating
              // beside the composer rather than attached to it.
              "absolute -top-3 right-6 z-10 inline-flex h-6 items-center gap-1.5 rounded-t-md rounded-b-none",
              "border border-b-0 border-warning/30 bg-warning/12 px-2 text-xs font-medium text-warning",
              "hover:bg-warning/18",
            )}
          >
            <ArrowRightLeftIcon className="size-3 shrink-0" />
            <span>Out of capacity</span>
          </button>
        }
      />
      <PopoverPopup align="end" side="top" className="w-80 p-3 text-sm">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 font-medium">
              {offer.spentAccentColor ? (
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: offer.spentAccentColor }}
                />
              ) : null}
              {offer.spentAccountName} is out of capacity
            </span>
            <span className="text-muted-foreground">
              {resetLabel ? `Resets ${resetLabel}. ` : ""}
              This thread cannot continue on it — a session cannot move between accounts.
            </span>
          </div>

          <div className="flex flex-col gap-1 rounded-md bg-muted/50 p-2">
            <span className="flex items-center gap-1.5 font-medium">
              {offer.targetAccentColor ? (
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: offer.targetAccentColor }}
                />
              ) : null}
              Continue on {offer.targetAccountName}
            </span>
            {/*
              The cost is the decision. Carrying is billed fresh because prompt
              caches never cross organizations, so waiting out the reset is a
              real alternative rather than a worse one.
            */}
            <span className="text-muted-foreground">
              Starts a new thread carrying ~{offer.costLabel} tokens, billed fresh — no cache
              carries across accounts.
            </span>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 ps-4 text-muted-foreground">
              {offer.carries.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          <Button size="sm" onClick={onContinue} disabled={isBusy}>
            {isBusy ? "Starting…" : `Continue on ${offer.targetAccountName}`}
          </Button>
          <span className="text-xs text-muted-foreground">
            This thread stays open and will be linked from the new one.
          </span>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
