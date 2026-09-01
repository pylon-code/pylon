import * as ChildProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const packageRoot = process.env.PRIME_AGENT_RECOVERY_REAL_PACKAGE_ROOT;
const exactHead = "507a52239d3ace7bb2b2965ade7779988fdb6344";

const waitForExit = (child, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("subprocess exit timed out")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

const runCaptured = (command, args, options, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = ChildProcess.spawn(command, args, options);
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maximumBytes = 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("owner subprocess timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumBytes) child.kill("SIGTERM");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maximumBytes) child.kill("SIGTERM");
      else stderr.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve(output);
      else reject(new Error(`owner subprocess failed (${code}): ${errorOutput}`));
    });
  });

describe.skipIf(!packageRoot)("Prime Agent exact-head restart adoption subprocess", () => {
  it("adopts after the creating owner process exits and proves authoritative cleanup", async () => {
    const gitHead = ChildProcess.execFileSync("git", ["-C", packageRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    expect(gitHead).toBe(exactHead);

    const codingAgentRoot = Path.join(packageRoot, "packages", "coding-agent");
    const sdkEntry = Path.join(codingAgentRoot, "dist", "index.js");
    const cliEntry = Path.join(codingAgentRoot, "dist", "bundle", "cli.js");
    const temp = await FSP.mkdtemp(Path.join(OS.tmpdir(), "pylon-prime-restart-"));
    const socket = Path.join(temp, "daemon.sock");
    const sessionDir = Path.join(temp, "sessions");
    const agentDir = Path.join(temp, "agent-home");
    await FSP.mkdir(sessionDir, { recursive: true });
    await FSP.mkdir(agentDir, { recursive: true });
    const launchEnv = {
      HOME: process.env.HOME ?? temp,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PRIME_AGENT_CODING_AGENT_DIR: agentDir,
    };
    const daemon = ChildProcess.spawn(
      process.execPath,
      [
        cliEntry,
        "--mode",
        "daemon",
        "--daemon-socket",
        socket,
        "--offline",
        "--session-dir",
        sessionDir,
      ],
      { env: launchEnv, stdio: ["ignore", "ignore", "pipe"] },
    );
    const daemonErrors = [];
    daemon.stderr.on("data", (chunk) => daemonErrors.push(chunk));

    try {
      const helper = Path.join(temp, "create-owner.mjs");
      await FSP.writeFile(
        helper,
        `import { randomUUID } from "node:crypto";
import { DaemonClient, createRecoverableOwnedSession } from ${JSON.stringify(pathToFileURL(sdkEntry).href)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const client = new DaemonClient(${JSON.stringify(socket)});
let connected = false;
for (let attempt = 0; attempt < 80; attempt += 1) {
  try { await client.connect(); connected = true; break; } catch { await sleep(25); }
}
if (!connected) throw new Error("daemon readiness timed out");
await client.waitForHello();
const config = ${JSON.stringify({ cwd: temp, sessionDir, noBuiltinTools: true, noExtensions: true, noSkills: true, noContextFiles: true })};
const created = await createRecoverableOwnedSession(client, {
  requestId: randomUUID(), correlationId: "correlation-real-1", mcpOwnerId: "pylon:mcp-real-1",
  config, continueRecent: false, launchEnv: ${JSON.stringify(launchEnv)},
  connectionOptions: { closeClientOnDispose: false, supportsExtensionUi: true },
});
await created.connection.submitCorrelatedPrompt("/help", {
  correlationId: "correlation-real-1",
  queueIfBusy: true,
});
for (let attempt = 0; attempt < 80; attempt += 1) {
  const lifecycles = await created.connection.getPromptLifecycles();
  if (lifecycles.records?.some((entry) => entry.correlationId === "correlation-real-1") ||
      lifecycles.expired?.some((entry) => entry.correlationId === "correlation-real-1")) break;
  await sleep(25);
}
const snapshot = await created.connection.getInitialSnapshot();
process.stdout.write(JSON.stringify({
  recoveryHandle: created.recoveryHandle,
  supervisorGeneration: created.supervisorGeneration,
  activeSessionId: created.state.activeSessionId,
  sessionId: created.state.sessionId,
  cursor: snapshot.lastEventCursor,
  config,
}));
client.close();
`,
        "utf8",
      );

      const authority = JSON.parse(
        await runCaptured(
          process.execPath,
          [helper],
          { env: launchEnv, stdio: ["ignore", "pipe", "pipe"] },
          20_000,
        ),
      );
      expect(authority.cursor).toEqual(
        expect.objectContaining({ generation: expect.any(String), sequence: expect.any(Number) }),
      );

      const sdk = await import(pathToFileURL(sdkEntry).href);
      const client = new sdk.DaemonClient(socket);
      await client.connect();
      const hello = await client.waitForHello();
      expect(hello.supervisorGeneration).toBe(authority.supervisorGeneration);
      const adoptionRequestId = randomUUID();
      const adopted = await sdk.adoptRecoverableOwnedSession(client, {
        requestId: adoptionRequestId,
        recoveryHandle: authority.recoveryHandle,
        expectedSupervisorGeneration: authority.supervisorGeneration,
        activeSessionId: authority.activeSessionId,
        sessionId: authority.sessionId,
        correlationId: "correlation-real-1",
        cursor: authority.cursor,
        previousMcpOwnerId: "pylon:mcp-real-1",
        mcpOwnerId: "pylon:mcp-real-2",
        config: authority.config,
        launchEnv,
        connectionOptions: { closeClientOnDispose: false, supportsExtensionUi: true },
      });
      expect(adopted.recoveryHandle).not.toBe(authority.recoveryHandle);
      expect(adopted.proof.ownershipGeneration).toBeGreaterThan(0);
      await sdk.confirmRecoverableOwnedSessionAdoption(client, {
        requestId: adoptionRequestId,
        recoveryHandle: adopted.recoveryHandle,
        proof: adopted.proof,
      });
      const cleanup = await adopted.connection.disposeOwnedSession({ timeoutMs: 10_000 });
      expect(["completed", "already_completed"]).toContain(cleanup.status);
      await client.request({ type: "shutdown" }, 5_000);
      client.close();
      const exit = await waitForExit(daemon, 10_000);
      expect(exit.code).toBe(0);
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGTERM");
      await waitForExit(daemon, 5_000).catch(() => undefined);
      await FSP.rm(temp, { recursive: true, force: true });
      if (daemon.exitCode && daemon.exitCode !== 0) {
        throw new Error(Buffer.concat(daemonErrors).toString("utf8"));
      }
    }
  }, 40_000);
});
