/**
 * Assembling what a continuation thread is told.
 *
 * A provider session cannot cross accounts, so continuing work elsewhere means
 * a fresh session that remembers nothing. Everything it knows arrives in one
 * visible message — deliberately one, rather than history synthesized onto the
 * new account, so the seam is obvious rather than disguised.
 *
 * The carried context is shown but not editable. In the common case it is the
 * verbatim transcript plus a generated diff, neither of which can be wrong, so
 * there is nothing to correct — while an editable handoff could have its
 * framing stripped or its diff mangled. Steering the continuation is what the
 * next message is for.
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
import type {
  OrchestrationMessage,
  ProviderInstanceId,
  ThreadHandoffEstimate,
} from "@t3tools/contracts";
import { estimateThreadHandoff, formatHandoffTokenCost } from "@t3tools/contracts";

import { getDiffLineStat, getRenderablePatch, resolveFileDiffPath } from "../../lib/diffRendering";
import {
  isProviderInstanceDrained,
  sortProviderInstancesForRouting,
  type ProviderInstanceEntry,
} from "../../providerInstances";

/**
 * Turns kept verbatim when a thread is too large to replay whole.
 *
 * The tail is where the work actually is — what was just tried, what failed,
 * what the user last asked for. Older turns are the ones the checkpoint diff
 * already accounts for.
 */
export const CONDENSED_VERBATIM_TURN_COUNT = 6;

/**
 * Files listed individually before the summary starts counting instead.
 *
 * A long thread can touch hundreds of files, and the point of the summary is to
 * tell the continuation where to look — not to spend its context on a manifest.
 */
export const HANDOFF_DIFF_FILE_LIMIT = 40;

const pluralize = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Condense a thread's cumulative patch into the stat block the seed carries.
 *
 * The patch itself is deliberately not carried: it can dwarf the conversation,
 * and the cost shown on the offer is measured from the thread's context, not
 * from a diff of unknown size. Paths and line counts are enough to point the
 * continuation at the work; it is told to read the repository for the rest.
 *
 * Returns `undefined` when there is no parseable change, which is the seed's
 * signal to tell the continuation to verify state on its own.
 */
