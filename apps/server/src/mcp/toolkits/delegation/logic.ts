/**
 * Pure rules for delegated child threads: identity, state, results, and the
 * model and permission policy. Kept free of services so every rule is tested
 * directly.
 *
 * @module mcp/toolkits/delegation/logic
 */
import {
  DEFAULT_MODEL_BY_PROVIDER,
  ThreadId,
  type OrchestrationCheckpointSummary,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";

const DELEGATED_THREAD_ID_PREFIX = "delegated:";
export const MAX_LIVE_CHILDREN = 8;
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TITLE_MAX = 80;
const HASH_LENGTH = 16;

export type DelegatedThreadState =
  | "queued"
  | "running"
  | "completed"
  | "interrupted"
  | "error"
  | "archived";

export function isValidDelegationKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

export function isDelegatedThreadId(threadId: string): boolean {
  return threadId.startsWith(DELEGATED_THREAD_ID_PREFIX);
}

export function delegatedChildPrefix(parentThreadId: ThreadId): string {
  return `${DELEGATED_THREAD_ID_PREFIX}${parentThreadId}:`;
}

/**
 * The child id embeds its parent, so ownership, depth, and the live-children
 * count need no lookup and survive restarts. `sha256Hex` is injected so the
 * rule stays pure.
 */
export function delegatedThreadId(
  parentThreadId: ThreadId,
  delegationKey: string,
  sha256Hex: (input: string) => string,
): ThreadId {
  const hash = sha256Hex(`${parentThreadId}\n${delegationKey}`).slice(0, HASH_LENGTH);
  return ThreadId.make(`${delegatedChildPrefix(parentThreadId)}${hash}`);
}

export function deriveDelegatedThreadState(shell: OrchestrationThreadShell): DelegatedThreadState {
  if (shell.archivedAt !== null) return "archived";
  const turn = shell.latestTurn;
  const session = shell.session;
  if (session?.status === "error" || turn?.state === "error") return "error";
  if (turn === null) return "queued";
  if (turn.state === "running") return "running";
  if (turn.state === "interrupted") return "interrupted";
  // Native subagents can outlive the turn; the child is not done until they settle.
  if (
    turn.state === "completed" &&
    (session === null || session.activeTurnId === null) &&
    shell.backgroundLiveness !== "working"
  ) {
    return "completed";
  }
  return "running";
}

export function isLiveDelegatedState(state: DelegatedThreadState): boolean {
  return state === "queued" || state === "running";
}

export interface DelegatedFileChange {
  readonly path: string;
  /** Checkpoint file kinds are open strings; do not narrow to a literal union. */
  readonly kind: string;
  readonly additions: number;
  readonly deletions: number;
}

export function aggregateFilesChanged(
  checkpoints: ReadonlyArray<Pick<OrchestrationCheckpointSummary, "files">>,
): ReadonlyArray<DelegatedFileChange> {
  const byPath = new Map<string, DelegatedFileChange>();
  for (const checkpoint of checkpoints) {
    for (const file of checkpoint.files) {
      const previous = byPath.get(file.path);
      byPath.set(file.path, {
        path: file.path,
        kind: file.kind,
        additions: (previous?.additions ?? 0) + file.additions,
        deletions: (previous?.deletions ?? 0) + file.deletions,
      });
    }
  }
  return [...byPath.values()];
}

export function truncateText(
  text: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  return text.length <= maxChars
    ? { text, truncated: false }
    : { text: text.slice(0, maxChars), truncated: true };
}

export function defaultTitleFor(task: string): string {
  const firstLine = task.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const base = firstLine.length > 0 ? firstLine : "Delegated task";
  return base.length > TITLE_MAX ? base.slice(0, TITLE_MAX) : base;
}

export function resolveDelegatedModel(
  snapshot: Pick<ServerProvider, "driver" | "models">,
  requested: string | undefined,
): { readonly ok: true; readonly model: string } | { readonly ok: false } {
  if (requested !== undefined) {
    const match = snapshot.models.find(
      (model) => model.slug === requested || (model.aliases ?? []).includes(requested),
    );
    return match ? { ok: true, model: match.slug } : { ok: false };
  }
  const preferred = snapshot.models.find((model) => model.isDefault === true);
  if (preferred) return { ok: true, model: preferred.slug };
  const fallback = DEFAULT_MODEL_BY_PROVIDER[snapshot.driver];
  return fallback === undefined ? { ok: false } : { ok: true, model: fallback };
}

/** A child may run in its parent's mode or approval-required, never with broader autonomy. */
export function resolveDelegatedRuntimeMode(
  parentMode: RuntimeMode,
  requested: RuntimeMode | undefined,
):
  | { readonly ok: true; readonly mode: RuntimeMode }
  | { readonly ok: false; readonly reason: "escalation" } {
  const mode = requested ?? parentMode;
  if (mode === parentMode || mode === "approval-required") return { ok: true, mode };
  return { ok: false, reason: "escalation" };
}

export function selectAssistantMessage(
  thread: Pick<OrchestrationThread, "latestTurn" | "messages">,
): OrchestrationMessage | null {
  const referenced = thread.latestTurn?.assistantMessageId ?? null;
  if (referenced !== null) {
    const found = thread.messages.find((message) => message.id === referenced);
    if (found) return found;
  }
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message !== undefined && message.role === "assistant" && !message.streaming) {
      return message;
    }
  }
  return null;
}
