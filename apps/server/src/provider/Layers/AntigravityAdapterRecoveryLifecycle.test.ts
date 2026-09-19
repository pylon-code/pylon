import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AntigravitySettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import type { AcpSessionRuntimeEvent } from "../acp/AcpSessionRuntime.ts";
import { makeAntigravityAdapter, type AntigravityAdapterOptions } from "./AntigravityAdapter.ts";

const instanceId = ProviderInstanceId.make("antigravity-lifecycle-test");
const threadId = ThreadId.make("antigravity-lifecycle-thread");
const nativeSessionId = "c86eb8e9-cd99-40e5-aa63-ac2b4674a7b0";
const nativeDefault = "gemini-test-low";
const decodeSettings = Schema.decodeSync(AntigravitySettings);

interface NativePrompt {
  readonly index: number;
  readonly content: ReadonlyArray<AcpSchema.ContentBlock>;
  readonly result: Deferred.Deferred<AcpSchema.PromptResponse, AcpErrors.AcpError>;
}

interface RuntimeInstance {
  readonly index: number;
  readonly input: Parameters<AntigravityAdapterOptions["makeRuntime"]>[0];
  readonly events: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly activePrompt: () => NativePrompt | undefined;
}

const makeHarness = Effect.fn("makeAntigravityAdapterLifecycleHarness")(function* (options?: {
  readonly hangResume?: boolean;
}) {
  const canonicalEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const prompts = yield* Queue.unbounded<NativePrompt>();
  const cancellations = yield* Queue.unbounded<number>();
  const cancelReleases = yield* Queue.unbounded<Deferred.Deferred<void>>();
  const seen: ProviderRuntimeEvent[] = [];
  const instances: RuntimeInstance[] = [];
  const resumeStarted = yield* Deferred.make<void>();
  const resumeRelease = yield* Deferred.make<void>();

  let promptIndex = 0;
  let runtimeCounter = 0;

  const configOptions = (): ReadonlyArray<AcpSchema.SessionConfigOption> => [
    {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: nativeDefault,
      options: [{ value: nativeDefault, name: "Gemini test low" }],
    },
  ];

  const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true }), {
    instanceId,
    makeRuntime: (input) =>
      Effect.gen(function* () {
        const rIndex = ++runtimeCounter;
        const runtimeEvents = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
        let active: NativePrompt | undefined;

        const drainEvents = Effect.gen(function* () {
          const acknowledge = yield* Deferred.make<void>();
          yield* Queue.offer(runtimeEvents, { _tag: "EventStreamBarrier", acknowledge });
          yield* Deferred.await(acknowledge);
        });

        const runtime: Effect.Success<ReturnType<AntigravityAdapterOptions["makeRuntime"]>> = {
          handleRequestPermission: () => Effect.void,
          handleReadTextFile: () => Effect.void,
          handleWriteTextFile: () => Effect.void,
          start: () =>
            Effect.gen(function* () {
              if (options?.hangResume && rIndex > 1) {
                yield* Deferred.succeed(resumeStarted, undefined);
                yield* Deferred.await(resumeRelease);
              }
              return {
                sessionId: nativeSessionId,
                initializeResult: {
                  protocolVersion: 1,
                  agentCapabilities: { sessionCapabilities: { resume: {} } },
                },
                sessionSetupResult: { sessionId: nativeSessionId, configOptions: configOptions() },
                modelConfigId: "model",
              };
            }),
          getConfigOptions: Effect.sync(configOptions),
          setModel: () => Effect.void,
          setMode: () => Effect.succeed({}),
          getEvents: () => Stream.fromQueue(runtimeEvents),
          drainEvents,
          prompt: (payload, promptOptions) =>
            Effect.gen(function* () {
              const p: NativePrompt = {
                index: ++promptIndex,
                content: payload.prompt,
                result: yield* Deferred.make<AcpSchema.PromptResponse, AcpErrors.AcpError>(),
              };
              active = p;
              if (promptOptions?.dispatched) {
                yield* Deferred.succeed(promptOptions.dispatched, undefined);
              }
              yield* Queue.offer(prompts, p);
              return yield* Deferred.await(p.result).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (active === p) active = undefined;
                  }),
                ),
              );
            }),
          cancel: Effect.gen(function* () {
            const p = active;
            if (!p) return;
            yield* Queue.offer(cancellations, p.index);
            const release = yield* Deferred.make<void>();
            yield* Queue.offer(cancelReleases, release);
            yield* Deferred.await(release);
            yield* Deferred.succeed(p.result, { stopReason: "cancelled" });
            yield* drainEvents;
          }),
        };

        const inst: RuntimeInstance = {
          index: rIndex,
          input,
          events: runtimeEvents,
          activePrompt: () => active,
        };
        instances.push(inst);
        return runtime;
      }),
    withProcess: (_stop, task) => task,
  });

  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        seen.push(event);
      }).pipe(Effect.andThen(Queue.offer(canonicalEvents, event))),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  return {
    adapter,
    instances,
    prompts,
    seen,
    nextEvent: Queue.take(canonicalEvents),
    nextPrompt: Queue.take(prompts),
    nextCancellation: Queue.take(cancellations),
    cancelReleases,
    resumeStarted,
    resumeRelease,
  };
});

