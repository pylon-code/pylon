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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  EnvironmentId,
  PrimeAgentSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  makePrimeAgentAdapter,
  parsePrimeAgentResumeMarker,
  primeAgentSessionDirectory,
} from "./PrimeAgentAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const decodeSettings = Schema.decodeSync(PrimeAgentSettings);
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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

it.effect("rejects an MCP route owned by another provider instance before ACP launch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const boundInstanceId = ProviderInstanceId.make("prime-acp-bound");
      const threadId = ThreadId.make("prime-acp-mcp-mismatch");
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          McpProviderSession.setMcpProviderSession({
            providerSessionId: "provider-session-mismatch",
            threadId,
            environmentId: EnvironmentId.make("environment-mismatch"),
            providerInstanceId: ProviderInstanceId.make("prime-acp-other"),
            endpoint: "http://127.0.0.1:4321/mcp/mismatch",
            authorizationHeader: "Bearer must-not-route",
          }),
        ),
        () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      );
      const adapter = yield* makePrimeAgentAdapter(decodeSettings({}), {
        instanceId: boundInstanceId,
      });

      const result = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("primeAgent"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterValidationError");
        if (result.failure._tag === "ProviderAdapterValidationError") {
          assert.equal(
            result.failure.issue,
            "The MCP route does not belong to this provider instance.",
          );
        }
      }
    }),
  ).pipe(Effect.provide(testLayer)),
);

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
    const sessionIncarnationId = RuntimeSessionId.make("prime-acp-incarnation");
    const mcpSession = {
      providerSessionId: "provider-session-prime-acp-test",
      threadId,
      environmentId: EnvironmentId.make("environment-prime-acp-test"),
      providerInstanceId: ProviderInstanceId.make("primeAgent"),
      endpoint: "http://127.0.0.1:4321/mcp/provider-session-prime-acp-test",
      authorizationHeader: "Bearer scoped-secret",
      expiresAt: 4_000_000_000_000,
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => McpProviderSession.setMcpProviderSession(mcpSession)),
      () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
    );
    const startupWarning = yield* Deferred.make<void>();
    const unavailableResources =
      yield* Deferred.make<
        Extract<ProviderRuntimeEvent, { readonly type: "session.resources.updated" }>
      >();
    const unavailableGoal =
      yield* Deferred.make<
        Extract<ProviderRuntimeEvent, { readonly type: "session.goal.updated" }>
      >();
    const startupWarningFiber = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (
            event.type === "runtime.warning" &&
            event.payload.message === "Prime daemon unavailable; using ACP compatibility fallback."
          ) {
            yield* Deferred.succeed(startupWarning, undefined).pipe(Effect.ignore);
          }
          if (event.type === "session.resources.updated") {
            yield* Deferred.succeed(unavailableResources, event).pipe(Effect.ignore);
          }
          if (event.type === "session.goal.updated") {
            yield* Deferred.succeed(unavailableGoal, event).pipe(Effect.ignore);
          }
        }),
      ),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    const session = yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("primeAgent"),
      cwd: process.cwd(),
      runtimeMode: "full-access",
      sessionIncarnationId,
      resumeCursor: { schemaVersion: 1, kind: "prime-agent-cli-continue", continue: true },
      modelSelection: {
        instanceId: ProviderInstanceId.make("primeAgent"),
        model: "openai/gpt-5.4",
      },
    });
    yield* Deferred.await(startupWarning);
    const resourcesEvent = yield* Deferred.await(unavailableResources);
    const goalEvent = yield* Deferred.await(unavailableGoal);
    yield* Fiber.interrupt(startupWarningFiber);
    assert.deepEqual(resourcesEvent.payload, {
      available: false,
      skills: [],
      prompts: [],
      commands: [],
    });
    assert.equal(resourcesEvent.providerInstanceId, ProviderInstanceId.make("primeAgent"));
    assert.equal(resourcesEvent.sessionIncarnationId, sessionIncarnationId);
    assert.deepEqual(goalEvent.payload, {
      available: false,
      active: false,
      status: "idle",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      continuationsUsed: 0,
    });
    assert.equal(goalEvent.providerInstanceId, ProviderInstanceId.make("primeAgent"));
    assert.equal(goalEvent.sessionIncarnationId, sessionIncarnationId);
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
    const expectedSessionDirectoryStat = yield* Effect.promise(() =>
      NodeFSP.stat(expectedSessionDir),
    );
    assert.isTrue(expectedSessionDirectoryStat.isDirectory());
    assert.equal(expectedSessionDirectoryStat.mode & 0o777, 0o700);

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
    assert.isTrue(
      completedTurnEvents.every((event) => event.sessionIncarnationId === sessionIncarnationId),
    );
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
    const toolEvents = completedTurnEvents.filter(
      (event) =>
        (event.type === "item.updated" || event.type === "item.completed") &&
        event.payload.itemType === "command_execution",
    );
    assert.isAbove(toolEvents.length, 0);
    for (const event of toolEvents) {
      if (event.itemId === undefined || event.raw === undefined) {
        assert.fail("Prime ACP tool events must have sanitized canonical identities");
      }
      assert.match(event.itemId, /^prime-tool:[0-9a-f]{32}$/);
      assert.notProperty(event.payload, "title");
      assert.notProperty(event.payload, "detail");
      assert.notProperty(event.payload, "data");
      assert.isUndefined(event.raw.payload);
    }
    assert.equal(completedTurnEvents.at(-1)?.type, "turn.completed");
    assert.lengthOf(
      completedTurnEvents.filter((event) => event.type === "turn.completed"),
      1,
    );
    assert.isTrue(completedTurnEvents.every((event) => event.turnId === completedTurn.turnId));
    // Prime ingests images only. ProviderService now hands every attachment to
    // the adapter and puts each one's path in the prompt text, so a generic file
    // must be skipped here rather than base64'd into an ACP image block.
    const { attachmentsDir } = yield* ServerConfig;
    const imageAttachment = {
      type: "image" as const,
      id: "thread-prime-attach-12345678-1234-1234-1234-123456789abc",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const fileAttachment = {
      type: "file" as const,
      id: "thread-prime-attach-12345678-1234-1234-1234-123456789abd",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
    };
    for (const attachment of [imageAttachment, fileAttachment]) {
      const onDisk = NodePath.join(attachmentsDir, attachmentRelativePath(attachment)!);
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(onDisk), { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(onDisk, Uint8Array.from([1, 2, 3, 4])));
    }
    const attachmentSignal = yield* Deferred.make<void>();
    turnCompletedSignals.set(threadId, attachmentSignal);
    yield* adapter.sendTurn({
      threadId,
      input: "summarize the report",
      attachments: [imageAttachment, fileAttachment],
    });
    yield* Deferred.await(attachmentSignal);

    const requestEntries: ReadonlyArray<unknown> = yield* Effect.promise(() =>
      NodeFSP.readFile(requestLogPath, "utf8").then((contents) =>
        contents
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown),
      ),
    );
    const promptEntries = requestEntries.filter(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "method" in entry &&
        entry.method === "session/prompt",
    ) as ReadonlyArray<{
      readonly params?: { readonly prompt?: ReadonlyArray<{ readonly type?: string }> };
    }>;
    const attachmentPrompt = promptEntries.at(-1);
    assert.isDefined(attachmentPrompt);
    const blockTypes = (attachmentPrompt?.params?.prompt ?? []).map((block) => block.type);
    // One image block for the PNG, none for the PDF, and the text block still
    // carries the path line ProviderService appended.
    assert.deepEqual(
      blockTypes.filter((type) => type === "image"),
      ["image"],
    );
    assert.include(blockTypes, "text");

    const newSessionEntry = requestEntries.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "method" in entry &&
        entry.method === "session/new",
    );
    assert.isDefined(newSessionEntry);
    const newSessionParams = (
      newSessionEntry as { readonly params?: { readonly mcpServers?: unknown } }
    ).params;
    assert.deepEqual(newSessionParams?.mcpServers, [
      {
        name: "t3-code",
        type: "http",
        url: mcpSession.endpoint,
        headers: [{ name: "Authorization", value: mcpSession.authorizationHeader }],
      },
    ]);
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
    assert.equal(failedPrompt._tag, "Success");
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

