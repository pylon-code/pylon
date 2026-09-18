/**
 * What a client needs to show and control a pair: whether this lead can have
 * one, whether it is on, what its executor is doing, and the command inputs
 * that turn it on and off. Pure, shared by web and mobile.
 */
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { isPairExecutorThreadId, pairExecutorThreadId } from "@t3tools/shared/delegatedThreads";

import { delegatedThreadStatus } from "./delegatedThreads.ts";
import type { EnvironmentThreadShell } from "./models.ts";

/** Shown wherever the pair control is disabled for the selected lead provider. */
export const PAIR_UNSUPPORTED_LEAD_REASON =
  "This provider cannot lead a pair yet, because Pylon cannot pause its own subagents. It works as the executor.";

export type PairExecutorPhase =
  | "idle"
  | "running"
  | "needs-approval"
  | "needs-input"
  | "completed"
  | "interrupted"
  | "error";

export type PairState =
  | { readonly kind: "unsupported-lead"; readonly reason: string }
  | { readonly kind: "off"; readonly executorId: ThreadId }
  | {
      readonly kind: "on";
      readonly executorId: ThreadId;
      readonly phase: PairExecutorPhase;
      readonly modelSelection: ModelSelection;
      /** The executor's last error, or the plan step it is on, trimmed for one line. */
      readonly activity: string | null;
    };

/** Mirrors the server's rule: Antigravity offers no control over its own subagents. */
export function isPairLeadSupported(driverKind: string | null | undefined): boolean {
  return driverKind !== "antigravity";
}

export function resolvePairState(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly lead: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly driverKind: string | null | undefined;
  };
}): PairState {
  if (!isPairLeadSupported(input.lead.driverKind)) {
    return { kind: "unsupported-lead", reason: PAIR_UNSUPPORTED_LEAD_REASON };
  }

  const executorId = pairExecutorThreadId(input.lead.threadId);
  const executor = input.threads.find(
    (thread) =>
      thread.id === executorId &&
      thread.environmentId === input.lead.environmentId &&
      thread.archivedAt === null,
  );
  if (executor === undefined) {
    return { kind: "off", executorId };
  }

  let phase: PairExecutorPhase;
  if (executor.session === null && executor.latestTurn === null) {
    phase = "idle";
  } else {
    const status = delegatedThreadStatus(executor);
    if (status === "starting") {
      phase = "running";
    } else if (status !== "archived") {
      phase = status;
    } else {
      phase = "idle";
    }
  }

  const rawActivity =
    phase === "error"
      ? executor.session?.lastError
      : phase === "running"
        ? executor.planProgress?.step
        : null;
  const activity = rawActivity?.replace(/\s+/g, " ").trim().slice(0, 160) || null;

  return {
    kind: "on",
    executorId,
    phase,
    modelSelection: executor.modelSelection,
    activity,
  };
}

/** Threads a list should show: an executor is reached through its lead, not the list. */
export function withoutPairExecutors<T extends { readonly id: ThreadId }>(
  threads: readonly T[],
): readonly T[] {
  return threads.filter((thread) => !isPairExecutorThreadId(thread.id));
}

export interface PairExecutorCreateInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: "default";
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

/** The `thread.create` fields that turn a pair on for a lead. */
export function pairExecutorCreateInput(input: {
  readonly lead: Pick<
    EnvironmentThreadShell,
    "id" | "projectId" | "title" | "runtimeMode" | "branch" | "worktreePath"
  >;
  readonly executorSelection: ModelSelection;
  /** The user's Child permissions setting. */
  readonly childRuntimeMode: "inherit" | "approval-required";
}): PairExecutorCreateInput {
  return {
    threadId: pairExecutorThreadId(input.lead.id),
    projectId: input.lead.projectId,
    title: `Executor · ${input.lead.title}`.slice(0, 200),
    modelSelection: input.executorSelection,
    runtimeMode:
      input.childRuntimeMode === "approval-required" ? "approval-required" : input.lead.runtimeMode,
    interactionMode: "default",
    branch: input.lead.branch,
    worktreePath: input.lead.worktreePath,
  };
}

/**
 * Why a lead cannot be rewound right now, or null. The executor works in the
 * lead's worktree, so one that holds a turn would write over the files a rewind
 * restores. The server interrupts it when a rewind is requested, but that lands
 * a moment late; the clients ask the user to stop it first.
 */
export function pairRewindBlockedReason(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly environmentId: EnvironmentId;
  readonly leadThreadId: ThreadId;
}): string | null {
  const state = resolvePairState({
    threads: input.threads,
    // Any lead that has an executor counts here, whatever its provider.
    lead: { environmentId: input.environmentId, threadId: input.leadThreadId, driverKind: null },
  });
  if (state.kind !== "on") {
    return null;
  }
  return state.phase === "running" ||
    state.phase === "needs-approval" ||
    state.phase === "needs-input"
    ? "Stop the executor before rewinding. It works in this thread's worktree and would write over the restored files."
    : null;
}

/** What the executor is doing, in the words every client uses. */
export function pairPhaseLabel(phase: PairExecutorPhase): string {
  switch (phase) {
    case "idle":
      return "Waiting for a brief";
    case "running":
      return "Working";
    case "needs-approval":
      return "Needs your approval";
    case "needs-input":
      return "Has a question";
    case "completed":
      return "Finished";
    case "interrupted":
      return "Stopped";
    case "error":
      return "Failed";
  }
}

/**
 * One line for a lead's thread screen: who it is paired with and what that
 * executor is doing. Null while the pair is off or cannot exist.
 */
export function pairStatusLine(state: PairState, executorLabel: string): string | null {
  if (state.kind !== "on") {
    return null;
  }
  return `Paired with ${executorLabel} · ${pairPhaseLabel(state.phase)}`;
}
