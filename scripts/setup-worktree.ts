// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Worktree setup, run by the t3.json "Setup Worktree" action as
 * `node scripts/setup-worktree.ts`. Plain Node keeps one command working in
 * every shell Pylon spawns (zsh, bash, fish, PowerShell): it installs
 * dependencies, links the main checkout's gitignored env files into this
 * worktree, then warms the web dependency cache.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const projectRoot = (() => {
  const root = process.env.T3CODE_PROJECT_ROOT;
  if (!root) {
    throw new Error("T3CODE_PROJECT_ROOT is not set. Run this through the t3.json setup action.");
  }
  return root;
})();
const worktree = NodePath.dirname(import.meta.dirname);

function linkEnvFile(file: string) {
  const source = NodePath.join(projectRoot, file);
  if (!NodeFS.existsSync(source)) return;
  const target = NodePath.join(worktree, file);
  // Existing local settings (including a dangling link) belong to this
  // worktree. A setup rerun must never replace them.
  if (NodeFS.lstatSync(target, { throwIfNoEntry: false })) return;
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  try {
    NodeFS.symlinkSync(source, target, "file");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return;
    // Windows can deny file symlinks without Developer Mode. A private copy
    // still lets a newly created worktree start; reruns preserve that copy.
    if (
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Setup runs before Effect is installed.
      NodeOS.platform() !== "win32" ||
      !(error instanceof Error && "code" in error && error.code === "EPERM")
    ) {
      throw error;
    }
    try {
      NodeFS.copyFileSync(source, target, NodeFS.constants.COPYFILE_EXCL);
      process.stderr.write(
        `Copied ${file} because Windows denied a file symlink; rerun setup after source changes.\n`,
      );
    } catch (copyError) {
      if (!(copyError instanceof Error && "code" in copyError && copyError.code === "EEXIST")) {
        throw copyError;
      }
    }
  }
}

// `shell` resolves `vp` through PATH, including Windows command shims.
const install = NodeChildProcess.spawnSync("vp i", {
  cwd: worktree,
  shell: true,
  stdio: "inherit",
});
if (install.status !== 0) process.exit(install.status ?? 1);

// In the main checkout itself, relinking would replace the real env files.
if (NodeFS.realpathSync(projectRoot) !== NodeFS.realpathSync(worktree)) {
  for (const file of ENV_FILES) {
    linkEnvFile(file);
  }
}

const warm = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts")],
  { cwd: worktree, stdio: "inherit" },
);
process.exit(warm.status ?? 1);
