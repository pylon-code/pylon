import type { PrimeDaemonMessage } from "./PrimeAgentDaemonEvents.ts";

const MAX_HISTORY_ENTRIES = 8_192;
const TRANSCRIPT_TAIL = 1_024;
const metadataKinds = new Set([
  "thinking_level_change",
  "service_tier_change",
  "model_change",
  "custom",
  "child_usage_attributed",
  "label",
  "session_info",
  "session_state",
  "agent_status",
  "git_state",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Entry = Record<string, unknown> & {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
};
export interface PrimeCompactionHistory {
  readonly previous: ReadonlyArray<PrimeDaemonMessage>;
  readonly current: ReadonlyArray<PrimeDaemonMessage>;
  readonly appended: ReadonlyArray<PrimeDaemonMessage>;
  readonly retainedCount: number;
}

/** The public tree is evidence only when its exact leaf and rendered context match the snapshot. */
export function decodePrimeCompactionHistory(
  value: unknown,
  leafId: string,
  decodeMessage: (value: unknown) => PrimeDaemonMessage | undefined,
): PrimeCompactionHistory | undefined {
  if (!record(value) || value.leafId !== leafId || !Array.isArray(value.tree)) return undefined;
  const entries = new Map<string, Entry>();
  const pending: Array<{ node: unknown; parentId: string | null }> = value.tree.map(
    (node: unknown) => ({ node, parentId: null }),
  );
  if (pending.length > MAX_HISTORY_ENTRIES) return undefined;
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (!record(next.node) || !record(next.node.entry) || !Array.isArray(next.node.children))
      return undefined;
    const entry = next.node.entry;
    if (
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      entries.has(entry.id) ||
      entry.parentId !== next.parentId ||
      typeof entry.type !== "string" ||
      typeof entry.timestamp !== "string" ||
      !Number.isFinite(Date.parse(entry.timestamp))
    )
      return undefined;
    entries.set(entry.id, {
      ...entry,
      id: entry.id,
      parentId: next.parentId,
      type: entry.type,
      timestamp: entry.timestamp,
    });
    if (entries.size + pending.length + next.node.children.length > MAX_HISTORY_ENTRIES)
      return undefined;
    for (const node of next.node.children) pending.push({ node, parentId: entry.id });
  }
  const path: Entry[] = [];
  let cursor: string | null = leafId;
  while (cursor !== null) {
    const entry = entries.get(cursor);
    if (entry === undefined || path.length >= entries.size) return undefined;
    path.push(entry);
    cursor = entry.parentId;
  }
  path.reverse();
  const boundary = path.findLastIndex((entry) => entry.type === "compaction");
  if (boundary < 0) return undefined;

  const messagesFrom = (source: ReadonlyArray<Entry>): PrimeDaemonMessage[] | undefined => {
    const result: PrimeDaemonMessage[] = [];
    for (const entry of source) {
      let raw: unknown;
      if (entry.type === "message") raw = entry.message;
      else if (entry.type === "custom_message")
        raw = {
          role: "custom",
          customType: entry.customType,
          content: entry.content,
          display: entry.display,
          details: entry.details,
          timestamp: Date.parse(entry.timestamp),
        };
      else if (entry.type === "branch_summary") {
        if (entry.summary === "") continue;
        raw = {
          role: "branchSummary",
          summary: entry.summary,
          fromId: entry.fromId,
          timestamp: Date.parse(entry.timestamp),
        };
      } else if (entry.type === "compaction" || metadataKinds.has(entry.type)) continue;
      else return undefined;
      const message = decodeMessage(raw);
      if (message === undefined) return undefined;
      result.push(message);
    }
    return result;
  };
  const render = (
    source: ReadonlyArray<Entry>,
  ): { messages: PrimeDaemonMessage[]; retainedCount: number } | undefined => {
    const index = source.findLastIndex((entry) => entry.type === "compaction");
    if (index < 0) {
      const messages = messagesFrom(source);
      return messages === undefined ? undefined : { messages, retainedCount: 0 };
    }
    const compaction = source[index]!;
    const firstKept = source.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
    if (firstKept < 0 || firstKept >= index) return undefined;
    const retained = messagesFrom(source.slice(firstKept, index));
    const appended = messagesFrom(source.slice(index + 1));
    if (retained === undefined || appended === undefined) return undefined;
    const summary = decodeMessage({
      role: "compactionSummary",
      summary: compaction.summary,
      tokensBefore: compaction.tokensBefore,
      retainedMessageCount: retained.length,
      customInstructions: compaction.customInstructions,
      harnessDigest: compaction.harnessDigest,
      timestamp: Date.parse(compaction.timestamp),
    });
    return summary === undefined
      ? undefined
      : { messages: [summary, ...retained, ...appended], retainedCount: retained.length };
  };
  const previous = render(path.slice(0, boundary));
  const current = render(path);
  const appended = messagesFrom(path.slice(boundary + 1));
  if (previous === undefined || current === undefined || appended === undefined) return undefined;
  return {
    previous: previous.messages,
    current: current.messages,
    appended,
    retainedCount: current.retainedCount,
  };
}

/** Translate an exactly proved old context prefix into the new context's count space. */
export function planPrimeCompactionReplacement(input: {
  readonly history: PrimeCompactionHistory;
  readonly observedCount: number;
  readonly observedFingerprints: ReadonlyArray<string>;
  readonly snapshotCount: number;
  readonly snapshot: ReadonlyArray<PrimeDaemonMessage>;
  readonly fingerprint: (message: PrimeDaemonMessage) => string;
  readonly matchesFingerprint?: (message: PrimeDaemonMessage, expected: string) => boolean;
}):
  | {
      readonly observedCount: number;
      readonly observed: ReadonlyArray<PrimeDaemonMessage>;
      readonly previousCount: number;
      readonly retainedCount: number;
    }
  | undefined {
  const { history, fingerprint } = input;
  if (
    input.snapshotCount !== history.current.length ||
    input.snapshot.length !== Math.min(input.snapshotCount, TRANSCRIPT_TAIL) ||
    input.observedCount < history.previous.length ||
    input.observedCount > history.previous.length + history.appended.length ||
    input.observedFingerprints.length !== Math.min(input.observedCount, TRANSCRIPT_TAIL)
  )
    return undefined;
  const currentTail = history.current.slice(-TRANSCRIPT_TAIL);
  if (
    input.snapshot.some(
      (message, index) => fingerprint(message) !== fingerprint(currentTail[index]!),
    )
  )
    return undefined;
  const oldPrefix = [...history.previous, ...history.appended]
    .slice(0, input.observedCount)
    .slice(-TRANSCRIPT_TAIL);
  if (
    input.observedFingerprints.some(
      (identity, index) =>
        !(
          input.matchesFingerprint?.(oldPrefix[index]!, identity) ??
          identity === fingerprint(oldPrefix[index]!)
        ),
    )
  )
    return undefined;
  const observedCount = 1 + history.retainedCount + input.observedCount - history.previous.length;
  return {
    observedCount,
    observed: history.current.slice(0, observedCount).slice(-TRANSCRIPT_TAIL),
    previousCount: history.previous.length,
    retainedCount: history.retainedCount,
  };
}
