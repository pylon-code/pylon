import { GitCommandError, type VcsStatusLocalResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { prepareChildWorktree, removeChildWorktree } from "./worktree.ts";

const localStatus = (refName: string | null): VcsStatusLocalResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: refName === "main",
  refName,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
});

const gitError = (operation: string) =>
  new GitCommandError({
    operation,
    command: "git",
    cwd: "/repo",
    detail: `${operation} failed\nmore`,
  });

const makeFakeGit = (options: {
  readonly refName?: string | null;
  readonly remoteExists?: boolean;
  readonly remoteBranchExists?: boolean;
  readonly failCreate?: boolean;
  readonly failRemove?: boolean;
}) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (name: string) => Ref.update(calls, (all) => [...all, name]);
    const layer = Layer.mock(GitWorkflowService.GitWorkflowService)({
      localStatus: () =>
        record("localStatus").pipe(
          Effect.as(localStatus(options.refName === undefined ? "main" : options.refName)),
        ),
      remoteExists: () => record("remoteExists").pipe(Effect.as(options.remoteExists ?? true)),
      fetchRemote: () => record("fetchRemote"),
      remoteBranchExists: () =>
        record("remoteBranchExists").pipe(Effect.as(options.remoteBranchExists ?? true)),
      resolveRemoteTrackingCommit: () =>
        record("resolveRemoteTrackingCommit").pipe(
          Effect.as({ commitSha: "abc123", remoteRefName: "origin/main" }),
        ),
      createWorktree: (input) =>
        options.failCreate
          ? Effect.fail(gitError("createWorktree"))
          : record(
              `createWorktree:${input.refName}:${input.newRefName}:${input.baseRefName}:${input.path}`,
            ).pipe(
              Effect.as({
                worktree: {
                  path: `/wt/repo/${(input.newRefName ?? "none").replace("/", "-")}`,
                  refName: input.newRefName ?? "none",
                },
              }),
            ),
      removeWorktree: (input) =>
        record(`removeWorktree:${input.path}:${input.force}`).pipe(
          Effect.andThen(
            options.failRemove ? Effect.fail(gitError("removeWorktree")) : Effect.void,
          ),
        ),
    });
    return { calls, layer };
  });

const randomHex = () => "deadbeef";

describe("prepareChildWorktree", () => {
  it.effect("starts from origin when configured and the remote branch exists", () =>
    Effect.gen(function* () {
      const git = yield* makeFakeGit({});
      const result = yield* prepareChildWorktree({
        projectCwd: "/repo",
        parentBranch: null,
        startFromOrigin: true,
        randomHex,
      }).pipe(Effect.provide(git.layer));
      expect(result).toEqual({
        path: "/wt/repo/t3code-deadbeef",
        branch: "t3code/deadbeef",
        startedFromOrigin: true,
      });
      expect(yield* Ref.get(git.calls)).toEqual([
        "localStatus",
        "remoteExists",
        "fetchRemote",
        "remoteBranchExists",
        "resolveRemoteTrackingCommit",
        "createWorktree:abc123:t3code/deadbeef:main:null",
      ]);
    }),
  );

  it.effect("reports the created worktree path through the callback", () =>
    Effect.gen(function* () {
      const git = yield* makeFakeGit({});
      const reported: string[] = [];
      yield* prepareChildWorktree({
        projectCwd: "/repo",
        parentBranch: "main",
        startFromOrigin: false,
        randomHex,
        onWorktreeCreated: (path) => reported.push(path),
      }).pipe(Effect.provide(git.layer));
      expect(reported).toEqual(["/wt/repo/t3code-deadbeef"]);
    }),
  );

  it.effect("uses the local base when the remote branch is missing", () =>
    Effect.gen(function* () {
      const git = yield* makeFakeGit({ remoteBranchExists: false });
      const result = yield* prepareChildWorktree({
        projectCwd: "/repo",
        parentBranch: "feature/x",
        startFromOrigin: true,
        randomHex,
      }).pipe(Effect.provide(git.layer));
      expect(result.startedFromOrigin).toBe(false);
      expect(yield* Ref.get(git.calls)).toEqual([
        "remoteExists",
        "fetchRemote",
        "remoteBranchExists",
        "createWorktree:feature/x:t3code/deadbeef:feature/x:null",
      ]);
    }),
  );

  it.effect("uses the parent branch as base and skips origin when disabled", () =>
    Effect.gen(function* () {
      const git = yield* makeFakeGit({});
      const result = yield* prepareChildWorktree({
        projectCwd: "/repo",
        parentBranch: "feature/x",
        startFromOrigin: false,
        randomHex,
      }).pipe(Effect.provide(git.layer));
      expect(result.startedFromOrigin).toBe(false);
      expect(yield* Ref.get(git.calls)).toEqual([
        "createWorktree:feature/x:t3code/deadbeef:feature/x:null",
      ]);
    }),
  );

  it.effect("fails on a detached HEAD without touching git further", () =>
    Effect.gen(function* () {
      const git = yield* makeFakeGit({ refName: null });
      const error = yield* prepareChildWorktree({
        projectCwd: "/repo",
        parentBranch: null,
        startFromOrigin: true,
        randomHex,
      }).pipe(Effect.provide(git.layer), Effect.flip);
      expect(error._tag).toBe("DelegationWorktreeError");
      expect(error.detail).toContain("detached HEAD");
      expect(yield* Ref.get(git.calls)).toEqual(["localStatus"]);
    }),
  );

  it.effect("maps git failures to the first line of the git message", () =>
    Effect.gen(function* () {
      const git = yield* makeFakeGit({ failCreate: true });
      const error = yield* prepareChildWorktree({
        projectCwd: "/repo",
        parentBranch: "main",
        startFromOrigin: false,
        randomHex,
      }).pipe(Effect.provide(git.layer), Effect.flip);
      expect(error._tag).toBe("DelegationWorktreeError");
      expect(error.detail).not.toContain("\n");
    }),
  );
});

describe("removeChildWorktree", () => {
  it.effect("forces removal", () =>
    Effect.gen(function* () {
      const git = yield* makeFakeGit({});
      yield* removeChildWorktree({ projectCwd: "/repo", path: "/wt/repo/t3code-deadbeef" }).pipe(
        Effect.provide(git.layer),
      );
      expect(yield* Ref.get(git.calls)).toEqual(["removeWorktree:/wt/repo/t3code-deadbeef:true"]);
    }),
  );

  it.effect("never fails when git cannot remove the worktree", () =>
    Effect.gen(function* () {
      const git = yield* makeFakeGit({ failRemove: true });
      yield* removeChildWorktree({ projectCwd: "/repo", path: "/wt/repo/t3code-deadbeef" }).pipe(
        Effect.provide(git.layer),
      );
      expect(yield* Ref.get(git.calls)).toHaveLength(1);
    }),
  );
});
