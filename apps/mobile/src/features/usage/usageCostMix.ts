/**
 * Shapes merged cost into the part-to-whole segments the Usage cost section
 * draws: by token type, and by request speed.
 *
 * @module usageCostMix
 */
import type { CategoryCost, SpeedCost } from "@t3tools/shared/usageMerge";

export interface CostMixSegment {
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

export interface CostMixColors {
  readonly input: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
  readonly output: string;
  readonly other: string;
  readonly standard: string;
  readonly fast: string;
  readonly ultrafast: string;
}

export function costTypeSegments(
  cost: CategoryCost,
  colors: CostMixColors,
): readonly CostMixSegment[] {
  return [
    { label: "Input", value: cost.input, color: colors.input },
    { label: "Cache read", value: cost.cacheRead, color: colors.cacheRead },
    { label: "Cache write", value: cost.cacheWrite, color: colors.cacheWrite },
    { label: "Output", value: cost.output, color: colors.output },
    // Reported cost with no rates to split it, or from older servers. Below a
    // cent it is rounding, not usage.
    { label: "Other", value: cost.unsplit >= 0.005 ? cost.unsplit : 0, color: colors.other },
  ];
}

export function speedCostSegments(
  cost: SpeedCost,
  colors: CostMixColors,
): readonly CostMixSegment[] {
  return [
    { label: "Standard", value: cost.standard, color: colors.standard },
    { label: "Fast", value: cost.fast, color: colors.fast },
    { label: "Ultrafast", value: cost.ultrafast, color: colors.ultrafast },
  ];
}

/** Servers from before the speed split count all of their cost as standard. */
export const SPEED_COST_FOOTNOTE =
  "Servers that predate speed tracking count all cost as Standard.";

/** The speed bar only appears once some cost ran faster than standard. */
export function hasFasterSpeedCost(cost: SpeedCost): boolean {
  return cost.fast + cost.ultrafast > 0;
}

/** Empty segments are left out of a bar and its legend. */
export function visibleCostSegments(
  segments: readonly CostMixSegment[],
): readonly CostMixSegment[] {
  return segments.filter((segment) => segment.value > 0);
}