it.effect("discards Prime ACP thought chunks before native logs and runtime publication", () =>
  Effect.gen(function* () {
    const tempDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-agent-acp-thought-test-")),
    );
    const wrapperPath = NodePath.join(tempDir, "fake-prime-agent.sh");
    const nativeWrites: Array<unknown> = [];
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        wrapperPath,
        `#!/bin/sh
exec ${process.execPath} ${mockAgentPath} "$@"
`,
        "utf8",
      ),
    );
    yield* Effect.promise(() => NodeFSP.chmod(wrapperPath, 0o755));

    const adapter = yield* makePrimeAgentAdapter(decodeSettings({ binaryPath: wrapperPath }), {
      instanceId: ProviderInstanceId.make("primeAgent-thought-boundary"),
      nativeEventLogger: {
        filePath: NodePath.join(tempDir, "unused-native.ndjson"),
        write: (event) => Effect.sync(() => nativeWrites.push(event)),
        close: () => Effect.void,
      },
      environment: {
        ...process.env,
        T3_ACP_EMIT_PRIVATE_THOUGHT_CHUNK: "1",
        T3_ACP_PROMPT_RESPONSE_TEXT: "public answer",
      },
    });
    const threadId = ThreadId.make("thought-boundary");
    const completed = yield* Deferred.make<void>();
    const events: Array<ProviderRuntimeEvent> = [];
    const eventFiber = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed" && event.threadId === threadId) {
            yield* Deferred.succeed(completed, undefined).pipe(Effect.ignore);
          }
        }),
      ),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("primeAgent"),
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });
    const turn = yield* adapter.sendTurn({ threadId, input: "answer publicly", attachments: [] });
    yield* Deferred.await(completed);

    const turnEvents = events.filter((event) => event.turnId === turn.turnId);
    const serializedEvents = encodeUnknownJsonString(turnEvents);
    assert.notInclude(serializedEvents, "private-thought-sentinel");
    assert.notInclude(serializedEvents, "agent_thought_chunk");
    assert.notInclude(serializedEvents, "reasoning_text");
    assert.deepEqual(
      turnEvents
        .filter((event) => event.type === "content.delta")
        .map((event) => event.payload.delta),
      ["public answer"],
    );

    const serializedNativeWrites = encodeUnknownJsonString(nativeWrites);
    assert.isAbove(nativeWrites.length, 0);
    assert.include(serializedNativeWrites, '"direction":"outgoing"');
    assert.notInclude(serializedNativeWrites, '"direction":"incoming"');
    assert.notInclude(serializedNativeWrites, "private-thought-sentinel");
    assert.notInclude(serializedNativeWrites, "agent_thought_chunk");

    yield* adapter.stopSession(threadId);
    yield* Fiber.interrupt(eventFiber);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "emits safe missing-final-response notices only for authoritative textless terminals",
  () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-agent-acp-textless-test-")),
      );
      const wrapperPath = NodePath.join(tempDir, "private-native-path", "fake-prime-agent.sh");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.dirname(wrapperPath), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          wrapperPath,
          `#!/bin/sh
exec ${process.execPath} ${mockAgentPath} "$@"
`,
          "utf8",
        ),
      );
      yield* Effect.promise(() => NodeFSP.chmod(wrapperPath, 0o755));

      let caseIndex = 0;
      const runTerminalTurn = Effect.fn("PrimeAgentAdapter.test.runTerminalTurn")(function* (
        label: string,
        environment: NodeJS.ProcessEnv,
      ) {
        caseIndex += 1;
        const adapter = yield* makePrimeAgentAdapter(decodeSettings({ binaryPath: wrapperPath }), {
          instanceId: ProviderInstanceId.make(`primeAgent-textless-${caseIndex}`),
          environment: { ...process.env, ...environment },
        });
        const threadId = ThreadId.make(`textless-${label}-${caseIndex}`);
        const completed = yield* Deferred.make<void>();
        const events: Array<ProviderRuntimeEvent> = [];
        const eventFiber = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "turn.completed" && event.threadId === threadId) {
                yield* Deferred.succeed(completed, undefined).pipe(Effect.ignore);
              }
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("primeAgent"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const result = yield* adapter
          .sendTurn({ threadId, input: label, attachments: [] })
          .pipe(Effect.result);
        yield* Deferred.await(completed);
        const turnId = events.find(
          (event) => event.type === "turn.started" && event.threadId === threadId,
        )?.turnId;
        assert.isDefined(turnId);
        const turnEvents = events.filter((event) => event.turnId === turnId);
        const providerThread = yield* adapter.readThread(threadId);

        yield* adapter.stopSession(threadId);
        yield* Fiber.interrupt(eventFiber);
        return { result, turnEvents, providerThread };
      });

      const toolOnly = yield* runTerminalTurn("tool-only", {
        T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS: "1",
        T3_ACP_OMIT_INTERLEAVED_FINAL_TEXT: "1",
      });
      assert.equal(toolOnly.result._tag, "Success");
      assert.deepEqual(
        toolOnly.turnEvents
          .filter((event) => event.type === "content.delta")
          .map((event) => event.payload.delta),
        ["before tool"],
      );
      const toolOnlyWarning = toolOnly.turnEvents.find((event) => event.type === "runtime.warning");
      assert.equal(toolOnlyWarning?.type, "runtime.warning");
      if (toolOnlyWarning?.type === "runtime.warning") {
        assert.deepEqual(toolOnlyWarning.payload, {
          message: "Prime Agent finished without sending a final response.",
          detail: { kind: "missing-final-response", outcome: "completed" },
        });
        const serializedNotice = encodeUnknownJsonString(toolOnlyWarning);
        assert.notInclude(serializedNotice, "echo");
        assert.notInclude(serializedNotice, "tool-call-1");
        assert.notInclude(serializedNotice, wrapperPath);
      }
      const toolOnlyTypes = toolOnly.turnEvents.map((event) => event.type);
      assert.isBelow(
        toolOnlyTypes.lastIndexOf("runtime.warning"),
        toolOnlyTypes.lastIndexOf("turn.completed"),
      );
      assert.equal(toolOnly.turnEvents.at(-1)?.type, "turn.completed");
      const toolOnlyTerminal = toolOnly.turnEvents.find(isTurnCompletedEvent);
      assert.equal(toolOnlyTerminal?.payload.state, "completed");
      assert.isTrue(toolOnly.providerThread.turns.every((turn) => turn.items.length === 0));

      const normalText = yield* runTerminalTurn("normal-text", {
        T3_ACP_PROMPT_RESPONSE_TEXT: "normal final response",
      });
      assert.equal(normalText.result._tag, "Success");
      assert.deepEqual(
        normalText.turnEvents
          .filter((event) => event.type === "content.delta")
          .map((event) => event.payload.delta),
        ["normal final response"],
      );
      assert.isFalse(
        normalText.turnEvents.some(
          (event) => event.type === "runtime.warning" || event.type === "runtime.error",
        ),
      );

      const actionablePromptFailure =
        "402 Insufficient balance (including overdraft). Please add funds to continue.";
      const failed = yield* runTerminalTurn("failed", {
        T3_ACP_FAIL_PROMPT: "1",
        T3_ACP_FAIL_PROMPT_MESSAGE: actionablePromptFailure,
      });
      assert.equal(failed.result._tag, "Success");
      const serializedFailureResult = encodeUnknownJsonString(failed.result);
      assert.notInclude(serializedFailureResult, actionablePromptFailure);
      assert.notInclude(serializedFailureResult, wrapperPath);
      assert.isFalse(
        failed.turnEvents.some(
          (event) => event.type === "runtime.warning" || event.type === "runtime.error",
        ),
      );
      assert.equal(failed.turnEvents.at(-1)?.type, "turn.completed");
      const failedTerminal = failed.turnEvents.find(isTurnCompletedEvent);
      assert.deepEqual(failedTerminal?.payload, {
        state: "failed",
        errorMessage: actionablePromptFailure,
      });
      const serializedFailureEvents = encodeUnknownJsonString(failed.turnEvents);
      assert.include(serializedFailureEvents, actionablePromptFailure);
      assert.notInclude(
        serializedFailureEvents,
        "Prime Agent stopped before sending a final response.",
      );
      assert.notInclude(serializedFailureEvents, wrapperPath);

      const privateThought = yield* runTerminalTurn("private-thought", {
        T3_ACP_EMIT_PRIVATE_THOUGHT_CHUNK: "1",
        T3_ACP_PROMPT_RESPONSE_TEXT: "   ",
      });
      assert.equal(privateThought.result._tag, "Success");
      const privateThoughtSerialized = encodeUnknownJsonString(privateThought.turnEvents);
      assert.notInclude(privateThoughtSerialized, "private-thought-sentinel");
      assert.notInclude(privateThoughtSerialized, "agent_thought_chunk");
      const privateThoughtWarning = privateThought.turnEvents.find(
        (event) => event.type === "runtime.warning",
      );
      assert.equal(privateThoughtWarning?.type, "runtime.warning");
      if (privateThoughtWarning?.type === "runtime.warning") {
        assert.deepEqual(privateThoughtWarning.payload.detail, {
          kind: "missing-final-response",
          outcome: "completed",
        });
      }

      const cancelledAdapter = yield* makePrimeAgentAdapter(
        decodeSettings({ binaryPath: wrapperPath }),
        {
          instanceId: ProviderInstanceId.make("primeAgent-textless-cancelled"),
          environment: { ...process.env, T3_ACP_HANG_PROMPT_FOREVER: "1" },
        },
      );
      const cancelledThreadId = ThreadId.make("textless-cancelled");
      const cancelledStarted = yield* Deferred.make<TurnId>();
      const cancelledCompleted = yield* Deferred.make<void>();
      const cancelledEvents: Array<ProviderRuntimeEvent> = [];
      const cancelledEventFiber = yield* cancelledAdapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            cancelledEvents.push(event);
            if (
              event.type === "turn.started" &&
              event.threadId === cancelledThreadId &&
              event.turnId !== undefined
            ) {
              yield* Deferred.succeed(cancelledStarted, event.turnId).pipe(Effect.ignore);
            }
            if (event.type === "turn.completed" && event.threadId === cancelledThreadId) {
              yield* Deferred.succeed(cancelledCompleted, undefined).pipe(Effect.ignore);
            }
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* cancelledAdapter.startSession({
        threadId: cancelledThreadId,
        provider: ProviderDriverKind.make("primeAgent"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const cancelledTurnFiber = yield* cancelledAdapter
        .sendTurn({ threadId: cancelledThreadId, input: "cancel", attachments: [] })
        .pipe(Effect.forkChild);
      const cancelledTurnId = yield* Deferred.await(cancelledStarted);
      yield* cancelledAdapter.interruptTurn(cancelledThreadId, cancelledTurnId);
      yield* Deferred.await(cancelledCompleted);
      yield* Fiber.join(cancelledTurnFiber);
      const cancelledTurnEvents = cancelledEvents.filter(
        (event) => event.turnId === cancelledTurnId,
      );
      assert.isFalse(
        cancelledTurnEvents.some(
          (event) => event.type === "runtime.warning" || event.type === "runtime.error",
        ),
      );
      const cancelledTerminal = cancelledTurnEvents.find(isTurnCompletedEvent);
      assert.equal(cancelledTerminal?.payload.state, "cancelled");

      yield* cancelledAdapter.stopSession(cancelledThreadId);
      yield* Fiber.interrupt(cancelledEventFiber);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("waits for Prime Agent 0.8 terminal quiescence before settling ACP fallback turns", () =>
  Effect.gen(function* () {
    const tempDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-agent-acp-quiescence-")),
    );
    const wrapperPath = NodePath.join(tempDir, "fake-prime-agent.sh");
    const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        wrapperPath,
        `#!/bin/sh
exec ${process.execPath} ${mockAgentPath} "$@"
`,
        "utf8",
      ),
    );
    yield* Effect.promise(() => NodeFSP.chmod(wrapperPath, 0o755));

    const adapter = yield* makePrimeAgentAdapter(decodeSettings({ binaryPath: wrapperPath }), {
      instanceId: ProviderInstanceId.make("primeAgent-quiescence"),
      environment: {
        ...process.env,
        T3_ACP_PRIME_TERMINAL_QUIESCENCE_DELAY_MS: "500",
        T3_ACP_PRIME_TERMINAL_QUIESCENCE_OUTCOME: "error",
        T3_ACP_PRIME_TERMINAL_QUIESCENCE_RESPONSE_TEXT: "   ",
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_ASSERT_TOP_LEVEL_ENV: "1",
        PRIME_AGENT_INTERNAL_TEST_WORKER: "nested",
        RLM_DEPTH: "3",
        RLM_MAX_DEPTH: "4",
      },
    });
    const threadId = ThreadId.make("terminal-quiescence");
    const terminalFiber = yield* adapter.streamEvents.pipe(
      Stream.filter(
        (event): event is TurnCompletedEvent =>
          event.threadId === threadId && event.type === "turn.completed",
      ),
      Stream.runHead,
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("primeAgent"),
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    yield* adapter.sendTurn({
      threadId,
      input: "wait for descendants",
      attachments: [],
    });
    const terminal = yield* Fiber.join(terminalFiber);
    assert.isTrue(Option.isSome(terminal));
    if (Option.isSome(terminal)) {
      assert.deepEqual(terminal.value.payload, {
        state: "failed",
        errorMessage: "Prime Agent stopped before sending a final response.",
      });
    }
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
