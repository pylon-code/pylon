// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import { expect, it } from "vite-plus/test";
import { parse } from "yaml";

const root = NodePath.resolve(import.meta.dirname, "..");
const workflowPath = NodePath.join(root, ".github/workflows/prime-artifact-graduation.yml");
const source = NodeFS.readFileSync(workflowPath, "utf8");
const workflow = parse(source) as Readonly<Record<string, unknown>>;
const publishingSurface =
  /\b(?:npm publish|gh release|git push|create-release|stable dispatch)\b/iu;
const skippedProof = /\b(?:it|describe)\.skip\b/u;

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be one mapping.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertNoPublishingOrSkippedProof(candidate: string): void {
  if (publishingSurface.test(candidate)) {
    throw new Error("Prime artifact graduation contains a publishing surface.");
  }
  if (skippedProof.test(candidate)) {
    throw new Error("Prime artifact graduation contains a skipped proof.");
  }
}

it("keeps Prime artifact graduation manual, protected, read-only, and immutable", () => {
  expect(workflow.name).toBe("Prime artifact graduation");
  const dispatch = record(record(workflow.on, "on").workflow_dispatch, "workflow_dispatch");
  const inputs = record(dispatch.inputs, "workflow_dispatch.inputs");
  expect(Object.keys(inputs).toSorted()).toEqual(["preview_tag", "second_preview_tag"]);
  expect(record(inputs.preview_tag, "preview_tag")).toMatchObject({
    required: true,
    type: "string",
  });
  expect(record(inputs.second_preview_tag, "second_preview_tag")).toMatchObject({
    required: false,
    default: "",
    type: "string",
  });
  expect(workflow.permissions).toEqual({ contents: "read" });
  const jobs = record(workflow.jobs, "jobs");
  const graduate = record(jobs.graduate, "jobs.graduate");
  expect(graduate.environment).toBe("prime-graduation");
  expect(graduate["runs-on"]).toBe("ubuntu-24.04");
});

