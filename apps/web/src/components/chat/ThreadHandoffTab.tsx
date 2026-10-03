import { ArrowRightLeftIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { formatRelativeTimeUntilLabel } from "../../timestampFormat";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Button } from "../ui/button";
import type { ThreadHandoffOffer } from "./ThreadHandoff.logic";

const RESET_TICK_MS = 60_000;

/** Capacity relief prepares a native handoff; sending stays the user's decision. */
export const ThreadHandoffTab = memo(function ThreadHandoffTab({
  offer,
  onContinue,
}: {
  readonly offer: ThreadHandoffOffer | null;
  readonly onContinue: () => void;
}) {
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
            aria-label={`${offer.spentAccountName} is out of capacity — use ${offer.targetAccountName} for the next message`}
            className={cn(
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
      <PopoverPopup align="end" side="top" width="md" className="p-3 text-sm">
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
              Wait for the reset or choose another account for your next message.
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
            <span className="text-muted-foreground">
              A fresh session receives selected conversation context, which may be billed again.
              Your current context is ~{offer.costLabel} tokens; the amount carried may differ.
            </span>
            <span className="text-muted-foreground">
              Work stays in this thread with its full transcript. Some older details may be left out
              of the handoff and recovered from the thread when needed.
            </span>
          </div>

          <Button type="button" size="sm" onClick={onContinue}>
            Use {offer.targetAccountName} for the next message
          </Button>
          <span className="text-xs text-muted-foreground">
            This only selects the account. Nothing is sent until you send the next message.
          </span>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
