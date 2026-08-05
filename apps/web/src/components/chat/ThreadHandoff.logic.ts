/**
 * Assembling what a continuation thread is told.
 *
 * A provider session cannot cross accounts, so continuing work elsewhere means
 * a fresh session that remembers nothing. Everything it knows arrives in one
 * visible message — deliberately one, rather than history synthesized onto the
 * new account. The seam being obvious is the point: the carried context is
 * exactly what you can read and edit before sending, so a bad reconstruction
 * is something you correct rather than discover three turns later.
 *
 * Two rules shape the content, both from the drain-and-swap design:
 *
 *  - **Facts come from the diff, prose only carries intent.** A summary can
 *    confidently misremember what it changed; a git diff cannot. The
 *    continuation is told to trust the repository over the narrative.
 *  - **Carry everything when it fits.** Condensing is for threads that would
 *    crowd the target context, not the default. Most handoffs lose nothing.
 *
 * @module components/chat/ThreadHandoff.logic
 */
import type { OrchestrationMessage, ThreadHandoffEstimate } from "@t3tools/contracts";

/**
 * Turns kept verbatim when a thread is too large to replay whole.
 *
 * The tail is where the work actually is — what was just tried, what failed,
 * what the user last asked for. Older turns are the ones the checkpoint diff
 * already accounts for.
 */
export const CONDENSED_VERBATIM_TURN_COUNT = 6;

export interface ThreadHandoffSeedInput {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly estimate: ThreadHandoffEstimate;
  /** Human-readable summary of the checkpoint diff, when one is available. */
  readonly diffSummary?: string | undefined;
  readonly sourceAccountName?: string | undefined;
  readonly targetAccountName?: string | undefined;
}

const roleLabel = (role: OrchestrationMessage["role"]): string =>
  role === "user" ? "User" : role === "assistant" ? "Assistant" : role;

const renderTurns = (messages: ReadonlyArray<OrchestrationMessage>): string =>
  messages
    .filter((message) => message.text.trim().length > 0)
    .map((message) => `**${roleLabel(message.role)}:** ${message.text.trim()}`)
    .join("\n\n");

/**
 * The messages a continuation carries, and whether anything was left behind.
 *
 * Split out from the prose so the count is assertable and the UI can say how
 * much is being dropped without re-deriving it.
 */
export function selectHandoffMessages(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly estimate: ThreadHandoffEstimate;
}): {
  readonly carried: ReadonlyArray<OrchestrationMessage>;
  readonly omittedCount: number;
} {
  const substantive = input.messages.filter((message) => message.text.trim().length > 0);
  if (input.estimate.fidelity === "verbatim" || substantive.length <= CONDENSED_VERBATIM_TURN_COUNT) {
    return { carried: substantive, omittedCount: 0 };
  }
  const carried = substantive.slice(-CONDENSED_VERBATIM_TURN_COUNT);
  return { carried, omittedCount: substantive.length - carried.length };
}

/**
 * Build the single message a continuation thread opens with.
 *
 * Returns `null` when there is nothing to carry — an empty thread should start
 * fresh rather than open with a handoff that transfers nothing.
 */
export function buildThreadHandoffSeed(input: ThreadHandoffSeedInput): string | null {
  const { carried, omittedCount } = selectHandoffMessages(input);
  if (carried.length === 0) return null;

  const target = input.targetAccountName?.trim();
  const source = input.sourceAccountName?.trim();
  const sections: string[] = [];

  // Stating the memory gap outright stops the continuation from writing as if
  // it remembers work it never did.
  sections.push(
    [
      "You are continuing work from an earlier thread.",
      source
        ? `It was running on ${source}, which ran out of subscription capacity, so this is a fresh session${target ? ` on ${target}` : ""}.`
        : `This is a fresh session${target ? ` on ${target}` : ""}.`,
      "You have no memory of that conversation beyond what appears below.",
    ].join(" "),
  );

  const [first, ...rest] = carried;
  if (first && first.role === "user") {
    sections.push(`## Original request\n\n${first.text.trim()}`);
  }

  const transcript = renderTurns(first && first.role === "user" ? rest : carried);
  if (transcript.length > 0) {
    sections.push(
      omittedCount > 0
        ? `## Most recent turns\n\nThe ${omittedCount} earlier turn${omittedCount === 1 ? "" : "s"} ${omittedCount === 1 ? "is" : "are"} not included; the diff below is the record of what they changed.\n\n${transcript}`
        : `## What happened so far\n\n${transcript}`,
    );
  }

  if (input.diffSummary?.trim()) {
    sections.push(`## Changes already made\n\n${input.diffSummary.trim()}`);
  }

  sections.push(
    input.diffSummary?.trim()
      ? "Check the repository against the diff above before continuing — the diff is the record of what changed, the text above only describes intent."
      : "Check the current state of the repository before continuing — the text above describes intent, not verified fact.",
  );

  return sections.join("\n\n");
}
