import { describe, expect, it } from "vite-plus/test";

import {
  estimateThreadHandoff,
  formatHandoffTokenCost,
  VERBATIM_REPLAY_CONTEXT_BUDGET,
} from "./threadHandoff.ts";

describe("estimateThreadHandoff", () => {
  // The common case. A thread that fits loses nothing, which is the whole
  // reason to check before reaching for summarization.
  it("carries a small thread verbatim", () => {
    const estimate = estimateThreadHandoff({ usedTokens: 31_000, maxTokens: 1_000_000 });

    expect(estimate.fidelity).toBe("verbatim");
    expect(estimate.carriedTokens).toBe(31_000);
    expect(estimate.isEmpty).toBe(false);
  });

  it("condenses only once the transcript would crowd the target context", () => {
    const estimate = estimateThreadHandoff({ usedTokens: 700_000, maxTokens: 1_000_000 });

    expect(estimate.fidelity).toBe("condensed");
    expect(estimate.contextShare).toBeCloseTo(0.7);
  });

  // A continuation that starts nearly full has no room to do the work it was
  // handed off to finish, so the budget sits well under the limit.
  it("leaves room to work rather than filling the context", () => {
    const justUnder = estimateThreadHandoff({
      usedTokens: VERBATIM_REPLAY_CONTEXT_BUDGET * 1_000_000 - 1,
      maxTokens: 1_000_000,
    });
    const justOver = estimateThreadHandoff({
      usedTokens: VERBATIM_REPLAY_CONTEXT_BUDGET * 1_000_000 + 1,
      maxTokens: 1_000_000,
    });

    expect(justUnder.fidelity).toBe("verbatim");
    expect(justOver.fidelity).toBe("condensed");
    expect(VERBATIM_REPLAY_CONTEXT_BUDGET).toBeLessThan(1);
  });

  // Condensing on a guessed limit would drop turns for a ceiling that may not
  // exist; carrying everything is the recoverable mistake.
  it("carries verbatim when the target context size is unknown", () => {
    const estimate = estimateThreadHandoff({ usedTokens: 900_000 });

    expect(estimate.fidelity).toBe("verbatim");
    expect(estimate.contextShare).toBe(0);
  });

  // Presenting a handoff that would silently transfer nothing is worse than
  // offering to start fresh.
  it.each([
    ["no usage reported", {}],
    ["zero tokens", { usedTokens: 0, maxTokens: 1_000_000 }],
    ["a nonsense count", { usedTokens: Number.NaN, maxTokens: 1_000_000 }],
    ["a negative count", { usedTokens: -5, maxTokens: 1_000_000 }],
  ])("reports nothing to carry for %s", (_label, usage) => {
    const estimate = estimateThreadHandoff(usage);

    expect(estimate.isEmpty).toBe(true);
    expect(estimate.carriedTokens).toBe(0);
  });

  it("ignores a nonsense context size rather than dividing by it", () => {
    const estimate = estimateThreadHandoff({ usedTokens: 10_000, maxTokens: 0 });

    expect(estimate.contextShare).toBe(0);
    expect(estimate.fidelity).toBe("verbatim");
  });
});

describe("formatHandoffTokenCost", () => {
  it.each([
    [0, "0"],
    [-10, "0"],
    [340, "300"],
    [1_500, "1.5k"],
    [31_000, "31k"],
    [700_000, "700k"],
    [1_400_000, "1.4m"],
  ])("formats %s as %s", (tokens, expected) => {
    expect(formatHandoffTokenCost(tokens)).toBe(expected);
  });

  // This number decides whether someone spends context or waits for a reset.
  // Exact-looking digits would read as a quote rather than a running total.
  it("stays coarse rather than implying precision", () => {
    expect(formatHandoffTokenCost(31_427)).toBe("31k");
  });
});
