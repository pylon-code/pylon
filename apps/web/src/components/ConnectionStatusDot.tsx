import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { DotMatrix, type DotMatrixState } from "~/components/ui/dot-matrix";

type ConnectionStatusDotProps = {
  tooltipText?: string | null;
  state: Extract<DotMatrixState, "live" | "connecting" | "error" | "idle">;
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
      title={tooltipText}
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
