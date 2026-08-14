import type { SessionInputQueueSnapshot } from "@t3tools/client-runtime/state/session-input-queue";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { cn } from "~/lib/utils";
import { ComposerControl } from "./ComposerControl";

type QueueWithModes = SessionInputQueueSnapshot & {
  readonly steeringMode: "all-at-once" | "one-at-a-time";
  readonly followUpMode: "all-at-once" | "one-at-a-time";
};

function modeLabel(mode: QueueWithModes["steeringMode"]): string {
  return mode === "all-at-once" ? "All at once" : "One at a time";
}

function DeliveryModeButtons(props: {
  readonly label: string;
  readonly value: QueueWithModes["steeringMode"];
  readonly disabled: boolean;
  readonly onChange: (value: QueueWithModes["steeringMode"]) => void;
}) {
  return (
    <div
      role="group"
      aria-label={props.label}
      className="grid grid-cols-2 rounded-md border border-border/70 bg-muted/30 p-0.5"
    >
      {(["one-at-a-time", "all-at-once"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={props.value === mode}
          disabled={props.disabled}
          className={cn(
            "min-h-7 rounded px-2 text-[11px] font-medium transition-colors",
            props.value === mode
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
            "disabled:pointer-events-none disabled:opacity-64",
          )}
          onClick={() => props.onChange(mode)}
        >
          {modeLabel(mode)}
        </button>
      ))}
    </div>
  );
}

export function SessionInputQueueDeliveryPanel(props: {
  readonly snapshot: QueueWithModes;
  readonly count: number;
  readonly canSetModes: boolean;
  readonly isSettingMode: boolean;
  readonly canClear: boolean;
  readonly isClearing: boolean;
  readonly canRemove: boolean;
  readonly isRemoving: boolean;
  readonly onSetMode: (queue: "steering" | "follow-up", value: string | null) => void;
  readonly onRemove: (queue: "steering" | "follow-up") => void;
  readonly onClear: () => void;
}) {
  return (
    <div className="grid gap-3 p-3" data-session-input-queue-delivery="true">
      <div className="grid gap-1">
        <div className="text-xs font-semibold text-foreground">Session input delivery</div>
        <div className="text-[11px] leading-4 text-muted-foreground">
          Choose whether queued inputs are delivered together or across separate agent steps.
        </div>
      </div>
      <div className="grid gap-1 text-[11px] font-medium text-muted-foreground">
        Steering inputs
        <DeliveryModeButtons
          label="Steering input delivery"
          value={props.snapshot.steeringMode}
          disabled={!props.canSetModes}
          onChange={(value) => props.onSetMode("steering", value)}
        />
      </div>
      <div className="grid gap-1 text-[11px] font-medium text-muted-foreground">
        Follow-up inputs
        <DeliveryModeButtons
          label="Follow-up input delivery"
          value={props.snapshot.followUpMode}
          disabled={!props.canSetModes}
          onChange={(value) => props.onSetMode("follow-up", value)}
        />
      </div>
      {props.isSettingMode ? (
        <div aria-live="polite" className="text-[11px] text-muted-foreground">
          Updating delivery…
        </div>
      ) : null}
      {props.snapshot.steeringCount === 1 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!props.canRemove || props.isRemoving}
          onClick={() => props.onRemove("steering")}
        >
          {props.isRemoving ? "Removing pending input…" : "Remove pending steering input"}
        </Button>
      ) : null}
      {props.snapshot.followUpCount === 1 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!props.canRemove || props.isRemoving}
          onClick={() => props.onRemove("follow-up")}
        >
          {props.isRemoving ? "Removing pending input…" : "Remove pending follow-up input"}
        </Button>
      ) : null}
      {props.count > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!props.canClear || props.isClearing}
          onClick={props.onClear}
        >
          {props.isClearing
            ? "Clearing pending inputs…"
            : `Clear ${props.count} pending input${props.count === 1 ? "" : "s"}`}
        </Button>
      ) : null}
    </div>
  );
}

export function SessionInputQueueControl(props: {
  readonly snapshot: QueueWithModes;
  readonly count: number;
  readonly canSetModes: boolean;
  readonly isSettingMode: boolean;
  readonly canClear: boolean;
  readonly isClearing: boolean;
  readonly canRemove: boolean;
  readonly isRemoving: boolean;
  readonly onSetMode: (queue: "steering" | "follow-up", value: string | null) => void;
  readonly onRemove: (queue: "steering" | "follow-up") => void;
  readonly onClear: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <ComposerControl
            type="button"
            aria-label={`Session input delivery. ${props.count} pending. Steering ${modeLabel(props.snapshot.steeringMode).toLowerCase()}. Follow-ups ${modeLabel(props.snapshot.followUpMode).toLowerCase()}.`}
          />
        }
      >
        <span className="text-xs font-medium">
          Inputs{props.count > 0 ? ` · ${props.count}` : ""}
        </span>
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        className="w-72"
        viewportClassName="p-0"
        aria-label="Session input delivery"
      >
        <SessionInputQueueDeliveryPanel {...props} />
      </PopoverPopup>
    </Popover>
  );
}
