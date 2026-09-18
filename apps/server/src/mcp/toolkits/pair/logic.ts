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
 * Antigravity has no per-session control over its own subagents, so it can
 * only be the executor.
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
 * to the worktree, or null when it could reach outside it. STUB.
 */
export function normalizeProtectedPath(_path: string): string | null {
  throw new Error("pair/logic.normalizeProtectedPath is not implemented");
}

/**
 * Recorded paths whose current content differs or that no longer exist, in
 * recorded order. `current` maps a path to its digest, or null when the file
 * could not be read. STUB.
 */
export function changedProtectedPaths(
  _recorded: ReadonlyArray<ProtectedPathRecord>,
  _current: ReadonlyMap<string, string | null>,
): ReadonlyArray<string> {
  throw new Error("pair/logic.changedProtectedPaths is not implemented");
}
