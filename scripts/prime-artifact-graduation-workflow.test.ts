// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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
  expect(uses.length).toBeGreaterThanOrEqual(3);
  for (const action of uses) expect(action).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
  expect(source).not.toMatch(/\$\{\{\s*secrets\./u);
  expect(() => assertNoPublishingOrSkippedProof(source)).not.toThrow();
  expect(source).not.toContain("/releases/latest");
  expect(source).not.toMatch(/curl[^\n]*latest/iu);
  expect(source).toContain("persist-credentials: false");
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
  expect(source).toContain("$RUNNER_TEMP/prime-stock/prime-agent-0.8.1.tgz");
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
