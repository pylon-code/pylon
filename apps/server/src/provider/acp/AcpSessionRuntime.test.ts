import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as AcpErrors from "effect-acp/errors";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { makeAntigravityAcpRuntime } from "./AntigravityAcpSupport.ts";
import * as NodeURL from "node:url";

import { make, type AcpSessionRequestLogEvent } from "./AcpSessionRuntime.ts";

const mockPeerPath = NodeURL.fileURLToPath(
  new URL("../../../../../packages/effect-acp/test/fixtures/acp-mock-peer.ts", import.meta.url),
);
const mockPeerArgs = [
  ...(process.features?.typescript ? [] : ["--experimental-strip-types"]),
  mockPeerPath,
];

const startRuntime = (authMethodId?: string) =>
  Effect.gen(function* () {
    const requestLog = yield* Ref.make<Array<AcpSessionRequestLogEvent>>([]);
    const runtime = yield* make({
      spawn: {
        command: process.execPath,
        args: mockPeerArgs,
      },
      cwd: process.cwd(),
      clientInfo: {
        name: "acp-session-runtime-test",
        version: "0.0.0",
      },
      ...(authMethodId !== undefined ? { authMethodId } : {}),
      requestLogger: (event) => Ref.update(requestLog, (events) => [...events, event]),
    });

    yield* runtime.start();
    return (yield* Ref.get(requestLog))
      .filter((event) => event.status === "started")
      .map((event) => event.method);
  });

