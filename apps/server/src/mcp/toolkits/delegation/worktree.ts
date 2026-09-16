/**
 * Worktrees for delegated child threads.
 *
 * Mirrors the websocket bootstrap sequence in `ws.ts` (base branch, optional
 * start from origin, temporary branch, `path: null`) without touching the
 * transport layer, which upstream changes often.
 *
 * @module mcp/toolkits/delegation/worktree
 */
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { DelegationWorktreeError } from "./tools.ts";

export interface PrepareChildWorktreeInput {
  readonly projectCwd: string;
  /** The parent thread's branch; null falls back to the project checkout's current branch. */
  readonly parentBranch: string | null;
  /** The project's `newWorktreesStartFromOrigin` setting. */
  readonly startFromOrigin: boolean;
  readonly randomHex: (byteLength: number) => string;
  /**
   * Called with the new worktree path in the same uninterruptible step that
   * creates it, so a caller's cleanup can always find a worktree that exists.
   */
  readonly onWorktreeCreated?: (path: string) => void;
}

export interface PreparedChildWorktree {
  readonly path: string;
  readonly branch: string;
  readonly startedFromOrigin: boolean;
}

const ORIGIN = "origin";

/** Git output can span lines and include local detail; the agent gets the first line only. */
const firstLine = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : String(cause);
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > 0 ? line : "unknown git error";
};

const toWorktreeError = (cause: unknown) =>
  new DelegationWorktreeError({ detail: firstLine(cause) });

export const prepareChildWorktree = Effect.fn("delegation.prepareChildWorktree")(function* (
  input: PrepareChildWorktreeInput,
) {
  const git = yield* GitWorkflowService.GitWorkflowService;

  const baseBranch =
    input.parentBranch ??
    (yield* git.localStatus({ cwd: input.projectCwd }).pipe(Effect.mapError(toWorktreeError)))
      .refName;
  if (baseBranch === null) {
    return yield* new DelegationWorktreeError({
      detail: "The project is on a detached HEAD; check out a branch first.",
    });
  }

  let baseRef = baseBranch;
  let startedFromOrigin = false;
  const remote = { cwd: input.projectCwd, remoteName: ORIGIN };
  if (
    input.startFromOrigin &&
    (yield* git.remoteExists(remote).pipe(Effect.mapError(toWorktreeError)))
  ) {
    yield* git.fetchRemote(remote).pipe(Effect.mapError(toWorktreeError));
    const remoteBaseExists = yield* git
      .remoteBranchExists({ ...remote, refName: baseBranch })
      .pipe(Effect.mapError(toWorktreeError));
    if (remoteBaseExists) {
      const resolved = yield* git
        .resolveRemoteTrackingCommit({
          cwd: input.projectCwd,
          refName: baseBranch,
          fallbackRemoteName: ORIGIN,
        })
        .pipe(Effect.mapError(toWorktreeError));
      baseRef = resolved.commitSha;
      startedFromOrigin = true;
    }
  }

  const created = yield* git
    .createWorktree({
      cwd: input.projectCwd,
      refName: baseRef,
      newRefName: buildTemporaryWorktreeBranchName(input.randomHex),
      baseRefName: baseBranch,
      path: null,
    })
    .pipe(
      Effect.tap((result) => Effect.sync(() => input.onWorktreeCreated?.(result.worktree.path))),
      Effect.uninterruptible,
      Effect.mapError(toWorktreeError),
    );

  const prepared: PreparedChildWorktree = {
    path: created.worktree.path,
    branch: created.worktree.refName,
    startedFromOrigin,
  };
  return prepared;
});

/** Best effort: a failed removal is logged, never surfaced, so cleanup can continue. */
export const removeChildWorktree = Effect.fn("delegation.removeChildWorktree")(function* (input: {
  readonly projectCwd: string;
  readonly path: string;
}) {
  const git = yield* GitWorkflowService.GitWorkflowService;
  yield* git
    .removeWorktree({ cwd: input.projectCwd, path: input.path, force: true })
    .pipe(Effect.ignoreCause({ log: true }));
});
