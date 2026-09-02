// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";

import * as ServerConfig from "../config.ts";
import { RollbackWorkspace, layer as RollbackWorkspaceLive } from "./RollbackWorkspace.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const run = async (cwd: string, args: ReadonlyArray<string>) =>
  (await execFileAsync("git", [...args], { cwd, encoding: "utf8", timeout: 30_000 })).stdout.trim();

const layer = it.layer(
  RollbackWorkspaceLive.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-rollback-workspace-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

layer("RollbackWorkspace", (it) => {
  it.effect("applies an immutable target and restores the complete mutable Git pre-image", () =>
    Effect.acquireUseRelease(
      Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-rollback-git-"))),
      (cwd) =>
        Effect.gen(function* () {
          const workspace = yield* RollbackWorkspace;

          yield* Effect.promise(async () => {
            await run(cwd, ["init", "-b", "main"]);
            await run(cwd, ["config", "user.name", "Pylon Test"]);
            await run(cwd, ["config", "user.email", "pylon@example.test"]);
            await NodeFSP.writeFile(
              NodePath.join(cwd, ".gitignore"),
              ".private\nignored-target.txt\n",
            );
            await NodeFSP.writeFile(NodePath.join(cwd, "tracked.txt"), "base\n");
            await NodeFSP.writeFile(NodePath.join(cwd, "deleted.txt"), "delete me\n");
            await NodeFSP.writeFile(NodePath.join(cwd, "rename-old.txt"), "rename me\n");
            await run(cwd, ["add", "-A"]);
            await run(cwd, ["commit", "-m", "base"]);

            await NodeFSP.writeFile(NodePath.join(cwd, "tracked.txt"), "target\n");
            await NodeFSP.writeFile(NodePath.join(cwd, "target-added.txt"), "target added\n");
            await NodeFSP.writeFile(
              NodePath.join(cwd, "ignored-target.txt"),
              "target ignored path\n",
            );
            await NodeFSP.rm(NodePath.join(cwd, "deleted.txt"));
            await run(cwd, ["add", "-A"]);
            await run(cwd, ["add", "-f", "ignored-target.txt"]);
            const targetTree = await run(cwd, ["write-tree"]);
            const targetOid = await run(cwd, [
              "commit-tree",
              targetTree,
              "-m",
              "target checkpoint",
            ]);
            await run(cwd, ["update-ref", "refs/t3/checkpoints/thread-test/turn/1", targetOid]);
            await run(cwd, ["reset", "--hard", "HEAD"]);

            await NodeFSP.writeFile(NodePath.join(cwd, "tracked.txt"), "staged\n");
            await run(cwd, ["add", "tracked.txt"]);
            await NodeFSP.writeFile(NodePath.join(cwd, "tracked.txt"), "unstaged\n");
            await NodeFSP.rm(NodePath.join(cwd, "deleted.txt"));
            await run(cwd, ["mv", "rename-old.txt", "rename-new.txt"]);
            await NodeFSP.mkdir(NodePath.join(cwd, "nested"));
            await NodeFSP.writeFile(
              NodePath.join(cwd, "nested", "untracked.txt"),
              "untracked canary\n",
            );
            await NodeFSP.symlink("tracked.txt", NodePath.join(cwd, "link.txt"));
            await NodeFSP.writeFile(NodePath.join(cwd, ".private"), "ignored private canary\n");
            await NodeFSP.writeFile(
              NodePath.join(cwd, "ignored-target.txt"),
              "source ignored path\n",
            );
            await run(cwd, ["update-ref", "refs/t3/checkpoints/thread-test/turn/2", "HEAD"]);
          });

          const sourceStatus = yield* Effect.promise(() =>
            run(cwd, ["status", "--porcelain=v1", "-uall"]),
          );
          const sourceIndex = yield* Effect.promise(() => run(cwd, ["ls-files", "--stage", "-z"]));
          const sourceRefs = yield* Effect.promise(() =>
            run(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/t3/checkpoints"]),
          );
          const target = yield* workspace.resolveCheckpoint({
            cwd,
            checkpointRef: "refs/t3/checkpoints/thread-test/turn/1",
          });
          const preimage = yield* workspace.capturePreimage({
            operationId: "operation-workspace",
            cwd,
            targetCheckpointOid: target.oid,
          });
          assert.notEqual(preimage.digest.length, 0);
          assert.ok(!preimage.backupPath.startsWith(`${cwd}${NodePath.sep}`));
          const applied = yield* workspace.applyCheckpoint({ cwd, checkpointOid: target.oid });
          assert.notEqual(applied.digest, preimage.digest);
          assert.equal(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(cwd, "tracked.txt"), "utf8"),
            ),
            "target\n",
          );
          assert.equal(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(cwd, "target-added.txt"), "utf8"),
            ),
            "target added\n",
          );
          assert.equal(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(cwd, "ignored-target.txt"), "utf8"),
            ),
            "target ignored path\n",
          );
          assert.isFalse(
            yield* Effect.promise(() =>
              NodeFSP.stat(NodePath.join(cwd, "nested", "untracked.txt")).then(
                () => true,
                () => false,
              ),
            ),
          );
          assert.isFalse(
            yield* Effect.promise(() =>
              NodeFSP.stat(NodePath.join(cwd, "deleted.txt")).then(
                () => true,
                () => false,
              ),
            ),
          );
          assert.equal(
            yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(cwd, ".private"), "utf8")),
            "ignored private canary\n",
          );
          assert.equal(
            yield* Effect.promise(() => run(cwd, ["symbolic-ref", "HEAD"])),
            "refs/heads/main",
          );
          assert.equal(
            yield* Effect.promise(() =>
              run(cwd, ["rev-parse", "refs/t3/checkpoints/thread-test/turn/2"]),
            ),
            yield* Effect.promise(() => run(cwd, ["rev-parse", "HEAD"])),
          );

          yield* Effect.promise(async () => {
            await run(cwd, ["update-ref", "-d", "refs/t3/checkpoints/thread-test/turn/2"]);
            await run(cwd, ["update-ref", "refs/t3/checkpoints/rogue/turn/99", "HEAD"]);
          });
          const restored = yield* workspace.restorePreimage({ cwd, preimage });
          assert.equal(restored.digest, preimage.digest);
          assert.equal(
            yield* Effect.promise(() => run(cwd, ["status", "--porcelain=v1", "-uall"])),
            sourceStatus,
          );
          assert.equal(
            yield* Effect.promise(() => run(cwd, ["ls-files", "--stage", "-z"])),
            sourceIndex,
          );
          assert.equal(
            yield* Effect.promise(() =>
              run(cwd, [
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/t3/checkpoints",
              ]),
            ),
            sourceRefs,
          );
          assert.equal(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(cwd, "nested", "untracked.txt"), "utf8"),
            ),
            "untracked canary\n",
          );
          assert.equal(
            yield* Effect.promise(() => NodeFSP.readlink(NodePath.join(cwd, "link.txt"))),
            "tracked.txt",
          );
          assert.equal(
            yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(cwd, ".private"), "utf8")),
            "ignored private canary\n",
          );
          assert.equal(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(cwd, "ignored-target.txt"), "utf8"),
            ),
            "source ignored path\n",
          );

          yield* workspace.cleanupPreimage(preimage);
          assert.isFalse(
            yield* Effect.promise(() =>
              NodeFSP.stat(preimage.backupPath).then(
                () => true,
                () => false,
              ),
            ),
          );
        }),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    ),
  );

  it.effect("uses distinct leases and restores the index for a linked worktree", () =>
    Effect.acquireUseRelease(
      Effect.tryPromise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-rollback-linked-")),
      ),
      (root) =>
        Effect.gen(function* () {
          const workspace = yield* RollbackWorkspace;
          const main = NodePath.join(root, "main");
          const linked = NodePath.join(root, "linked");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(main);
            await run(main, ["init", "-b", "main"]);
            await run(main, ["config", "user.name", "Pylon Test"]);
            await run(main, ["config", "user.email", "pylon@example.test"]);
            await NodeFSP.writeFile(NodePath.join(main, "tracked.txt"), "base\n");
            await run(main, ["add", "tracked.txt"]);
            await run(main, ["commit", "-m", "base"]);
            await run(main, ["worktree", "add", "-b", "linked-branch", linked]);
            await NodeFSP.writeFile(NodePath.join(linked, "tracked.txt"), "checkpoint\n");
            await run(linked, ["add", "tracked.txt"]);
            const tree = await run(linked, ["write-tree"]);
            const checkpoint = await run(linked, ["commit-tree", tree, "-m", "linked checkpoint"]);
            await run(linked, ["update-ref", "refs/t3/checkpoints/linked/turn/1", checkpoint]);
            await run(linked, ["reset", "--hard", "HEAD"]);
            await NodeFSP.writeFile(NodePath.join(linked, "tracked.txt"), "linked pre-image\n");
            await run(linked, ["add", "tracked.txt"]);
            await NodeFSP.writeFile(NodePath.join(linked, "tracked.txt"), "linked unstaged\n");
          });

          const mainIdentity = yield* workspace.resolveIdentity(main);
          const linkedIdentity = yield* workspace.resolveIdentity(linked);
          assert.equal(mainIdentity.gitCommonDir, linkedIdentity.gitCommonDir);
          assert.notEqual(mainIdentity.workspaceKey, linkedIdentity.workspaceKey);

          const checkpoint = yield* workspace.resolveCheckpoint({
            cwd: linked,
            checkpointRef: "refs/t3/checkpoints/linked/turn/1",
          });
          const preimage = yield* workspace.capturePreimage({
            operationId: "operation-linked",
            cwd: linked,
            targetCheckpointOid: checkpoint.oid,
          });
          yield* workspace.applyCheckpoint({ cwd: linked, checkpointOid: checkpoint.oid });
          assert.equal(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(linked, "tracked.txt"), "utf8"),
            ),
            "checkpoint\n",
          );
          const restored = yield* workspace.restorePreimage({ cwd: linked, preimage });
          assert.equal(restored.digest, preimage.digest);
          assert.equal(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(linked, "tracked.txt"), "utf8"),
            ),
            "linked unstaged\n",
          );
          assert.equal(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(main, "tracked.txt"), "utf8"),
            ),
            "base\n",
          );
          yield* workspace.cleanupPreimage(preimage);
        }),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    ),
  );
});
