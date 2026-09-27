// @effect-diagnostics nodeBuiltinImport:off - tests run the dependency-free Node setup script.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";

async function makeFixture() {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "pylon setup with spaces "),
  );
  const projectRoot = NodePath.join(directory, "main checkout");
  const worktree = NodePath.join(directory, "linked worktree");
  const bin = NodePath.join(directory, "fake bin");
  await NodeFSP.mkdir(NodePath.join(worktree, "scripts"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(worktree, "apps", "web", "scripts"), { recursive: true });
  await NodeFSP.mkdir(projectRoot, { recursive: true });
  await NodeFSP.mkdir(bin, { recursive: true });
  await NodeFSP.copyFile(
    new URL("./setup-worktree.ts", import.meta.url),
    NodePath.join(worktree, "scripts", "setup-worktree.ts"),
  );
  await NodeFSP.writeFile(
    NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts"),
    "require('node:fs').writeFileSync('warm-ran', 'yes');",
  );
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The fixture needs the host shell shim.
  if (NodeOS.platform() === "win32") {
    await NodeFSP.writeFile(
      NodePath.join(bin, "vp.cmd"),
      '@echo off\r\nif not "%1"=="i" exit /b 2\r\necho yes>install-ran\r\n',
    );
  } else {
    const vp = NodePath.join(bin, "vp");
    await NodeFSP.writeFile(vp, '#!/bin/sh\n[ "$1" = i ] || exit 2\nprintf yes > install-ran\n');
    await NodeFSP.chmod(vp, 0o755);
  }
  const run = (root: string | null = projectRoot) =>
    NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(worktree, "scripts", "setup-worktree.ts")],
      {
        cwd: worktree,
        encoding: "utf8",
        env: {
          ...process.env,
          T3CODE_PROJECT_ROOT: root ?? undefined,
          PATH: `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );
  return { directory, projectRoot, worktree, run };
}

it("preserves local env files, skips missing sources, and is safe to rerun", async () => {
  const fixture = await makeFixture();
  try {
    await NodeFSP.writeFile(NodePath.join(fixture.projectRoot, ".env"), "main-value");
    await NodeFSP.writeFile(NodePath.join(fixture.worktree, ".env"), "local-value");
    const first = fixture.run();
    assert.equal(first.status, 0);
    assert.equal(first.stderr, "");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(fixture.worktree, ".env"), "utf8"),
      "local-value",
    );
    assert.equal(
      NodeFS.existsSync(NodePath.join(fixture.worktree, "infra", "relay", ".env")),
      false,
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(fixture.worktree, "install-ran"), "utf8").trim(),
      "yes",
    );
    assert.equal(NodeFS.readFileSync(NodePath.join(fixture.worktree, "warm-ran"), "utf8"), "yes");

    await NodeFSP.writeFile(NodePath.join(fixture.projectRoot, ".env"), "new-main-value");
    const second = fixture.run();
    assert.equal(second.status, 0);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(fixture.worktree, ".env"), "utf8"),
      "local-value",
    );
  } finally {
    await NodeFSP.rm(fixture.directory, { recursive: true, force: true });
  }
});

it("uses the compatibility root variable with paths containing spaces", async () => {
  const fixture = await makeFixture();
  try {
    await NodeFSP.writeFile(NodePath.join(fixture.projectRoot, ".env"), "main-value");
    const relaySource = NodePath.join(fixture.projectRoot, "infra", "relay", ".env");
    await NodeFSP.mkdir(NodePath.dirname(relaySource), { recursive: true });
    await NodeFSP.writeFile(relaySource, "relay-value");
    const result = fixture.run();
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(fixture.worktree, ".env"), "utf8"),
      "main-value",
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(fixture.worktree, "infra", "relay", ".env"), "utf8"),
      "relay-value",
    );
    const rerun = fixture.run();
    assert.equal(rerun.status, 0);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(fixture.worktree, ".env"), "utf8"),
      "main-value",
    );
    const missingRoot = fixture.run(null);
    assert.notEqual(missingRoot.status, 0);
    assert.match(missingRoot.stderr, /T3CODE_PROJECT_ROOT is not set/);
  } finally {
    await NodeFSP.rm(fixture.directory, { recursive: true, force: true });
  }
});
