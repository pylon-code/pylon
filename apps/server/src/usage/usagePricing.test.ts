import { describe, expect, it } from "@effect/vitest";

import { lookupRate, normalizeModelName, parseRateTable } from "./usagePricing.ts";

const rate = (input: number, cacheRead?: number) => ({
  input_cost_per_token: input,
  output_cost_per_token: input * 5,
  ...(cacheRead === undefined ? {} : { cache_read_input_token_cost: cacheRead }),
});

describe("usage pricing", () => {
  it("keeps the existing model-name normalization contract", () => {
    expect(normalizeModelName(" Anthropic/Claude-Opus-5 ")).toBe("claude-opus-5");
  });

  it("keeps the canonical Fable rate separate from DeepInfra in either order", () => {
    const canonical = ["claude-fable-5", rate(1e-5, 1e-6)] as const;
    const deepInfra = ["deepinfra/anthropic/claude-fable-5", rate(1e-5)] as const;

    for (const entries of [
      [canonical, deepInfra],
      [deepInfra, canonical],
    ]) {
      const table = parseRateTable(Object.fromEntries(entries));

      expect(lookupRate(table, "claude-fable-5")?.cacheReadCostPerToken).toBe(1e-6);
      expect(lookupRate(table, "deepinfra/anthropic/claude-fable-5")?.cacheReadCostPerToken).toBe(
        1e-5,
      );
      // An unknown provider prefix prices as the model it names. Transcripts
      // record gateway-proxied ids LiteLLM has no key for, and the canonical
      // rate is a far better answer for those than reporting $0 spent.
      expect(lookupRate(table, "other/claude-fable-5")?.cacheReadCostPerToken).toBe(1e-6);
    }
  });

  it("adds a bare alias when every qualified entry has the same rate", () => {
    const table = parseRateTable({
      "provider-a/example-model": rate(1),
      "provider-b/example-model": rate(1),
    });

    expect(lookupRate(table, "example-model")).toEqual(
      lookupRate(table, "provider-a/example-model"),
    );
  });

  it("resolves a disagreeing bare name to the shallowest publisher", () => {
    const table = parseRateTable({
      "provider-a/example-model": rate(1),
      "provider-b/example-model": rate(3),
      "reseller/provider-a/example-model": rate(9),
    });

    expect(lookupRate(table, "provider-a/example-model")?.inputCostPerToken).toBe(1);
    expect(lookupRate(table, "provider-b/example-model")?.inputCostPerToken).toBe(3);
    // Requiring unanimity here would leave the bare name unpriced, which is what
    // stripped every Grok model of pricing: LiteLLM publishes them only under
    // disagreeing xai/, azure_ai/ and replicate/ keys.
    expect(lookupRate(table, "example-model")?.inputCostPerToken).toBe(1);
  });

  it("prefers a canonical entry over any qualified one", () => {
    const table = parseRateTable({
      "example-model": rate(2, 2e-7),
      "reseller/example-model": rate(2),
    });

    expect(lookupRate(table, "example-model")?.cacheReadCostPerToken).toBe(2e-7);
    expect(lookupRate(table, "reseller/example-model")?.cacheReadCostPerToken).toBe(2);
  });
});
