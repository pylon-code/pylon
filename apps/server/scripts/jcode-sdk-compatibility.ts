// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off - Standalone Node probe script, not an Effect runtime.
/**
 * Opt-in compatibility runner for the pinned Jcode SDK.
 *
 * This script is never part of a normal test run: it launches a real Jcode
 * runtime, so it needs a binary on the machine and, for the live-turn checks,
 * real model quota. It exists so the compatibility matrix in
 * `docs/internals/jcode-sdk-compatibility.md` can be reproduced on demand
 * instead of being asserted from memory.
 *
 * Usage:
 *
 * ```bash
 * JCODE_COMPAT_HOME=/tmp/jcode-compat node apps/server/scripts/jcode-sdk-compatibility.ts
 * JCODE_COMPAT_LIVE_TURNS=1 node apps/server/scripts/jcode-sdk-compatibility.ts
 * ```
 *
 * Every check writes one JSON line to stdout, and the process exits nonzero if
 * any required check fails. Only the public SDK is used: no TUI scraping, no
 * private daemon frames.
 */
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { JcodeClient, launchInstance, type LaunchedInstance } from "@1jehuang/jcode-sdk";

import { sanitizeJcodeLaunchEnvironment } from "../src/provider/jcode/JcodeEnvironment.ts";

type CheckStatus = "pass" | "fail" | "skipped";

interface CheckResult {
  readonly check: string;
  readonly status: CheckStatus;
  readonly required: boolean;
  readonly durationMs: number;
  readonly detail?: string;
  readonly data?: unknown;
}

const results: CheckResult[] = [];

function emit(result: CheckResult) {
  results.push(result);
  NodeProcess.stdout.write(`${JSON.stringify(result)}\n`);
}

