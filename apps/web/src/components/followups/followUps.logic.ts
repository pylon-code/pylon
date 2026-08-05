import type { FollowUp, FollowUpKind } from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";

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

function followUpResolutionPrompt(item: FollowUp): ReadonlyArray<string> {
  if (item.resolution === null) return [];

  const commitSha = item.resolution.commitSha?.trim() ?? "";
  return [
    "",
    "### Recorded resolution",
    item.resolution.note,
    ...(item.resolution.threadId ? [`Resolution thread: ${item.resolution.threadId}`] : []),
    ...(commitSha.length > 0 ? [`Resolution commit: ${commitSha}`] : []),
  ];
}

const FOLLOW_UP_PROMPT_FRAME_VERSION = "v1";
const FOLLOW_UP_PROMPT_FRAME_HEADER_PREFIX = `<!-- PYLON-OWNED FOLLOW-UP ${FOLLOW_UP_PROMPT_FRAME_VERSION} `;
const FOLLOW_UP_PROMPT_FRAME_FOOTER_PREFIX = `<!-- /PYLON-OWNED FOLLOW-UP ${FOLLOW_UP_PROMPT_FRAME_VERSION} `;
const FOLLOW_UP_PROMPT_FRAME_FOOTER_PATTERN =
  /^<!-- \/PYLON-OWNED FOLLOW-UP v1 mode=(work|validation) utf16=(0|[1-9]\d*) sha256=([0-9a-f]{64}) -->/;

type FollowUpPromptMode = "work" | "validation";

function encodeUtf16LittleEndian(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    bytes[index * 2] = codeUnit & 0xff;
    bytes[index * 2 + 1] = codeUnit >>> 8;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function followUpPromptChecksum(mode: FollowUpPromptMode, prompt: string): string {
  const checksumInput = [
    "pylon-owned-follow-up",
    FOLLOW_UP_PROMPT_FRAME_VERSION,
    mode,
    String(prompt.length),
    prompt,
  ].join("\0");
  return bytesToHex(sha256(encodeUtf16LittleEndian(checksumInput)));
}

function followUpPromptFrameMarker(
  boundary: "header" | "footer",
  mode: FollowUpPromptMode,
  promptLength: number,
  checksum: string,
): string {
  const prefix =
    boundary === "header"
      ? FOLLOW_UP_PROMPT_FRAME_HEADER_PREFIX
      : FOLLOW_UP_PROMPT_FRAME_FOOTER_PREFIX;
  return `${prefix}mode=${mode} utf16=${promptLength} sha256=${checksum} -->`;
}

function frameFollowUpPrompt(mode: FollowUpPromptMode, prompt: string): string {
  const checksum = followUpPromptChecksum(mode, prompt);
  return [
    followUpPromptFrameMarker("header", mode, prompt.length, checksum),
    prompt,
    followUpPromptFrameMarker("footer", mode, prompt.length, checksum),
  ].join("\n");
}

function findOwnedFollowUpPromptRange(
  prompt: string,
): { readonly start: number; readonly end: number } | null {
  let searchFrom = prompt.length;
  while (searchFrom >= 0) {
    const footerStart = prompt.lastIndexOf(FOLLOW_UP_PROMPT_FRAME_FOOTER_PREFIX, searchFrom);
    if (footerStart < 0) return null;
    searchFrom = footerStart - 1;

    const footerMatch = FOLLOW_UP_PROMPT_FRAME_FOOTER_PATTERN.exec(prompt.slice(footerStart));
    if (footerMatch === null) continue;

    const modeValue = footerMatch[1];
    const promptLengthValue = footerMatch[2];
    const checksum = footerMatch[3];
    if (
      (modeValue !== "work" && modeValue !== "validation") ||
      promptLengthValue === undefined ||
      checksum === undefined
    ) {
      continue;
    }
    const mode = modeValue;
    const promptLength = Number(promptLengthValue);
    if (!Number.isSafeInteger(promptLength) || promptLength > prompt.length) continue;

    const bodyEnd = footerStart - 1;
    if (bodyEnd < 0 || prompt[bodyEnd] !== "\n") continue;
    const bodyStart = bodyEnd - promptLength;
    if (bodyStart < 0) continue;

    const expectedHeader = followUpPromptFrameMarker("header", mode, promptLength, checksum);
    const frameStart = bodyStart - expectedHeader.length - 1;
    if (frameStart < 0 || prompt.slice(frameStart, bodyStart) !== `${expectedHeader}\n`) continue;

    const body = prompt.slice(bodyStart, bodyEnd);
    if (followUpPromptChecksum(mode, body) !== checksum) continue;

    return { start: frameStart, end: footerStart + footerMatch[0].length };
  }
  return null;
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
      ...followUpResolutionPrompt(item),
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
      ...followUpResolutionPrompt(item),
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
