import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { DotMatrix, type DotMatrixState } from "~/components/ui/dot-matrix";

/**
 * Connection phase as a DotMatrix state. The dot carries hue and motion
 * together, so callers pass a phase rather than assembling colors themselves.
 */
export function connectionPhaseDotMatrixState(
  phase: EnvironmentConnectionPhase,
): ConnectionStatusDotProps["state"] {
  switch (phase) {
    case "connected":
      return "success";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "error":
      return "error";
    default:
      return "offline";
  }
}

type ConnectionStatusDotProps = {
  tooltipText?: string | null;
  state: Extract<
    DotMatrixState,
    "success" | "connecting" | "waiting" | "queued" | "error" | "offline"
  >;
  /** Only needed when a caller wants a hue other than the state's canonical
   * tone (see dot-matrix.tsx's TONE map). */
  colorClassName?: string | undefined;
};

export function ConnectionStatusDot({
  tooltipText,
  state,
  colorClassName,
}: ConnectionStatusDotProps) {
  const dotContent = (
    <DotMatrix aria-hidden state={state} className={cn("size-3", colorClassName)} />
  );

  if (!tooltipText) {
    return (
      <span className="relative flex size-3.5 shrink-0 items-center justify-center">
        {dotContent}
      </span>
    );
  }

  const dot = (
    <button
      type="button"
      aria-label={tooltipText}
      className="relative flex size-3.5 shrink-0 cursor-help items-center justify-center rounded-full outline-hidden"
    >
      {dotContent}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={dot} />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}
