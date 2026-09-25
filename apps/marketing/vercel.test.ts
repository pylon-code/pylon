import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { config } from "./vercel.ts";

/**
 * The ignore command decides whether Vercel spends a build. It is a shell
 * string, so nothing type-checks it, and the previous version silently leaked:
 * a push to a new branch has no previously deployed commit and fell back to
 * comparing one commit, which built whenever that commit moved a lockfile.
 * Exercise it against a real repository rather than asserting on its text.
 */
describe("marketing ignore command", () => {
  let dir: string;
  let siteChanged: string;

  const run = (ref: string, previousSha: string): "skip" | "build" => {
    try {
      NodeChildProcess.execFileSync("bash", ["-c", config.ignoreCommand ?? ""], {
        cwd: NodePath.join(dir, "apps/marketing"),
        env: {
          ...process.env,
          VERCEL_GIT_COMMIT_REF: ref,
          ...(previousSha ? { VERCEL_GIT_PREVIOUS_SHA: previousSha } : {}),
        },
        stdio: "ignore",
      });
      return "skip";
    } catch {
      return "build";
    }
  };

  const commit = (message: string): string => {
    NodeChildProcess.execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    NodeChildProcess.execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "ignore" });
    return NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  };

  beforeAll(() => {
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pylon-marketing-ignore-"));
    NodeFS.mkdirSync(NodePath.join(dir, "apps/marketing/src"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(dir, "packages/shared"), { recursive: true });
    NodeChildProcess.execFileSync("git", ["init", "-q", "-b", "pylon"], {
      cwd: dir,
      stdio: "ignore",
    });
    NodeChildProcess.execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: dir,
      stdio: "ignore",
    });
    NodeChildProcess.execFileSync("git", ["config", "user.name", "Test"], {
      cwd: dir,
      stdio: "ignore",
    });
    NodeFS.writeFileSync(NodePath.join(dir, "pnpm-lock.yaml"), "lockfile: 1\n");
    NodeFS.writeFileSync(NodePath.join(dir, "pnpm-workspace.yaml"), "packages: []\n");
    NodeFS.writeFileSync(NodePath.join(dir, "apps/marketing/src/index.astro"), "<h1>one</h1>\n");
    commit("base");

    NodeFS.writeFileSync(NodePath.join(dir, "apps/marketing/src/index.astro"), "<h1>two</h1>\n");
    siteChanged = commit("touch the site");
  });

  afterAll(() => {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("spends a build only for a product-branch push that moved the site", () => {
    const base = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD^"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    expect(run("pylon", base)).toBe("build");
  });

  it("skips a product-branch push that left the site alone", () => {
    expect(run("pylon", siteChanged)).toBe("skip");
  });

  it("skips every other branch, even one that did move the site", () => {
    const base = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD^"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    expect(run("fix/unrelated", base)).toBe("skip");
  });

  it("skips a brand new branch, which has no previously deployed commit", () => {
    // The regression: with no VERCEL_GIT_PREVIOUS_SHA the diff falls back to
    // HEAD^, so any commit touching a lockfile used to buy a build.
    NodeFS.writeFileSync(NodePath.join(dir, "pnpm-lock.yaml"), "lockfile: 2\n");
    commit("bump the lockfile");
    expect(run("feat/brand-new", "")).toBe("skip");
  });
});
