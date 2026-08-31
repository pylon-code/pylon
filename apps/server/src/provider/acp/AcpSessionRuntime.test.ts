import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as NodeURL from "node:url";

import { make, type AcpSessionRequestLogEvent } from "./AcpSessionRuntime.ts";

const mockPeerPath = NodeURL.fileURLToPath(
  new URL("../../../../../packages/effect-acp/test/fixtures/acp-mock-peer.ts", import.meta.url),
);

const startRuntime = (authMethodId?: string) =>
  Effect.gen(function* () {
    const requestLog = yield* Ref.make<Array<AcpSessionRequestLogEvent>>([]);
    const runtime = yield* make({
      spawn: {
        command: process.execPath,
        args: [mockPeerPath],
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
            args: [mockPeerPath],
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
        args: [mockPeerPath],
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
