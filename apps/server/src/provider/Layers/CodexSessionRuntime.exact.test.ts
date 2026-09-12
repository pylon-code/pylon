// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { type ProviderEvent, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeCodexSessionRuntime, type CodexSessionRuntimeOptions } from "./CodexSessionRuntime.ts";

const SOURCE = "private-source";
const decodeLogEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optionalKey(Schema.String),
      params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      result: Schema.optionalKey(Schema.Unknown),
      error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
    }),
  ),
);
const markerPayload = Schema.Struct({ requestId: Schema.String });
const isMarkerPayload = Schema.is(markerPayload);

// The real runtime owns a real scoped stdio child. Only its executable is redirected
// to this isolated peer; lifecycle, protocol decoding, queues, and approval handlers run unchanged.
const PEER = String.raw`
import * as fs from "node:fs";
import * as readline from "node:readline";
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const cwd = process.cwd();
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => write({ id, result });
const log = (message) => fs.appendFileSync(config.logPath, JSON.stringify(message) + "\n");
const threads = new Map([["private-source", []], ["private-immutable", []]]);
const nativeRecords = new Map();
const loaded = new Set();
const nativePath = (threadId) => cwd + "/" + threadId + ".jsonl";
const nativeHeader = (threadId, sourceId) => ({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: {
  id: threadId, session_id: threadId, timestamp: "2026-01-01T00:00:00.000Z", cwd,
  context_window: { window_id: "window-" + threadId }, base_instructions: { text: "native proof fixture" },
  ...(sourceId ? { forked_from_id: sourceId } : {})
} });
const persistNative = (threadId, records) => {
  nativeRecords.set(threadId, records);
  fs.writeFileSync(nativePath(threadId), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
};
for (const threadId of threads.keys()) persistNative(threadId, [nativeHeader(threadId),
  ...(config.changedNative && threadId === "private-source" ? [{ timestamp: "2026-01-01T00:00:00.000Z", type: "world_state", payload: { full: true, state: { hidden: "changed model context" } } }] : [])
]);
const metadata = (threadId) => ({
  id: threadId, cwd, path: nativePath(threadId), ephemeral: false,
  status: { type: config.unloadedSnapshots && !loaded.has(threadId) ? "notLoaded" : "idle" }, turns: threads.get(threadId) ?? [],
  cliVersion: "test", createdAt: 1, updatedAt: 1, modelProvider: "openai", preview: "",
  sessionId: threadId, source: "appServer"
});
const opened = (threadId) => ({
  cwd: config.wrongCwd ? cwd + "/other" : cwd, model: "codex-test", modelProvider: "openai",
  approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" },
  thread: metadata(config.wrongIdentity ? "foreign-thread" : threadId)
});
const notification = (method, params) => write({ method, params });
const marker = (name, threadId = "private-source") => notification("serverRequest/resolved", { threadId, requestId: name });
const delta = (name, threadId = "private-source") => notification("item/agentMessage/delta", {
  threadId, turnId: "native-turn", itemId: "native-item", delta: name
});
let pendingOpen;
let pendingFeedback;
let requestSequence = 500;
const serverRequest = () => {
  const request = config.serverRequest;
  const id = ++requestSequence;
  write({ id, method: request.method, params: { threadId: "private-source", ...request.params } });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log(message);
  if (message.method === undefined) {
    if (pendingOpen !== undefined) {
      const id = pendingOpen;
      pendingOpen = undefined;
      reply(id, opened("private-source"));
    }
    if (pendingFeedback !== undefined) {
      const id = pendingFeedback;
      pendingFeedback = undefined;
      marker("approval-complete");
      reply(id, { threadId: "private-source" });
    }
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") return reply(id, { userAgent: "exact-test", codexHome: cwd, platformFamily: "unix", platformOs: "linux" });
  if (method === "initialized") return;
  if (method === "thread/resume" || method === "thread/start") {
    if (method === "thread/resume" && config.missingThread) return write({ id, error: { code: -32603, message: "thread not found" } });
    loaded.add(method === "thread/start" ? "fresh-thread" : params.threadId);
    if (config.startupTraffic) {
      notification("thread/started", { thread: metadata("private-source") });
      delta("startup-private-text");
      pendingOpen = id;
      serverRequest();
      return;
    }
    return reply(id, opened(method === "thread/start" ? "fresh-thread" : params.threadId));
  }
  if (method === "thread/read") return reply(id, { thread: metadata(params.threadId) });
  if (method === "thread/goal/get") return reply(id, { goal: config.nativeGoal ? { ...config.nativeGoal, threadId: params.threadId } : null });
  if (method === "thread/fork") {
    threads.set("private-fork", [...threads.get(params.threadId)]);
    persistNative("private-fork", [nativeHeader("private-fork", params.threadId), ...nativeRecords.get(params.threadId)]);
    loaded.add("private-fork");
    if (config.knownChildTraffic) {
      const usage = { totalTokens: 9, inputTokens: 5, cachedInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0 };
      notification("thread/tokenUsage/updated", { threadId: "known-child", turnId: "child-completed-turn", tokenUsage: { total: usage, last: usage, modelContextWindow: 100 } });
      marker("known-receiver-receipt", "known-receiver");
    }
    if (config.forkTraffic) {
      notification("thread/started", { thread: metadata("private-fork") });
      delta("private-fork-secret", "private-fork");
      notification("turn/started", { threadId: "private-fork", turn: { id: "private-fork-turn", status: "inProgress", items: [] } });
      delta("parent-during-fork");
    }
    return reply(id, { ...opened("private-fork"), thread: { ...metadata("private-fork"), forkedFromId: params.threadId } });
  }
  if (method === "feedback/upload") {
    if (params.reason === "register-children") {
      notification("item/completed", {
        threadId: "private-source", turnId: "parent-completed-turn", completedAtMs: 1,
        item: { id: "child-activity", type: "subAgentActivity", agentThreadId: "known-child", agentPath: "/root/child", kind: "interacted" }
      });
      notification("item/completed", {
        threadId: "private-source", turnId: "parent-completed-turn", completedAtMs: 1,
        item: { id: "receiver-call", type: "collabAgentToolCall", tool: "wait", status: "completed", senderThreadId: "private-source", receiverThreadIds: ["known-receiver"], agentsStates: {} }
      });
    }
    if (params.reason === "approval-race") {
      pendingFeedback = id;
      serverRequest();
      return;
    }
    if (params.reason === "unload-fork") loaded.delete("private-fork");
    if (params.reason === "after-fork") delta("late-private-fork-secret", "private-fork");
    delta(params.reason, params.threadId);
    if (params.reason === "queued") delta("second-queued", params.threadId);
    marker(params.reason + "-complete", params.threadId);
    return reply(id, { threadId: params.threadId });
  }
  if (method === "turn/start") return reply(id, { turn: { id: "new-native-turn", status: "inProgress", items: [] } });
  return write({ id, error: { code: -32601, message: "Unexpected method " + method } });
});
`;

