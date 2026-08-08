// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  PrimeAgentSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import type { PrimeAgentDaemonExtensionUiResponse } from "./PrimeAgentDaemonBridge.ts";
import type { PrimeDaemonEvent, PrimeDaemonMessage } from "./PrimeAgentDaemonEvents.ts";
import type { PrimeAgentDaemonManager } from "./PrimeAgentDaemonManager.ts";
import {
  makePrimeAgentDaemonAdapter,
  type PrimeAgentDaemonAdapterLiveOptions,
} from "./PrimeAgentDaemonAdapter.ts";
import {
  PRIME_AGENT_DAEMON_RESUME_CURSOR,
  type PrimeAgentDaemonSessionRuntime,
  PrimeAgentDaemonSessionRuntimeError,
  type PrimeAgentDaemonSessionRuntimeInput,
} from "./PrimeAgentDaemonSessionRuntime.ts";

const decodeSettings = Schema.decodeSync(PrimeAgentSettings);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const instanceId = ProviderInstanceId.make("prime-daemon-test");
const threadId = ThreadId.make("prime-daemon/thread");
const manager = {} as PrimeAgentDaemonManager;
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pylon-prime-daemon-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const usage = {
  inputTokens: 11,
  outputTokens: 7,
  cachedInputTokens: 3,
  cacheWriteTokens: 2,
  totalTokens: 23,
  totalCostUsd: 0.012,
};

function assistantMessage(text: string, stopReason: "stop" | "aborted" | "error" = "stop") {
  return {
    role: "assistant",
    timestamp: 1,
    provider: "prime",
    model: "model",
    text,
    thinking: "",
    toolCalls: [],
    usage,
    stopReason,
  } satisfies PrimeDaemonMessage;
}

function initialSnapshot(): Extract<PrimeDaemonEvent, { readonly _tag: "SessionResynced" }> {
  return {
    _tag: "SessionResynced",
    state: {
      sessionId: "native-session-secret",
      cwd: "/native/secret/path",
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      retryAttempt: 0,
      thinkingLevel: "medium",
      serviceTier: null,
      messageCount: 0,
    },
    messages: [],
    children: [],
    lastEventSequence: 1,
  };
}

interface FakeCaptures {
  readonly runtimeInputs: Array<PrimeAgentDaemonSessionRuntimeInput>;
  readonly prompts: Array<{
    readonly text: string;
    readonly images: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }>;
    readonly signal: AbortSignal | undefined;
  }>;
  readonly models: Array<string>;
  readonly extensions: Array<{
    readonly id: string;
    readonly response: PrimeAgentDaemonExtensionUiResponse;
  }>;
  readonly order: Array<string>;
  disposeCount: number;
  extensionFailure: boolean;
  promptObserved: Queue.Queue<void> | undefined;
  queue: Queue.Queue<PrimeDaemonEvent> | undefined;
}

function makeCaptures(): FakeCaptures {
  return {
    runtimeInputs: [],
    prompts: [],
    models: [],
    extensions: [],
    order: [],
    disposeCount: 0,
    extensionFailure: false,
    promptObserved: undefined,
    queue: undefined,
  };
}

function fakeRuntimeFactory(
  captures: FakeCaptures,
): NonNullable<PrimeAgentDaemonAdapterLiveOptions["runtimeFactory"]> {
  return (input) =>
    Effect.gen(function* () {
      captures.runtimeInputs.push(input);
      const queue = yield* Queue.unbounded<PrimeDaemonEvent>();
      const promptObserved = yield* Queue.unbounded<void>();
      captures.queue = queue;
      captures.promptObserved = promptObserved;
      const runtime: PrimeAgentDaemonSessionRuntime = {
        resumeCursor: PRIME_AGENT_DAEMON_RESUME_CURSOR,
        activeSessionId: "native-active-secret",
        initialSnapshot: initialSnapshot(),
        events: Stream.fromQueue(queue),
        prompt: (prompt) =>
          Effect.sync(() => {
            captures.order.push("prompt");
            captures.prompts.push({
              text: prompt.text,
              images: prompt.images ?? [],
              signal: prompt.signal,
            });
          }).pipe(Effect.andThen(Queue.offer(promptObserved, undefined)), Effect.asVoid),
        steer: () => Effect.void,
        followUp: () => Effect.void,
        abort: Effect.sync(() => {
          captures.order.push("abort");
          expect(captures.prompts.at(-1)?.signal?.aborted).toBe(true);
        }),
        setModel: (model) =>
          Effect.sync(() => {
            captures.order.push(`model:${model}`);
            captures.models.push(model);
            const separator = model.indexOf("/");
            return {
              provider: model.slice(0, separator),
              id: model.slice(separator + 1),
              name: model,
            };
          }),
        setThinkingLevel: () => Effect.void,
        setServiceTier: () => Effect.void,
        respondToExtensionUiRequest: (id, response) =>
          captures.extensionFailure
            ? Effect.fail(
                new PrimeAgentDaemonSessionRuntimeError({
                  operation: "extension-ui-response",
                  reason: "request-failed",
                  detail: "native secret failure",
                }),
              )
            : Effect.sync(() => {
                captures.extensions.push({ id, response });
              }),
        dispose: Effect.sync(() => {
          captures.order.push("dispose");
          captures.disposeCount += 1;
        }),
      };
      return runtime;
    });
}

