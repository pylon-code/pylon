import type { ModelCapabilities, ProviderOptionDescriptor } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { JCODE_DEFAULT_REASONING_EFFORT } from "./JcodeSessionRuntime.ts";

/**
 * Re-exported rather than redefined: `JcodeSessionRuntime` skips
 * `set_reasoning_effort` for exactly this sentinel, so a second copy of the
 * literal would silently forward `jcode-default` to the daemon.
 */
export { JCODE_DEFAULT_REASONING_EFFORT };

/** Option id the session runtime reads off the turn's model selection. */
export const JCODE_REASONING_EFFORT_OPTION_ID = "reasoningEffort" as const;

/**
 * Efforts Jcode accepts, ascending. Jcode also accepts `none`, which Pylon does
 * not publish: it is indistinguishable from the inherited default in the UI.
 */
export const JCODE_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type JcodeReasoningEffort = (typeof JCODE_REASONING_EFFORTS)[number];

const REASONING_EFFORT_LABELS: Readonly<Record<JcodeReasoningEffort, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

/**
 * Every Jcode model carries the same thinking control: the daemon accepts the
 * effort per session rather than per model, and the probe reports no per-model
 * reasoning metadata to narrow it with.
 */
export function makeJcodeModelCapabilities(): ModelCapabilities {
  const descriptor: ProviderOptionDescriptor = {
    id: JCODE_REASONING_EFFORT_OPTION_ID,
    label: "Thinking",
    type: "select",
    options: [
      {
        id: JCODE_DEFAULT_REASONING_EFFORT,
        label: "Jcode default",
        isDefault: true,
        description: "Use the reasoning effort from this Jcode session.",
      },
      ...JCODE_REASONING_EFFORTS.map((effort) => ({
        id: effort,
        label: REASONING_EFFORT_LABELS[effort],
      })),
    ],
    currentValue: JCODE_DEFAULT_REASONING_EFFORT,
  };
  return createModelCapabilities({ optionDescriptors: [descriptor] });
}
