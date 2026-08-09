// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  PrimeAgentSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  SessionInteractionRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import type {
  PrimeAgentDaemonExtensionUiResponse,
  PrimeAgentDaemonServiceTier,
  PrimeAgentDaemonThinkingLevel,
} from "./PrimeAgentDaemonBridge.ts";
import type { PrimeDaemonEvent, PrimeDaemonMessage } from "./PrimeAgentDaemonEvents.ts";
import type { PrimeAgentDaemonManager } from "./PrimeAgentDaemonManager.ts";
import {
  makePrimeAgentDaemonAdapter,
  type PrimeAgentDaemonAdapterLiveOptions,
} from "./PrimeAgentDaemonAdapter.ts";
import {
  PRIME_AGENT_DAEMON_RESUME_CURSOR,
  type PrimeAgentDaemonSessionRuntime,
  type PrimeAgentDaemonSessionStats,
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

function assistantMessage(
  text: string,
  stopReason: Extract<PrimeDaemonMessage, { readonly role: "assistant" }>["stopReason"] = "stop",
) {
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
      autoCompactionEnabled: true,
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
  readonly steers: Array<{
    readonly text: string;
    readonly images: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }>;
  }>;
  readonly models: Array<string>;
  readonly thinkingLevels: Array<PrimeAgentDaemonThinkingLevel>;
  readonly serviceTiers: Array<PrimeAgentDaemonServiceTier>;
  readonly extensions: Array<{
    readonly id: string;
    readonly response: PrimeAgentDaemonExtensionUiResponse;
  }>;
  readonly order: Array<string>;
  disposeCount: number;
  extensionFailure: boolean;
  abortClearFailure: boolean;
  sessionStatsFailure: boolean;
  sessionStatsCount: number;
  sessionStats: PrimeAgentDaemonSessionStats;
  promptObserved: Queue.Queue<void> | undefined;
  queue: Queue.Queue<PrimeDaemonEvent> | undefined;
}

