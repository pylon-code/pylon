/**
 * Model rate lookup and cost arithmetic.
 *
 * Rates come from LiteLLM's `model_prices_and_context_window.json`, the same
 * table `ccusage` prices against. Everything here is pure: fetching and caching
 * the table lives in `UsageService`.
 *
 * @module usagePricing
 */
import type { UsageCostSource, UsageTokenTotals } from "@t3tools/contracts";

/**
 * The subset of a LiteLLM entry we price against. All values are USD per token.
 *
 * LiteLLM also publishes tiered variants (`*_above_272k_tokens`, `*_flex`,
 * `*_priority`, `*_batches`). We deliberately price at the base tier: the
 * transcripts don't record which tier served a request, so anything else would
 * be a guess dressed up as precision.
 */
export interface ModelRate {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadCostPerToken: number;
  readonly cacheCreationCostPerToken: number;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

/** Raw shape of one LiteLLM entry, narrowed to the fields we read. */
interface LiteLlmEntry {
  readonly input_cost_per_token?: unknown;
  readonly output_cost_per_token?: unknown;
  readonly cache_read_input_token_cost?: unknown;
  readonly cache_creation_input_token_cost?: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Projects the LiteLLM document into a rate table.
 *
 * Entries without both an input and an output rate are dropped: a half-priced
 * model would silently under-report cost, which is worse than reporting the
 * model as unpriced.
 *
 * Entries keep their full normalized key; a bare name is aliased only when no
 * canonical entry exists and every qualified entry has the same rate.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as LiteLlmEntry;
    const input = finiteNumber(entry.input_cost_per_token);
    const output = finiteNumber(entry.output_cost_per_token);
    if (input === null || output === null) continue;

    const key = normalizeRateKey(name);
    if (key.length === 0) continue;
    table.set(key, {
      inputCostPerToken: input,
      outputCostPerToken: output,
      // Anthropic bills cache reads at a discount and cache writes at a
      // premium. When a model omits them, cached input is priced as plain
      // input rather than as free.
      cacheReadCostPerToken: finiteNumber(entry.cache_read_input_token_cost) ?? input,
      cacheCreationCostPerToken: finiteNumber(entry.cache_creation_input_token_cost) ?? input,
    });
  }

  // A bare name always resolves to something. Requiring unanimity among
  // qualified entries would strip pricing from every model LiteLLM publishes
  // only under provider prefixes — all the Grok models among them, whose
  // xai/, azure_ai/ and replicate/ rates disagree.
  //
  // The rule is precedence, not agreement: a canonical unqualified entry wins,
  // and otherwise the shallowest qualified key does, which is the first-party
  // publisher rather than a reseller (`xai/grok-4` over `replicate/xai/grok-4`).
  // That is what keeps a resale entry with no cache discount from overwriting
  // the canonical Anthropic rate, which is the bug this all started from.
  const aliasCandidates = new Map<string, { readonly depth: number; readonly rate: ModelRate }>();
  for (const [key, rate] of table) {
    const alias = bareModelName(key);
    if (alias.length === 0 || alias === key || table.has(alias)) continue;
    const depth = key.split("/").length;
    const held = aliasCandidates.get(alias);
    if (held === undefined || depth < held.depth) {
      aliasCandidates.set(alias, { depth, rate });
    }
  }
  for (const [alias, candidate] of aliasCandidates) {
    table.set(alias, candidate.rate);
  }

  return table;
}

function normalizeRateKey(model: string): string {
  return model.trim().toLowerCase();
}

/**
 * The bare model name a lookup falls back to: a `provider/` prefix stripped and
 * lowercased, since transcripts are inconsistent about both.
 */
export function normalizeModelName(model: string): string {
  return bareModelName(normalizeRateKey(model));
}

function bareModelName(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

/**
 * Models we never price, regardless of the table.
 *
 * `<synthetic>` marks locally generated messages that were never billed. Bare
 * family names ("opus", "sonnet") are genuinely ambiguous across generations,
 * so we report them as unpriced instead of guessing a generation.
 */
const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

/**
 * How many distinct models the table can price, which is the count of bare
 * names. The map also holds every provider-qualified restatement, so its raw
 * size roughly doubles the figure a user would recognise.
 */
export function countKnownModels(table: RateTable): number {
  let count = 0;
  for (const key of table.keys()) {
    if (!key.includes("/")) count += 1;
  }
  return count;
}

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const key = normalizeRateKey(model);
  const bareName = normalizeModelName(model);
  if (bareName.length === 0 || UNPRICEABLE_MODELS.has(bareName)) return null;
  // Exact first, so a reseller's own key keeps its own rate. Then the bare name,
  // because transcripts record gateway-proxied ids LiteLLM has no key for —
  // `anthropic/claude-sonnet-4-5`, `x-ai/grok-code-fast-1` — and those should
  // price as the model they are rather than reporting unpriced.
  return table.get(key) ?? table.get(bareName) ?? null;
}

export interface PricedUsage {
  readonly costUsd: number;
  readonly costSource: UsageCostSource;
}

/**
 * Prices a bucket's tokens.
 *
 * `reasoningTokens` is intentionally not charged separately: it is already
 * counted inside `outputTokens`.
 */
export function priceUsage(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
  reportedCostUsd: number | null,
): PricedUsage {
  if (reportedCostUsd !== null && Number.isFinite(reportedCostUsd)) {
    return { costUsd: reportedCostUsd, costSource: "providerReported" };
  }

  const rate = lookupRate(table, model);
  if (rate === null) return { costUsd: 0, costSource: "unpriced" };

  const costUsd =
    totals.uncachedInputTokens * rate.inputCostPerToken +
    totals.cachedInputTokens * rate.cacheReadCostPerToken +
    totals.cacheCreationTokens * rate.cacheCreationCostPerToken +
    totals.outputTokens * rate.outputCostPerToken;

  return { costUsd, costSource: "modelPriced" };
}

/**
 * What the cached input would have cost at full input rates, minus what it
 * actually cost. Drives the "cache savings" figure.
 */
export function cacheSavingsUsd(table: RateTable, model: string, totals: UsageTokenTotals): number {
  const rate = lookupRate(table, model);
  if (rate === null) return 0;
  return totals.cachedInputTokens * (rate.inputCostPerToken - rate.cacheReadCostPerToken);
}
