// @effect-diagnostics nodeBuiltinImport:off - a one-off maintenance script with no
// Effect runtime; it only inspects files and optionally spawns vitest.
// Run with: node apps/server/scripts/update-test-shard-weights.ts [--heuristic]
// Runs the whole server suite once and records how long each test file takes,
// so CI can split the suite into shards of equal duration. See
// src/testUtils/weightedShardSequencer.ts. Rerun it when a shard in CI runs
// much longer than the others.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Files faster than this are all treated alike, which keeps the weights file short.
const MIN_RECORDED_SECONDS = 0.5;

interface VitestJsonReport {
  readonly testResults: ReadonlyArray<{
    readonly name: string;
    readonly startTime: number;
    readonly endTime: number;
  }>;
}

const serverDir = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const weightsPath = NodePath.join(serverDir, "src/testUtils/shardWeights.json");
// Pylon bootstrap: no CI timings are available and the full suite is expensive.
// --heuristic records one weight unit per 16 KiB of source, rounded to tenths,
// with a 0.5 minimum. These are relative cost estimates, not measured seconds.
// Omit the flag to replace them with local full-suite timings.
if (NodeProcess.argv.includes("--heuristic")) {
  const files = NodeFS.globSync("**/*.{test,spec}.?(c|m)[jt]s?(x)", {
    cwd: serverDir,
    exclude: ["node_modules/**", "dist/**", "dist-electron/**"],
  }).toSorted();
  const weights = Object.fromEntries(
    files.map((file) => [
      file.replaceAll("\\", "/"),
      Math.max(
        MIN_RECORDED_SECONDS,
        Math.round(NodeFS.statSync(NodePath.join(serverDir, file)).size / 1638.4) / 10,
      ),
    ]),
  );
  NodeFS.writeFileSync(weightsPath, `${JSON.stringify(weights, null, 2)}\n`);
} else {
  const reportDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-server-test-report-"));
  const reportPath = NodePath.join(reportDir, "report.json");

  // `node --run` puts the package's own `vp` on PATH, on every platform. Failing
  // tests still report their duration, so the exit code is not checked.
  NodeChildProcess.spawnSync(
    NodeProcess.execPath,
    ["--run", "test", "--", "--reporter=json", `--outputFile=${reportPath}`],
    { cwd: serverDir, stdio: "inherit" },
  );

  let report: VitestJsonReport;
  try {
    report = JSON.parse(NodeFS.readFileSync(reportPath, "utf8"));
  } finally {
    NodeFS.rmSync(reportDir, { recursive: true, force: true });
  }

  const weights = Object.fromEntries(
    report.testResults
      .map(
        (file) =>
          [
            NodePath.relative(serverDir, file.name).replaceAll("\\", "/"),
            Math.round((file.endTime - file.startTime) / 100) / 10,
          ] as const,
      )
      .filter(([, seconds]) => seconds >= MIN_RECORDED_SECONDS)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

  NodeFS.writeFileSync(weightsPath, `${JSON.stringify(weights, null, 2)}\n`);
}