async function check<A>(
  name: string,
  options: { readonly required?: boolean | undefined; readonly skip?: string | undefined },
  run: () => Promise<A>,
): Promise<A | undefined> {
  const required = options.required ?? true;
  if (options.skip !== undefined) {
    emit({ check: name, status: "skipped", required, durationMs: 0, detail: options.skip });
    return undefined;
  }

  const startedAt = Date.now();
  try {
    const data = await run();
    emit({
      check: name,
      status: "pass",
      required,
      durationMs: Date.now() - startedAt,
      data: data === undefined ? undefined : data,
    });
    return data;
  } catch (error) {
    emit({
      check: name,
      status: "fail",
      required,
      durationMs: Date.now() - startedAt,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return undefined;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * A stable home keeps sessions across runs, which is what makes the
 * detach/reattach check meaningful rather than a fresh-instance tautology.
 */
function resolveCompatHome(): string {
  const configured = NodeProcess.env.JCODE_COMPAT_HOME?.trim();
  if (configured) {
    NodeFs.mkdirSync(configured, { recursive: true, mode: 0o700 });
    return configured;
  }
  const fallback = NodePath.join(NodeOs.tmpdir(), "pylon-jcode-compat");
  NodeFs.mkdirSync(fallback, { recursive: true, mode: 0o700 });
  return fallback;
}

function makeWorkingDir(home: string, name: string): string {
  const dir = NodePath.join(home, "workspaces", name);
  NodeFs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function main(): Promise<number> {
  const binary = NodeProcess.env.JCODE_BINARY?.trim() || "jcode";
  const jcodeHome = resolveCompatHome();
  const inheritLogins = NodeProcess.env.JCODE_COMPAT_INHERIT_LOGINS !== "0";
  const liveTurns = NodeProcess.env.JCODE_COMPAT_LIVE_TURNS === "1";
  const liveSkip = liveTurns ? undefined : "set JCODE_COMPAT_LIVE_TURNS=1 (spends model quota)";
  const sanitizedEnv = sanitizeJcodeLaunchEnvironment(NodeProcess.env);

  emit({
    check: "environment",
    status: "pass",
    required: true,
    durationMs: 0,
    data: {
      binary,
      jcodeHome,
      inheritLogins,
      liveTurns,
      node: NodeProcess.version,
      platform: NodeProcess.platform,
      arch: NodeProcess.arch,
      sdkVersion: "1.1.0",
    },
  });

  let instance: LaunchedInstance | undefined;
  const clients: JcodeClient[] = [];

  try {
    instance = await check("launch_instance", {}, async () => {
      const launched = await launchInstance({
        binary,
        jcodeHome,
        inheritLogins,
        env: sanitizedEnv,
      });
      assert(
        typeof launched.socketPath === "string" && launched.socketPath.length > 0,
        "no socket",
      );
      return launched;
    });

    if (!instance) return 1;
    const launched = instance;
    const socketPath = launched.socketPath;

    const control = await check("connect_control_client", {}, async () => {
      const client = await JcodeClient.connect({
        socketPath,
        clientName: "pylon-jcode-compat/control",
      });
      clients.push(client);
      return client;
    });
    if (!control) return 1;

    await check("ping", {}, async () => {
      await control.ping();
      return { server: control.server, capabilities: control.capabilities };
    });

    const sessions = await check("create_sessions", {}, async () => {
      // A protocol-v1 connection owns exactly one attached session. Create the
      // two sessions through separate temporary clients, just as concurrent
      // Pylon threads use separate child connections.
      const [firstCreator, secondCreator] = await Promise.all([
        JcodeClient.connect({ socketPath, clientName: "pylon-jcode-compat/create-1" }),
        JcodeClient.connect({ socketPath, clientName: "pylon-jcode-compat/create-2" }),
      ]);
      try {
        const [first, second] = await Promise.all([
          firstCreator.createSession(makeWorkingDir(jcodeHome, "alpha")),
          secondCreator.createSession(makeWorkingDir(jcodeHome, "beta")),
        ]);
        assert(first.session_id !== second.session_id, "sessions share an id");
        return { first: first.session_id, second: second.session_id };
      } finally {
        await Promise.all([firstCreator.close(), secondCreator.close()]);
      }
    });
    if (!sessions) return 1;

    // The bridge allows one attachment per connection, so concurrent sessions
    // mean concurrent child clients. This is the shape Pylon's provider uses.
    const children = await check("attach_children_concurrently", {}, async () => {
      const [first, second] = await Promise.all([
        JcodeClient.connect({ socketPath, clientName: "pylon-jcode-compat/child-1" }),
        JcodeClient.connect({ socketPath, clientName: "pylon-jcode-compat/child-2" }),
      ]);
      clients.push(first, second);
      const [attachedFirst, attachedSecond] = await Promise.all([
        first.attachSession(sessions.first),
        second.attachSession(sessions.second),
      ]);
      assert(attachedFirst.session_id === sessions.first, "first attach bound the wrong session");
      assert(
        attachedSecond.session_id === sessions.second,
        "second attach bound the wrong session",
      );
      return { first, second };
    });
    if (!children) return 1;

    await check("list_models", {}, async () => {
      const models = await children.first.listModels(sessions.first);
      assert(Array.isArray(models.models), "models is not an array");
      return { count: models.models.length, current: models.current };
    });

    await check("runtime_info", {}, async () => {
      const info = await children.first.getRuntimeInfo(sessions.first);
      assert(info.healthy === true, "runtime reported unhealthy");
      assert(info.sessionId === sessions.first, "runtime info bound the wrong session");
      return {
        server: info.server,
        protocolVersion: info.protocolVersion,
        capabilities: info.capabilities,
        providers: info.providers,
        model: info.model,
      };
    });

    await check("detach_reattach_exact_session", {}, async () => {
      await children.first.detachSession(sessions.first);
      const reattached = await children.first.attachSession(sessions.first);
      assert(reattached.session_id === sessions.first, "reattach landed on another session");
      return { sessionId: reattached.session_id, status: reattached.status };
    });

    await check("live_text_turn", { skip: liveSkip }, async () => {
      const turn = await children.first.run(sessions.first, "Reply with exactly: ok");
      assert(turn.text.trim().length > 0, "empty assistant text");
      return { text: turn.text.slice(0, 200), usage: turn.usage };
    });

    await check("live_reasoning_turn", { skip: liveSkip }, async () => {
      const turn = await children.first.run(
        sessions.first,
        "Think step by step, then answer with only the number: 17 + 25",
      );
      return { reasoningLength: turn.reasoning.length, text: turn.text.slice(0, 200) };
    });

    await check("live_tool_turn", { skip: liveSkip }, async () => {
      const turn = await children.second.run(
        sessions.second,
        "List the files in the current directory using your tools, then say done.",
        { autoApprove: true },
      );
      return { toolCalls: turn.toolCalls.map(({ name, error }) => ({ name, error })) };
    });

    await check("live_image_turn", { skip: liveSkip }, async () => {
      // 1x1 transparent PNG, the smallest attachment that exercises the path.
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      const turn = await children.first.run(sessions.first, "Describe this image in one word.", {
        images: [["image/png", png]],
      });
      return { text: turn.text.slice(0, 200) };
    });

    await check("live_cancel_turn", { skip: liveSkip }, async () => {
      await children.second.sendMessage(sessions.second, "Count slowly from 1 to 500.");
      await children.second.cancel(sessions.second);
      return { cancelled: true };
    });

    await check("clean_shutdown", {}, async () => {
      for (const client of clients.splice(0)) {
        await client.close();
      }
      await launched.shutdown();
      instance = undefined;
      return { shutdown: true };
    });
  } finally {
    for (const client of clients.splice(0)) {
      await client.close().catch(() => {});
    }
    if (instance) {
      await instance.shutdown().catch(() => {});
    }
  }

  const failed = results.filter((result) => result.required && result.status === "fail");
  emit({
    check: "summary",
    status: failed.length === 0 ? "pass" : "fail",
    required: true,
    durationMs: 0,
    data: {
      pass: results.filter((result) => result.status === "pass").length,
      fail: results.filter((result) => result.status === "fail").length,
      skipped: results.filter((result) => result.status === "skipped").length,
    },
  });

  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    globalThis.process.exitCode = code;
  },
  (error: unknown) => {
    emit({
      check: "runner",
      status: "fail",
      required: true,
      durationMs: 0,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    globalThis.process.exitCode = 1;
  },
);
