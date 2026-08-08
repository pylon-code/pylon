// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  PrimeAgentSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  makePrimeAgentAdapter,
  parsePrimeAgentResumeMarker,
  primeAgentSessionDirectory,
} from "./PrimeAgentAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const decodeSettings = Schema.decodeSync(PrimeAgentSettings);
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pylon-prime-agent-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

type TurnCompletedEvent = Extract<ProviderRuntimeEvent, { readonly type: "turn.completed" }>;

const isTurnCompletedEvent = (event: ProviderRuntimeEvent): event is TurnCompletedEvent =>
  event.type === "turn.completed";

it("keeps every branded session id inside its Prime Agent storage root", () => {
  const stateDir = NodePath.join(NodeOS.tmpdir(), "prime-agent-session-path-test");
  const root = NodePath.join(stateDir, "provider-sessions", "prime-agent");
  const values = [".", "..", "slash/value", "percent%value", "雪"];
  const directories = values.map((value) =>
    primeAgentSessionDirectory({
      stateDir,
      instanceId: ProviderInstanceId.make("primeAgent"),
      threadId: ThreadId.make(value),
      join: NodePath.join,
    }),
  );

  assert.equal(new Set(directories).size, values.length);
  for (const directory of directories) {
    const relative = NodePath.relative(root, directory);
    assert.lengthOf(relative.split(NodePath.sep), 2);
    assert.isFalse(relative.startsWith(`..${NodePath.sep}`));
    assert.notInclude(relative, ".");
  }
});

