import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionOptionValue } from "@t3tools/shared/model";

import type {
  PrimeAgentDaemonServiceTier,
  PrimeAgentDaemonThinkingLevel,
} from "./PrimeAgentDaemonBridge.ts";

export const PRIME_AGENT_INHERIT_MODEL_OPTION = "prime-default" as const;
export const PRIME_AGENT_THINKING_LEVEL_OPTION_ID = "thinkingLevel" as const;
export const PRIME_AGENT_SERVICE_TIER_OPTION_ID = "serviceTier" as const;

const THINKING_LEVELS: ReadonlyArray<PrimeAgentDaemonThinkingLevel> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const SERVICE_TIERS = ["default", "priority"] as const satisfies ReadonlyArray<
  Exclude<PrimeAgentDaemonServiceTier, null>
>;

type PrimeAgentInheritedThinkingLevel =
  | PrimeAgentDaemonThinkingLevel
  | typeof PRIME_AGENT_INHERIT_MODEL_OPTION;
type PrimeAgentInheritedServiceTier =
  | (typeof SERVICE_TIERS)[number]
  | typeof PRIME_AGENT_INHERIT_MODEL_OPTION;

export interface PrimeAgentModelControlMetadata {
  readonly provider: string;
  readonly id: string;
  readonly api?: string | undefined;
  readonly reasoning?: boolean | undefined;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>> | undefined;
}

export type PrimeAgentTurnControlsResult =
  | {
      readonly _tag: "Valid";
      readonly thinkingLevel?: PrimeAgentInheritedThinkingLevel | undefined;
      readonly serviceTier?: PrimeAgentInheritedServiceTier | undefined;
    }
  | { readonly _tag: "Invalid"; readonly issue: string };

function thinkingLevelLabel(level: PrimeAgentDaemonThinkingLevel): string {
  switch (level) {
    case "off":
      return "Off";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Maximum";
  }
}

export function supportedPrimeAgentThinkingLevels(
  metadata: PrimeAgentModelControlMetadata,
): ReadonlyArray<PrimeAgentDaemonThinkingLevel> {
  if (metadata.reasoning !== true) return [];
  return THINKING_LEVELS.filter((level) => {
    const mapped = metadata.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

export function primeAgentModelSupportsFastMode(metadata: PrimeAgentModelControlMetadata): boolean {
  return (
    metadata.provider === "openai-codex" &&
    metadata.api === "openai-codex-responses" &&
    (metadata.id === "gpt-5.4" ||
      metadata.id === "gpt-5.5" ||
      metadata.id === "gpt-5.6" ||
      metadata.id.startsWith("gpt-5.6-"))
  );
}

export function makePrimeAgentModelCapabilities(
  metadata: PrimeAgentModelControlMetadata,
): ModelCapabilities {
  const descriptors: ProviderOptionDescriptor[] = [];
  const thinkingLevels = supportedPrimeAgentThinkingLevels(metadata);
  if (thinkingLevels.length > 0) {
    descriptors.push({
      id: PRIME_AGENT_THINKING_LEVEL_OPTION_ID,
      label: "Thinking",
      type: "select",
      options: [
        {
          id: PRIME_AGENT_INHERIT_MODEL_OPTION,
          label: "Prime default",
          isDefault: true,
          description: "Use the thinking level from this Prime Agent session.",
        },
        ...thinkingLevels.map((level) => ({ id: level, label: thinkingLevelLabel(level) })),
      ],
      currentValue: PRIME_AGENT_INHERIT_MODEL_OPTION,
    });
  }
  if (primeAgentModelSupportsFastMode(metadata)) {
    descriptors.push({
      id: PRIME_AGENT_SERVICE_TIER_OPTION_ID,
      label: "Service Tier",
      type: "select",
      options: [
        {
          id: PRIME_AGENT_INHERIT_MODEL_OPTION,
          label: "Prime default",
          isDefault: true,
          description: "Use the service tier from this Prime Agent session.",
        },
        { id: "default", label: "Standard" },
        { id: "priority", label: "Fast" },
      ],
      currentValue: PRIME_AGENT_INHERIT_MODEL_OPTION,
    });
  }
  return createModelCapabilities({ optionDescriptors: descriptors });
}

function invalidOption(id: string): PrimeAgentTurnControlsResult {
  return { _tag: "Invalid", issue: `Prime Agent model option '${id}' is invalid.` };
}

export function resolvePrimeAgentTurnControls(
  modelSelection: ModelSelection | null | undefined,
): PrimeAgentTurnControlsResult {
  const options = modelSelection?.options ?? [];
  for (const id of [
    PRIME_AGENT_THINKING_LEVEL_OPTION_ID,
    PRIME_AGENT_SERVICE_TIER_OPTION_ID,
  ] as const) {
    if (options.filter((option) => option.id === id).length > 1) return invalidOption(id);
  }

  const rawThinkingLevel = getModelSelectionOptionValue(
    modelSelection,
    PRIME_AGENT_THINKING_LEVEL_OPTION_ID,
  );
  const rawServiceTier = getModelSelectionOptionValue(
    modelSelection,
    PRIME_AGENT_SERVICE_TIER_OPTION_ID,
  );
  if (
    rawThinkingLevel !== undefined &&
    (typeof rawThinkingLevel !== "string" ||
      (rawThinkingLevel !== PRIME_AGENT_INHERIT_MODEL_OPTION &&
        !THINKING_LEVELS.includes(rawThinkingLevel as PrimeAgentDaemonThinkingLevel)))
  ) {
    return invalidOption(PRIME_AGENT_THINKING_LEVEL_OPTION_ID);
  }
  if (
    rawServiceTier !== undefined &&
    (typeof rawServiceTier !== "string" ||
      (rawServiceTier !== PRIME_AGENT_INHERIT_MODEL_OPTION &&
        !SERVICE_TIERS.includes(rawServiceTier as (typeof SERVICE_TIERS)[number])))
  ) {
    return invalidOption(PRIME_AGENT_SERVICE_TIER_OPTION_ID);
  }

  return {
    _tag: "Valid",
    ...(rawThinkingLevel === undefined
      ? {}
      : { thinkingLevel: rawThinkingLevel as PrimeAgentInheritedThinkingLevel }),
    ...(rawServiceTier === undefined
      ? {}
      : { serviceTier: rawServiceTier as PrimeAgentInheritedServiceTier }),
  };
}