function makeCaptures(): FakeCaptures {
  return {
    runtimeInputs: [],
    prompts: [],
    steers: [],
    models: [],
    thinkingLevels: [],
    serviceTiers: [],
    extensions: [],
    order: [],
    disposeCount: 0,
    extensionFailure: false,
    abortClearFailure: false,
    sessionStatsFailure: false,
    sessionStatsCount: 0,
    sessionStats: {
      contextUsage: { usedTokens: 320, maxTokens: 200_000 },
    },
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
      yield* Effect.promise(() =>
        NodeFSP.writeFile(`${input.sessionDir}/native-session-secret.jsonl`, ""),
      );
      const queue = yield* Queue.unbounded<PrimeDaemonEvent>();
      const promptObserved = yield* Queue.unbounded<void>();
      captures.queue = queue;
      captures.promptObserved = promptObserved;
      const runtime: PrimeAgentDaemonSessionRuntime = {
        resumeCursor: PRIME_AGENT_DAEMON_RESUME_CURSOR,
        sessionId: "native-session-secret",
        sessionFile: `${input.sessionDir}/native-session-secret.jsonl`,
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
        steer: (steer) =>
          Effect.sync(() => {
            captures.order.push("steer");
            captures.steers.push({ text: steer.text, images: steer.images ?? [] });
          }),
        followUp: () => Effect.void,
        abort: Effect.sync(() => {
          captures.order.push("abort");
          expect(captures.prompts.at(-1)?.signal?.aborted).toBe(true);
        }),
        abortAndClearQueue: captures.abortClearFailure
          ? Effect.fail(
              new PrimeAgentDaemonSessionRuntimeError({
                operation: "abort-and-clear-queue",
                reason: "request-failed",
                detail: "abort clear failed",
              }),
            )
          : Effect.sync(() => {
              captures.order.push("abort-clear");
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
        setThinkingLevel: (level) =>
          Effect.sync(() => {
            captures.order.push(`thinking:${level}`);
            captures.thinkingLevels.push(level);
          }),
        setServiceTier: (tier) =>
          Effect.sync(() => {
            captures.order.push(`service:${tier ?? "none"}`);
            captures.serviceTiers.push(tier);
          }),
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
                captures.order.push(`extension:${id}`);
                captures.extensions.push({ id, response });
              }),
        getSessionStats: captures.sessionStatsFailure
          ? Effect.fail(
              new PrimeAgentDaemonSessionRuntimeError({
                operation: "session-stats",
                reason: "request-failed",
                detail: "stats failed",
              }),
            )
          : Effect.sync(() => {
              captures.sessionStatsCount += 1;
              return captures.sessionStats;
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
  it.effect("rejects unsupported runtime modes at the adapter boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        for (const runtimeMode of ["auto", "auto-accept-edits"] as const) {
          const error = yield* adapter
            .startSession({ threadId, cwd: process.cwd(), runtimeMode })
            .pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "ProviderAdapterValidationError",
            operation: "startSession",
          });
        }
        expect(captures.runtimeInputs).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );
  it.effect("fails closed when the loaded managed extension source changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const delegate = fakeRuntimeFactory(captures);
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: (input) =>
            delegate(input).pipe(
              Effect.tap(() =>
                Effect.promise(() => NodeFSP.writeFile(input.extensions![0]!, "tampered")),
              ),
            ),
        });
        const error = yield* adapter
          .startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderAdapterProcessError",
          detail:
            "Prime Agent loaded an execution policy extension whose source integrity could not be verified.",
        });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes authoritative context usage and clears unknown post-compaction state", () =>
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

        const initialUsage = yield* awaitObservedType(
          subscription.observed,
          "thread.token-usage.updated",
        );
        expect(initialUsage).toMatchObject({
          payload: {
            usage: {
              usedTokens: 320,
              maxTokens: 200_000,
              compactsAutomatically: true,
            },
          },
        });
        expect(initialUsage).not.toHaveProperty("turnId");

        captures.sessionStats = {
          contextUsage: { usedTokens: null, maxTokens: 200_000 },
        };
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "compact", interactionMode: "default" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        yield* offer(captures, { _tag: "RunStarted" });
        yield* offer(captures, {
          _tag: "RunCompleted",
          messages: [assistantMessage("done")],
        });

        const cleared = yield* awaitObservedType(
          subscription.observed,
          "thread.token-usage.cleared",
        );
        expect(cleared).toMatchObject({ payload: { reason: "unknown" } });
        expect(cleared).not.toHaveProperty("turnId");
        expect(captures.sessionStatsCount).toBe(2);
        yield* Fiber.join(turnFiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps usage telemetry failures ancillary to completed turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.sessionStatsFailure = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "hello", interactionMode: "default" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        yield* offer(captures, { _tag: "RunStarted" });
        yield* offer(captures, {
          _tag: "RunCompleted",
          messages: [assistantMessage("done")],
        });

        const completed = yield* awaitObservedType(subscription.observed, "turn.completed");
        expect(completed).toMatchObject({ payload: { state: "completed" } });
        expect(subscription.events.some((event) => event.type === "runtime.error")).toBe(false);
        yield* Fiber.join(turnFiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("persists a server-private identity behind the opaque v3 cursor", () =>
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
          modelSelection: { instanceId, model: "openai/first" },
        });
        yield* awaitObservedType(subscription.observed, "thread.started");

        expect(session.resumeCursor).toEqual(PRIME_AGENT_DAEMON_RESUME_CURSOR);
        expect(captures.runtimeInputs[0]).toMatchObject({
          agentDir: "/prime/home",
          model: "openai/first",
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
        const identitySource = yield* Effect.promise(() =>
          NodeFSP.readFile(
            `${captures.runtimeInputs[0]!.sessionDir}/.pylon-prime-session.json`,
            "utf8",
          ),
        );
        expect(identitySource).toContain('"sessionId":"native-session-secret"');
        const privateDirMode =
          (yield* Effect.promise(() => NodeFSP.stat(captures.runtimeInputs[0]!.sessionDir))).mode &
          0o777;
        const identityMode =
          (yield* Effect.promise(() =>
            NodeFSP.stat(`${captures.runtimeInputs[0]!.sessionDir}/.pylon-prime-session.json`),
          )).mode & 0o777;
        expect(privateDirMode).toBe(0o700);
        expect(identityMode).toBe(0o600);

        yield* Effect.promise(() =>
          NodeFSP.unlink(`${captures.runtimeInputs[0]!.sessionDir}/.pylon-prime-session.json`),
        );
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: session.resumeCursor,
        });
        expect(captures.runtimeInputs[1]).toMatchObject({
          resumeCursor: PRIME_AGENT_DAEMON_RESUME_CURSOR,
        });
        expect(captures.runtimeInputs[1]).not.toHaveProperty("resumeSessionId");

        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: session.resumeCursor,
        });
        expect(captures.runtimeInputs[2]).toMatchObject({
          resumeCursor: PRIME_AGENT_DAEMON_RESUME_CURSOR,
          resumeSessionId: "native-session-secret",
        });
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails visibly instead of resuming a missing native transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const error = yield* adapter
          .startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: PRIME_AGENT_DAEMON_RESUME_CURSOR,
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "ProviderAdapterProcessError",
          detail: "No saved Prime Agent session is available to continue.",
        });
        expect(captures.runtimeInputs).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("gates approval-required sessions through opaque canonical approvals", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        yield* awaitObservedType(subscription.observed, "thread.started");

        expect(session.runtimeMode).toBe("approval-required");
        expect(captures.runtimeInputs[0]).toMatchObject({
          disableExtensionDiscovery: true,
          disableAutoReconnect: true,
          requiredExtension: {
            markerCommand: "pylon-permission-gate-v1",
          },
        });
        expect(captures.runtimeInputs[0]!.extensions).toHaveLength(1);
        const slashError = yield* adapter
          .sendTurn({
            threadId,
            input: "/export /tmp/bypass.html",
            interactionMode: "default",
          })
          .pipe(Effect.flip);
        expect(slashError).toMatchObject({
          operation: "sendTurn",
          issue: expect.stringContaining("slash commands"),
        });
        expect(captures.prompts).toEqual([]);
        const extensionPath = captures.runtimeInputs[0]!.extensions![0]!;
        const extensionSource = yield* Effect.promise(() =>
          NodeFSP.readFile(extensionPath, "utf8"),
        );
        const title = extensionSource.match(/const TITLE = "([^"]+)";/)?.[1];
        expect(title).toMatch(/^Pylon execution approval:[0-9a-f-]{36}$/);
        if (title === undefined) throw new Error("Managed extension title was not generated.");

        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-approval-secret",
            method: "confirm",
            title,
            message: "pylon-permission-v1\ncommand_execution_approval\nbash\nprintf guarded",
            timeoutMs: 600_000,
          },
        });
        const requested = yield* awaitObservedType(subscription.observed, "request.opened");
        expect(requested).toMatchObject({
          payload: {
            requestType: "command_execution_approval",
            detail: "printf guarded",
            args: { toolName: "bash" },
          },
        });
        expect(encodeUnknownJson(requested)).not.toContain("native-approval-secret");
        expect(encodeUnknownJson(requested)).not.toContain(title);

        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(String(requested.requestId)),
          "acceptForSession",
        );
        const resolved = yield* awaitObservedType(subscription.observed, "request.resolved");
        expect(resolved).toMatchObject({
          requestId: requested.requestId,
          payload: { requestType: "command_execution_approval", decision: "acceptForSession" },
        });
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-session-approved",
            method: "confirm",
            title,
            message: "pylon-permission-v1\nfile_change_approval\nedit\nREADME.md",
          },
        });
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-wrong-token",
            method: "confirm",
            title: "Pylon execution approval:wrong-token",
            message: "pylon-permission-v1\ncommand_execution_approval\nbash\ntouch denied",
          },
        });
        yield* awaitObservedType(subscription.observed, "runtime.error");
        expect(captures.extensions).toEqual([
          { id: "native-approval-secret", response: { confirmed: true } },
          { id: "native-session-approved", response: { confirmed: true } },
          { id: "native-wrong-token", response: { confirmed: false } },
        ]);
        expect(subscription.events.filter((event) => event.type === "request.opened")).toHaveLength(
          1,
        );
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "keeps failed responses pending and settles cancellation even when queue clearing fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const captures = makeCaptures();
          captures.abortClearFailure = true;
          const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
            instanceId,
            runtimeFactory: fakeRuntimeFactory(captures),
          });
          const subscription = yield* subscribe(adapter);
          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });
          yield* awaitObservedType(subscription.observed, "thread.started");
          const extensionPath = captures.runtimeInputs[0]!.extensions![0]!;
          const source = yield* Effect.promise(() => NodeFSP.readFile(extensionPath, "utf8"));
          const title = source.match(/const TITLE = "([^"]+)";/)?.[1];
          if (title === undefined) throw new Error("Managed extension title was not generated.");
          const turnFiber = yield* adapter
            .sendTurn({ threadId, input: "run custom", interactionMode: "default" })
            .pipe(Effect.forkChild);
          yield* awaitObservedType(subscription.observed, "turn.started");
          yield* Queue.take(captures.promptObserved!);
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-retry-approval",
              method: "confirm",
              title,
              message: "pylon-permission-v1\ncommand_execution_approval\nbash\nprintf guarded",
            },
          });
          const requested = yield* awaitObservedType(subscription.observed, "request.opened");
          const requestId = ApprovalRequestId.make(String(requested.requestId));
          captures.extensionFailure = true;
          yield* adapter.respondToRequest(threadId, requestId, "accept").pipe(Effect.flip);
          expect(subscription.events.some((event) => event.type === "request.resolved")).toBe(
            false,
          );

          captures.extensionFailure = false;
          const cancelExit = yield* adapter
            .respondToRequest(threadId, requestId, "cancel")
            .pipe(Effect.exit);
          expect(Exit.isFailure(cancelExit)).toBe(true);
          const resolved = yield* awaitObservedType(subscription.observed, "request.resolved");
          expect(resolved).toMatchObject({ payload: { decision: "cancel" } });
          const result = yield* Fiber.join(turnFiber);
          expect(result.threadId).toBe(threadId);
          expect(
            subscription.events.some(
              (event) => event.type === "turn.completed" && event.payload.state === "cancelled",
            ),
          ).toBe(true);
          expect(captures.extensions).toEqual([
            { id: "native-retry-approval", response: { confirmed: false } },
          ]);
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "publishes the stamped canonical sequence, switches models, sends images, and resolves extensions",
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
              modelSelection: {
                instanceId,
                model: "anthropic/second",
                options: [
                  { id: "thinkingLevel", value: "high" },
                  { id: "serviceTier", value: "priority" },
                ],
              },
              interactionMode: "default",
            })
            .pipe(Effect.forkChild);
          yield* awaitObservedType(subscription.observed, "turn.started");
          yield* Queue.take(captures.promptObserved!);
          const toolTurnMessage = assistantMessage("hello back", "toolUse");
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
            content: "because",
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
            message: toolTurnMessage,
          });
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-request-secret",
              method: "select",
              title: " Choose a client ",
              options: ["web", "desktop"],
              timeoutMs: 10_000,
              text: "native payload secret",
            },
          });
          const requested = yield* awaitObservedType(
            subscription.observed,
            "interaction.requested",
          );
          expect(requested).toMatchObject({
            turnId: subscription.events.findLast((event) => event.type === "turn.started")!.turnId,
            payload: {
              request: {
                kind: "select",
                title: "Choose a client",
                options: ["web", "desktop"],
                timeout: 10_000,
              },
            },
          });
          expect(requested.requestId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          expect(captures.extensions).toEqual([]);
          yield* adapter.respondToInteraction!(threadId, requested.requestId!, {
            kind: "selected",
            value: "desktop",
          });
          const resolved = yield* awaitObservedType(subscription.observed, "interaction.resolved");
          expect(resolved).toMatchObject({
            requestId: requested.requestId,
            turnId: requested.turnId,
            payload: { response: { kind: "selected", value: "desktop" } },
          });
          yield* offer(captures, {
            _tag: "TurnCompleted",
            message: toolTurnMessage,
            toolResults: [],
          });
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: { id: "cycle-barrier", method: "barrier" },
          });
          yield* awaitObservedType(subscription.observed, "runtime.warning");
          expect(turnFiber.pollUnsafe()).toBeUndefined();

          const finalMessage = assistantMessage("final answer");
          yield* offer(captures, { _tag: "TurnStarted" });
          yield* offer(captures, { _tag: "MessageStarted", message: finalMessage });
          yield* offer(captures, { _tag: "MessageCompleted", message: finalMessage });
          yield* offer(captures, {
            _tag: "TurnCompleted",
            message: finalMessage,
            toolResults: [],
          });
          yield* offer(captures, { _tag: "SessionInfoChanged", name: "Cycle complete" });
          yield* awaitObservedType(subscription.observed, "thread.metadata.updated");
          expect(turnFiber.pollUnsafe()).toBeUndefined();
          yield* offer(captures, {
            _tag: "RunCompleted",
            messages: [toolTurnMessage, finalMessage],
          });
          const result = yield* Fiber.join(turnFiber);
          yield* awaitObservedType(subscription.observed, "session.state.changed");

          expect(result.resumeCursor).toEqual(PRIME_AGENT_DAEMON_RESUME_CURSOR);
          expect(captures.order.slice(0, 4)).toEqual([
            "model:anthropic/second",
            "thinking:high",
            "service:priority",
            "prompt",
          ]);
          expect(captures.thinkingLevels).toEqual(["high"]);
          expect(captures.serviceTiers).toEqual(["priority"]);
          expect(captures.prompts[0]).toMatchObject({
            text: "hello",
            images: [{ type: "image", data: "AQID", mimeType: "image/png" }],
          });
          expect(captures.extensions).toEqual([
            { id: "native-request-secret", response: { value: "desktop" } },
          ]);

          const turnEvents = subscription.events.filter((event) => event.turnId === result.turnId);
          expect(turnEvents.map((event) => event.type)).toEqual([
            "turn.started",
            "item.started",
            "item.completed",
            "content.delta",
            "item.started",
            "item.updated",
            "item.completed",
            "item.completed",
            "interaction.requested",
            "interaction.resolved",
            "runtime.warning",
            "item.started",
            "content.delta",
            "item.completed",
            "thread.metadata.updated",
            "turn.completed",
            "session.state.changed",
          ]);
          expect(turnEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
          expect(turnEvents.find((event) => event.type === "turn.completed")).toMatchObject({
            payload: {
              state: "completed",
              usage: {
                inputTokens: 22,
                outputTokens: 14,
                cachedInputTokens: 6,
                cacheWriteTokens: 4,
                totalTokens: 46,
              },
              totalCostUsd: 0.024,
            },
          });
          expect(new Set(turnEvents.map((event) => event.eventId)).size).toBe(turnEvents.length);
          expect(turnEvents.every((event) => event.createdAt.length > 0)).toBe(true);
          const serialized = encodeUnknownJson(turnEvents);
          expect(serialized).not.toContain("native-request-secret");
          expect(serialized).not.toContain("native/dialog");
          expect(serialized).not.toContain("native payload secret");
          expect(serialized).not.toContain("/native/private/path");

          // A duplicate authoritative completion after settlement is ignored.
          yield* offer(captures, {
            _tag: "RunCompleted",
            messages: [assistantMessage("duplicate")],
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

  it.effect("steers an active daemon run without opening or settling another turn", () =>
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
        yield* awaitObservedType(subscription.observed, "thread.token-usage.updated");
        expect(captures.sessionStatsCount).toBe(1);

        const running = yield* adapter
          .sendTurn({ threadId, input: "first" })
          .pipe(Effect.forkChild);
        const started = yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);

        const changedControls = yield* adapter
          .sendTurn({
            threadId,
            input: "change controls",
            modelSelection: {
              instanceId,
              model: "default",
              options: [{ id: "thinkingLevel", value: "xhigh" }],
            },
          })
          .pipe(Effect.result);
        expect(changedControls._tag).toBe("Failure");

        const steered = yield* adapter.sendTurn({
          threadId,
          input: "focus on the failure",
          modelSelection: {
            instanceId,
            model: "default",
            options: [
              { id: "thinkingLevel", value: "medium" },
              { id: "serviceTier", value: "prime-default" },
            ],
          },
        });
        expect(steered.turnId).toBe(started.turnId);
        expect(captures.steers).toEqual([{ text: "focus on the failure", images: [] }]);
        expect(captures.thinkingLevels).toEqual([]);
        expect(captures.serviceTiers).toEqual([]);
        expect(captures.order).toEqual(["prompt", "steer"]);
        expect(subscription.events.filter((event) => event.type === "turn.started")).toHaveLength(
          1,
        );
        expect(running.pollUnsafe()).toBeUndefined();

        const firstRunMessage = assistantMessage("base");
        yield* offer(captures, {
          _tag: "TurnCompleted",
          message: firstRunMessage,
          toolResults: [],
        });
        yield* offer(captures, { _tag: "RunCompleted", messages: [firstRunMessage] });
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 0,
          steering: [],
          followUps: [],
        });
        yield* offer(captures, {
          _tag: "RetryStarted",
          attempt: 1,
          maxAttempts: 2,
          delayMs: 0,
          errorMessage: "queue barrier",
        });
        yield* awaitObservedType(subscription.observed, "runtime.warning");
        expect(running.pollUnsafe()).toBeUndefined();
        expect(subscription.events.filter((event) => event.type === "turn.completed")).toHaveLength(
          0,
        );
        expect(captures.sessionStatsCount).toBe(1);

        yield* offer(captures, { _tag: "RunStarted" });
        const finalMessage = assistantMessage("done");
        yield* offer(captures, {
          _tag: "TurnCompleted",
          message: finalMessage,
          toolResults: [],
        });
        yield* offer(captures, { _tag: "RunCompleted", messages: [finalMessage] });
        yield* Fiber.join(running);
        yield* awaitObservedType(subscription.observed, "thread.token-usage.updated");
        expect(captures.sessionStatsCount).toBe(2);
        const completed = subscription.events.filter((event) => event.type === "turn.completed");
        expect(completed).toHaveLength(1);
        expect(completed[0]?.payload.usage).toEqual({
          inputTokens: 22,
          outputTokens: 14,
          cachedInputTokens: 6,
          cacheWriteTokens: 4,
          totalTokens: 46,
        });
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("settles when a queued steer fails before a native run starts", () =>
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

        const running = yield* adapter
          .sendTurn({ threadId, input: "first" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        yield* adapter.sendTurn({ threadId, input: "queued one" });
        yield* adapter.sendTurn({ threadId, input: "queued two" });

        const firstRunMessage = assistantMessage("base");
        yield* offer(captures, { _tag: "RunCompleted", messages: [firstRunMessage] });
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 1,
          steering: ["queued two"],
          followUps: [],
          active: { kind: "turn", phase: "preparing" },
        });
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 1,
          steering: ["queued two"],
          followUps: [],
        });
        yield* Fiber.join(running);

        const completions = subscription.events.filter((event) => event.type === "turn.completed");
        expect(completions).toHaveLength(1);
        expect(completions[0]?.payload).toMatchObject({
          state: "failed",
          errorMessage: "Prime Agent could not start a queued input.",
        });
        expect(captures.steers.map((steer) => steer.text)).toEqual(["queued one", "queued two"]);
        expect(captures.order.at(-1)).toBe("abort-clear");
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("finishes detached cleanup when a failed queued run cannot clear the queue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captures = makeCaptures();
        captures.abortClearFailure = true;
        const adapter = yield* makePrimeAgentDaemonAdapter(decodeSettings({}), manager, {
          instanceId,
          runtimeFactory: fakeRuntimeFactory(captures),
        });
        const subscription = yield* subscribe(adapter);
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* awaitObservedType(subscription.observed, "thread.started");

        const running = yield* adapter
          .sendTurn({ threadId, input: "first" })
          .pipe(Effect.forkChild);
        yield* awaitObservedType(subscription.observed, "turn.started");
        yield* Queue.take(captures.promptObserved!);
        yield* adapter.sendTurn({ threadId, input: "queued" });
        yield* offer(captures, {
          _tag: "RunCompleted",
          messages: [assistantMessage("base")],
        });
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 0,
          steering: [],
          followUps: [],
          active: { kind: "turn", phase: "preparing" },
        });
        yield* offer(captures, {
          _tag: "QueueChanged",
          queuedCount: 0,
          steering: [],
          followUps: [],
        });

        yield* Fiber.join(running);
        const exited = yield* awaitObservedType(subscription.observed, "session.exited");
        expect(exited).toMatchObject({ payload: { exitKind: "graceful" } });
        expect(captures.disposeCount).toBe(1);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "validates interaction responses, retains failed native requests, and rejects stale ids",
    () =>
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

          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-select-secret",
              method: "select",
              title: "Target",
              options: ["web", "desktop"],
            },
          });
          const requested = yield* awaitObservedType(
            subscription.observed,
            "interaction.requested",
          );
          const requestId = requested.requestId!;

          const wrongKind = yield* adapter.respondToInteraction!(threadId, requestId, {
            kind: "confirmed",
            confirmed: true,
          }).pipe(Effect.result);
          const wrongValue = yield* adapter.respondToInteraction!(threadId, requestId, {
            kind: "selected",
            value: "mobile",
          }).pipe(Effect.result);
          expect(wrongKind._tag).toBe("Failure");
          expect(wrongValue._tag).toBe("Failure");
          expect(captures.extensions).toEqual([]);

          captures.extensionFailure = true;
          const nativeFailure = yield* adapter.respondToInteraction!(threadId, requestId, {
            kind: "selected",
            value: "desktop",
          }).pipe(Effect.result);
          expect(nativeFailure._tag).toBe("Failure");
          captures.extensionFailure = false;
          yield* adapter.respondToInteraction!(threadId, requestId, {
            kind: "selected",
            value: "desktop",
          });
          yield* awaitObservedType(subscription.observed, "interaction.resolved");
          expect(captures.extensions).toEqual([
            { id: "native-select-secret", response: { value: "desktop" } },
          ]);

          const duplicate = yield* adapter.respondToInteraction!(threadId, requestId, {
            kind: "cancelled",
          }).pipe(Effect.result);
          const unknown = yield* adapter.respondToInteraction!(
            threadId,
            SessionInteractionRequestId.make("00000000-0000-4000-8000-000000000099"),
            { kind: "cancelled" },
          ).pipe(Effect.result);
          expect(duplicate._tag).toBe("Failure");
          expect(unknown._tag).toBe("Failure");

          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-confirm-secret",
              method: "confirm",
              title: "Continue?",
              message: "Proceed now",
            },
          });
          const confirm = yield* awaitObservedType(subscription.observed, "interaction.requested");
          yield* adapter.respondToInteraction!(threadId, confirm.requestId!, {
            kind: "confirmed",
            confirmed: false,
          });
          yield* awaitObservedType(subscription.observed, "interaction.resolved");

          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-input-secret",
              method: "input",
              title: "Branch",
              placeholder: "feature/name",
            },
          });
          const input = yield* awaitObservedType(subscription.observed, "interaction.requested");
          yield* adapter.respondToInteraction!(threadId, input.requestId!, {
            kind: "submitted",
            value: "feature/safe",
          });
          yield* awaitObservedType(subscription.observed, "interaction.resolved");

          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-editor-secret",
              method: "editor",
              title: "Plan",
              prefill: "# Draft",
            },
          });
          const editor = yield* awaitObservedType(subscription.observed, "interaction.requested");
          yield* adapter.respondToInteraction!(threadId, editor.requestId!, {
            kind: "submitted",
            value: "# Final",
          });
          yield* awaitObservedType(subscription.observed, "interaction.resolved");

          expect(captures.extensions.slice(1)).toEqual([
            { id: "native-confirm-secret", response: { confirmed: false } },
            { id: "native-input-secret", response: { value: "feature/safe" } },
            { id: "native-editor-secret", response: { value: "# Final" } },
          ]);
          yield* Fiber.interrupt(subscription.fiber);
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "expires blocking interactions without replying to an already-timed-out native dialog",
    () =>
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
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: {
              id: "native-timeout-secret",
              method: "input",
              title: "Short-lived input",
              timeoutMs: 1_000,
            },
          });
          const requested = yield* awaitObservedType(
            subscription.observed,
            "interaction.requested",
          );

          yield* TestClock.adjust("1 second");
          const resolved = yield* awaitObservedType(subscription.observed, "interaction.resolved");
          expect(resolved).toMatchObject({
            requestId: requested.requestId,
            payload: { response: { kind: "cancelled" } },
          });
          expect(captures.extensions).toEqual([]);
          const stale = yield* adapter.respondToInteraction!(threadId, requested.requestId!, {
            kind: "cancelled",
          }).pipe(Effect.result);
          expect(stale._tag).toBe("Failure");
          expect(
            subscription.events.filter(
              (event) =>
                event.type === "interaction.resolved" && event.requestId === requested.requestId,
            ),
          ).toHaveLength(1);
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

        expect(captures.order).toEqual(["prompt", "abort-clear"]);
        const completions = subscription.events.filter(
          (event) => event.type === "turn.completed" && event.turnId === turnId,
        );
        expect(completions).toHaveLength(1);
        expect(completions[0]).toMatchObject({ payload: { state: "cancelled" } });

        const lateMessage = assistantMessage("cancelled", "aborted");
        yield* offer(captures, {
          _tag: "TurnCompleted",
          message: lateMessage,
          toolResults: [],
        });
        yield* offer(captures, { _tag: "RunCompleted", messages: [lateMessage] });
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: { id: "interrupt-barrier", method: "barrier" },
        });
        yield* awaitObservedType(subscription.observed, "runtime.warning");
        expect(
          subscription.events.filter(
            (event) => event.type === "turn.completed" && event.turnId === turnId,
          ),
        ).toHaveLength(1);
        yield* Fiber.interrupt(subscription.fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes safe nonblocking presentation updates and ignores malformed requests", () =>
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

        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-notify-secret",
            method: "notify",
            message: "Saved",
            notifyType: "warning",
            text: "native notification payload",
          },
        });
        const notification = yield* awaitObservedType(
          subscription.observed,
          "session-presentation.updated",
        );
        expect(notification).toMatchObject({
          payload: {
            presentation: { kind: "notification", message: "Saved", level: "warning" },
          },
        });

        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-status-secret",
            method: "setStatus",
            statusKey: " build ",
            statusText: "Running",
            text: "native status payload",
          },
        });
        const status = yield* awaitObservedType(
          subscription.observed,
          "session-presentation.updated",
        );
        expect(status).toMatchObject({
          payload: { presentation: { kind: "status", key: "build", text: "Running" } },
        });

        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-widget-secret",
            method: "setWidget",
            widgetKey: "plan",
            widgetLines: ["1. Test", "2. Ship"],
            widgetPlacement: "belowEditor",
            text: "native widget payload",
          },
        });
        const widget = yield* awaitObservedType(
          subscription.observed,
          "session-presentation.updated",
        );
        expect(widget).toMatchObject({
          payload: {
            presentation: {
              kind: "widget",
              key: "plan",
              lines: ["1. Test", "2. Ship"],
              placement: "belowEditor",
            },
          },
        });

        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-fire-and-forget-secret",
            method: "setTitle",
            title: "New title",
          },
        });
        yield* awaitObservedType(subscription.observed, "runtime.warning");
        expect(captures.extensions).toEqual([]);
        expect(captures.order).toEqual([]);

        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: { id: "native-malformed-notify", method: "notify", message: "   " },
        });
        const presentationWarning = yield* awaitObservedType(
          subscription.observed,
          "runtime.warning",
        );
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: {
            id: "native-malformed-select",
            method: "select",
            title: "Choose",
            options: [],
          },
        });
        const blockingWarning = yield* awaitObservedType(subscription.observed, "runtime.warning");

        expect(captures.extensions).toEqual([
          { id: "native-malformed-select", response: { cancelled: true } },
        ]);
        expect(encodeUnknownJson([notification, status, widget])).not.toContain("native");
        expect(presentationWarning).toMatchObject({
          payload: {
            message: "Prime Agent sent an unsupported interaction update; it was ignored.",
          },
        });
        expect(blockingWarning).toMatchObject({
          payload: { message: "Prime Agent sent a malformed interaction request; it was ignored." },
        });
        expect(encodeUnknownJson([presentationWarning, blockingWarning])).not.toContain(
          "malformed-select",
        );
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
            method: "confirm",
            title: "   ",
            text: "native secret payload",
          },
        });
        yield* awaitObservedType(subscription.observed, "runtime.error");
        const result = yield* Fiber.join(turnFiber);

        expect(captures.order).toEqual(["prompt", "abort-clear"]);
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

  it.effect(
    "cancels pending interactions before stop disposal and resolves each exactly once",
    () =>
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
          yield* offer(captures, {
            _tag: "ExtensionRequest",
            request: { id: "native-stop-secret", method: "input", title: "Pending input" },
          });
          const requested = yield* awaitObservedType(
            subscription.observed,
            "interaction.requested",
          );

          yield* adapter.stopSession(threadId);
          const resolved = yield* awaitObservedType(subscription.observed, "interaction.resolved");
          yield* awaitObservedType(subscription.observed, "session.exited");

          expect(resolved).toMatchObject({
            requestId: requested.requestId,
            payload: { response: { kind: "cancelled" } },
          });
          expect(
            subscription.events.filter(
              (event) =>
                event.type === "interaction.resolved" && event.requestId === requested.requestId,
            ),
          ).toHaveLength(1);
          expect(captures.extensions).toEqual([
            { id: "native-stop-secret", response: { cancelled: true } },
          ]);
          expect(captures.order).toEqual(["extension:native-stop-secret", "dispose"]);
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
        yield* offer(captures, {
          _tag: "ExtensionRequest",
          request: { id: "native-close-secret", method: "confirm", title: "Still pending?" },
        });
        const requested = yield* awaitObservedType(subscription.observed, "interaction.requested");
        yield* offer(captures, { _tag: "SessionClosed", error: "daemon closed" });
        const resolved = yield* awaitObservedType(subscription.observed, "interaction.resolved");
        yield* awaitObservedType(subscription.observed, "turn.completed");
        yield* awaitObservedType(subscription.observed, "session.exited");
        const result = yield* Fiber.join(turnFiber);

        expect(captures.disposeCount).toBe(1);
        expect(captures.extensions).toEqual([]);
        expect(resolved).toMatchObject({
          requestId: requested.requestId,
          payload: { response: { kind: "cancelled" } },
        });
        expect(
          subscription.events.filter(
            (event) =>
              event.type === "interaction.resolved" && event.requestId === requested.requestId,
          ),
        ).toHaveLength(1);
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
