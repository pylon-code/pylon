/**
 * Pure rules for the pair executor: identity, state, wait caps, and message
 * ids. Kept free of services so every rule is tested directly.
 *
 * @module mcp/toolkits/pair/logic
 */
import {
  MessageId,
  type OrchestrationThreadShell,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { delegatedParentThreadId } from "@t3tools/shared/delegatedThreads";

import { delegatedThreadId, deriveDelegatedThreadState } from "../delegation/logic.ts";
import type { PairExecutorState } from "./tools.ts";

/**
 * The longest `pair_await` any provider is allowed. Defined here, not in
 * `tools.ts`, so this module stays free of service imports: the provider
 * service reads pair identity from it while preparing a session.
 */
export const MAX_PAIR_AWAIT_SECONDS = 150;

/** The reserved delegation key. The fan-out tools must refuse it. */
export const PAIR_DELEGATION_KEY = "pair";

const EXECUTOR_TITLE_MAX_CHARS = 200;

export function pairExecutorThreadId(
  leadThreadId: ThreadId,
  sha256Hex: (input: string) => string,
): ThreadId {
  return delegatedThreadId(leadThreadId, PAIR_DELEGATION_KEY, sha256Hex);
}

export function isPairExecutorThreadId(
  threadId: ThreadId,
  sha256Hex: (input: string) => string,
): boolean {
  const parent = delegatedParentThreadId(threadId);
  if (parent === null) return false;
  return pairExecutorThreadId(parent, sha256Hex) === threadId;
}

export function derivePairExecutorState(shell: OrchestrationThreadShell): PairExecutorState {
  if (shell.archivedAt !== null) return "archived";
  if (shell.session === null && shell.latestTurn === null) return "idle";
  const state = deriveDelegatedThreadState(shell);
  if (state === "queued" || state === "running") return "running";
  return state;
}

/** Instant reads of a running executor a lead may make in a row before one blocks. */
export const MAX_INSTANT_READS = 2;

/**
 * What one `pair_await` call does, given how many instant reads of a running
 * executor came straight before it. An instant read is `maxSeconds: 0`. The
 * third in a row waits the whole cap instead, so a lead cannot poll; the call
 * still returns the moment the executor changes. Any wait, and any call that
 * finds the executor not running, clears the count.
 */
export function pairAwaitPlan(_input: {
  readonly requestedSeconds: number | undefined;
  readonly capSeconds: number;
  readonly running: boolean;
  readonly instantReads: number;
}): { readonly budgetSeconds: number; readonly instantReads: number } {
  return { budgetSeconds: 0, instantReads: 0 };
}

/**
 * The checkpoints of the executor's latest turn. One executor serves every
 * brief of a pair, so its checkpoints pile up; the lead is reviewing the brief
 * it just sent and has already read the earlier ones.
 */
export function latestTurnCheckpoints<T extends { readonly turnId: string }>(
  checkpoints: ReadonlyArray<T>,
  latestTurnId: string | null,
): ReadonlyArray<T> {
  return latestTurnId === null
    ? []
    : checkpoints.filter((checkpoint) => checkpoint.turnId === latestTurnId);
}

/**
 * How long one `pair_await` call waits. Only an explicit 0 reads the state and
 * returns; any other request waits the lead's whole cap, because a short wait
 * repeated in a loop costs a model turn each time and the call already returns
 * the moment the executor changes.
 */
export function pairAwaitBudgetSeconds(requested: number | undefined, capSeconds: number): number {
  return requested === 0 ? 0 : capSeconds;
}

/**
 * Wait budget cap for pair_await.
 * Codex gets 150 seconds because Pylon sets Codex's MCP tool_timeout_sec to 180
 * in CodexAdapter.ts. Everything else (including undefined and Prime Agent, which
 * cancels tool calls at 60 seconds) gets 45 seconds to settle safely before
 * client-side timeouts fire.
 */
export function pairAwaitCapSeconds(leadDriver: string | undefined): number {
  return leadDriver === "codex" ? MAX_PAIR_AWAIT_SECONDS : 45;
}

export function pairMessageId(executorId: ThreadId, messageKey: string): MessageId {
  return MessageId.make(`pair-message:${executorId}:${messageKey}`);
}

export function pairSteerMessageId(executorId: ThreadId, turnId: TurnId): MessageId {
  return MessageId.make(`pair-message:${executorId}:steer:${turnId}`);
}

export function pairExecutorTitle(leadTitle: string): string {
  return `Executor · ${leadTitle}`.slice(0, EXECUTOR_TITLE_MAX_CHARS);
}

/**
 * Whether a provider can lead a pair.
 * Antigravity has no per-session control over its own subagents and receives no
 * Pylon instructions, so it can only be the executor. Codex cannot have its
 * `collaboration.*` tools removed either, but it follows the pair protocol once
 * that reaches it as thread developer instructions, so it can lead.
 */
export function isPairLeadSupported(leadDriver: string | undefined): boolean {
  return leadDriver !== "antigravity";
}

export interface ProtectedPathRecord {
  readonly path: string;
  /** Hex digest of the file's content when the brief was sent. */
  readonly hash: string;
}

/**
 * A protected path as the lead may write it, reduced to a clean path relative
 * to the worktree, or null when it could reach outside it.
 */
export function normalizeProtectedPath(path: string): string | null {
  if (path.includes("\0")) return null;
  const normalizedSlashes = path.replaceAll("\\", "/");
  if (
    normalizedSlashes.startsWith("/") ||
    normalizedSlashes.startsWith("~") ||
    /^[A-Za-z]:/.test(normalizedSlashes)
  ) {
    return null;
  }
  const rawSegments = normalizedSlashes.split("/");
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  return segments.join("/");
}

/**
 * Recorded paths whose current content differs or that no longer exist, in
 * recorded order. `current` maps a path to its digest, or null when the file
 * could not be read.
 */
export function changedProtectedPaths(
  recorded: ReadonlyArray<ProtectedPathRecord>,
  current: ReadonlyMap<string, string | null>,
): ReadonlyArray<string> {
  const changed: string[] = [];
  for (const record of recorded) {
    if (current.get(record.path) !== record.hash) {
      changed.push(record.path);
    }
  }
  return changed;
}