it.effect("skips ACP authentication only when no auth method is configured", () =>
  Effect.gen(function* () {
    const withoutAuthentication = yield* startRuntime();
    const withAuthentication = yield* startRuntime("cursor_login");

    assert.deepEqual(withoutAuthentication, ["initialize", "session/new"]);
    assert.deepEqual(withAuthentication, ["initialize", "authenticate", "session/new"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("bounds every ACP startup RPC with typed default and configured timeouts", () =>
  Effect.gen(function* () {
    const cases = [
      {
        method: "initialize",
        hangEnvironment: "ACP_MOCK_HANG_INITIALIZE",
        authMethodId: undefined,
        startupRpcTimeout: undefined,
        timeoutBeforeBoundary: "89999 millis",
        timeoutAtBoundary: "1 millis",
      },
      {
        method: "authenticate",
        hangEnvironment: "ACP_MOCK_HANG_AUTHENTICATE",
        authMethodId: "cursor_login",
        startupRpcTimeout: "1 second",
        timeoutBeforeBoundary: "999 millis",
        timeoutAtBoundary: "1 millis",
      },
      {
        method: "session/new",
        hangEnvironment: "ACP_MOCK_HANG_CREATE_SESSION",
        authMethodId: undefined,
        startupRpcTimeout: "1 second",
        timeoutBeforeBoundary: "999 millis",
        timeoutAtBoundary: "1 millis",
      },
    ] as const;

    for (const testCase of cases) {
      yield* Effect.gen(function* () {
        const requestStarted = yield* Deferred.make<void>();
        const runtime = yield* make({
          spawn: {
            command: process.execPath,
            args: mockPeerArgs,
            env: { [testCase.hangEnvironment]: "1" },
          },
          cwd: process.cwd(),
          clientInfo: {
            name: "acp-session-runtime-timeout-test",
            version: "0.0.0",
          },
          ...(testCase.authMethodId === undefined ? {} : { authMethodId: testCase.authMethodId }),
          ...(testCase.startupRpcTimeout === undefined
            ? {}
            : { startupRpcTimeout: testCase.startupRpcTimeout }),
          requestLogger: (event) =>
            event.method === testCase.method && event.status === "started"
              ? Deferred.succeed(requestStarted, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });
        const startFiber = yield* runtime.start().pipe(Effect.forkChild);

        yield* Deferred.await(requestStarted);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(testCase.timeoutBeforeBoundary);
        assert.isUndefined(startFiber.pollUnsafe());

        yield* TestClock.adjust(testCase.timeoutAtBoundary);
        const error = yield* Fiber.join(startFiber).pipe(Effect.flip);
        assert.equal(error._tag, "AcpTransportError");
        if (error._tag === "AcpTransportError") {
          assert.equal(error.operation, "call-rpc");
          assert.equal(error.method, testCase.method);
          assert.equal(error.detail, `${testCase.method} timed out waiting for RPC response`);
        }
      }).pipe(Effect.scoped);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not apply the startup RPC timeout to long prompt calls", () =>
  Effect.gen(function* () {
    const promptStarted = yield* Deferred.make<void>();
    const runtime = yield* make({
      spawn: {
        command: process.execPath,
        args: mockPeerArgs,
        env: { ACP_MOCK_HANG_PROMPT: "1" },
      },
      cwd: process.cwd(),
      startupRpcTimeout: "1 second",
      clientInfo: {
        name: "acp-session-runtime-prompt-test",
        version: "0.0.0",
      },
      requestLogger: (event) =>
        event.method === "session/prompt" && event.status === "started"
          ? Deferred.succeed(promptStarted, undefined).pipe(Effect.asVoid)
          : Effect.void,
    });
    yield* runtime.start();
    const promptFiber = yield* runtime
      .prompt({ prompt: [{ type: "text", text: "keep working" }] })
      .pipe(Effect.forkChild);

    yield* Deferred.await(promptStarted);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("5 minutes");
    assert.isUndefined(promptFiber.pollUnsafe());
    yield* Fiber.interrupt(promptFiber);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "delivers child stderr while ACP requests are pending without parsing it as protocol",
  () =>
    Effect.gen(function* () {
      const received = yield* Deferred.make<string>();
      const runtime = yield* make({
        spawn: {
          command: process.execPath,
          args: ["-e", 'process.stderr.write("provider sign-in URL\\n"); process.stdin.resume()'],
        },
        cwd: process.cwd(),
        clientInfo: { name: "stderr-test", version: "0.0.0" },
        onStderr: (text) => Deferred.succeed(received, text).pipe(Effect.asVoid),
      });
      yield* runtime.initialize().pipe(Effect.forkScoped);
      assert.strictEqual(yield* Deferred.await(received), "provider sign-in URL\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails pending ACP requests when the provider rejects stderr sign-in", () =>
  Effect.gen(function* () {
    const failure = new AcpErrors.AcpTransportError({
      detail: "Sign in to Antigravity in Settings before you continue.",
      cause: undefined,
    });
    const runtime = yield* make({
      spawn: {
        command: process.execPath,
        args: ["-e", 'process.stderr.write("login required\\n"); process.stdin.resume()'],
      },
      cwd: process.cwd(),
      clientInfo: { name: "stderr-test", version: "0.0.0" },
      onStderr: () => Effect.fail(failure),
    });
    const error = yield* runtime.initialize().pipe(Effect.flip);
    assert.strictEqual(error, failure);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const mockAgentPath = NodeURL.fileURLToPath(
  new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
);
const mockAgentArgs = [
  ...(process.features?.typescript ? [] : ["--experimental-strip-types"]),
  mockAgentPath,
];

it.effect("terminates session on prompt inactivity timeout and captures redacted stderr tail", () =>
  Effect.gen(function* () {
    const promptStarted = yield* Deferred.make<void>();
    const runtime = yield* make({
      spawn: {
        command: process.execPath,
        args: [
          "-e",
          [
            'process.stderr.write("line 1\\n");',
            'process.stderr.write("SECRET_AUTH_LINE: 12345\\n");',
            'process.stderr.write("line 2\\n");',
            'const readline = require("readline").createInterface({ input: process.stdin });',
            'readline.on("line", (line) => {',
            "  const msg = JSON.parse(line);",
            '  if (msg.method === "initialize") {',
            '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "test", version: "0.0.0" } } }) + "\\n");',
            '  } else if (msg.method === "session/new") {',
            '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } }) + "\\n");',
            "  }",
            "});",
          ].join(""),
        ],
      },
      cwd: process.cwd(),
      promptInactivityTimeout: "500 millis",
      redactStderrLine: (line) => (line.startsWith("SECRET_AUTH_LINE") ? undefined : line),
      clientInfo: {
        name: "acp-session-runtime-inactivity-test",
        version: "0.0.0",
      },
      requestLogger: (event) =>
        event.method === "session/prompt" && event.status === "started"
          ? Deferred.succeed(promptStarted, undefined).pipe(Effect.asVoid)
          : Effect.void,
    });
    yield* runtime.start();
    const promptFiber = yield* runtime
      .prompt({ prompt: [{ type: "text", text: "keep working" }] })
      .pipe(Effect.forkChild);

    yield* Deferred.await(promptStarted);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("500 millis");

    const error = yield* Fiber.join(promptFiber).pipe(Effect.flip);
    assert.equal(error._tag, "AcpTransportError");
    if (error._tag === "AcpTransportError") {
      assert.include(
        error.detail ?? "",
        "The agent sent nothing for 1 minutes after its last message and never completed the prompt. Its process was stopped.",
      );
      assert.include(error.detail ?? "", "Last stderr: line 1 | line 2");
      assert.notInclude(error.detail ?? "", "SECRET_AUTH_LINE");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("exempts watchdog from prompt inactivity timeout when tool calls are in flight", () =>
  Effect.gen(function* () {
    const promptStarted = yield* Deferred.make<void>();
    const runtime = yield* make({
      spawn: {
        command: process.execPath,
        args: mockAgentArgs,
        env: {
          T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG: "1",
        },
      },
      cwd: process.cwd(),
      promptInactivityTimeout: "500 millis",
      clientInfo: {
        name: "acp-session-runtime-tool-exempt-test",
        version: "0.0.0",
      },
      requestLogger: (event) =>
        event.method === "session/prompt" && event.status === "started"
          ? Deferred.succeed(promptStarted, undefined).pipe(Effect.asVoid)
          : Effect.void,
    });
    yield* runtime.start();
    const promptFiber = yield* runtime
      .prompt({ prompt: [{ type: "text", text: "tool call hanging" }] })
      .pipe(Effect.forkChild);

    yield* Deferred.await(promptStarted);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("500 millis");
    yield* Effect.yieldNow;
    assert.isUndefined(promptFiber.pollUnsafe());

    yield* TestClock.adjust("500 millis");
    yield* Effect.yieldNow;
    assert.isUndefined(promptFiber.pollUnsafe());

    yield* Fiber.interrupt(promptFiber);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "exempts watchdog from prompt inactivity timeout when client requests are in flight",
  () =>
    Effect.gen(function* () {
      const promptStarted = yield* Deferred.make<void>();
      const permissionStarted = yield* Deferred.make<void>();
      const permissionRelease = yield* Deferred.make<void>();
      const runtime = yield* make({
        spawn: {
          command: process.execPath,
          args: mockPeerArgs,
        },
        cwd: process.cwd(),
        promptInactivityTimeout: "500 millis",
        clientInfo: {
          name: "acp-session-runtime-client-req-exempt-test",
          version: "0.0.0",
        },
        requestLogger: (event) =>
          event.method === "session/prompt" && event.status === "started"
            ? Deferred.succeed(promptStarted, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });
      yield* runtime.handleRequestPermission(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(permissionStarted, undefined);
          yield* Deferred.await(permissionRelease);
          return { outcome: { outcome: "cancelled" as const } };
        }),
      );
      yield* runtime.start();
      const promptFiber = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "run permission" }] })
        .pipe(Effect.forkChild);

      yield* Deferred.await(promptStarted);
      yield* Deferred.await(permissionStarted);
      yield* Effect.yieldNow;

      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      assert.isUndefined(promptFiber.pollUnsafe());

      yield* Deferred.succeed(permissionRelease, undefined);
      yield* Fiber.interrupt(promptFiber);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retires runtime on cancel timeout with wait-for-prompt and returns success", () =>
  Effect.gen(function* () {
    const promptStarted = yield* Deferred.make<void>();
    const runtime = yield* make({
      spawn: {
        command: process.execPath,
        args: mockAgentArgs,
        env: {
          T3_ACP_HANG_PROMPT_FOREVER: "1",
        },
      },
      cwd: process.cwd(),
      cancelBehavior: "wait-for-prompt",
      cancelTimeout: "5 seconds",
      clientInfo: {
        name: "acp-session-runtime-cancel-timeout-test",
        version: "0.0.0",
      },
      requestLogger: (event) =>
        event.method === "session/prompt" && event.status === "started"
          ? Deferred.succeed(promptStarted, undefined).pipe(Effect.asVoid)
          : Effect.void,
    });
    yield* runtime.start();
    const promptFiber = yield* runtime
      .prompt({ prompt: [{ type: "text", text: "hang forever" }] })
      .pipe(Effect.forkChild);

    yield* Deferred.await(promptStarted);
    yield* Effect.yieldNow;

    const cancelFiber = yield* runtime.cancel.pipe(Effect.forkChild);
    yield* Effect.yieldNow;

    yield* TestClock.adjust("5 seconds");
    yield* Effect.yieldNow;

    yield* Fiber.join(cancelFiber);

    const promptResult = yield* Fiber.join(promptFiber).pipe(Effect.flip);
    assert.equal(promptResult._tag, "AcpTransportError");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("Antigravity stops an unresponsive prompt within three seconds", () =>
  Effect.gen(function* () {
    const promptStarted = yield* Deferred.make<void>();
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeAntigravityAcpRuntime({
      childProcessSpawner,
      clientFileSystem: true,
      spawn: {
        command: process.execPath,
        args: mockAgentArgs,
        env: { T3_ACP_HANG_PROMPT_FOREVER: "1", T3_ACP_ANTIGRAVITY: "1" },
      },
      cwd: process.cwd(),
      clientInfo: { name: "antigravity-stop-budget-test", version: "0.0.0" },
      requestLogger: (event) =>
        event.method === "session/prompt" && event.status === "started"
          ? Deferred.succeed(promptStarted, undefined).pipe(Effect.asVoid)
          : Effect.void,
    });
    yield* runtime.start();
    const prompt = yield* runtime
      .prompt({ prompt: [{ type: "text", text: "hang" }] })
      .pipe(Effect.forkChild);
    yield* Deferred.await(promptStarted);
    const stopping = yield* runtime.cancel.pipe(Effect.forkChild);
    yield* TestClock.adjust("3 seconds");
    yield* Fiber.join(stopping);
    const result = yield* Fiber.join(prompt).pipe(Effect.flip);
    assert.equal(result._tag, "AcpTransportError");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
