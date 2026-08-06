/**
 * Deciding what a cross-account handoff carries, and what it costs.
 *
 * A provider session cannot move between accounts, so continuing work
 * elsewhere means seeding a fresh thread from Pylon's own event log. Two
 * questions decide how faithful that seeding can be, and both are answerable
 * before anything is sent:
 *
 *  - **Does the thread fit?** If the conversation fits inside the target
 *    context, it is replayed verbatim and nothing is lost. Condensing is the
 *    exception for genuinely long threads, not the default — most handoffs
 *    should lose nothing at all.
 *  - **What will it cost?** Every carried token is billed as a fresh read.
 *    Prompt caches never cross organizations, so none of it can be served
 *    from cache no matter how recently the work ran. Waiting for the window
 *    to reset instead costs nothing, which is the trade the user is making.
 *
 * Pure so both decisions are testable without a provider, a thread, or a
 * clock.
 *
 * @module threadHandoff
 */

/**
 * Share of the target context a verbatim replay may occupy before the handoff
 * condenses instead.
 *
 * Well below the limit on purpose: the carried transcript is the *starting*
 * point, and a continuation that begins at 90% of context has no room left to
 * do the work it was handed off to finish.
 */
export const VERBATIM_REPLAY_CONTEXT_BUDGET = 0.5;

export type ThreadHandoffFidelity =
  /** The conversation fits; every turn is carried exactly as it happened. */
  | "verbatim"
  /**
   * Too large to replay whole. Recent turns and the checkpoint diff are still
   * carried exactly; only older turns are condensed, and only for intent —
   * facts stay anchored on the diff, which a summary cannot invent.
   */
  | "condensed";

export interface ThreadHandoffEstimate {
  readonly fidelity: ThreadHandoffFidelity;
  /**
   * Tokens the target account is billed to receive the carried context.
   * Measured from the thread's own reported usage rather than estimated from
   * text, so it reflects what the provider actually counted.
   */
  readonly carriedTokens: number;
  /** Portion of the target context the carried transcript will occupy, 0–1. */
  readonly contextShare: number;
  /**
   * True when nothing can be carried — an empty or unmeasured thread. The
   * caller should offer to start fresh rather than present a handoff that
   * would silently transfer nothing.
   */
  readonly isEmpty: boolean;
}

export interface ThreadHandoffUsage {
  /** Tokens the thread currently occupies, as the provider reported them. */
  readonly usedTokens?: number | undefined;
  /** Target context size. Falls back to the source thread's own limit. */
  readonly maxTokens?: number | undefined;
}

const isPositive = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Decide how a handoff would carry a thread, and what receiving it costs.
 *
 * `usedTokens` is the provider's own count for the conversation, which is why
 * the estimate is trustworthy enough to base a spending decision on. Without
 * it there is nothing to measure and nothing to carry, so the result is empty
 * rather than a guess.
 */
export function estimateThreadHandoff(usage: ThreadHandoffUsage): ThreadHandoffEstimate {
  const carriedTokens = isPositive(usage.usedTokens) ? Math.round(usage.usedTokens) : 0;
  const maxTokens = isPositive(usage.maxTokens) ? usage.maxTokens : undefined;
  const contextShare = maxTokens ? carriedTokens / maxTokens : 0;

  if (carriedTokens === 0) {
    return { fidelity: "verbatim", carriedTokens: 0, contextShare: 0, isEmpty: true };
  }

  // Without a known context size there is nothing to measure the transcript
  // against. Carrying it whole is the honest default — condensing on a guess
  // would discard turns for a limit that may not exist.
  const fidelity: ThreadHandoffFidelity =
    maxTokens && contextShare > VERBATIM_REPLAY_CONTEXT_BUDGET ? "condensed" : "verbatim";

  return { fidelity, carriedTokens, contextShare, isEmpty: false };
}

/**
 * Round a token count to something a person can weigh at a glance.
 *
 * Deliberately coarse. This number decides whether someone spends context or
 * waits for a reset, and false precision invites reading it as exact when it
 * is the provider's own running total rather than a quote.
 */
export function formatHandoffTokenCost(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1_000) return `${Math.round(tokens / 100) * 100}`;
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}