const layer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pylon-antigravity-lifecycle-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("AntigravityAdapter recovery lifecycle", (it) => {
  it.effect(
    "isolates runtime events so stale events and failures from retired transport are ignored",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        expect(h.instances).toHaveLength(1);
        const runtime1 = h.instances[0]!;

        yield* h.adapter.sendTurn({ threadId, input: "Turn 1" });
        const prompt1 = yield* h.nextPrompt;

        const steering = yield* h.adapter
          .sendTurn({ threadId, input: "Steering prompt" })
          .pipe(Effect.forkChild);
        yield* h.nextCancellation;
        const release = yield* Queue.take(h.cancelReleases);

        const cancelDetail = "The ACP agent did not finish cancellation. Its process was stopped.";
        yield* Queue.offer(runtime1.events, {
          _tag: "ConnectionTerminated",
          error: new AcpErrors.AcpTransportError({
            operation: "call-rpc",
            method: "session/cancel",
            detail: cancelDetail,
            cause: undefined,
          }),
        });
        yield* Deferred.fail(
          prompt1.result,
          new AcpErrors.AcpTransportError({
            operation: "call-rpc",
            method: "session/prompt",
            detail: cancelDetail,
            cause: undefined,
          }),
        );
        yield* Deferred.succeed(release, undefined);

        const prompt2 = yield* h.nextPrompt;
        expect(h.instances).toHaveLength(2);

        // Emit stale events to retired runtime1: tool call, output chunk, and ConnectionTerminated
        yield* Queue.offer(runtime1.events, {
          _tag: "ToolCallUpdated",
          toolCall: {
            toolCallId: "stale-call-1",
            title: "Stale command",
            kind: "execute",
            status: "inProgress",
            data: {},
          },
          rawPayload: {},
        });
        yield* Queue.offer(runtime1.events, {
          _tag: "ConnectionTerminated",
          error: new AcpErrors.AcpTransportError({
            operation: "call-rpc",
            method: "session/prompt",
            detail: "Fatal stale error",
            cause: undefined,
          }),
        });

        // Verify active runtime2 is unaffected and completes turn cleanly
        yield* Deferred.succeed(prompt2.result, { stopReason: "end_turn" });
        const steerExit = yield* Fiber.await(steering);
        expect(steerExit._tag).toBe("Success");

        while (true) {
          const event = yield* h.nextEvent;
          if (event.type === "turn.completed") {
            expect(event.payload.state).toBe("completed");
            break;
          }
        }
        // Stale tool call should not have entered seen canonical events
        const staleEvents = h.seen.filter((e) => e.itemId === "stale-call-1");
        expect(staleEvents).toHaveLength(0);
        expect(yield* h.adapter.hasSession(threadId)).toBe(true);
      }),
  );

  it.effect("Stop during hung resumption startup promptly aborts recovery without waiting", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ hangResume: true });
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* h.adapter.sendTurn({ threadId, input: "Turn 1" });
      const prompt1 = yield* h.nextPrompt;

      const steering = yield* h.adapter
        .sendTurn({ threadId, input: "Steering prompt" })
        .pipe(Effect.forkChild);
      yield* h.nextCancellation;
      const release = yield* Queue.take(h.cancelReleases);

      const cancelDetail = "The ACP agent did not finish cancellation. Its process was stopped.";
      yield* Queue.offer(h.instances[0]!.events, {
        _tag: "ConnectionTerminated",
        error: new AcpErrors.AcpTransportError({
          operation: "call-rpc",
          method: "session/cancel",
          detail: cancelDetail,
          cause: undefined,
        }),
      });
      yield* Deferred.fail(
        prompt1.result,
        new AcpErrors.AcpTransportError({
          operation: "call-rpc",
          method: "session/prompt",
          detail: cancelDetail,
          cause: undefined,
        }),
      );
      yield* Deferred.succeed(release, undefined);

      // Resumption is now hung waiting on resumeRelease
      yield* Deferred.await(h.resumeStarted);

      // Stop session / interrupt turn while recovery startup is hung
      yield* h.adapter.interruptTurn(threadId);

      const steerResult = yield* Fiber.await(steering);
      expect(steerResult._tag).toBe("Failure");
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.effect(
    "does not attempt transport recovery on authentication or session corruption errors",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        yield* h.adapter.sendTurn({ threadId, input: "Turn 1" });
        const prompt1 = yield* h.nextPrompt;

        const steering = yield* h.adapter
          .sendTurn({ threadId, input: "Steering prompt" })
          .pipe(Effect.forkChild);
        yield* h.nextCancellation;
        const release = yield* Queue.take(h.cancelReleases);

        // Prompt fails with auth error rather than forced cancellation
        const failure = new AcpErrors.AcpTransportError({
          operation: "call-rpc",
          method: "session/prompt",
          detail: "Authentication credentials were rejected.",
          cause: undefined,
        });
        yield* Queue.offer(h.instances[0]!.events, {
          _tag: "ConnectionTerminated",
          error: failure,
        });
        yield* Deferred.fail(prompt1.result, failure);
        yield* Deferred.succeed(release, undefined);

        const steerResult = yield* Fiber.await(steering);
        expect(steerResult._tag).toBe("Failure");

        // Must NOT launch a second runtime for auth error
        expect(h.instances).toHaveLength(1);
        expect(yield* h.adapter.hasSession(threadId)).toBe(false);
      }),
  );
});