it("pins every action and exposes no publishing or secret-bearing surface", () => {
  const uses = [...source.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1]!);
  expect(uses.length).toBeGreaterThanOrEqual(2);
  for (const action of uses) expect(action).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
  expect(source).not.toMatch(/\$\{\{\s*secrets\./u);
  expect(() => assertNoPublishingOrSkippedProof(source)).not.toThrow();
  expect(source).not.toContain("/releases/latest");
  expect(source).not.toMatch(/curl[^\n]*latest/iu);
});

it("checks out the exact public revision without credentials or traversing vendored gitlinks", () => {
  const graduate = record(record(workflow.jobs, "jobs").graduate, "graduate");
  if (!Array.isArray(graduate.steps)) throw new Error("Expected workflow steps.");
  const checkout = record(
    graduate.steps.find(
      (step: unknown) => record(step, "step").name === "Checkout exact Pylon revision",
    ),
    "checkout",
  );
  expect(checkout.env).toEqual({
    SOURCE_SHA: "${{ github.sha }}",
    REPOSITORY_URL: "https://github.com/pylon-code/pylon.git",
  });
  if (typeof checkout.run !== "string") throw new Error("Expected checkout script.");

  const fixture = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prime-graduation-checkout-"));
  const repository = NodePath.join(fixture, "repository");
  const workspace = NodePath.join(fixture, "workspace");
  const globalConfig = NodePath.join(fixture, "gitconfig");
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    NodeFS.mkdirSync(repository);
    NodeFS.mkdirSync(workspace);
    NodeFS.writeFileSync(globalConfig, "[credential]\n\thelper = forbidden-fixture-helper\n");
    git(repository, "init", "--quiet");
    NodeFS.writeFileSync(NodePath.join(repository, "source.txt"), "selected revision\n");
    git(repository, "add", "source.txt");
    git(repository, "commit", "--quiet", "-m", "Initial fixture");
    const gitlink = git(repository, "rev-parse", "HEAD");
    const vendoredPath = ".repos/alchemy-effect/.vendor/alchemy";
    git(repository, "update-index", "--add", "--cacheinfo", `160000,${gitlink},${vendoredPath}`);
    git(repository, "commit", "--quiet", "-m", "Unregistered vendored gitlink");
    const selectedSha = git(repository, "rev-parse", "HEAD");
    NodeFS.writeFileSync(NodePath.join(repository, "source.txt"), "later branch revision\n");
    git(repository, "commit", "--quiet", "-am", "Advance branch beyond selected revision");
    git(
      repository,
      "config",
      "--file",
      globalConfig,
      "url./missing-fixture-remote.insteadOf",
      repository,
    );
    const result = NodeChildProcess.spawnSync("bash", ["-c", checkout.run], {
      cwd: workspace,
      env: {
        ...env,
        GITHUB_REPOSITORY: "pylon-code/pylon",
        SOURCE_SHA: selectedSha,
        REPOSITORY_URL: repository,
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(git(workspace, "rev-parse", "HEAD")).toBe(selectedSha);
    expect(NodeFS.readFileSync(NodePath.join(workspace, "source.txt"), "utf8")).toBe(
      "selected revision\n",
    );
    expect(NodeFS.existsSync(NodePath.join(workspace, ".repos"))).toBe(false);
    expect(git(workspace, "ls-files", "--stage", vendoredPath)).toBe(
      `160000 ${gitlink} 0\t${vendoredPath}`,
    );
    expect(git(workspace, "config", "--local", "--list")).not.toMatch(
      /credential|extraheader|sshcommand/iu,
    );
    const oldCleanup = NodeChildProcess.spawnSync(
      "git",
      ["submodule", "foreach", "--recursive", "true"],
      {
        cwd: workspace,
        env,
        encoding: "utf8",
      },
    );
    expect(oldCleanup.status).not.toBe(0);
    expect(oldCleanup.stderr).toContain("No url found for submodule path");
  } finally {
    NodeFS.rmSync(fixture, { recursive: true, force: true });
  }
});

it("keeps mutation sentinels for publishing commands and skipped proofs", () => {
  for (const mutation of ["npm publish", "gh release create v1", 'it.skip("proof", () => {})']) {
    expect(() => assertNoPublishingOrSkippedProof(`${source}\n${mutation}\n`)).toThrow();
  }
});

it("downloads to runner temp, verifies before preview extraction, and runs every real proof", () => {
  const download = source.indexOf("download-preview");
  const verify = source.indexOf("verify-preview");
  const stockInstall = source.indexOf("npm install");
  const execute = source.indexOf("vp test run");
  expect(download).toBeGreaterThan(0);
  expect(verify).toBeGreaterThan(download);
  expect(stockInstall).toBeGreaterThan(verify);
  expect(execute).toBeGreaterThan(stockInstall);
  expect(source).toContain("$RUNNER_TEMP/prime-preview");
  expect(source).toContain(
    "${process.env.RUNNER_TEMP}/prime-stock/${PRIME_STOCK_ARTIFACT.assetName}",
  );
  expect(source).toContain(
    'import { PRIME_STOCK_ARTIFACT } from "./apps/server/src/provider/prime/PrimeAgentStockArtifact.ts"',
  );
  expect(source).toContain('"$PYLON_PRIME_STOCK_TARBALL"');
  expect(source).toContain("--ignore-scripts");
  expect(source).not.toContain("--passWithNoTests");
  expect(() => assertNoPublishingOrSkippedProof(source)).not.toThrow();
  expect(source).toContain("PYLON_PRIME_GRADUATION_REQUIRED=1");
  expect(source).toContain("assert-results");
  for (const testFile of [
    "PrimeAgentArtifactGraduation.integration.test.ts",
    "PrimeAgentDaemonBridge.test.ts",
    "PrimeAgentDriver.test.ts",
    "PrimeAgentRestartAdoption.real.test.mjs",
    "PrimeAgentMultipleInstances.integration.test.ts",
  ]) {
    expect(source).toContain(testFile);
  }
});

it("uploads only bounded summaries and makes the stable-approval run URL explicit", () => {
  const upload = source.slice(source.indexOf("Upload bounded graduation evidence"));
  expect(upload).toContain("verification.json");
  expect(upload).toContain("cases.json");
  expect(upload).toContain("graduation-summary.json");
  expect(upload).not.toContain("vitest.json");
  expect(upload).not.toMatch(/\.tgz|node_modules|provider-tools/u);
  expect(source).toContain("Run URL (required for stable approval)");
  expect(source).toContain("github.run_id");
});

it.each(["failed", "passed", "missing", "malformed"] as const)(
  "preserves secret-free diagnostics for a %s test report without changing the gate",
  (outcome) => {
    const graduate = record(record(workflow.jobs, "jobs").graduate, "graduate");
    if (!Array.isArray(graduate.steps)) throw new Error("Expected workflow steps.");
    const step = record(
      graduate.steps.find(
        (candidate: unknown) =>
          record(candidate, "step").name === "Preserve bounded test diagnostics",
      ),
      "diagnostics",
    );
    expect(step.if).toBe("always()");
    if (typeof step.run !== "string") throw new Error("Expected diagnostics script.");
    const upload = record(
      graduate.steps.find(
        (candidate: unknown) =>
          record(candidate, "step").name === "Upload bounded graduation evidence",
      ),
      "upload",
    );
    expect(upload.if).toBe("always()");
    expect(record(upload.with, "upload.with").path).toContain("test-summary.json");
    const fixture = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prime-graduation-summary-"));
    const directory = NodePath.join(fixture, "prime-graduation-results");
    try {
      NodeFS.mkdirSync(directory);
      const report = {
        numTotalTests: 1,
        numPassedTests: outcome === "passed" ? 1 : 0,
        numFailedTests: outcome === "failed" ? 1 : 0,
        numPendingTests: 0,
        testResults: [
          {
            name: "/private/sentinel/PrimeAgentMultipleInstances.integration.test.ts",
            status: outcome,
            message: "private-sentinel credential and socket",
            assertionResults: [
              {
                fullName: "private-sentinel prompt",
                status: outcome,
                failureMessages: ["private-sentinel timeout stack and token"],
              },
            ],
          },
        ],
      };
      if (outcome !== "missing") {
        NodeFS.writeFileSync(
          NodePath.join(directory, "vitest.json"),
          outcome === "malformed" ? "private-sentinel malformed JSON" : JSON.stringify(report),
        );
      }
      const result = NodeChildProcess.spawnSync("bash", ["-c", step.run], {
        env: { ...process.env, RUNNER_TEMP: fixture },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const output = NodeFS.readFileSync(NodePath.join(directory, "test-summary.json"), "utf8");
      expect(output + result.stdout + result.stderr).not.toMatch(
        /private|sentinel|credential|socket|token|stack/u,
      );
      if (outcome === "missing" || outcome === "malformed") {
        expect(JSON.parse(output)).toEqual({ status: "unavailable" });
      } else {
        expect(JSON.parse(output)).toEqual({
          status: "available",
          total: 1,
          passed: outcome === "passed" ? 1 : 0,
          failed: outcome === "failed" ? 1 : 0,
          skipped: 0,
          results: [
            {
              file: "PrimeAgentMultipleInstances.integration.test.ts",
              failed: outcome === "failed",
              failures: outcome === "failed" ? [{ index: 0, category: "timeout" }] : [],
            },
          ],
        });
      }
      expect(source).toContain("Assert the protected gate ran with zero skips");
      expect(source).not.toContain("continue-on-error");
    } finally {
      NodeFS.rmSync(fixture, { recursive: true, force: true });
    }
  },
);
