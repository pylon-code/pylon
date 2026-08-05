import type { FollowUp, FollowUpKind } from "@t3tools/contracts";

export const FOLLOW_UP_KIND_LABELS: Readonly<Record<FollowUpKind, string>> = {
  blocker: "Blockers",
  open: "Open",
  idea: "Ideas",
};

export const FOLLOW_UP_DEFER_REASON_LABELS: Readonly<Record<FollowUp["deferReason"], string>> = {
  "out-of-scope": "Out of scope",
  "needs-decision": "Needs a decision",
  "blocked-externally": "Blocked externally",
  idea: "Idea",
};

export const FOLLOW_UP_STATUS_LABELS: Readonly<Record<FollowUp["status"], string>> = {
  open: "Open",
  resolved: "Resolved",
  waived: "Waived",
  moot: "Moot",
};

export interface GroupedFollowUps {
  readonly blocker: ReadonlyArray<FollowUp>;
  readonly open: ReadonlyArray<FollowUp>;
  readonly idea: ReadonlyArray<FollowUp>;
  readonly closed: ReadonlyArray<FollowUp>;
}

export function groupFollowUps(items: ReadonlyArray<FollowUp>): GroupedFollowUps {
  const grouped: Record<"blocker" | "open" | "idea" | "closed", FollowUp[]> = {
    blocker: [],
    open: [],
    idea: [],
    closed: [],
  };
  for (const item of items) {
    if (item.status === "open") grouped[item.kind].push(item);
    else grouped.closed.push(item);
  }
  const newestFirst = (left: FollowUp, right: FollowUp) =>
    right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
  grouped.blocker.sort(newestFirst);
  grouped.open.sort(newestFirst);
  grouped.idea.sort(newestFirst);
  grouped.closed.sort(newestFirst);
  return grouped;
}

export function resolveFollowUpProjectSelection(input: {
  readonly bootstrapped: boolean;
  readonly selectedProjectKey: string | null | undefined;
  readonly projectKeys: ReadonlyArray<string>;
}): string | null | undefined {
  if (!input.bootstrapped) return undefined;
  if (
    input.selectedProjectKey !== null &&
    input.selectedProjectKey !== undefined &&
    input.projectKeys.includes(input.selectedProjectKey)
  ) {
    return input.selectedProjectKey;
  }
  return input.projectKeys[0] ?? null;
}

function followUpPromptMarker(item: FollowUp): string {
  return `Follow-up ID: ${item.id}`;
}

function followUpEvidencePrompt(item: FollowUp): string {
  return item.evidence.length === 0
    ? "- None recorded."
    : item.evidence
        .map(
          (entry) =>
            `- ${entry.path}${entry.line === null ? "" : `:${entry.line}`} @ ${entry.commitSha}`,
        )
        .join("\n");
}

const FOLLOW_UP_PROMPT_FRAMES = {
  work: {
    start: "<!-- PYLON-OWNED FOLLOW-UP WORK START -->",
    end: "<!-- PYLON-OWNED FOLLOW-UP WORK END -->",
  },
  validation: {
    start: "<!-- PYLON-OWNED FOLLOW-UP VALIDATION START -->",
    end: "<!-- PYLON-OWNED FOLLOW-UP VALIDATION END -->",
  },
} as const;

type FollowUpPromptMode = keyof typeof FOLLOW_UP_PROMPT_FRAMES;

function frameFollowUpPrompt(mode: FollowUpPromptMode, prompt: string): string {
  const frame = FOLLOW_UP_PROMPT_FRAMES[mode];
  return [frame.start, prompt, frame.end].join("\n");
}

function findOwnedFollowUpPromptRange(
  prompt: string,
): { readonly start: number; readonly end: number } | null {
  let firstRange: { readonly start: number; readonly end: number } | null = null;
  for (const frame of Object.values(FOLLOW_UP_PROMPT_FRAMES)) {
    const start = prompt.indexOf(frame.start);
    if (start < 0) continue;
    const endMarker = prompt.indexOf(frame.end, start + frame.start.length);
    if (endMarker < 0) continue;
    const range = { start, end: endMarker + frame.end.length };
    if (firstRange === null || range.start < firstRange.start) {
      firstRange = range;
    }
  }
  return firstRange;
}

function mergeOwnedFollowUpPrompt(existingPrompt: string, dossier: string): string {
  const ownedRange = findOwnedFollowUpPromptRange(existingPrompt);
  if (ownedRange !== null) {
    return `${existingPrompt.slice(0, ownedRange.start)}${dossier}${existingPrompt.slice(ownedRange.end)}`;
  }
  return existingPrompt.length === 0 ? dossier : `${existingPrompt}\n\n---\n\n${dossier}`;
}

export function buildFollowUpThreadPrompt(item: FollowUp): string {
  const context = [
    `Kind: ${FOLLOW_UP_KIND_LABELS[item.kind]}`,
    `Why deferred: ${FOLLOW_UP_DEFER_REASON_LABELS[item.deferReason]}`,
    ...(item.gate ? [`Branch gate: ${item.gate.ref}`] : []),
    ...(item.sourceThreadId ? [`Filed from thread: ${item.sourceThreadId}`] : []),
  ];

  return frameFollowUpPrompt(
    "work",
    [
      "Take on this saved Pylon follow-up. Revalidate the verify check before changing code, then address it if it still applies.",
      "",
      `## ${item.title}`,
      followUpPromptMarker(item),
      ...context,
      "",
      "### Observation",
      item.observation,
      "",
      "### Verify check",
      item.verifyCheck,
      "",
      "### Evidence",
      followUpEvidencePrompt(item),
      "",
      `When the work is complete, resolve follow-up ${item.id} with an evidence-backed note from this thread.`,
    ].join("\n"),
  );
}

export function buildFollowUpValidationPrompt(item: FollowUp): string {
  return frameFollowUpPrompt(
    "validation",
    [
      "Validate this saved Pylon follow-up in this visible thread. Investigate read-only: do not change code as part of validation.",
      "Return exactly one outcome: still-needed, moot, or uncertain. Uncertain must fail closed and leave the item open. Never waive it.",
      "Only choose moot when concrete evidence proves the follow-up no longer applies.",
      "After checking, call followup_record_validation with the current revision, the verify check below, your outcome, note, evidence, and checked commit SHA.",
      "",
      `## Validate: ${item.title}`,
      `Validation for ${followUpPromptMarker(item)}`,
      `Current revision: ${item.revision}`,
      "",
      "### Observation",
      item.observation,
      "",
      "### Verify check",
      item.verifyCheck,
      "",
      "### Existing evidence",
      followUpEvidencePrompt(item),
    ].join("\n"),
  );
}

export function mergeFollowUpThreadPrompt(existingPrompt: string, item: FollowUp): string {
  return mergeOwnedFollowUpPrompt(existingPrompt, buildFollowUpThreadPrompt(item));
}

export function mergeFollowUpValidationPrompt(existingPrompt: string, item: FollowUp): string {
  return mergeOwnedFollowUpPrompt(existingPrompt, buildFollowUpValidationPrompt(item));
}

export function openFollowUpBlockersForBranch(
  items: ReadonlyArray<FollowUp>,
  input: Pick<FollowUp, "projectId"> & { readonly branchRef: string },
): ReadonlyArray<FollowUp> {
  return items.filter(
    (item) =>
      item.projectId === input.projectId &&
      item.kind === "blocker" &&
      item.status === "open" &&
      item.gate?.ref === input.branchRef,
  );
}
