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

const instanceId = ProviderInstanceId.make("antigravity-regression-test");
const threadId = ThreadId.make("antigravity-regression-thread");
const nativeSessionId = "b75db7e9-cd99-40e5-aa63-ac2b4674a6a9";
const nativeDefault = "gemini-test-low";
const decodeSettings = Schema.decodeSync(AntigravitySettings);

interface NativePrompt {
  readonly index: number;
  readonly content: ReadonlyArray<AcpSchema.ContentBlock>;
  readonly result: Deferred.Deferred<AcpSchema.PromptResponse, AcpErrors.AcpError>;
}

const makeHarness = Effect.fn("makeAntigravityAdapterRegressionHarness")(function* (options?: {
  readonly holdCancel?: boolean;
}) {
  const runtimeEvents = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
  const canonicalEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const prompts = yield* Queue.unbounded<NativePrompt>();
  const cancellations = yield* Queue.unbounded<number>();
  const cancelReleases = yield* Queue.unbounded<Deferred.Deferred<void>>();
  const seen: ProviderRuntimeEvent[] = [];
  const launches: Array<Parameters<AntigravityAdapterOptions["makeRuntime"]>[0]> = [];
  const resumeStarted = yield* Deferred.make<void>();
  const resumeRelease = yield* Deferred.make<void>();
  const dispatchedPrompts: NativePrompt[] = [];
  const controls = {
    failResume: false,
    holdResume: false,
    holdCancel: options?.holdCancel ?? false,
    completeReplacement: false,
  };
  let promptIndex = 0;
  let active: NativePrompt | undefined;

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
  const drainEvents = Effect.gen(function* () {
    const acknowledge = yield* Deferred.make<void>();
    yield* Queue.offer(runtimeEvents, { _tag: "EventStreamBarrier", acknowledge });
    yield* Deferred.await(acknowledge);
  });
  const emitNative = (event: AcpSessionRuntimeEvent) =>
    Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

  const runtime: Effect.Success<ReturnType<AntigravityAdapterOptions["makeRuntime"]>> = {
    handleRequestPermission: () => Effect.void,
    handleReadTextFile: () => Effect.void,
    handleWriteTextFile: () => Effect.void,
    start: () =>
      Effect.gen(function* () {
        if (controls.holdResume && launches.length > 1) {
          yield* Deferred.succeed(resumeStarted, undefined);
          yield* Deferred.await(resumeRelease);
        }
        if (controls.failResume && launches.length > 1) {
          return yield* new AcpErrors.AcpTransportError({
            operation: "call-rpc",
            detail: "Failed to resume native session transport.",
            cause: undefined,
          });
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
        const prompt: NativePrompt = {
          index: ++promptIndex,
          content: payload.prompt,
          result: yield* Deferred.make<AcpSchema.PromptResponse, AcpErrors.AcpError>(),
        };
        active = prompt;
        dispatchedPrompts.push(prompt);
        if (controls.completeReplacement && prompt.index > 1) {
          yield* Deferred.succeed(prompt.result, { stopReason: "end_turn" });
        }
        if (promptOptions?.dispatched) yield* Deferred.succeed(promptOptions.dispatched, undefined);
        yield* Queue.offer(prompts, prompt);
        return yield* Deferred.await(prompt.result).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (active === prompt) active = undefined;
            }),
          ),
        );
      }),
    cancel: Effect.gen(function* () {
      const prompt = active;
      if (!prompt) return;
      yield* Queue.offer(cancellations, prompt.index);
      if (controls.holdCancel) {
        const release = yield* Deferred.make<void>();
        yield* Queue.offer(cancelReleases, release);
        yield* Deferred.await(release);
      }
      yield* Deferred.succeed(prompt.result, { stopReason: "cancelled" });
      yield* drainEvents;
    }),
  };

  const adapter = yield* makeAntigravityAdapter(decodeSettings({ enabled: true }), {
    instanceId,
    makeRuntime: (input) => {
      launches.push(input);
      return Effect.succeed(runtime);
    },
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

  const waitForEvent = Effect.fn("AntigravityRegression.waitForEvent")(function* <
    T extends ProviderRuntimeEvent = ProviderRuntimeEvent,
  >(
    predicate:
      | ((event: ProviderRuntimeEvent) => event is T)
      | ((event: ProviderRuntimeEvent) => boolean),
  ) {
    while (true) {
      const event = yield* Queue.take(canonicalEvents);
      if (predicate(event)) return event as T;
    }
  });

  return {
    adapter,
    resumeStarted,
    resumeRelease,
    dispatchedPrompts,
    launches,
    controls,
    seen,
    waitForEvent,
    emitNative,
    cancelReleases,
    nextPrompt: Queue.take(prompts),
    nextCancellation: Queue.take(cancellations),
  };
});