export function summarizeHandoffDiff(patch: string | undefined): string | undefined {
  const renderable = getRenderablePatch(patch, "thread-handoff");
  if (renderable?.kind !== "files" || renderable.files.length === 0) return undefined;

  const files = renderable.files;
  const total = getDiffLineStat(files);
  const lines = [
    `${pluralize(files.length, "file")} changed, ${pluralize(total.additions, "insertion")}(+), ${pluralize(total.deletions, "deletion")}(-)`,
    "",
  ];

  for (const file of files.slice(0, HANDOFF_DIFF_FILE_LIMIT)) {
    const stat = getDiffLineStat([file]);
    lines.push(`- ${resolveFileDiffPath(file)} (+${stat.additions}, -${stat.deletions})`);
  }
  // Said out loud rather than silently truncated, so the continuation knows the
  // list is partial and the repository is the authority.
  const remaining = files.length - HANDOFF_DIFF_FILE_LIMIT;
  if (remaining > 0) lines.push(`- …and ${pluralize(remaining, "further file")}`);

  return lines.join("\n");
}

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
  if (
    input.estimate.fidelity === "verbatim" ||
    substantive.length <= CONDENSED_VERBATIM_TURN_COUNT
  ) {
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

/**
 * One end of a handoff seam, as the thread on screen should describe it.
 *
 * `from` reads on the continuation ("this picks up earlier work"); `into` on
 * the thread that was handed off ("the work moved on"). Both exist because the
 * original stays open: without the forward link it just looks abandoned.
 */
export interface ThreadContinuationLink {
  readonly direction: "from" | "into";
  readonly threadId: string;
  readonly environmentId: string;
  readonly title: string;
  /** Account the linked thread runs on, when it can be identified. */
  readonly accountName?: string | undefined;
  readonly accentColor?: string | undefined;
}

interface ContinuationShell {
  readonly id: string;
  readonly environmentId: string;
  readonly title: string;
  readonly continuedFromThreadId?: string | null | undefined;
  readonly modelSelection?: { readonly instanceId?: string | undefined } | null | undefined;
}

/**
 * Resolve the handoff links to show on a thread: where its work came from, and
 * where it went.
 *
 * Both ends are looked up in the thread shells the client already holds, so
 * neither costs a request. A missing thread on either side yields no link
 * rather than a dead one.
 */
export function getThreadContinuationLinks(input: {
  readonly thread: {
    readonly id: string;
    readonly continuedFromThreadId?: string | null | undefined;
  } | null;
  readonly shells: ReadonlyArray<ContinuationShell>;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
}): ReadonlyArray<ThreadContinuationLink> {
  if (!input.thread) return [];

  const describe = (
    shell: ContinuationShell,
    direction: ThreadContinuationLink["direction"],
  ): ThreadContinuationLink => {
    const account = input.entries.find(
      (entry) => entry.instanceId === shell.modelSelection?.instanceId,
    );
    return {
      direction,
      threadId: shell.id,
      environmentId: shell.environmentId,
      title: shell.title,
      ...(account ? { accountName: account.displayName } : {}),
      ...(account?.accentColor ? { accentColor: account.accentColor } : {}),
    };
  };

  const links: ThreadContinuationLink[] = [];

  const parentId = input.thread.continuedFromThreadId;
  if (parentId) {
    const parent = input.shells.find((shell) => shell.id === parentId);
    if (parent) links.push(describe(parent, "from"));
  }

  const child = input.shells.find(
    (shell) => shell.continuedFromThreadId === input.thread?.id && shell.id !== input.thread?.id,
  );
  if (child) links.push(describe(child, "into"));

  return links;
}

export interface ThreadHandoffOffer {
  /** Account the thread is bound to, which has run out of capacity. */
  readonly spentAccountName: string;
  readonly spentAccentColor?: string | undefined;
  readonly resetsAt?: string | undefined;
  /** Account the work would continue on. */
  readonly targetInstanceId: ProviderInstanceId;
  readonly targetAccountName: string;
  readonly targetAccentColor?: string | undefined;
  readonly estimate: ThreadHandoffEstimate;
  /** Coarse token figure for the cost warning, e.g. `31k`. */
  readonly costLabel: string;
  /** Plain lines describing exactly what crosses over. */
  readonly carries: ReadonlyArray<string>;
}

/**
 * Decide whether to offer a handoff for the thread's bound account, and on
 * what terms.
 *
 * Returns `null` in every case where the offer would be noise: the account is
 * fine, nothing else can take the work, or there is nothing to carry. The
 * offer is never acted on automatically — waiting for the window to reset is
 * free, and only the user knows whether the work is worth paying for now.
 */
export function getThreadHandoffOffer(input: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly boundInstanceId: string | undefined;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly usedTokens?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly nowMs: number;
}): ThreadHandoffOffer | null {
  if (!input.boundInstanceId) return null;
  const bound = input.entries.find((entry) => entry.instanceId === input.boundInstanceId);
  if (!bound || !isProviderInstanceDrained(bound, input.nowMs)) return null;

  const target = sortProviderInstancesForRouting(
    input.entries.filter(
      (entry) =>
        entry.driverKind === bound.driverKind &&
        entry.instanceId !== bound.instanceId &&
        entry.enabled &&
        entry.isAvailable &&
        !isProviderInstanceDrained(entry, input.nowMs),
    ),
    input.nowMs,
  )[0];
  // Nothing to hand off to. The drain pill already says the account is spent;
  // an offer with no destination would only restate it.
  if (!target) return null;

  const estimate = estimateThreadHandoff({
    ...(input.usedTokens !== undefined ? { usedTokens: input.usedTokens } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
  });
  if (estimate.isEmpty) return null;

  const { carried, omittedCount } = selectHandoffMessages({ messages: input.messages, estimate });
  if (carried.length === 0) return null;

  const carries = [
    "the original request",
    omittedCount > 0
      ? `the last ${carried.length} turns verbatim (${omittedCount} earlier turn${omittedCount === 1 ? "" : "s"} left behind)`
      : `all ${carried.length} turns, verbatim`,
    "the diff since this thread started",
  ];

  return {
    spentAccountName: bound.displayName,
    ...(bound.accentColor ? { spentAccentColor: bound.accentColor } : {}),
    ...(bound.snapshot.rateLimit?.resetsAt ? { resetsAt: bound.snapshot.rateLimit.resetsAt } : {}),
    targetInstanceId: target.instanceId,
    targetAccountName: target.displayName,
    ...(target.accentColor ? { targetAccentColor: target.accentColor } : {}),
    estimate,
    costLabel: formatHandoffTokenCost(estimate.carriedTokens),
    carries,
  };
}