const commandRequest = {
  method: "item/commandExecution/requestApproval",
  params: { turnId: "native-turn", itemId: "native-command", startedAtMs: 1, command: "echo test" },
};
const approvalRequests = [
  commandRequest,
  {
    method: "item/fileChange/requestApproval",
    params: { turnId: "native-turn", itemId: "native-file", startedAtMs: 1 },
  },
  {
    method: "mcpServer/elicitation/request",
    params: {
      turnId: "native-turn",
      serverName: "test",
      mode: "form",
      message: "Approve",
      requestedSchema: { type: "object", properties: {} },
    },
  },
  {
    method: "item/tool/requestUserInput",
    params: {
      turnId: "native-turn",
      itemId: "native-input",
      questions: [{ id: "question", header: "Choice", question: "Choose" }],
    },
  },
];

const makeHarness = Effect.fn("makeExactCodexRuntimeHarness")(function* (
  config: Schema.JsonObject = {},
  options: Pick<CodexSessionRuntimeOptions, "strictResume" | "quarantined" | "resumeCursor"> = {},
) {
  const cwd = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pylon-codex-exact-runtime-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(cwd, { recursive: true, force: true })),
  );
  const peerPath = NodePath.join(cwd, "peer.mjs");
  const configPath = NodePath.join(cwd, "config.json");
  const logPath = NodePath.join(cwd, "requests.jsonl");
  NodeFS.writeFileSync(peerPath, PEER);
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  NodeFS.writeFileSync(configPath, JSON.stringify({ ...config, logPath }));
  NodeFS.writeFileSync(logPath, "");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const uuidEntered = yield* Deferred.make<void>();
  const uuidReleased = yield* Deferred.make<void>();
  let gateNextUuid = false;
  const runtime = yield* makeCodexSessionRuntime({
    threadId: ThreadId.make("pylon-exact-runtime"),
    binaryPath: process.execPath,
    cwd,
    homePath: NodePath.join(cwd, "codex-home"),
    runtimeMode: "full-access",
    environment: {},
    ...(config.preflightProof
      ? {
          exactRecoverySnapshot: {
            threadId: "private-immutable",
            cwd,
            turns: [],
            rolloutPath: NodePath.join(cwd, "private-immutable.jsonl"),
            nativeRecords: [
              {
                type: "session_meta",
                payload: { cwd, base_instructions: { text: "native proof fixture" } },
              },
            ],
            nativeGoal: null,
          },
        }
      : {}),
    ...options,
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
      ...spawner,
      spawn: () =>
        spawner.spawn(
          ChildProcess.make(process.execPath, [peerPath, configPath], {
            cwd,
            extendEnv: false,
            env: {},
            forceKillAfter: "1 second",
          }),
        ),
    }),
    Effect.provideService(Crypto.Crypto, {
      ...crypto,
      randomUUIDv4: Effect.suspend(() => {
        if (!gateNextUuid) return crypto.randomUUIDv4;
        gateNextUuid = false;
        return Deferred.succeed(uuidEntered, undefined).pipe(
          Effect.andThen(Deferred.await(uuidReleased)),
          Effect.andThen(crypto.randomUUIDv4),
        );
      }),
    }),
  );
  NodeAssert.ok(runtime.absoluteConversation);
  return {
    runtime,
    absolute: runtime.absoluteConversation,
    uuidEntered,
    uuidReleased,
    armUuid: Effect.sync(() => {
      gateNextUuid = true;
    }),
    requests: () =>
      NodeFS.readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeLogEntry(line)),
  };
});

