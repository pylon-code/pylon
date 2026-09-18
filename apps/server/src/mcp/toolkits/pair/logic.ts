/**
 * Pure rules for the pair executor: identity, state, wait caps, and message
 * ids. Kept free of services so every rule is tested directly.
 *
 * STUB: written by the lead so the contract and tests compile. The executor
 * replaces every body; signatures and exported names must not change.
 *
 * @module mcp/toolkits/pair/logic
 */
import type { MessageId, OrchestrationThreadShell, ThreadId, TurnId } from "@t3tools/contracts";

import type { PairExecutorState } from "./tools.ts";

/** The reserved delegation key. The fan-out tools must refuse it. */
export const PAIR_DELEGATION_KEY = "pair";

const notImplemented = (name: string): never => {
  throw new Error(`pair/logic.${name} is not implemented`);
};

export function pairExecutorThreadId(
  _leadThreadId: ThreadId,
  _sha256Hex: (input: string) => string,
): ThreadId {
  return notImplemented("pairExecutorThreadId");
}

export function isPairExecutorThreadId(
  _threadId: ThreadId,
  _sha256Hex: (input: string) => string,
): boolean {
  return notImplemented("isPairExecutorThreadId");
}

export function derivePairExecutorState(_shell: OrchestrationThreadShell): PairExecutorState {
  return notImplemented("derivePairExecutorState");
}

export function pairAwaitCapSeconds(_leadDriver: string | undefined): number {
  return notImplemented("pairAwaitCapSeconds");
}

export function pairMessageId(_executorId: ThreadId, _messageKey: string): MessageId {
  return notImplemented("pairMessageId");
}

export function pairSteerMessageId(_executorId: ThreadId, _turnId: TurnId): MessageId {
  return notImplemented("pairSteerMessageId");
}

export function pairExecutorTitle(_leadTitle: string): string {
  return notImplemented("pairExecutorTitle");
}
