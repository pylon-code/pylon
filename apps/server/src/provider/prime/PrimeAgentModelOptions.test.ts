// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  makePrimeAgentModelCapabilities,
  PRIME_AGENT_INHERIT_MODEL_OPTION,
  resolvePrimeAgentTurnControls,
  supportedPrimeAgentThinkingLevels,
} from "./PrimeAgentModelOptions.ts";

const instanceId = ProviderInstanceId.make("primeAgent");

describe("PrimeAgentModelOptions", () => {
  it("derives exact thinking levels and fast mode from safe model metadata", () => {
    const capabilities = makePrimeAgentModelCapabilities({
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      api: "openai-codex-responses",
      reasoning: true,
      thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "thinkingLevel",
        label: "Thinking",
        type: "select",
        options: [
          {
            id: PRIME_AGENT_INHERIT_MODEL_OPTION,
            label: "Prime default",
            isDefault: true,
            description: "Use the thinking level from this Prime Agent session.",
          },
          { id: "off", label: "Off" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra high" },
          { id: "max", label: "Maximum" },
        ],
        currentValue: PRIME_AGENT_INHERIT_MODEL_OPTION,
      },
      {
        id: "serviceTier",
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
      },
    ]);
  });

  it("omits controls the discovered model cannot honor", () => {
    expect(
      makePrimeAgentModelCapabilities({
        provider: "prime-inference",
        id: "non-reasoning",
        api: "openai-completions",
        reasoning: false,
      }).optionDescriptors,
    ).toEqual([]);
    expect(
      supportedPrimeAgentThinkingLevels({
        provider: "anthropic",
        id: "max-only",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: null,
          max: "max",
        },
      }),
    ).toEqual(["max"]);
  });

  it("normalizes advertised selections and rejects malformed known options", () => {
    expect(
      resolvePrimeAgentTurnControls({
        instanceId,
        model: "openai-codex/gpt-5.6-sol",
        options: [
          { id: "thinkingLevel", value: "xhigh" },
          { id: "serviceTier", value: "priority" },
          { id: "futureOption", value: true },
        ],
      }),
    ).toEqual({ _tag: "Valid", thinkingLevel: "xhigh", serviceTier: "priority" });
    expect(
      resolvePrimeAgentTurnControls({
        instanceId,
        model: "openai-codex/gpt-5.6-sol",
        options: [{ id: "thinkingLevel", value: true }],
      }),
    ).toEqual({
      _tag: "Invalid",
      issue: "Prime Agent model option 'thinkingLevel' is invalid.",
    });
    expect(
      resolvePrimeAgentTurnControls({
        instanceId,
        model: "openai-codex/gpt-5.6-sol",
        options: [
          { id: "serviceTier", value: "default" },
          { id: "serviceTier", value: "priority" },
        ],
      }),
    ).toEqual({
      _tag: "Invalid",
      issue: "Prime Agent model option 'serviceTier' is invalid.",
    });
  });
});