const collectThroughMarker = <E, R>(events: Stream.Stream<ProviderEvent, E, R>, name: string) =>
  events.pipe(
    Stream.takeUntil(
      (event) =>
        event.method === "serverRequest/resolved" &&
        isMarkerPayload(event.payload) &&
        event.payload.requestId === name,
    ),
    Stream.runCollect,
  );

describe("CodexSessionRuntime exact recovery", () => {
  it.effect("preflights unloaded selected and immutable native histories before resuming", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        { preflightProof: true, unloadedSnapshots: true },
        { strictResume: true, quarantined: true, resumeCursor: { threadId: SOURCE } },
      );
      yield* harness.runtime.start();
      const immutable = yield* harness.absolute.read("private-immutable");
      NodeAssert.equal(immutable.threadId, "private-immutable");
      NodeAssert.equal(immutable.nativeRecords.length, 1);
      const requests = harness.requests();
      const resumeIndex = requests.findIndex((entry) => entry.method === "thread/resume");
      NodeAssert.ok(resumeIndex > 0);
      NodeAssert.ok(
        requests
          .slice(0, resumeIndex)
          .some(
            (entry) =>
              entry.method === "thread/read" && entry.params?.threadId === "private-immutable",
          ),
      );
      NodeAssert.equal(requests.filter((entry) => entry.method === "thread/resume").length, 1);
      NodeAssert.equal(requests[resumeIndex]?.params?.threadId, "private-fork");
      NodeAssert.equal(
        requests.some(
          (entry) => entry.method === "thread/resume" && entry.params?.threadId === SOURCE,
        ),
        false,
      );
      NodeAssert.ok(
        requests
          .slice(0, resumeIndex)
          .some(
            (entry) =>
              entry.method === "thread/fork" && entry.params?.deferGoalContinuation === true,
          ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const change of [
    { changedNative: true },
    {
      nativeGoal: {
        objective: "externally activated goal",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  ])
    it.effect(
      `rejects changed exact native proof before any native resume ${JSON.stringify(change)}`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness(
            { preflightProof: true, unloadedSnapshots: true, ...change },
            { strictResume: true, quarantined: true, resumeCursor: { threadId: SOURCE } },
          );
          yield* harness.runtime.start().pipe(Effect.flip);
          NodeAssert.equal(
            harness
              .requests()
              .some((entry) => entry.method === "thread/resume" || entry.method === "thread/start"),
            false,
          );
          NodeAssert.ok(harness.requests().some((entry) => entry.method === "thread/goal/get"));
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

  it.effect(
    "preserves settled child usage and receiver receipts arriving during a private fork",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(
          { knownChildTraffic: true },
          { resumeCursor: { threadId: SOURCE } },
        );
        yield* harness.runtime.start();
        const registration = yield* collectThroughMarker(
          harness.runtime.events,
          "register-children-complete",
        ).pipe(Effect.forkScoped);
        yield* harness.runtime.uploadFeedback("register-children");
        yield* Fiber.join(registration);
        NodeAssert.equal(yield* harness.absolute.isIdle, true);
        const collected = yield* collectThroughMarker(
          harness.runtime.events,
          "after-fork-complete",
        ).pipe(Effect.forkScoped);
        const source = yield* harness.absolute.read();
        yield* harness.absolute.fork({ source });
        yield* harness.runtime.uploadFeedback("after-fork");
        const events = Array.from(yield* Fiber.join(collected));
        const childUsage = events.find((event) => event.method === "collabAgent/tokenUsage");
        NodeAssert.ok(childUsage);
        NodeAssert.ok(
          typeof childUsage.payload === "object" &&
            childUsage.payload !== null &&
            "agentThreadId" in childUsage.payload,
        );
        NodeAssert.equal(childUsage.payload.agentThreadId, "known-child");
        NodeAssert.equal(
          events.find(
            (event) =>
              isMarkerPayload(event.payload) &&
              event.payload.requestId === "known-receiver-receipt",
          )?.turnId,
          "parent-completed-turn",
        );
        NodeAssert.equal(
          events.some((event) => event.textDelta === "late-private-fork-secret"),
          false,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "suppresses private fork lifecycle frames while preserving ordinary parent output",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(
          { forkTraffic: true },
          { resumeCursor: { threadId: SOURCE } },
        );
        yield* harness.runtime.start();
        const collected = yield* collectThroughMarker(
          harness.runtime.events,
          "after-fork-complete",
        ).pipe(Effect.forkScoped);
        const source = yield* harness.absolute.read();
        yield* harness.absolute.fork({ source });
        yield* harness.runtime.uploadFeedback("after-fork");
        const events = Array.from(yield* Fiber.join(collected));
        NodeAssert.deepEqual(
          events.filter((event) => event.textDelta !== undefined).map((event) => event.textDelta),
          ["parent-during-fork", "after-fork"],
        );
        NodeAssert.equal(
          events.some(
            (event) =>
              event.method === "thread/started" ||
              event.method === "turn/started" ||
              event.method.startsWith("collabAgent/"),
          ),
          false,
        );
        NodeAssert.equal(yield* harness.absolute.isIdle, true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "does not create a fresh native thread when strict resume cannot find the saved thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(
          { missingThread: true },
          { strictResume: true, quarantined: true, resumeCursor: { threadId: SOURCE } },
        );
        const error = yield* harness.runtime.start().pipe(Effect.flip);
        NodeAssert.match(error.message, /thread not found/);
        NodeAssert.deepEqual(
          harness
            .requests()
            .filter((entry) => entry.method?.startsWith("thread/"))
            .map((entry) => entry.method),
          ["thread/resume"],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a missing strict resume cursor before creating a native thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({}, { strictResume: true, quarantined: true });
      yield* harness.runtime.start().pipe(Effect.flip);
      NodeAssert.equal(
        harness.requests().some((entry) => entry.method === "thread/start"),
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const config of [{ wrongIdentity: true }, { wrongCwd: true }]) {
    it.effect(`rejects strict resume metadata mismatch ${JSON.stringify(config)}`, () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(config, {
          strictResume: true,
          quarantined: true,
          resumeCursor: { threadId: SOURCE },
        });
        const error = yield* harness.runtime.start().pipe(Effect.flip);
        NodeAssert.match(error.message, /different conversation or workspace/);
        NodeAssert.equal(
          harness.requests().some((entry) => entry.method === "thread/start"),
          false,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect(
    "suppresses startup output and rejects startup approval before releasing recovery",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(
          { startupTraffic: true, serverRequest: commandRequest },
          { strictResume: true, quarantined: true, resumeCursor: { threadId: SOURCE } },
        );
        yield* harness.runtime.start();
        NodeAssert.equal(yield* harness.absolute.isIdle, true);
        NodeAssert.ok(harness.requests().find((entry) => entry.id === 501)?.error);
        yield* harness.absolute.quarantine(false);
        const collected = yield* collectThroughMarker(harness.runtime.events, "live-complete").pipe(
          Effect.forkScoped,
        );
        yield* harness.runtime.uploadFeedback("live");
        const events = Array.from(yield* Fiber.join(collected));
        NodeAssert.deepEqual(
          events.map((event) => event.method),
          ["item/agentMessage/delta", "serverRequest/resolved"],
        );
        NodeAssert.equal(events[0]?.textDelta, "live");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "drops both queued public events and in-flight native notifications across quarantine release",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({}, { resumeCursor: { threadId: SOURCE } });
        yield* harness.runtime.start();
        yield* harness.armUuid;
        const queued = yield* harness.runtime.uploadFeedback("queued").pipe(Effect.forkScoped);
        yield* Deferred.await(harness.uuidEntered);
        yield* Fiber.join(queued);
        yield* harness.absolute.quarantine(true);
        yield* harness.absolute.quarantine(false);
        yield* Deferred.succeed(harness.uuidReleased, undefined);
        const collected = yield* collectThroughMarker(harness.runtime.events, "live-complete").pipe(
          Effect.forkScoped,
        );
        yield* harness.runtime.uploadFeedback("live");
        const events = Array.from(yield* Fiber.join(collected));
        NodeAssert.deepEqual(
          events.map((event) => event.method),
          ["item/agentMessage/delta", "serverRequest/resolved"],
        );
        NodeAssert.equal(events[0]?.textDelta, "live");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const request of approvalRequests) {
    it.effect(
      `rejects ${request.method} that was received before quarantine and resumed after release`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness(
            { serverRequest: request },
            { resumeCursor: { threadId: SOURCE } },
          );
          yield* harness.runtime.start();
          const seen: Array<ProviderEvent> = [];
          const collected = yield* harness.runtime.events.pipe(
            Stream.tap((event) =>
              Effect.gen(function* () {
                seen.push(event);
                if (event.kind !== "request" || event.requestId === undefined) return;
                // A buggy handler leaks an approval and would otherwise wait forever.
                // Answer it so the peer supplies the same completion barrier on both paths.
                if (event.method === "item/tool/requestUserInput")
                  yield* harness.runtime.respondToUserInput(event.requestId, {});
                else yield* harness.runtime.respondToRequest(event.requestId, "decline");
              }),
            ),
            (events) => collectThroughMarker(events, "approval-complete"),
            Effect.forkScoped,
          );
          yield* harness.armUuid;
          const feedback = yield* harness.runtime
            .uploadFeedback("approval-race")
            .pipe(Effect.forkScoped);
          yield* Deferred.await(harness.uuidEntered);
          yield* harness.absolute.quarantine(true);
          yield* harness.absolute.quarantine(false);
          yield* Deferred.succeed(harness.uuidReleased, undefined);
          yield* Fiber.join(feedback);
          yield* Fiber.join(collected);
          NodeAssert.deepEqual(
            seen.filter((event) => event.kind === "request"),
            [],
          );
          NodeAssert.ok(harness.requests().find((entry) => entry.id === 501)?.error);
          NodeAssert.equal(yield* harness.absolute.isIdle, true);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("refuses an unloaded selected target without resuming its immutable history", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        { unloadedSnapshots: true },
        { strictResume: true, quarantined: true, resumeCursor: { threadId: SOURCE } },
      );
      yield* harness.runtime.start();
      const source = yield* harness.absolute.read();
      const fork = yield* harness.absolute.fork({ source });
      yield* harness.runtime.uploadFeedback("unload-fork");
      NodeAssert.ok(Exit.isFailure(yield* Effect.exit(harness.absolute.select(fork))));
      NodeAssert.deepEqual((yield* harness.runtime.getSession).resumeCursor, { threadId: SOURCE });
      NodeAssert.equal(
        harness.requests().filter((entry) => entry.method === "thread/resume").length,
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("selects a verified private fork and routes the next turn to its native identity", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        {},
        { strictResume: true, quarantined: true, resumeCursor: { threadId: SOURCE } },
      );
      yield* harness.runtime.start();
      const source = yield* harness.absolute.read();
      const fork = yield* harness.absolute.fork({ source });
      yield* harness.absolute.select(fork);
      NodeAssert.deepEqual((yield* harness.runtime.getSession).resumeCursor, {
        threadId: "private-fork",
      });
      yield* harness.absolute.quarantine(false);
      const sent = yield* harness.runtime.sendTurn({ input: "Continue after rollback" });
      NodeAssert.deepEqual(sent.resumeCursor, { threadId: "private-fork" });
      NodeAssert.equal(
        harness.requests().find((entry) => entry.method === "turn/start")?.params?.threadId,
        "private-fork",
      );
      NodeAssert.equal(
        harness
          .requests()
          .some((entry) => entry.method === "thread/rollback" || entry.method === "thread/revert"),
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
