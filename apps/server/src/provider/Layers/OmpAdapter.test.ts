// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  ApprovalRequestId,
  EnvironmentId,
  OmpSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const decodeRequestLogEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optionalKey(Schema.String),
      params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

async function makeMockOmpWrapper(input?: {
  readonly argvLogPath?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly stderrBytes?: number;
}) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-omp.sh");
  const exports = Object.entries(input?.environment ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const argvLog = input?.argvLogPath
    ? `printf '%s\t' "$@" >> ${JSON.stringify(input.argvLogPath)}
printf '\n' >> ${JSON.stringify(input.argvLogPath)}`
    : "";
  const stderrFlood = input?.stderrBytes
    ? `dd if=/dev/zero bs=1024 count=${Math.ceil(input.stderrBytes / 1024)} 1>&2 2>/dev/null`
    : "";
  const script = `#!/bin/sh
${exports}
${stderrFlood}
${argvLog}
exec bun ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-omp-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("OMP adapter starts a scoped ACP session with profile and runtime policy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-argv-")),
      );
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(argvLogPath, "", "utf8"));
      const binaryPath = yield* Effect.promise(() => makeMockOmpWrapper({ argvLogPath }));
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath, profile: "work" }));
      const threadId = ThreadId.make("omp-session");

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "default",
        },
      });

      assert.equal(session.provider, "omp");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
        initialModelId: "default",
      });
      assert.isUndefined(session.restored);
      assert.deepStrictEqual(
        (yield* Effect.promise(() => NodeFSP.readFile(argvLogPath, "utf8")))
          .trim()
          .split("\t")
          .filter(Boolean),
        ["acp", "--profile", "work", "--approval-mode", "yolo"],
      );
      const rollbackError = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      assert.equal(rollbackError._tag, "ProviderAdapterRequestError");

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("Oh My Pi drains provider stderr before ACP initialization", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ stderrBytes: 512 * 1024 }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }));
      const threadId = ThreadId.make("omp-stderr-backpressure");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "reply after stderr", attachments: [] });
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("Oh My Pi hands the thread-scoped Pylon MCP server to ACP", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-mcp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const binaryPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          environment: { T3_ACP_REQUEST_LOG_PATH: requestLogPath },
        }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }));
      const threadId = ThreadId.make("omp-mcp-handoff");
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("primary"),
        threadId,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("omp"),
        endpoint: "http://127.0.0.1:43210/mcp",
        authorizationHeader: "Bearer test-mcp-token",
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const requests = (yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8")))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeRequestLogEntry(line));
      expect(requests.find((request) => request.method === "session/new")?.params).toMatchObject({
        mcpServers: [
          {
            type: "http",
            name: "pylon",
            url: "http://127.0.0.1:43210/mcp",
            headers: [{ name: "Authorization", value: "Bearer test-mcp-token" }],
          },
        ],
      });
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("OMP adapter bridges standard ACP form elicitation to provider user input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ environment: { T3_ACP_EMIT_ELICITATION: "1" } }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }));
      const threadId = ThreadId.make("omp-elicitation");
      const requested = yield* Deferred.make<{
        readonly requestId: string;
        readonly questions: ReadonlyArray<{ readonly id: string }>;
      }>();
      const resolved = yield* Deferred.make<Record<string, unknown>>();

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.threadId !== threadId) return Effect.void;
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, {
            requestId: String(event.requestId),
            questions: event.payload.questions,
          }).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event.payload.answers).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "default",
        },
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask me", attachments: [] })
        .pipe(Effect.forkChild);

      const request = yield* Deferred.await(requested);
      assert.deepStrictEqual(
        request.questions.map((question) => question.id),
        ["strategy"],
      );
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(request.requestId), {
        strategy: "safe",
      });
      yield* Fiber.join(turnFiber);
      assert.deepStrictEqual(yield* Deferred.await(resolved), { strategy: "safe" });

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect(
  "OMP adapter cancels unsupported optionless elicitation without waiting for web input",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* Effect.promise(() =>
          makeMockOmpWrapper({
            environment: { T3_ACP_EMIT_UNSUPPORTED_ELICITATION: "1" },
          }),
        );
        const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }));
        const threadId = ThreadId.make("omp-unsupported-elicitation");
        let sawUserInputRequest = false;

        yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (event.threadId === threadId && event.type === "user-input.requested") {
            sawUserInputRequest = true;
          }
          return Effect.void;
        }).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          providerInstanceId: ProviderInstanceId.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("omp"),
            model: "default",
          },
        });

        // Completion proves the ACP request was answered immediately instead of
        // leaving the turn blocked on a prompt the web client cannot render.
        yield* adapter.sendTurn({ threadId, input: "ask for free text", attachments: [] });
        assert.isFalse(sawUserInputRequest);

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.provide(testLayer)),
    ),
);

it.effect("Oh My Pi stop is idempotent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }));
      const threadId = ThreadId.make("omp-stop-idempotent");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);
      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("Oh My Pi emits a failed terminal event and restores ready after prompt failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ environment: { T3_ACP_FAIL_PROMPT: "1" } }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }));
      const threadId = ThreadId.make("omp-prompt-failure");
      const failed = yield* Deferred.make<string>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (
          event.threadId === threadId &&
          event.type === "turn.completed" &&
          event.payload.state === "failed"
        ) {
          return Deferred.succeed(failed, event.payload.errorMessage ?? "").pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const result = yield* adapter
        .sendTurn({ threadId, input: "fail this prompt", attachments: [] })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(yield* Deferred.await(failed), "Oh My Pi ACP prompt failed.");
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("Oh My Pi serializes prompt preparation and settles concurrent sends once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }));
      const threadId = ThreadId.make("omp-concurrent-prompts");
      const terminal = yield* Deferred.make<void>();
      let startedCount = 0;
      let completedCount = 0;
      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.threadId !== threadId) return Effect.void;
        if (event.type === "turn.started") startedCount += 1;
        if (event.type === "turn.completed") {
          completedCount += 1;
          return Deferred.succeed(terminal, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const [first, second] = yield* Effect.all(
        [
          adapter.sendTurn({ threadId, input: "first", attachments: [] }),
          adapter.sendTurn({ threadId, input: "second", attachments: [] }),
        ],
        { concurrency: "unbounded" },
      );
      yield* Deferred.await(terminal);

      assert.equal(first.turnId, second.turnId);
      assert.equal(startedCount, 1);
      assert.equal(completedCount, 1);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("Oh My Pi atomically replaces a session while its old prompt is running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" } }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }));
      const threadId = ThreadId.make("omp-replace-running");
      const started = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.threadId === threadId && event.type === "turn.started"
          ? Deferred.succeed(started, undefined).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);
      const input = {
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access" as const,
      };

      yield* adapter.startSession(input);
      const oldPrompt = yield* adapter
        .sendTurn({ threadId, input: "keep running", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* adapter.startSession(input);
      yield* Fiber.join(oldPrompt);

      assert.isTrue(yield* adapter.hasSession(threadId));
      assert.equal((yield* adapter.listSessions()).length, 1);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("Oh My Pi keeps draining ACP events after native notification logging fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }), {
        nativeEventLogger: {
          filePath: "memory://omp-native-events",
          write: (record: unknown) =>
            typeof record === "object" &&
            record !== null &&
            "event" in record &&
            typeof record.event === "object" &&
            record.event !== null &&
            "kind" in record.event &&
            record.event.kind === "notification"
              ? Effect.die(new Error("native log write failed"))
              : Effect.void,
          close: () => Effect.void,
        },
      });
      const threadId = ThreadId.make("omp-native-log-failure");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "keep streaming", attachments: [] });
      yield* adapter.sendTurn({ threadId, input: "still streaming", attachments: [] });
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("Oh My Pi returns from an explicit model to the captured profile model", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-model-default-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const explicitModel = "composer-2";
      const binaryPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          environment: {
            T3_ACP_EXTRA_MODEL_ID: explicitModel,
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          },
        }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }));
      const threadId = ThreadId.make("omp-return-to-default");
      const instanceId = ProviderInstanceId.make("omp");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: instanceId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId, model: "default" },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "use explicit",
        attachments: [],
        modelSelection: { instanceId, model: explicitModel },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "return to profile",
        attachments: [],
        modelSelection: { instanceId, model: "default" },
      });

      const modelValues = (yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8")))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeRequestLogEntry(line))
        .filter(
          (request) =>
            request.method === "session/set_config_option" && request.params?.configId === "model",
        )
        .map((request) => request.params?.value);
      expect(modelValues).toEqual([explicitModel, "default"]);
      assert.equal((yield* adapter.listSessions())[0]?.model, "default");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("Oh My Pi ignores a stale cancellation for a completed turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ environment: { T3_ACP_PROMPT_DELAY_MS: "1000" } }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }));
      const threadId = ThreadId.make("omp-stale-cancel");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const first = yield* adapter.sendTurn({ threadId, input: "first", attachments: [] });
      const secondStarted = yield* Deferred.make<TurnId>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.threadId === threadId && event.type === "turn.started" && event.turnId !== undefined
          ? Deferred.succeed(secondStarted, event.turnId).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);
      const secondFiber = yield* adapter
        .sendTurn({ threadId, input: "second", attachments: [] })
        .pipe(Effect.forkChild);
      const secondTurnId = yield* Deferred.await(secondStarted);

      yield* adapter.interruptTurn(threadId, first.turnId);
      assert.equal((yield* adapter.listSessions())[0]?.status, "running");
      yield* adapter.interruptTurn(threadId, secondTurnId);
      yield* Fiber.join(secondFiber);
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("Oh My Pi rejects provider-instance and model-selection routing mismatches", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const workId = ProviderInstanceId.make("omp_work");
      const personalId = ProviderInstanceId.make("omp_personal");
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }), {
        instanceId: workId,
      });
      const threadId = ThreadId.make("omp-instance-mismatch");
      const base = {
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access" as const,
      };

      assert.equal(
        (yield* adapter
          .startSession({ ...base, providerInstanceId: personalId })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* adapter
          .startSession({
            ...base,
            providerInstanceId: workId,
            modelSelection: { instanceId: personalId, model: "default" },
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.isFalse(yield* adapter.hasSession(threadId));

      yield* adapter.startSession({ ...base, providerInstanceId: workId });
      assert.equal(
        (yield* adapter
          .sendTurn({
            threadId,
            input: "wrong profile",
            attachments: [],
            modelSelection: { instanceId: personalId, model: "default" },
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("Oh My Pi rejects a session routed to another provider", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({}));
      const result = yield* adapter
        .startSession({
          threadId: ThreadId.make("omp-provider-mismatch"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("Oh My Pi loads a durable session from its versioned resume cursor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }));
      const threadId = ThreadId.make("omp-resume");
      const startInput = {
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access" as const,
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "default",
        },
      };

      const started = yield* adapter.startSession(startInput);
      yield* adapter.stopSession(threadId);
      const resumed = yield* adapter.startSession({
        ...startInput,
        resumeCursor: started.resumeCursor,
      });

      assert.deepStrictEqual(resumed.resumeCursor, started.resumeCursor);
      assert.isTrue(resumed.restored);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect("Oh My Pi returns the exact permission option id supplied by ACP", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          environment: {
            T3_ACP_EMIT_TOOL_CALLS: "1",
            T3_ACP_ALLOW_ONCE_OPTION_ID: "omp_allow_once",
            T3_ACP_EXPECT_PERMISSION_OPTION_ID: "omp_allow_once",
          },
        }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }));
      const threadId = ThreadId.make("omp-permission-option");
      const requested = yield* Deferred.make<string>();
      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.threadId === threadId && event.type === "request.opened") {
          return Deferred.succeed(requested, String(event.requestId)).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "default",
        },
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "read package metadata", attachments: [] })
        .pipe(Effect.forkChild);
      const requestId = yield* Deferred.await(requested);
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(requestId), "accept");
      yield* Fiber.join(turnFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);

it.effect(
  "Oh My Pi cancellation interrupts a running ACP prompt and emits one terminal event",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* Effect.promise(() =>
          makeMockOmpWrapper({ environment: { T3_ACP_HANG_PROMPT_FOREVER: "1" } }),
        );
        const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }));
        const threadId = ThreadId.make("omp-cancel");
        const started = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        let cancelledCount = 0;
        yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (event.threadId !== threadId) return Effect.void;
          if (event.type === "turn.started") {
            return Deferred.succeed(started, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed" && event.payload.state === "cancelled") {
            cancelledCount += 1;
            return Deferred.succeed(cancelled, undefined).pipe(Effect.ignore);
          }
          return Effect.void;
        }).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          providerInstanceId: ProviderInstanceId.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("omp"),
            model: "default",
          },
        });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "keep working", attachments: [] })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* adapter.interruptTurn(threadId);
        yield* Fiber.join(turnFiber);
        yield* Deferred.await(cancelled);
        assert.equal(cancelledCount, 1);
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.provide(testLayer)),
    ),
);

it.effect("Oh My Pi filters child-session updates and drains root deltas before completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ environment: { T3_ACP_EMIT_FOREIGN_SESSION_UPDATES: "1" } }),
      );
      const adapter = yield* makeOmpAdapter(decodeOmpSettings({ binaryPath }));
      const threadId = ThreadId.make("omp-root-events");
      const terminal = yield* Deferred.make<void>();
      const deltas: string[] = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.threadId !== threadId) return Effect.void;
        if (event.type === "content.delta") {
          deltas.push(event.payload.delta);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(terminal, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        providerInstanceId: ProviderInstanceId.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "default",
        },
      });
      yield* adapter.sendTurn({ threadId, input: "run root task", attachments: [] });
      yield* Deferred.await(terminal);

      assert.deepStrictEqual(deltas, ["root before child", " root after child"]);
      assert.notInclude(deltas.join(""), "child content");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  ),
);
