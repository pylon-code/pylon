// @effect-diagnostics nodeBuiltinImport:off
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { ServerConfig } from "../config.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const MAX_PREIMAGE_ENTRIES = 20_000;
const MAX_PREIMAGE_BYTES = 512 * 1024 * 1024;

export class RollbackWorkspaceError extends Schema.TaggedErrorClass<RollbackWorkspaceError>()(
  "RollbackWorkspaceError",
  { code: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Rollback workspace operation failed (${this.code}).`;
  }
}

export interface RollbackWorkspaceIdentity {
  readonly cwd: string;
  readonly workspaceKey: string;
  readonly gitCommonDir: string;
}
export interface RollbackCheckpointIdentity {
  readonly oid: string;
  readonly digest: string;
}
export interface RollbackWorkspacePreimage {
  readonly backupPath: string;
  readonly digest: string;
  readonly indexPath: string;
  readonly indexExisted: boolean;
  readonly headSymbolic: string | null;
  readonly headOid: string | null;
  readonly ownedRefs: ReadonlyArray<{ readonly ref: string; readonly oid: string }>;
  readonly paths: ReadonlyArray<string>;
  readonly entryCount: number;
  readonly totalBytes: number;
}
export interface RollbackWorkspaceReceipt {
  readonly digest: string;
  readonly treeDigest: string;
  readonly headSymbolic: string | null;
  readonly headOid: string | null;
}

export interface RollbackWorkspaceShape {
  readonly resolveIdentity: (
    cwd: string,
  ) => Effect.Effect<RollbackWorkspaceIdentity, RollbackWorkspaceError>;
  readonly resolveCheckpoint: (input: {
    readonly cwd: string;
    readonly checkpointRef: string;
  }) => Effect.Effect<RollbackCheckpointIdentity, RollbackWorkspaceError>;
  readonly capturePreimage: (input: {
    readonly operationId: string;
    readonly cwd: string;
    readonly targetCheckpointOid: string;
  }) => Effect.Effect<RollbackWorkspacePreimage, RollbackWorkspaceError>;
  readonly restorePreimage: (input: {
    readonly cwd: string;
    readonly preimage: RollbackWorkspacePreimage;
  }) => Effect.Effect<RollbackWorkspaceReceipt, RollbackWorkspaceError>;
  readonly applyCheckpoint: (input: {
    readonly cwd: string;
    readonly checkpointOid: string;
  }) => Effect.Effect<RollbackWorkspaceReceipt, RollbackWorkspaceError>;
  readonly inspect: (
    cwd: string,
  ) => Effect.Effect<RollbackWorkspaceReceipt, RollbackWorkspaceError>;
  readonly inspectCheckpoint: (input: {
    readonly cwd: string;
    readonly checkpointOid: string;
  }) => Effect.Effect<RollbackWorkspaceReceipt, RollbackWorkspaceError>;
  readonly cleanupPreimage: (
    preimage: RollbackWorkspacePreimage,
  ) => Effect.Effect<void, RollbackWorkspaceError>;
}
export class RollbackWorkspace extends Context.Service<RollbackWorkspace, RollbackWorkspaceShape>()(
  "t3/rollback/RollbackWorkspace",
) {}

async function git(
  cwd: string,
  args: ReadonlyArray<string>,
  allowFailure = false,
  env?: Readonly<Record<string, string>>,
): Promise<string> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      windowsHide: true,
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
    return result.stdout;
  } catch (cause) {
    if (
      allowFailure &&
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === 1
    ) {
      return "";
    }
    throw cause;
  }
}

async function listMutablePaths(cwd: string): Promise<ReadonlyArray<string>> {
  const raw = await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return Array.from(new Set(raw.split("\0").filter(Boolean))).toSorted();
}

async function listCheckpointPaths(
  cwd: string,
  checkpointOid: string,
): Promise<ReadonlyArray<string>> {
  const raw = await git(cwd, ["ls-tree", "-r", "--name-only", "-z", checkpointOid]);
  return Array.from(new Set(raw.split("\0").filter(Boolean))).toSorted();
}

async function walkPaths(
  root: string,
  paths: ReadonlyArray<string>,
): Promise<{ entries: number; bytes: number; digest: string }> {
  const hash = NodeCrypto.createHash("sha256");
  let entries = 0;
  let bytes = 0;
  for (const relative of paths) {
    const absolute = NodePath.join(root, relative);
    const stat = await NodeFSP.lstat(absolute).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    });
    entries += 1;
    if (entries > MAX_PREIMAGE_ENTRIES) throw new Error("entry-bound");
    hash.update(relative);
    hash.update("\0");
    if (stat === null) {
      hash.update("missing\0");
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = await NodeFSP.readlink(absolute);
      hash.update("l\0");
      hash.update(target);
      hash.update("\0");
    } else if (stat.isFile()) {
      hash.update(String(stat.mode & 0o111));
      hash.update("\0");
      bytes += stat.size;
      if (bytes > MAX_PREIMAGE_BYTES) throw new Error("byte-bound");
      hash.update("f\0");
      hash.update(String(stat.size));
      hash.update("\0");
      await new Promise<void>((resolve, reject) => {
        const stream = NodeFS.createReadStream(absolute);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", resolve);
      });
      hash.update("\0");
    } else {
      throw new Error("unsupported-entry");
    }
  }
  return { entries, bytes, digest: hash.digest("hex") };
}

async function copyPaths(
  source: string,
  target: string,
  paths: ReadonlyArray<string>,
): Promise<void> {
  await NodeFSP.mkdir(target, { recursive: true, mode: 0o700 });
  for (const relative of paths) {
    const sourcePath = NodePath.join(source, relative);
    const exists = await NodeFSP.lstat(sourcePath).then(
      () => true,
      () => false,
    );
    if (!exists) continue;
    const targetPath = NodePath.join(target, relative);
    await NodeFSP.mkdir(NodePath.dirname(targetPath), { recursive: true, mode: 0o700 });
    await NodeFSP.cp(sourcePath, targetPath, {
      recursive: false,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      errorOnExist: false,
      force: true,
    });
  }
}

async function copyBackup(source: string, target: string): Promise<void> {
  await NodeFSP.mkdir(target, { recursive: true, mode: 0o700 });
  for (const name of await NodeFSP.readdir(source)) {
    await NodeFSP.cp(NodePath.join(source, name), NodePath.join(target, name), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      errorOnExist: false,
      force: true,
    });
  }
}

async function clearMutablePaths(
  cwd: string,
  extraPaths: ReadonlyArray<string> = [],
): Promise<void> {
  const paths = new Set([...(await listMutablePaths(cwd)), ...extraPaths]);
  for (const relative of paths) {
    await NodeFSP.rm(NodePath.join(cwd, relative), { recursive: true, force: true });
  }
}

async function restoreCheckpointRefs(
  cwd: string,
  ownedRefs: ReadonlyArray<{ readonly ref: string; readonly oid: string }>,
): Promise<void> {
  const currentRaw = await git(cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
    "refs/t3/checkpoints",
  ]);
  const currentRefs = currentRaw
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\0")[0] ?? "");
  const desired = new Map(ownedRefs.map((entry) => [entry.ref, entry.oid]));
  const commands = [
    ...currentRefs.filter((ref) => !desired.has(ref)).map((ref) => `delete ${ref}`),
    ...ownedRefs.map((entry) => `update ${entry.ref} ${entry.oid}`),
  ];
  if (commands.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      "git",
      ["update-ref", "--stdin"],
      { cwd, timeout: 30_000, windowsHide: true },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
    child.stdin?.end(`${commands.join("\n")}\n`);
  });
}

async function resolveHead(cwd: string): Promise<{ symbolic: string | null; oid: string | null }> {
  const symbolic = (await git(cwd, ["symbolic-ref", "-q", "HEAD"], true)).trim() || null;
  const oid =
    (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], true)).trim() || null;
  return { symbolic, oid };
}

async function resolveIndexPath(cwd: string): Promise<string> {
  const raw = (await git(cwd, ["rev-parse", "--git-path", "index"])).trim();
  return NodePath.isAbsolute(raw) ? raw : NodePath.resolve(cwd, raw);
}

async function resolveWorkspaceIdentity(cwd: string): Promise<RollbackWorkspaceIdentity> {
  const top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const commonRaw = (await git(cwd, ["rev-parse", "--git-common-dir"])).trim();
  const canonicalTop = await NodeFSP.realpath(top);
  const common = NodePath.isAbsolute(commonRaw) ? commonRaw : NodePath.resolve(cwd, commonRaw);
  const canonicalCommon = await NodeFSP.realpath(common);
  const workspaceKey = NodeCrypto.createHash("sha256")
    .update(canonicalCommon)
    .update("\0")
    .update(canonicalTop)
    .digest("hex");
  return { cwd: canonicalTop, workspaceKey, gitCommonDir: canonicalCommon };
}

async function writeWorkspaceTree(
  cwd: string,
  forcedPaths: ReadonlyArray<string>,
): Promise<string> {
  const gitPathRaw = (await git(cwd, ["rev-parse", "--git-path", "t3"])).trim();
  const privateGitPath = NodePath.isAbsolute(gitPathRaw)
    ? gitPathRaw
    : NodePath.resolve(cwd, gitPathRaw);
  await NodeFSP.mkdir(privateGitPath, { recursive: true, mode: 0o700 });
  const indexPath = NodePath.join(
    privateGitPath,
    `rollback-inspect-${NodeCrypto.randomUUID()}.index`,
  );
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await git(cwd, ["read-tree", "--empty"], false, env);
    await git(cwd, ["add", "-A", "--", "."], false, env);
    const existingForcedPaths: string[] = [];
    for (const relative of forcedPaths) {
      const exists = await NodeFSP.lstat(NodePath.join(cwd, relative)).then(
        (stat) => stat.isFile() || stat.isSymbolicLink(),
        () => false,
      );
      if (exists) existingForcedPaths.push(relative);
    }
    if (existingForcedPaths.length > 0) {
      await git(cwd, ["add", "-f", "--", ...existingForcedPaths], false, env);
    }
    return (await git(cwd, ["write-tree"], false, env)).trim();
  } finally {
    await NodeFSP.rm(indexPath, { force: true });
  }
}

async function inspectWorkspace(
  cwd: string,
  forcedPaths: ReadonlyArray<string> = [],
): Promise<RollbackWorkspaceReceipt> {
  const paths = Array.from(new Set([...(await listMutablePaths(cwd)), ...forcedPaths])).toSorted();
  const workspace = await walkPaths(cwd, paths);
  const indexPath = await resolveIndexPath(cwd);
  const hash = NodeCrypto.createHash("sha256");
  hash.update(workspace.digest);
  if (
    await NodeFSP.stat(indexPath).then(
      () => true,
      () => false,
    )
  )
    hash.update(await NodeFSP.readFile(indexPath));
  const head = await resolveHead(cwd);
  const treeDigest = await writeWorkspaceTree(cwd, forcedPaths);
  hash.update(head.symbolic ?? "");
  hash.update(head.oid ?? "");
  hash.update(treeDigest);
  return {
    digest: hash.digest("hex"),
    treeDigest,
    headSymbolic: head.symbolic,
    headOid: head.oid,
  };
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const run = <A>(code: string, body: () => Promise<A>) =>
    Effect.tryPromise({ try: body, catch: (cause) => new RollbackWorkspaceError({ code, cause }) });

  const resolveIdentity: RollbackWorkspaceShape["resolveIdentity"] = (cwd) =>
    run("identity", () => resolveWorkspaceIdentity(cwd));

  const resolveCheckpoint: RollbackWorkspaceShape["resolveCheckpoint"] = (input) =>
    run("checkpoint-identity", async () => {
      const oid = (
        await git(input.cwd, ["rev-parse", "--verify", `${input.checkpointRef}^{commit}`])
      ).trim();
      const digest = (await git(input.cwd, ["rev-parse", "--verify", `${oid}^{tree}`])).trim();
      if (!/^[0-9a-f]{40,64}$/u.test(oid) || !/^[0-9a-f]{40,64}$/u.test(digest))
        throw new Error("invalid-oid");
      return { oid, digest };
    });

  const capturePreimage: RollbackWorkspaceShape["capturePreimage"] = (input) =>
    run("preimage-capture", async () => {
      const identity = await resolveWorkspaceIdentity(input.cwd);
      const configuredBackupPath = NodePath.resolve(
        config.baseDir,
        "rollback-private",
        input.operationId,
      );
      const relativeBackupPath = NodePath.relative(identity.cwd, configuredBackupPath);
      const backupPath =
        relativeBackupPath !== "" &&
        !relativeBackupPath.startsWith(`..${NodePath.sep}`) &&
        relativeBackupPath !== ".."
          ? NodePath.join(identity.gitCommonDir, "t3", "rollback-private", input.operationId)
          : configuredBackupPath;
      await NodeFSP.rm(backupPath, { recursive: true, force: true });
      await NodeFSP.mkdir(backupPath, { recursive: true, mode: 0o700 });
      const mutablePaths = Array.from(
        new Set([
          ...(await listMutablePaths(identity.cwd)),
          ...(await listCheckpointPaths(identity.cwd, input.targetCheckpointOid)),
        ]),
      ).toSorted();
      const measured = await walkPaths(identity.cwd, mutablePaths);
      const workspaceBackup = NodePath.join(backupPath, "workspace");
      await copyPaths(identity.cwd, workspaceBackup, mutablePaths);
      const copied = await walkPaths(workspaceBackup, mutablePaths);
      if (copied.digest !== measured.digest) {
        throw new Error("copy-mismatch");
      }
      const indexPath = await resolveIndexPath(identity.cwd);
      const indexExisted = await NodeFSP.stat(indexPath).then(
        () => true,
        () => false,
      );
      if (indexExisted) await NodeFSP.copyFile(indexPath, NodePath.join(backupPath, "index"));
      const head = await resolveHead(identity.cwd);
      const refsRaw = await git(identity.cwd, [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)",
        "refs/t3/checkpoints",
      ]);
      const ownedRefs = refsRaw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [ref = "", oid = ""] = line.split("\0");
          return { ref, oid };
        });
      const receipt = await inspectWorkspace(identity.cwd, mutablePaths);
      return {
        backupPath,
        digest: receipt.digest,
        indexPath,
        indexExisted,
        headSymbolic: head.symbolic,
        headOid: head.oid,
        ownedRefs,
        paths: mutablePaths,
        entryCount: measured.entries,
        totalBytes: measured.bytes,
      };
    });

  const restorePreimage: RollbackWorkspaceShape["restorePreimage"] = (input) =>
    run("preimage-restore", async () => {
      const identity = await resolveWorkspaceIdentity(input.cwd);
      const beforeHead = await resolveHead(identity.cwd);
      if (
        beforeHead.symbolic !== input.preimage.headSymbolic ||
        beforeHead.oid !== input.preimage.headOid
      )
        throw new Error("head-drift");
      await clearMutablePaths(identity.cwd, input.preimage.paths);
      await copyBackup(NodePath.join(input.preimage.backupPath, "workspace"), identity.cwd);
      if (input.preimage.indexExisted) {
        await NodeFSP.mkdir(NodePath.dirname(input.preimage.indexPath), { recursive: true });
        await NodeFSP.copyFile(
          NodePath.join(input.preimage.backupPath, "index"),
          input.preimage.indexPath,
        );
      } else {
        await NodeFSP.rm(input.preimage.indexPath, { force: true });
      }
      await restoreCheckpointRefs(identity.cwd, input.preimage.ownedRefs);
      const receipt = await inspectWorkspace(identity.cwd, input.preimage.paths);
      if (receipt.digest !== input.preimage.digest) throw new Error("preimage-postcondition");
      return receipt;
    });

  const applyCheckpoint: RollbackWorkspaceShape["applyCheckpoint"] = (input) =>
    run("checkpoint-apply", async () => {
      const identity = await resolveWorkspaceIdentity(input.cwd);
      const beforeHead = await resolveHead(identity.cwd);
      const targetPaths = await listCheckpointPaths(identity.cwd, input.checkpointOid);
      const untracked = (
        await git(identity.cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
      )
        .split("\0")
        .filter(Boolean);
      for (const relative of new Set([...untracked, ...targetPaths])) {
        await NodeFSP.rm(NodePath.join(identity.cwd, relative), { recursive: true, force: true });
      }
      await git(identity.cwd, [
        "restore",
        "--source",
        input.checkpointOid,
        "--worktree",
        "--staged",
        "--",
        ".",
      ]);
      if (beforeHead.oid !== null) await git(identity.cwd, ["reset", "--quiet", "--", "."]);
      const receipt = await inspectWorkspace(identity.cwd, targetPaths);
      const targetTree = (
        await git(identity.cwd, ["rev-parse", "--verify", `${input.checkpointOid}^{tree}`])
      ).trim();
      if (receipt.headSymbolic !== beforeHead.symbolic || receipt.headOid !== beforeHead.oid)
        throw new Error("head-mutated");
      if (receipt.treeDigest !== targetTree) throw new Error("checkpoint-postcondition");
      return receipt;
    });

  const inspect: RollbackWorkspaceShape["inspect"] = (cwd) =>
    run("inspect", () => inspectWorkspace(cwd));
  const inspectCheckpoint: RollbackWorkspaceShape["inspectCheckpoint"] = (input) =>
    run("inspect-checkpoint", async () => {
      const paths = await listCheckpointPaths(input.cwd, input.checkpointOid);
      const receipt = await inspectWorkspace(input.cwd, paths);
      const targetTree = (
        await git(input.cwd, ["rev-parse", "--verify", `${input.checkpointOid}^{tree}`])
      ).trim();
      if (receipt.treeDigest !== targetTree) throw new Error("checkpoint-postcondition");
      return receipt;
    });
  const cleanupPreimage: RollbackWorkspaceShape["cleanupPreimage"] = (preimage) =>
    run("cleanup", () => NodeFSP.rm(preimage.backupPath, { recursive: true, force: true }));

  return RollbackWorkspace.of({
    resolveIdentity,
    resolveCheckpoint,
    capturePreimage,
    restorePreimage,
    applyCheckpoint,
    inspect,
    inspectCheckpoint,
    cleanupPreimage,
  });
});

export const layer = Layer.effect(RollbackWorkspace, make);