const layer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-antigravity-regression-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("AntigravityAdapter steering regressions", (it) => {
  it.effect("Stop racing a steer prevents recovery and prompt cancellation exits session", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ holdCancel: true });
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const first = yield* h.adapter.sendTurn({ threadId, input: "Turn 1" }).pipe(Effect.forkChild);
      const prompt = yield* h.nextPrompt;

      // Start steering turn
      const steering = yield* h.adapter
        .sendTurn({ threadId, input: "Steering prompt" })
        .pipe(Effect.forkChild);
      yield* h.nextCancellation;
      const release = yield* Queue.take(h.cancelReleases);

      // Explicit Stop called while steering is cancelling previous prompt
      yield* h.adapter.interruptTurn(threadId).pipe(Effect.forkChild);

      const cancelDetail = "The ACP agent did not finish cancellation. Its process was stopped.";
      yield* h.emitNative({
        _tag: "ConnectionTerminated",
        error: new AcpErrors.AcpTransportError({
          operation: "call-rpc",
          method: "session/cancel",
          detail: cancelDetail,
          cause: undefined,
        }),
      });
      yield* Deferred.fail(
        prompt.result,
        new AcpErrors.AcpTransportError({
          operation: "call-rpc",
          method: "session/prompt",
          detail: cancelDetail,
          cause: undefined,
        }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(first);

      // Explicit Stop must cancel promptly and not trigger recovery/restart
      const exited = yield* h.waitForEvent(
        (event): event is Extract<ProviderRuntimeEvent, { type: "session.exited" }> =>
          event.type === "session.exited",
      );
      expect(exited.payload.exitKind).toBe("error");
      expect(exited.payload.reason).toBe(cancelDetail);
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
      // No replacement launch was performed
      expect(h.launches).toHaveLength(1);
      yield* Fiber.await(steering);
    }),
  );

  it.effect("Repeated steering with forced cancellation resumes session each time", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ holdCancel: true });
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const first = yield* h.adapter
        .sendTurn({ threadId, input: "Initial work" })
        .pipe(Effect.forkChild);
      const prompt1 = yield* h.nextPrompt;

      // Steer 1
      const steer1 = yield* h.adapter
        .sendTurn({ threadId, input: "Steer 1" })
        .pipe(Effect.forkChild);
      yield* h.nextCancellation;
      const release1 = yield* Queue.take(h.cancelReleases);
      const cancelDetail = "The ACP agent did not finish cancellation. Its process was stopped.";
      yield* h.emitNative({
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
      yield* Deferred.succeed(release1, undefined);
      yield* Fiber.await(first);

      const prompt2 = yield* h.nextPrompt;
      expect(prompt2.content).toContainEqual({ type: "text", text: "Steer 1" });
      expect(h.launches).toHaveLength(2);
      yield* Fiber.join(steer1);

      // Steer 2 while prompt2 is active
      const steer2 = yield* h.adapter
        .sendTurn({ threadId, input: "Steer 2" })
        .pipe(Effect.forkChild);
      yield* h.nextCancellation;
      const release2 = yield* Queue.take(h.cancelReleases);
      yield* h.emitNative({
        _tag: "ConnectionTerminated",
        error: new AcpErrors.AcpTransportError({
          operation: "call-rpc",
          method: "session/cancel",
          detail: cancelDetail,
          cause: undefined,
        }),
      });
      yield* Deferred.fail(
        prompt2.result,
        new AcpErrors.AcpTransportError({
          operation: "call-rpc",
          method: "session/prompt",
          detail: cancelDetail,
          cause: undefined,
        }),
      );
      yield* Deferred.succeed(release2, undefined);

      const prompt3 = yield* h.nextPrompt;
      expect(prompt3.content).toContainEqual({ type: "text", text: "Steer 2" });
      expect(h.launches).toHaveLength(3);
      const admitted = yield* Fiber.join(steer2);
      expect(admitted.turnId).toBeDefined();

      yield* Deferred.succeed(prompt3.result, { stopReason: "end_turn" });
      const ended = yield* h.waitForEvent(
        (event) => event.type === "turn.completed" && event.payload.state === "completed",
      );
      expect(ended.turnId).toBe(admitted.turnId);
      expect(yield* h.adapter.hasSession(threadId)).toBe(true);
    }),
  );

  it.effect("Resume failure does not retry and stops session cleanly", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ holdCancel: true });
      h.controls.failResume = true;
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const first = yield* h.adapter.sendTurn({ threadId, input: "Turn 1" }).pipe(Effect.forkChild);
      const prompt = yield* h.nextPrompt;

      const steering = yield* h.adapter
        .sendTurn({ threadId, input: "Steering prompt" })
        .pipe(Effect.forkChild);
      yield* h.nextCancellation;
      const release = yield* Queue.take(h.cancelReleases);
      const cancelDetail = "The ACP agent did not finish cancellation. Its process was stopped.";
      yield* h.emitNative({
        _tag: "ConnectionTerminated",
        error: new AcpErrors.AcpTransportError({
          operation: "call-rpc",
          method: "session/cancel",
          detail: cancelDetail,
          cause: undefined,
        }),
      });
      yield* Deferred.fail(
        prompt.result,
        new AcpErrors.AcpTransportError({
          operation: "call-rpc",
          method: "session/prompt",
          detail: cancelDetail,
          cause: undefined,
        }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(first);

      // Steering should fail because resume failed, exactly once (no retry)
      const steeringResult = yield* Fiber.await(steering);
      expect(steeringResult._tag).toBe("Failure");
      expect(h.launches).toHaveLength(2); // Exactly 1 initial + 1 resume attempt, NO retry loop
      expect(yield* h.adapter.hasSession(threadId)).toBe(false);
    }),
  );
  it.effect("Stop during transport resumption never dispatches the pending steer", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ holdCancel: true });
      h.controls.holdResume = true;
      yield* h.adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* h.adapter.sendTurn({ threadId, input: "Original work" });
      const prompt = yield* h.nextPrompt;
      const steering = yield* h.adapter
        .sendTurn({ threadId, input: "Do other work" })
        .pipe(Effect.forkChild);
      yield* h.nextCancellation;
      const release = yield* Queue.take(h.cancelReleases);
      const failure = new AcpErrors.AcpTransportError({
        operation: "call-rpc",
        method: "session/cancel",
        detail: "The ACP agent did not finish cancellation. Its process was stopped.",
        cause: undefined,
      });
      yield* h.emitNative({ _tag: "ConnectionTerminated", error: failure });
      yield* Deferred.fail(prompt.result, failure);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(h.resumeStarted);
      h.controls.holdCancel = false;
      const stopping = yield* h.adapter
        .interruptTurn(threadId)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(h.resumeRelease, undefined);
      yield* Fiber.await(stopping);
      yield* Fiber.await(steering);
      expect(h.dispatchedPrompts).toHaveLength(1);
    }),
  );

  it.effect("does not resume unrelated transport failures during steering", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ holdCancel: true });
      h.controls.completeReplacement = true;
      yield* h.adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* h.adapter.sendTurn({ threadId, input: "Original work" });
      const prompt = yield* h.nextPrompt;
      const steering = yield* h.adapter
        .sendTurn({ threadId, input: "Do other work" })
        .pipe(Effect.forkChild);
      yield* h.nextCancellation;
      const release = yield* Queue.take(h.cancelReleases);
      const failure = new AcpErrors.AcpTransportError({
        operation: "call-rpc",
        method: "session/prompt",
        detail: "Authentication credentials were rejected.",
        cause: undefined,
      });
      yield* h.emitNative({ _tag: "ConnectionTerminated", error: failure });
      yield* Deferred.fail(prompt.result, failure);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(steering);
      expect(h.launches).toHaveLength(1);
      expect(h.dispatchedPrompts).toHaveLength(1);
    }),
  );
});