function subscribe(adapter: { readonly streamEvents: Stream.Stream<ProviderRuntimeEvent> }) {
  return Effect.gen(function* () {
    const events: Array<ProviderRuntimeEvent> = [];
    const observed = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const fiber = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(Effect.andThen(Queue.offer(observed, event)), Effect.asVoid),
      ),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    return { events, observed, fiber };
  });
}

const awaitObservedType = Effect.fn("awaitObservedType")(function* (
  observed: Queue.Queue<ProviderRuntimeEvent>,
  type: ProviderRuntimeEvent["type"],
) {
  while (true) {
    const event = yield* Queue.take(observed);
    if (event.type === type) return event;
  }
});

function offer(captures: FakeCaptures, event: PrimeDaemonEvent) {
  return Queue.offer(captures.queue!, event).pipe(Effect.asVoid);
}

describe("PrimeAgentDaemonAdapter", () => {
  it.effect("starts with an opaque v2 cursor and owns the thread-scoped daemon directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(
          decodeSettings({ agentHomePath: "/prime/home" }),
          manager,
          { instanceId, runtimeFactory: fakeRuntimeFactory(captures) },
        );
        const subscription = yield* subscribe(adapter);
        const session = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("primeAgent"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: PRIME_AGENT_DAEMON_RESUME_CURSOR,
          modelSelection: { instanceId, model: "openai/first" },
        });
        yield* awaitObservedType(subscription.observed, "thread.started");

        expect(session.resumeCursor).toEqual(PRIME_AGENT_DAEMON_RESUME_CURSOR);
        expect(captures.runtimeInputs[0]).toMatchObject({
          agentDir: "/prime/home",
          model: "openai/first",
          resumeCursor: PRIME_AGENT_DAEMON_RESUME_CURSOR,
        });
        expect(captures.runtimeInputs[0]!.sessionDir).toContain("provider-sessions/prime-agent/");
        expect(subscription.events.map((event) => event.type)).toEqual([
          "session.started",
          "session.state.changed",
          "thread.started",
        ]);
        expect(encodeUnknownJson(subscription.events)).not.toContain("native-active-secret");
        expect(encodeUnknownJson(subscription.events)).not.toContain("native-session-secret");
        expect(encodeUnknownJson(subscription.events)).not.toContain("/native/secret/path");
        expect(new Set(subscription.events.map((event) => event.eventId)).size).toBe(3);
        expect(subscription.events.every((event) => event.createdAt.length > 0)).toBe(true);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "publishes the stamped canonical sequence, switches models, sends images, and auto-cancels extensions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: { instanceId, model: "openai/first" },
          });
          yield* awaitObservedType(subscription.observed, "thread.started");
          const config = yield* ServerConfig;
          const attachment = {
            type: "image" as const,
            id: "prime-daemon-thread-00000000-0000-4000-8000-000000000001",
            name: "pixel.png",
            mimeType: "image/png",
            sizeBytes: 3,
          };
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              `${config.attachmentsDir}/${attachmentRelativePath(attachment)}`,
              Buffer.from([1, 2, 3]),
            ),
          );

          const turnFiber = yield* adapter
            .sendTurn({
              threadId,
              input: "hello",
              attachments: [attachment],
              modelSelection: { instanceId, model: "anthropic/second" },
              interactionMode: "default",
            })
            .pipe(Effect.forkChild);
          yield* awaitObservedType(subscription.observed, "turn.started");
          yield* Queue.take(captures.promptObserved!);
          yield* offer(captures, { _tag: "MessageStarted", message: assistantMessage("") });
          yield* offer(captures, {
            _tag: "AssistantStream",
            phase: "start",
            kind: "thinking",
          });
          yield* offer(captures, {
            _tag: "AssistantStream",
            phase: "delta",
            kind: "thinking",
            delta: "because",
          });
          yield* offer(captures, {
            _tag: "AssistantStream",
            phase: "end",
            kind: "thinking",
          });
          yield* offer(captures, {
            _tag: "AssistantStream",
            phase: "delta",
            kind: "text",
            delta: "hello back",
          });
          yield* offer(captures, {
            _tag: "ToolStarted",
            toolCallId: "tool-1",
            toolName: "bash",
            input: { command: "pwd" },
          });
          yield* offer(captures, {
            _tag: "ToolProgress",
            toolCallId: "tool-1",
            toolName: "bash",
            text: "running",
          });
          yield* offer(captures, {
            _tag: "ToolCompleted",
            toolCallId: "tool-1",
            toolName: "bash",
            text: "done",
            isError: false,
          });
          yield* offer(captures, {
            _tag: "MessageCompleted",
            message: assistantMessage("hello back"),
          });
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-request-secret",
              method: "native/dialog",
              title: "/native/private/path",
              text: "native payload secret",
            },
          });
          yield* offer(captures, {
            _tag: "TurnCompleted",
            message: assistantMessage("hello back"),
            toolResults: [],
          });
          const result = yield* Fiber.join(turnFiber);
          yield* awaitObservedType(subscription.observed, "thread.token-usage.updated");

          expect(result.resumeCursor).toEqual(PRIME_AGENT_DAEMON_RESUME_CURSOR);
          expect(captures.order.slice(0, 2)).toEqual(["model:anthropic/second", "prompt"]);
          expect(captures.prompts[0]).toMatchObject({
            text: "hello",
            images: [{ type: "image", data: "AQID", mimeType: "image/png" }],
          });
          expect(captures.extensions).toEqual([
            { id: "native-request-secret", response: { cancelled: true } },
          ]);

          const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
          expect(turnEvents.map((event) => event.type)).toEqual([
            "turn.started",
            "item.started",
            "item.started",
            "content.delta",
            "item.completed",
            "content.delta",
            "item.started",
            "item.updated",
            "item.completed",
            "item.completed",
            "runtime.warning",
            "turn.completed",
            "thread.token-usage.updated",
          ]);
          expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
          expect(new Set(turnEvents.map((event) => event.eventId)).size).toBe(turnEvents.length);
          expect(turnEvents.every((event) => event.createdAt.length > 0)).toBe(true);
          const serialized = encodeUnknownJson(turnEvents);
          expect(serialized).not.toContain("native-request-secret");
          expect(serialized).not.toContain("native/dialog");
          expect(serialized).not.toContain("native payload secret");
          expect(serialized).not.toContain("/native/private/path");

          // A duplicate authoritative completion after settlement is ignored.
          yield* offer(captures, {
            _tag: "TurnCompleted",
            message: assistantMessage("duplicate"),
            toolResults: [],
          });
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: { id: "barrier", method: "barrier" },
          });
          yield* awaitObservedType(subscription.observed, "runtime.warning");
          expect(
            subscription.events.filter((event) => event.type === "turn.completed"),
          ).toHaveLength(1);
          yield* adapter.stopSession(threadId);
          yield* awaitObservedType(subscription.observed, "session.exited");
          expect(captures.disposeCount).toBe(1);
          expect(captures.order.at(-1)).toBe("dispose");
          expect(subscription.events.at(-1)?.type).toBe("session.exited");
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect("aborts the admission signal before runtime abort and settles cancellation once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const fiber = yield* adapter
          .sendTurn({ threadId, input: "cancel me" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        const turnId = subscription.events.findLast(
          (event) => event.type === "turn.started",
        )!.turnId!;
        yield* adapter.interruptTurn(threadId, turnId);
        yield* Fiber.join(fiber);
        yield* awaitObservedType(subscription.observed, "turn.completed");

        expect(captures.order).toEqual(["prompt", "abort"]);
        const completions = subscription.events.filter(
          (event) => event.type === "turn.completed" && event.turnId === turnId,
        );
        expect(completions).toHaveLength(1);
        expect(completions[0]).toMatchObject({ payload: { state: "cancelled" } });
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails closed when extension cancellation cannot be delivered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.extensionFailure = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "blocked interaction" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-extension-secret",
            method: "native/secret-method",
            text: "native secret payload",
          },
        });
        yield* awaitObservedType(subscription.observed, "runtime.error");
        const result = yield* Fiber.join(turnFiber);

        expect(captures.order).toEqual(["prompt", "abort"]);
        expect(
          subscription.events.filter(
            (event) => event.type === "turn.completed" && event.turnId === result.turnId,
          ),
        ).toHaveLength(1);
        const serialized = encodeUnknownJson(subscription.events);
        expect(serialized).not.toContain("native-extension-secret");
        expect(serialized).not.toContain("native/secret-method");
        expect(serialized).not.toContain("native secret payload");
        expect(serialized).not.toContain("native secret failure");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("treats SessionClosed as terminal cleanup without duplicate exit or completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        yield* offer(captures, { _tag: "ConnectionStatus", status: "reconnecting" });
        yield* awaitObservedType(subscription.observed, "session.state.changed");
        expect((yield* adapter.listSessions())[0]?.status).toBe("connecting");
        yield* offer(captures, { _tag: "ConnectionStatus", status: "connected" });
        yield* awaitObservedType(subscription.observed, "session.state.changed");
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");

        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "terminal" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        yield* offer(captures, { _tag: "SessionClosed", error: "daemon closed" });
        yield* awaitObservedType(subscription.observed, "turn.completed");
        yield* awaitObservedType(subscription.observed, "session.exited");
        const result = yield* Fiber.join(turnFiber);

        expect(captures.disposeCount).toBe(1);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(yield* adapter.listSessions()).toEqual([]);
        expect(
          subscription.events.filter(
            (event) => event.type === "turn.completed" && event.turnId === result.turnId,
          ),
        ).toHaveLength(1);
        expect(subscription.events.filter((event) => event.type === "session.exited")).toHaveLength(
          1,
        );
        const stoppedAgain = yield* adapter.stopSession(threadId).pipe(Effect.result);
        expect(stoppedAgain._tag).toBe("Failure");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