it.effect("validates Prime Agent session constraints and owns continuation storage", () =>
  Effect.gen(function* () {
    const tempDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-agent-acp-mock-")),
    );
    const wrapperPath = NodePath.join(tempDir, "fake-prime-agent.sh");
    const argsLogPath = NodePath.join(tempDir, "args.log");
    const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        wrapperPath,
        `#!/bin/sh
printf '%s\n' "$*" >> ${argsLogPath}
exec ${process.execPath} ${mockAgentPath} "$@"
`,
        "utf8",
      ),
    );
    yield* Effect.promise(() => NodeFSP.chmod(wrapperPath, 0o755));

    const adapter = yield* makePrimeAgentAdapter(
      decodeSettings({ binaryPath: wrapperPath, launchArgs: "--verbose" }),
      {
        instanceId: ProviderInstanceId.make("primeAgent"),
        environment: {
          ...process.env,
          T3_ACP_ALLOW_ALWAYS_OPTION_ID: "prime-allow-always",
          T3_ACP_ALLOW_ONCE_OPTION_ID: "prime-allow-once",
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_PROMPT_DELAY_MS: "250",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        },
        startupWarning: "Prime daemon unavailable; using ACP compatibility fallback.",
      },
    );
    const rejectedMode = yield* adapter
      .startSession({
        threadId: ThreadId.make("approval-required"),
        provider: ProviderDriverKind.make("primeAgent"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      })
      .pipe(Effect.result);
    assert.equal(rejectedMode._tag, "Failure");

    const reservedArgsAdapter = yield* makePrimeAgentAdapter(
      decodeSettings({ binaryPath: wrapperPath, launchArgs: "-- --mode text" }),
      { instanceId: ProviderInstanceId.make("primeAgent-reserved-args") },
    );
    const rejectedLaunchArgs = yield* reservedArgsAdapter
      .startSession({
        threadId: ThreadId.make("reserved-launch-args"),
        provider: ProviderDriverKind.make("primeAgent"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      })
      .pipe(Effect.result);
    assert.equal(rejectedLaunchArgs._tag, "Failure");

    const threadId = ThreadId.make("resume/thread");
    const startupWarning = yield* Deferred.make<void>();
    const startupWarningFiber = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        event.type === "runtime.warning" &&
        event.payload.message === "Prime daemon unavailable; using ACP compatibility fallback."
          ? Deferred.succeed(startupWarning, undefined).pipe(Effect.ignore)
          : Effect.void,
      ),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    const session = yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("primeAgent"),
      cwd: process.cwd(),
      runtimeMode: "full-access",
      resumeCursor: { schemaVersion: 1, kind: "prime-agent-cli-continue", continue: true },
      modelSelection: {
        instanceId: ProviderInstanceId.make("primeAgent"),
        model: "openai/gpt-5.4",
      },
    });
    yield* Deferred.await(startupWarning);
    yield* Fiber.interrupt(startupWarningFiber);
    assert.isTrue(parsePrimeAgentResumeMarker(session.resumeCursor));
    assert.isTrue(
      parsePrimeAgentResumeMarker({
        schemaVersion: 2,
        kind: "prime-agent-daemon-continue",
        continue: true,
      }),
    );
    assert.isFalse(
      parsePrimeAgentResumeMarker({
        schemaVersion: 0,
        kind: "prime-agent-cli-continue",
        continue: true,
      }),
    );
    assert.isFalse(
      parsePrimeAgentResumeMarker({
        schemaVersion: 1,
        kind: "prime-agent-cli-continue",
        continue: "yes",
      }),
    );

    const args = yield* Effect.promise(() => NodeFSP.readFile(argsLogPath, "utf8"));
    assert.include(args, "--mode acp --offline --cwd");
    assert.include(args, "--continue");
    assert.include(args, "--model openai/gpt-5.4");

    const serverConfig = yield* ServerConfig;
    const expectedSessionDir = primeAgentSessionDirectory({
      stateDir: serverConfig.stateDir,
      instanceId: ProviderInstanceId.make("primeAgent"),
      threadId,
      join: NodePath.join,
    });
    assert.isTrue(
      yield* Effect.promise(() => NodeFSP.stat(expectedSessionDir).then((s) => s.isDirectory())),
    );

    const modelSwitch = yield* adapter
      .sendTurn({
        threadId,
        input: "do not send",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("primeAgent"),
          model: "anthropic/claude-sonnet-4.6",
        },
      })
      .pipe(Effect.result);
    assert.equal(modelSwitch._tag, "Failure");

    const rollback = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.result);
    assert.equal(rollback._tag, "Failure");

    const events: Array<ProviderRuntimeEvent> = [];
    const turnStartedSignals = new Map<string, Deferred.Deferred<void>>();
    const turnCompletedSignals = new Map<string, Deferred.Deferred<void>>();
    const eventFiber = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.started") {
            const signal = turnStartedSignals.get(event.threadId);
            if (signal) yield* Deferred.succeed(signal, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            const signal = turnCompletedSignals.get(event.threadId);
            if (signal) yield* Deferred.succeed(signal, undefined).pipe(Effect.ignore);
          }
        }),
      ),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;

    const completedSignal = yield* Deferred.make<void>();
    turnCompletedSignals.set(threadId, completedSignal);
    const completedTurn = yield* adapter.sendTurn({
      threadId,
      input: "completed turn",
      attachments: [],
    });
    yield* Deferred.await(completedSignal);
    const completedTurnEvents = events.filter((event) => event.turnId === completedTurn.turnId);
    assert.include(
      completedTurnEvents.map((event) => event.type),
      "content.delta",
    );
    assert.include(
      completedTurnEvents.map((event) => event.type),
      "item.updated",
    );
    assert.include(
      completedTurnEvents.map((event) => event.type),
      "item.completed",
    );
    assert.equal(completedTurnEvents.at(-1)?.type, "turn.completed");
    assert.lengthOf(
      completedTurnEvents.filter((event) => event.type === "turn.completed"),
      1,
    );
    assert.isTrue(completedTurnEvents.every((event) => event.turnId === completedTurn.turnId));
    const requestEntries: ReadonlyArray<unknown> = yield* Effect.promise(() =>
      NodeFSP.readFile(requestLogPath, "utf8").then((contents) =>
        contents
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown),
      ),
    );
    assert.isTrue(
      requestEntries.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "result" in entry &&
          typeof entry.result === "object" &&
          entry.result !== null &&
          "outcome" in entry.result &&
          typeof entry.result.outcome === "object" &&
          entry.result.outcome !== null &&
          "optionId" in entry.result.outcome &&
          entry.result.outcome.optionId === "prime-allow-once",
      ),
    );

    const interruptStarted = yield* Deferred.make<void>();
    const interruptCompleted = yield* Deferred.make<void>();
    turnStartedSignals.set(threadId, interruptStarted);
    turnCompletedSignals.set(threadId, interruptCompleted);
    const firstTurnFiber = yield* adapter
      .sendTurn({ threadId, input: "first turn", attachments: [] })
      .pipe(Effect.forkChild);
    yield* Deferred.await(interruptStarted);
    const interruptedTurnId = events.findLast(
      (event) => event.threadId === threadId && event.type === "turn.started",
    )?.turnId;
    assert.isDefined(interruptedTurnId);
    const steering = yield* adapter
      .sendTurn({ threadId, input: "steer", attachments: [] })
      .pipe(Effect.result);
    assert.equal(steering._tag, "Failure");
    yield* adapter.interruptTurn(threadId, interruptedTurnId);
    const interruptedTurnExit = yield* Fiber.await(firstTurnFiber);
    assert.isTrue(Exit.isSuccess(interruptedTurnExit));
    yield* Deferred.await(interruptCompleted);
    const interruptedTerminals = events.filter(
      (event): event is TurnCompletedEvent =>
        event.turnId === interruptedTurnId && isTurnCompletedEvent(event),
    );
    assert.lengthOf(interruptedTerminals, 1);
    assert.equal(interruptedTerminals[0]?.payload.state, "cancelled");

    const stopThreadId = ThreadId.make("stop-race");
    yield* adapter.startSession({
      threadId: stopThreadId,
      provider: ProviderDriverKind.make("primeAgent"),
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });
    const stopStarted = yield* Deferred.make<void>();
    const stopCompleted = yield* Deferred.make<void>();
    turnStartedSignals.set(stopThreadId, stopStarted);
    turnCompletedSignals.set(stopThreadId, stopCompleted);
    const stoppedTurnFiber = yield* adapter
      .sendTurn({ threadId: stopThreadId, input: "stop me", attachments: [] })
      .pipe(Effect.forkChild);
    yield* Deferred.await(stopStarted);
    const stoppedTurnId = events.findLast(
      (event) => event.threadId === stopThreadId && event.type === "turn.started",
    )?.turnId;
    assert.isDefined(stoppedTurnId);
    yield* adapter.stopSession(stopThreadId);
    const stoppedTurnExit = yield* Fiber.await(stoppedTurnFiber);
    assert.isTrue(Exit.isSuccess(stoppedTurnExit));
    yield* Deferred.await(stopCompleted);
    const stoppedThreadEvents = events.filter((event) => event.threadId === stopThreadId);
    assert.lengthOf(
      stoppedThreadEvents.filter(
        (event) => event.turnId === stoppedTurnId && event.type === "turn.completed",
      ),
      1,
    );
    assert.isBelow(
      stoppedThreadEvents.findIndex(
        (event) => event.turnId === stoppedTurnId && event.type === "turn.completed",
      ),
      stoppedThreadEvents.findIndex((event) => event.type === "session.exited"),
    );

    const interruptedFiberThreadId = ThreadId.make("caller-interrupted");
    yield* adapter.startSession({
      threadId: interruptedFiberThreadId,
      provider: ProviderDriverKind.make("primeAgent"),
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });
    const callerStarted = yield* Deferred.make<void>();
    const callerCompleted = yield* Deferred.make<void>();
    turnStartedSignals.set(interruptedFiberThreadId, callerStarted);
    turnCompletedSignals.set(interruptedFiberThreadId, callerCompleted);
    const callerInterruptedFiber = yield* adapter
      .sendTurn({
        threadId: interruptedFiberThreadId,
        input: "interrupt caller",
        attachments: [],
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(callerStarted);
    const callerInterruptedTurnId = events.findLast(
      (event) => event.threadId === interruptedFiberThreadId && event.type === "turn.started",
    )?.turnId;
    assert.isDefined(callerInterruptedTurnId);
    yield* Fiber.interrupt(callerInterruptedFiber);
    yield* Deferred.await(callerCompleted);
    assert.lengthOf(
      events.filter(
        (event) => event.turnId === callerInterruptedTurnId && event.type === "turn.completed",
      ),
      1,
    );
    yield* adapter.stopSession(interruptedFiberThreadId);

    yield* adapter.stopSession(threadId);
    yield* Fiber.interrupt(eventFiber);

    const failingAdapter = yield* makePrimeAgentAdapter(
      decodeSettings({ binaryPath: wrapperPath }),
      {
        instanceId: ProviderInstanceId.make("primeAgent-failing"),
        environment: { ...process.env, T3_ACP_FAIL_PROMPT: "1" },
      },
    );
    const failingThreadId = ThreadId.make("prompt-failure");
    const failureEvents: Array<ProviderRuntimeEvent> = [];
    const failureEventFiber = yield* failingAdapter.streamEvents.pipe(
      Stream.runForEach((event) => Effect.sync(() => failureEvents.push(event))),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* failingAdapter.startSession({
      threadId: failingThreadId,
      provider: ProviderDriverKind.make("primeAgent"),
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });
    const failedPrompt = yield* failingAdapter
      .sendTurn({ threadId: failingThreadId, input: "fail", attachments: [] })
      .pipe(Effect.result);
    assert.equal(failedPrompt._tag, "Failure");
    const failedTurnId = failureEvents.find(
      (event) => event.threadId === failingThreadId && event.type === "turn.started",
    )?.turnId;
    assert.isDefined(failedTurnId);
    const failedTerminals = failureEvents.filter(
      (event): event is TurnCompletedEvent =>
        event.turnId === failedTurnId && isTurnCompletedEvent(event),
    );
    assert.lengthOf(failedTerminals, 1);
    assert.equal(failedTerminals[0]?.payload.state, "failed");
    yield* failingAdapter.stopSession(failingThreadId);
    yield* Fiber.interrupt(failureEventFiber);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
