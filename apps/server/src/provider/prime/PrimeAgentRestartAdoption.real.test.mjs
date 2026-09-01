/* eslint-disable t3code/no-manual-effect-runtime-in-tests -- This opt-in POSIX proof drives two external server processes through their public RPC boundary. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { ORCHESTRATION_WS_METHODS, WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/unstable/socket/Socket";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { describe, expect, it } from "vite-plus/test";

import { persistPrimeManagedReceipt } from "./PrimeAgentDistributionVerifier.ts";

const packageRoot = NodeProcess.env.PRIME_AGENT_REAL_PACKAGE_ROOT?.trim();
const exactHead = "507a52239d3ace7bb2b2965ade7779988fdb6344";
const skipReason =
  NodeProcess.platform === "win32"
    ? "native Windows is unsupported; run the POSIX proof in WSL2 with a Linux PRIME_AGENT_REAL_PACKAGE_ROOT"
    : "set PRIME_AGENT_REAL_PACKAGE_ROOT to the built exact Prime checkout at 507a52239d3ace7bb2b2965ade7779988fdb6344";
const enabled = NodeProcess.platform !== "win32" && Boolean(packageRoot);
const outerSafetyMs = 120_000;
const maximumOutputBytes = 2 * 1024 * 1024;
const providerInstanceId = "primeAgent";
const modelSelection = {
  instanceId: providerInstanceId,
  model: "faux-adoption/faux-adoption",
};

const withSafetyCeiling = (promise, timeoutMs, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded its safety ceiling`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const waitForExit = (child, timeoutMs, label) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return withSafetyCeiling(
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    timeoutMs,
    label,
  );
};

const runCaptured = (command, args, options, timeoutMs, label) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, options);
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (effect) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      effect();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`${label} exceeded its safety ceiling`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumOutputBytes) {
        child.kill("SIGTERM");
        finish(() => reject(new Error(`${label} exceeded its stdout budget`)));
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maximumOutputBytes) {
        child.kill("SIGTERM");
        finish(() => reject(new Error(`${label} exceeded its stderr budget`)));
      } else {
        stderr.push(chunk);
      }
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      finish(() => {
        if (code === 0) resolve(output);
        else reject(new Error(`${label} failed (${code ?? signal}): ${errorOutput || output}`));
      });
    });
  });

const reserveEphemeralPort = () =>
  new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("ephemeral port reservation returned no TCP address"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const createGate = () => {
  let resolveGate;
  let settled = false;
  const promise = new Promise((resolve) => {
    resolveGate = resolve;
  });
  return {
    promise,
    settle: (value) => {
      if (settled) return false;
      settled = true;
      resolveGate(value);
      return true;
    },
    get settled() {
      return settled;
    },
  };
};

const startFixtureBackend = async () => {
  const firstAdmission = createGate();
  const secondAdmission = createGate();
  const firstConnectionClosed = createGate();
  const records = [];
  const sockets = new Set();
  let heldFirstResponse;

  const contentChunk = (content) =>
    `data: ${JSON.stringify({
      id: `fixture-${records.length}`,
      object: "chat.completion.chunk",
      created: 0,
      model: modelSelection.model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    })}\n\n`;
  const terminalChunks = () =>
    [
      `data: ${JSON.stringify({
        id: `fixture-${records.length}`,
        object: "chat.completion.chunk",
        created: 0,
        model: modelSelection.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
  const start = (response, content) => {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "close",
      "Cache-Control": "no-cache",
    });
    response.write(contentChunk(content));
  };
  const finish = (response, content) => {
    start(response, content);
    response.end(terminalChunks());
  };

  const messageText = (message) =>
    typeof message.content === "string"
      ? message.content
      : (message.content ?? [])
          .map((part) => (typeof part === "string" ? part : (part.text ?? "")))
          .join("");

  const server = NodeHttp.createServer((request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      response.end(JSON.stringify({ object: "list", data: [] }));
      return;
    }
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404, { Connection: "close" });
      response.end();
      return;
    }
    let buffered = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      buffered += chunk;
    });
    request.once("end", () => {
      const payload = JSON.parse(buffered);
      const authorization = request.headers.authorization ?? "";
      const workerPidMatch = /^Bearer (\d+)$/.exec(authorization);
      if (workerPidMatch === null) {
        response.destroy(
          new Error(`fixture request omitted its worker identity: ${authorization}`),
        );
        return;
      }
      const record = {
        callCount: records.length + 1,
        workerPid: Number(workerPidMatch[1]),
        messages: (payload.messages ?? []).map((message) => ({
          role: message.role,
          text: messageText(message),
        })),
      };
      records.push(record);
      if (record.callCount === 1) {
        heldFirstResponse = response;
        request.socket.once("close", () => firstConnectionClosed.settle());
        firstAdmission.settle(record);
        return;
      }
      if (record.callCount === 2) {
        secondAdmission.settle(record);
        finish(response, "SECOND_TURN_COMPLETE");
        return;
      }
      response.destroy(new Error(`unexpected fixture call ${record.callCount}`));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await withSafetyCeiling(
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("fixture backend returned no HTTP address"));
          return;
        }
        resolve(address.port);
      });
    }),
    5_000,
    "fixture backend listen",
  );
  return {
    port,
    records,
    firstAdmission: firstAdmission.promise,
    secondAdmission: secondAdmission.promise,
    firstConnectionClosed: firstConnectionClosed.promise,
    releaseFirst: () => {
      if (heldFirstResponse === undefined || heldFirstResponse.destroyed) {
        throw new Error("the first native provider request is not held");
      }
      start(heldFirstResponse, "FIRST_TURN_COMPLETE");
    },
    finishFirst: () => {
      if (heldFirstResponse === undefined || heldFirstResponse.destroyed) {
        throw new Error("the first native provider response cannot be finished");
      }
      heldFirstResponse.end(terminalChunks());
    },
    close: () =>
      withSafetyCeiling(
        new Promise((resolve, reject) => {
          for (const socket of sockets) socket.destroy();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
        5_000,
        "fixture backend close",
      ),
  };
};

const sanitizeServerEnvironment = (home) => {
  const environment = { ...NodeProcess.env };
  for (const name of Object.keys(environment)) {
    if (
      name.startsWith("PRIME_AGENT_INTERNAL_") ||
      name.startsWith("RLM_") ||
      name === "PRIME_AGENT_CODING_AGENT_DIR" ||
      name === "PI_CODING_AGENT_DIR" ||
      name === "PRIME_AGENT_REAL_PACKAGE_ROOT" ||
      name === "FORCE_COLOR" ||
      name === "VITEST" ||
      name.startsWith("VITEST_") ||
      name === "JEST_WORKER_ID" ||
      name === "NODE_CHANNEL_FD" ||
      name === "NODE_UNIQUE_ID"
    ) {
      delete environment[name];
    }
  }
  return {
    ...environment,
    HOME: home,
    SHELL: "/bin/sh",
    NO_COLOR: "1",
    T3CODE_LOG_LEVEL: "Debug",
    T3CODE_TRACE_TIMING_ENABLED: "false",
  };
};

const createPrimeFacade = async (temp, sourceRoot, sourceCommit, sourceTree) => {
  const codingAgentRoot = NodePath.join(sourceRoot, "packages", "coding-agent");
  const sdkEntry = NodePath.join(codingAgentRoot, "dist", "index.js");
  const cliEntry = NodePath.join(codingAgentRoot, "dist", "bundle", "cli.js");
  const aiEntry = NodePath.join(sourceRoot, "packages", "ai", "dist", "index.js");
  for (const required of [sdkEntry, cliEntry, aiEntry]) {
    await NodeFSP.access(required);
  }

  const facadeRoot = NodePath.join(temp, "prime-package");
  await NodeFSP.mkdir(facadeRoot, { recursive: true, mode: 0o700 });
  const executable = NodePath.join(facadeRoot, "prime-agent");
  const moduleEntry = NodePath.join(facadeRoot, "index.mjs");
  const buildId = `pylon-build-g${sourceCommit.slice(0, 12)}-r1`;
  await NodeFSP.writeFile(
    executable,
    `#!/usr/bin/env node\nprocess.argv[1] = ${JSON.stringify(cliEntry)};\nawait import(${JSON.stringify(NodeURL.pathToFileURL(cliEntry).href)});\n`,
    { mode: 0o700 },
  );
  await NodeFSP.writeFile(
    moduleEntry,
    `export * from ${JSON.stringify(NodeURL.pathToFileURL(sdkEntry).href)};\n`,
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(facadeRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "prime-agent",
        version: "0.8.1",
        type: "module",
        exports: "./index.mjs",
        bin: { "prime-agent": "./prime-agent" },
        pylonDistribution: {
          schemaVersion: 1,
          repository: "https://github.com/pylon-code/prime-agent",
          sourceCommit,
          sourceTree,
          buildId,
          recipeRevision: 1,
          node: "22.23.2",
          npm: "11.10.1",
          packageLockSha256: "0".repeat(64),
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { facadeRoot, executable, sdkEntry, aiEntry, buildId };
};

const writeFixtureModelConfig = async (agentHome, port) => {
  await NodeFSP.mkdir(agentHome, { recursive: true, mode: 0o700 });
  await NodeFSP.writeFile(
    NodePath.join(agentHome, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "faux-adoption": {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: "openai-completions",
            apiKey: '!printf "$PPID"',
            authHeader: true,
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              supportsUsageInStreaming: false,
              maxTokensField: "max_tokens",
            },
            models: [
              {
                id: "faux-adoption",
                name: "Faux Adoption",
                reasoning: false,
                input: ["text"],
                contextWindow: 128_000,
                maxTokens: 4_096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
};

const preparePylonState = async (
  baseDir,
  executable,
  agentHome,
  facadeRoot,
  buildId,
  sourceCommit,
  sourceTree,
) => {
  const stateDir = NodePath.join(baseDir, "userdata");
  await NodeFSP.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await NodeFSP.writeFile(
    NodePath.join(stateDir, "settings.json"),
    `${JSON.stringify(
      {
        enableProviderUpdateChecks: false,
        enableLegacyTokenStreaming: true,
        providers: {
          primeAgent: {
            enabled: true,
            binaryPath: executable,
            agentHomePath: agentHome,
            launchArgs: "",
            customModels: [modelSelection.model],
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await persistPrimeManagedReceipt({
    stateDir,
    instanceId: providerInstanceId,
    packageRoot: facadeRoot,
    platform: NodeProcess.platform,
    publication: {
      channel: "preview",
      sequenceEpoch: 1,
      sequence: 1,
      buildId,
      sourceCommit,
      sourceTree,
      recipeRevision: 1,
      rootAsset: "pylon-prime-agent-0.8.1.tgz",
      rootSha256: "1".repeat(64),
    },
  });
  return stateDir;
};

const spawnPylonServer = async ({ repoRoot, baseDir, projectDir, home, port, label }) => {
  const output = [];
  let outputBytes = 0;
  let pairingBuffer = "";
  const pairing = createGate();
  const child = NodeChildProcess.spawn(
    NodeProcess.execPath,
    [
      NodePath.join(repoRoot, "apps", "server", "src", "bin.ts"),
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      baseDir,
      projectDir,
    ],
    {
      cwd: repoRoot,
      env: sanitizeServerEnvironment(home),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const capture = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > maximumOutputBytes) {
      child.kill("SIGTERM");
      pairing.settle(Promise.reject(new Error(`${label} exceeded its output budget`)));
      return;
    }
    output.push(chunk);
    pairingBuffer += chunk.toString("utf8");
    const match = /Pairing URL:\s+(https?:\/\/[^\s]+#token=([^\s]+))/u.exec(pairingBuffer);
    if (match) pairing.settle({ pairingUrl: match[1], credential: match[2] });
    if (pairingBuffer.length > 128 * 1024) pairingBuffer = pairingBuffer.slice(-64 * 1024);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("error", (error) => {
    if (!pairing.settled) pairing.settle(Promise.reject(error));
  });
  child.once("exit", (code, signal) => {
    if (!pairing.settled) {
      pairing.settle(
        Promise.reject(
          new Error(
            `${label} exited before publishing pairing readiness (${code ?? signal}): ${Buffer.concat(output).toString("utf8")}`,
          ),
        ),
      );
    }
  });
  const access = await withSafetyCeiling(pairing.promise, 30_000, `${label} pairing readiness`);
  return {
    child,
    access,
    output: () => Buffer.concat(output).toString("utf8"),
    baseUrl: `http://127.0.0.1:${port}`,
  };
};

const fetchJson = async (url, options, label) => {
  const response = await withSafetyCeiling(fetch(url, options), 10_000, label);
  const text = await withSafetyCeiling(response.text(), 10_000, `${label} body`);
  if (!response.ok) throw new Error(`${label} returned ${response.status}: ${text}`);
  return text.length === 0 ? undefined : JSON.parse(text);
};

const exchangePairingCredential = (baseUrl, credential) =>
  fetchJson(
    `${baseUrl}/oauth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: credential,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        client_label: "Prime restart adoption proof",
        client_device_type: "desktop",
        client_os: NodeProcess.platform,
      }),
    },
    "pairing-token exchange",
  );

const issueWebSocketUrl = async (baseUrl, bearerToken) => {
  const issued = await fetchJson(
    `${baseUrl}/api/auth/websocket-ticket`,
    { method: "POST", headers: { authorization: `Bearer ${bearerToken}` } },
    "websocket ticket issuance",
  );
  const url = new URL(baseUrl.replace(/^http/u, "ws"));
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", issued.ticket);
  return url.toString();
};

const wsRpcProtocolLayer = (url) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(url).pipe(
        Layer.provide(
          Layer.succeed(
            Socket.WebSocketConstructor,
            (socketUrl, protocols) => new NodeSocket.NodeWS.WebSocket(socketUrl, protocols),
          ),
        ),
      ),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
const runRpc = (wsUrl, operation, label) =>
  withSafetyCeiling(
    Effect.runPromise(
      Effect.scoped(
        makeWsRpcClient.pipe(Effect.flatMap(operation), Effect.provide(wsRpcProtocolLayer(wsUrl))),
      ),
    ),
    15_000,
    label,
  );

const dispatch = (wsUrl, command, label) =>
  runRpc(wsUrl, (client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](command), label);

const readThreadSnapshot = (baseUrl, bearerToken, threadId) =>
  fetchJson(
    `${baseUrl}/api/orchestration/threads/${encodeURIComponent(threadId)}`,
    { headers: { authorization: `Bearer ${bearerToken}` } },
    "thread snapshot",
  );

const readDaemonState = async (sdkEntry, socketPath) => {
  const sdk = await import(NodeURL.pathToFileURL(sdkEntry).href);
  const client = new sdk.DaemonClient(socketPath);
  try {
    await client.connect(2_000);
    await client.waitForHello(2_000);
    const response = await client.request({ type: "list", includeClientOwned: true }, 3_000);
    if (response.success !== true || !Array.isArray(response.data?.sessions)) {
      throw new Error(`invalid Prime daemon list response: ${JSON.stringify(response)}`);
    }
    return response.data;
  } finally {
    client.close();
  }
};

const readLedger = (databasePath, threadId) => {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT thread_id, provider_instance_id, session_incarnation_id, admission_request_id,
                turn_id, package_root, active_session_id, native_session_id, recovery_handle,
                supervisor_generation, ownership_generation, cursor_generation, cursor_sequence,
                correlation_id, mcp_owner_id, owner_token, state
           FROM prime_agent_recovery_ledger WHERE thread_id = ?`,
      )
      .get(threadId);
  } finally {
    database.close();
  }
};

const readProviderSessionRuntime = (databasePath, threadId) => {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT provider_instance_id, status, runtime_payload_json
           FROM provider_session_runtime WHERE thread_id = ?`,
      )
      .get(threadId);
    if (row === undefined) return undefined;
    return {
      providerInstanceId: row.provider_instance_id,
      status: row.status,
      runtimePayload:
        typeof row.runtime_payload_json === "string" ? JSON.parse(row.runtime_payload_json) : {},
    };
  } finally {
    database.close();
  }
};

const waitForDurableActiveRuntime = async (databasePath, threadId, expected, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let observed;
  while (Date.now() < deadline) {
    observed = readProviderSessionRuntime(databasePath, threadId);
    if (
      observed?.status === "running" &&
      observed.providerInstanceId === providerInstanceId &&
      observed.runtimePayload.activeTurnId === expected.turnId &&
      observed.runtimePayload.activeTurnRequestId === expected.admissionRequestId &&
      observed.runtimePayload.sessionIncarnationId === expected.sessionIncarnationId
    ) {
      return observed;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `provider runtime did not become durably active before restart (status=${String(observed?.status)})`,
  );
};

const readRawThreadEvents = (databasePath, threadId) => {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT sequence, event_type, payload_json FROM orchestration_events WHERE stream_id = ? ORDER BY sequence",
      )
      .all(threadId)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
  } finally {
    database.close();
  }
};

const shutdownCapturedDaemon = async (sdkEntry, socketPath) => {
  if (sdkEntry === undefined || socketPath === undefined) return;
  try {
    const sdk = await import(NodeURL.pathToFileURL(sdkEntry).href);
    const client = new sdk.DaemonClient(socketPath);
    try {
      await client.connect(2_000);
      await client.waitForHello(2_000);
      const response = await client.request({ type: "shutdown" }, 3_000);
      if (response.success !== true) throw new Error("Prime daemon rejected shutdown");
    } finally {
      client.close();
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error.code === "ENOENT" ||
        (error instanceof Error && error.message.includes(`ENOENT ${socketPath}`)))
    ) {
      return;
    }
    throw error;
  }
};

const stopCaptured = async (server, signal = "SIGTERM") => {
  if (server === undefined) return;
  const { child } = server;
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  try {
    await waitForExit(child, 10_000, `captured Pylon ${signal} exit`);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForExit(child, 5_000, "captured Pylon forced exit").catch(() => undefined);
    throw error;
  }
};

const processExists = (pid) => {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") return false;
    throw error;
  }
};

const waitForProcessExit = async (pid, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) throw new Error(`${label} exceeded its safety ceiling`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const listSessionJsonlFiles = async (stateDir) => {
  const root = NodePath.join(stateDir, "provider-sessions", "prime-agent");
  const found = [];
  const visit = async (directory) => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  await visit(root);
  return found;
};

const runRestartedTurn = ({ wsUrl, threadId, fixture, onRecoveredActivity }) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeWsRpcClient;
        const synchronized = yield* Deferred.make();
        const firstAssistantMessage = yield* Deferred.make();
        const firstCheckpoint = yield* Deferred.make();
        const secondCheckpoint = yield* Deferred.make();
        const stopped = yield* Deferred.make();
        const items = [];
        let checkpointCount = 0;
        let stopRequested = false;

        yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({
          threadId,
          afterSequence: 0,
          requestCompletionMarker: true,
        }).pipe(
          Stream.runForEach((item) =>
            Effect.gen(function* () {
              items.push(item);
              if (item.kind === "synchronized") yield* Deferred.succeed(synchronized, undefined);
              if (item.kind !== "event") return;
              if (
                item.event.type === "thread.message-sent" &&
                item.event.payload.role === "assistant" &&
                item.event.payload.text === "FIRST_TURN_COMPLETE"
              ) {
                yield* Deferred.succeed(firstAssistantMessage, item.event);
              }
              if (item.event.type === "thread.turn-diff-completed") {
                checkpointCount += 1;
                if (checkpointCount === 1) yield* Deferred.succeed(firstCheckpoint, item.event);
                if (checkpointCount === 2) yield* Deferred.succeed(secondCheckpoint, item.event);
              }
              if (
                stopRequested &&
                item.event.type === "thread.session-set" &&
                item.event.payload.session.status === "stopped"
              ) {
                yield* Deferred.succeed(stopped, item.event);
              }
            }),
          ),
          Effect.forkScoped,
        );

        yield* Deferred.await(synchronized);
        expect(fixture.records).toHaveLength(1);
        yield* Effect.sync(() => fixture.releaseFirst());
        const firstAssistantMessageEvent = yield* Deferred.await(firstAssistantMessage);
        yield* Effect.tryPromise(() => onRecoveredActivity(firstAssistantMessageEvent));
        const firstCheckpointEvent = yield* Deferred.await(firstCheckpoint);

        const secondCommandId = `cmd-${NodeCrypto.randomUUID()}`;
        yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          type: "thread.turn.start",
          commandId: secondCommandId,
          threadId,
          message: {
            messageId: `message-${NodeCrypto.randomUUID()}`,
            role: "user",
            text: "second prompt proves exact native transcript continuity",
            attachments: [],
          },
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        });
        const secondCheckpointEvent = yield* Deferred.await(secondCheckpoint);

        stopRequested = true;
        yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          type: "thread.session.stop",
          commandId: `stop-${NodeCrypto.randomUUID()}`,
          threadId,
          createdAt: new Date().toISOString(),
        });
        const stoppedEvent = yield* Deferred.await(stopped);
        return { items, firstCheckpointEvent, secondCheckpointEvent, stoppedEvent };
      }).pipe(Effect.provide(wsRpcProtocolLayer(wsUrl))),
    ),
  );

describe.skipIf(!enabled)(
  `Prime Agent two-Pylon-server restart adoption (${enabled ? "enabled" : skipReason})`,
  () => {
    it(
      "adopts one live owned worker across the real server boundary and cleans it authoritatively",
      async () => {
        const repoRoot = NodePath.resolve(import.meta.dirname, "../../../../..");
        const sourceRoot = NodePath.resolve(packageRoot);
        const sourceHead = (
          await runCaptured(
            "git",
            ["-C", sourceRoot, "rev-parse", "HEAD"],
            { stdio: ["ignore", "pipe", "pipe"] },
            5_000,
            "Prime source HEAD",
          )
        ).trim();
        const sourceTree = (
          await runCaptured(
            "git",
            ["-C", sourceRoot, "rev-parse", "HEAD^{tree}"],
            { stdio: ["ignore", "pipe", "pipe"] },
            5_000,
            "Prime source tree",
          )
        ).trim();
        expect(sourceHead).toBe(exactHead);

        const temp = await NodeFSP.realpath(
          await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-two-server-adoption-")),
        );
        const home = NodePath.join(temp, "home");
        const baseDir = NodePath.join(temp, "server-home");
        const agentHome = NodePath.join(home, ".prime", "agent");
        const projectDir = NodePath.join(temp, "project");
        let fixture;
        let serverA;
        let serverB;
        let bearerToken;
        let daemonSocket;
        let primeSdkEntry;
        let workerPid;
        let secondWorkerPid;
        try {
          await Promise.all([
            NodeFSP.mkdir(home, { recursive: true, mode: 0o700 }),
            NodeFSP.mkdir(agentHome, { recursive: true, mode: 0o700 }),
            NodeFSP.mkdir(projectDir, { recursive: true, mode: 0o700 }),
          ]);
          await runCaptured(
            "git",
            ["init", "--initial-branch=main", projectDir],
            { stdio: ["ignore", "pipe", "pipe"], env: sanitizeServerEnvironment(home) },
            10_000,
            "fixture repository initialization",
          );
          await runCaptured(
            "git",
            [
              "-C",
              projectDir,
              "-c",
              "user.name=Pylon Test",
              "-c",
              "user.email=pylon@test.invalid",
              "commit",
              "--allow-empty",
              "-m",
              "fixture",
            ],
            { stdio: ["ignore", "pipe", "pipe"], env: sanitizeServerEnvironment(home) },
            10_000,
            "fixture repository seed commit",
          );

          fixture = await startFixtureBackend();
          const primeFacade = await createPrimeFacade(temp, sourceRoot, sourceHead, sourceTree);
          primeSdkEntry = primeFacade.sdkEntry;
          await writeFixtureModelConfig(agentHome, fixture.port);
          const stateDir = await preparePylonState(
            baseDir,
            primeFacade.executable,
            agentHome,
            primeFacade.facadeRoot,
            primeFacade.buildId,
            sourceHead,
            sourceTree,
          );
          const databasePath = NodePath.join(stateDir, "state.sqlite");
          daemonSocket = NodePath.join(
            NodeOS.tmpdir(),
            `pylon-prime-agent-${NodeCrypto.createHash("sha256")
              .update(`${NodePath.resolve(stateDir)}\0${providerInstanceId}`)
              .digest("hex")
              .slice(0, 20)}`,
            "daemon.sock",
          );
          const portA = await reserveEphemeralPort();
          serverA = await spawnPylonServer({
            repoRoot,
            baseDir,
            projectDir,
            home,
            port: portA,
            label: "server A",
          });
          const exchanged = await exchangePairingCredential(
            serverA.baseUrl,
            serverA.access.credential,
          );
          bearerToken = exchanged.access_token;
          expect(typeof bearerToken).toBe("string");
          const wsA = await issueWebSocketUrl(serverA.baseUrl, bearerToken);
          await runRpc(
            wsA,
            (client) => client[WS_METHODS.serverProbe]({}),
            "server A command readiness",
          );

          const projectId = `project-${NodeCrypto.randomUUID()}`;
          const threadId = `thread-${NodeCrypto.randomUUID()}`;
          const createdAt = new Date().toISOString();
          await dispatch(
            wsA,
            {
              type: "project.create",
              commandId: `project-command-${NodeCrypto.randomUUID()}`,
              projectId,
              title: "Two-server adoption proof",
              workspaceRoot: projectDir,
              defaultModelSelection: modelSelection,
              createdAt,
            },
            "project creation",
          );
          await dispatch(
            wsA,
            {
              type: "thread.create",
              commandId: `thread-command-${NodeCrypto.randomUUID()}`,
              threadId,
              projectId,
              title: "Restart adoption",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
              createdAt,
            },
            "thread creation",
          );
          const firstPrompt = "first prompt must be admitted once before owner A exits";
          await dispatch(
            wsA,
            {
              type: "thread.turn.start",
              commandId: `turn-command-${NodeCrypto.randomUUID()}`,
              threadId,
              message: {
                messageId: `message-${NodeCrypto.randomUUID()}`,
                role: "user",
                text: firstPrompt,
                attachments: [],
              },
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: new Date().toISOString(),
            },
            "first prompt admission",
          );

          const firstNativeRecord = await withSafetyCeiling(
            fixture.firstAdmission,
            5_000,
            "first native provider activity",
          );
          expect(firstNativeRecord.callCount).toBe(1);
          expect(
            firstNativeRecord.messages.filter((message) => message.text.includes(firstPrompt)),
          ).toHaveLength(1);
          const daemonStateA = await readDaemonState(primeFacade.sdkEntry, daemonSocket);
          expect(daemonStateA).toMatchObject({ sessions: [], busyClientOwnedSessionCount: 1 });
          workerPid = firstNativeRecord.workerPid;
          expect(workerPid).toEqual(expect.any(Number));
          const activeSnapshot = await readThreadSnapshot(serverA.baseUrl, bearerToken, threadId);
          expect(activeSnapshot.thread.id).toBe(threadId);
          if (activeSnapshot.thread.session.status !== "running") {
            throw new Error(
              `${JSON.stringify(activeSnapshot.thread.session)}\n${serverA.output()}`,
            );
          }
          expect(activeSnapshot.thread.session).toMatchObject({
            status: "running",
            providerInstanceId,
            activeTurnId: expect.any(String),
          });
          expect(
            activeSnapshot.thread.messages.filter((message) => message.text === firstPrompt),
          ).toHaveLength(1);

          const ledgerA = readLedger(databasePath, threadId);
          expect(ledgerA).toMatchObject({
            thread_id: threadId,
            provider_instance_id: providerInstanceId,
            turn_id: activeSnapshot.thread.session.activeTurnId,
            state: "active",
          });
          const sessionFilesBefore = await listSessionJsonlFiles(stateDir);
          expect(sessionFilesBefore).toHaveLength(1);
          expect(await NodeFSP.lstat(daemonSocket)).toMatchObject({});
          await waitForDurableActiveRuntime(
            databasePath,
            threadId,
            {
              turnId: ledgerA.turn_id,
              admissionRequestId: ledgerA.admission_request_id,
              sessionIncarnationId: ledgerA.session_incarnation_id,
            },
            5_000,
          );

          serverA.child.kill("SIGKILL");
          const ownerAExit = await waitForExit(serverA.child, 10_000, "server A abrupt exit");
          expect(ownerAExit.signal).toBe("SIGKILL");
          expect(processExists(workerPid)).toBe(true);
          expect(fixture.records).toHaveLength(1);
          expect(await readDaemonState(primeFacade.sdkEntry, daemonSocket)).toMatchObject({
            sessions: [],
            busyClientOwnedSessionCount: 1,
          });

          const portB = await reserveEphemeralPort();
          serverB = await spawnPylonServer({
            repoRoot,
            baseDir,
            projectDir,
            home,
            port: portB,
            label: "server B",
          });
          const wsB = await issueWebSocketUrl(serverB.baseUrl, bearerToken);
          await runRpc(
            wsB,
            (client) => client[WS_METHODS.serverProbe]({}),
            "server B command readiness after adoption",
          );
          expect(fixture.records).toHaveLength(1);
          if (!processExists(workerPid)) {
            throw new Error(
              `captured Prime worker ${workerPid} exited before recovered activity\n${serverB.output()}`,
            );
          }

          let ledgerB;
          const restarted = await withSafetyCeiling(
            runRestartedTurn({
              wsUrl: wsB,
              threadId,
              fixture,
              onRecoveredActivity: async () => {
                ledgerB = readLedger(databasePath, threadId);
                expect(ledgerB).toMatchObject({
                  thread_id: ledgerA.thread_id,
                  session_incarnation_id: ledgerA.session_incarnation_id,
                  admission_request_id: ledgerA.admission_request_id,
                  turn_id: ledgerA.turn_id,
                  active_session_id: ledgerA.active_session_id,
                  native_session_id: ledgerA.native_session_id,
                  supervisor_generation: ledgerA.supervisor_generation,
                  correlation_id: ledgerA.correlation_id,
                  state: "active",
                });
                expect(ledgerB.recovery_handle).not.toBe(ledgerA.recovery_handle);
                expect(ledgerB.owner_token).not.toBe(ledgerA.owner_token);
                expect(ledgerB.mcp_owner_id).not.toBe(ledgerA.mcp_owner_id);
                expect(ledgerB.ownership_generation).toBeGreaterThan(ledgerA.ownership_generation);
                expect(ledgerB.cursor_sequence).toBeGreaterThanOrEqual(ledgerA.cursor_sequence);
                const daemonStateB = await readDaemonState(primeFacade.sdkEntry, daemonSocket);
                expect(daemonStateB).toMatchObject({
                  sessions: [],
                  busyClientOwnedSessionCount: 1,
                });
                fixture.finishFirst();
              },
            }),
            60_000,
            "restarted turn completion and explicit stop",
          );
          const secondNativeRecord = await withSafetyCeiling(
            fixture.secondAdmission,
            10_000,
            "second native provider activity",
          );
          expect(fixture.records).toHaveLength(2);
          secondWorkerPid = secondNativeRecord.workerPid;
          expect(secondWorkerPid).not.toBe(workerPid);
          expect(
            secondNativeRecord.messages.filter((message) => message.text.includes(firstPrompt)),
          ).toHaveLength(1);
          expect(
            secondNativeRecord.messages.filter((message) =>
              message.text.includes("FIRST_TURN_COMPLETE"),
            ),
          ).toHaveLength(1);
          expect(
            secondNativeRecord.messages.filter((message) =>
              message.text.includes("second prompt proves exact native transcript continuity"),
            ),
          ).toHaveLength(1);

          const publicEvents = restarted.items.filter((item) => item.kind === "event");
          const persistedThreadEvents = readRawThreadEvents(databasePath, threadId);
          expect(
            persistedThreadEvents.filter(
              (event) => event.event_type === "thread.turn-start-requested",
            ),
          ).toHaveLength(2);
          const checkpointEvents = persistedThreadEvents.filter(
            (event) => event.event_type === "thread.turn-diff-completed",
          );
          expect(checkpointEvents).toHaveLength(2);
          expect(new Set(checkpointEvents.map((event) => event.payload.turnId)).size).toBe(2);
          expect(restarted.firstCheckpointEvent.payload.turnId).toBe(ledgerA.turn_id);
          expect(restarted.secondCheckpointEvent.payload.turnId).not.toBe(ledgerA.turn_id);
          expect(checkpointEvents.map((event) => event.payload.status)).toEqual(["ready", "ready"]);

          const finalSnapshot = await readThreadSnapshot(serverB.baseUrl, bearerToken, threadId);
          expect(finalSnapshot.thread.id).toBe(threadId);
          expect(finalSnapshot.thread.session).toMatchObject({
            status: "stopped",
            activeTurnId: null,
          });
          expect(
            finalSnapshot.thread.messages.filter((message) => message.text === firstPrompt),
          ).toHaveLength(1);
          expect(
            finalSnapshot.thread.messages.filter(
              (message) => message.text === "FIRST_TURN_COMPLETE",
            ),
          ).toHaveLength(1);
          expect(
            finalSnapshot.thread.messages.filter(
              (message) => message.text === "SECOND_TURN_COMPLETE",
            ),
          ).toHaveLength(1);
          expect(readLedger(databasePath, threadId)).toBeUndefined();
          expect(await listSessionJsonlFiles(stateDir)).toEqual(sessionFilesBefore);
          await waitForProcessExit(workerPid, 5_000, "adopted Prime worker exit after its turn");
          await waitForProcessExit(secondWorkerPid, 5_000, "second Prime worker exit after Stop");

          const publicSurface = JSON.stringify({ snapshot: finalSnapshot, events: publicEvents });
          const privateValues = [
            ledgerA.recovery_handle,
            ledgerB.recovery_handle,
            ledgerA.owner_token,
            ledgerB.owner_token,
            ledgerA.active_session_id,
            ledgerA.native_session_id,
            ledgerA.cursor_generation,
            ledgerA.correlation_id,
            ledgerA.mcp_owner_id,
            ledgerB.mcp_owner_id,
            primeFacade.facadeRoot,
            sourceRoot,
            home,
            agentHome,
            daemonSocket,
            serverA.access.credential,
            bearerToken,
            String(serverA.child.pid),
            String(serverB.child.pid),
            String(workerPid),
          ];
          for (const privateValue of privateValues) {
            expect(publicSurface).not.toContain(privateValue);
          }
          const logSafeResult = [serverA.output(), serverB.output()]
            .join("\n")
            .replace(/^.*(?:Pairing URL|Connection string):.*$/gmu, "[startup access redacted]");
          for (const privateValue of [
            ledgerA.recovery_handle,
            ledgerB.recovery_handle,
            ledgerA.owner_token,
            ledgerB.owner_token,
            ledgerA.active_session_id,
            ledgerA.native_session_id,
            ledgerA.cursor_generation,
            ledgerA.correlation_id,
            ledgerA.mcp_owner_id,
            ledgerB.mcp_owner_id,
            daemonSocket,
          ]) {
            expect(logSafeResult).not.toContain(privateValue);
          }

          await waitForProcessExit(workerPid, 5_000, "adopted Prime worker exit after its turn");
          await waitForProcessExit(secondWorkerPid, 5_000, "second Prime worker exit after Stop");
          await stopCaptured(serverB, "SIGTERM");
          serverB = undefined;
          await expect(NodeFSP.access(daemonSocket)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          await stopCaptured(serverB, "SIGTERM").catch(() => undefined);
          await stopCaptured(serverA, "SIGKILL").catch(() => undefined);
          if (fixture !== undefined) {
            await fixture.close().catch(() => undefined);
          }
          if (primeSdkEntry !== undefined && daemonSocket !== undefined) {
            await shutdownCapturedDaemon(primeSdkEntry, daemonSocket);
          }
          for (const [pid, label] of [
            [workerPid, "adopted Prime worker test cleanup"],
            [secondWorkerPid, "second Prime worker test cleanup"],
          ]) {
            if (pid !== undefined) await waitForProcessExit(pid, 5_000, label);
          }
          await NodeFSP.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      },
      outerSafetyMs,
    );
  },
);
