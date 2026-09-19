import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AntigravitySettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeURL from "node:url";
import { ServerConfig } from "../../config.ts";
import { makeAntigravityAcpRuntime } from "../acp/AntigravityAcpSupport.ts";
import { makeAntigravityAdapter, type AntigravityAdapterOptions } from "./AntigravityAdapter.ts";

const decodeSettings = Schema.decodeEffect(AntigravitySettings);

const layer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pylon-antigravity-recovery-process-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("Antigravity process recovery", (it) => {
  it.effect("replaces an unresponsive ACP process and completes the pending steer once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-antigravity-acp-" });
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const firstPrompt = yield* Deferred.make<void>();
      const canonical = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const events: ProviderRuntimeEvent[] = [];
      const launches: Array<Parameters<AntigravityAdapterOptions["makeRuntime"]>[0]> = [];
      const prompts: unknown[] = [];
      const adapter = yield* makeAntigravityAdapter(yield* decodeSettings({ enabled: true }), {
        instanceId: ProviderInstanceId.make("antigravity-process-test"),
        withProcess: (_stop, task) => task,
        makeRuntime: (input) => {
          launches.push(input);
          const initial = launches.length === 1;
          return makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [
                NodeURL.fileURLToPath(
                  new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
                ),
              ],
              cwd,
              env: {
                T3_ACP_ANTIGRAVITY: "1",
                ...(initial ? { T3_ACP_HANG_PROMPT_FOREVER: "1" } : {}),
              },
            },
            requestLogger: (event) =>
              Effect.gen(function* () {
                if (event.method !== "session/prompt" || event.status !== "started") return;
                prompts.push(event.payload);
                if (initial) yield* Deferred.succeed(firstPrompt, undefined);
              }),
          }).pipe(Effect.provideService(Crypto.Crypto, crypto));
        },
      });
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => {
          events.push(event);
          return Queue.offer(canonical, event);
        }),
        Effect.forkScoped({ startImmediately: true }),
      );
      const threadId = ThreadId.make("antigravity-process-recovery");
      const session = yield* adapter.startSession({ threadId, cwd, runtimeMode: "full-access" });
      const original = yield* adapter.sendTurn({ threadId, input: "Original work" });
      yield* Deferred.await(firstPrompt);
      const steering = yield* adapter
        .sendTurn({ threadId, input: "Changed direction" })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("3 seconds");
      const admitted = yield* Fiber.join(steering);
      while (true) {
        const event = yield* Queue.take(canonical);
        if (event.type === "turn.completed" && event.turnId === admitted.turnId) {
          expect(event.payload.state).toBe("completed");
          break;
        }
      }
      expect(launches).toHaveLength(2);
      expect(session.resumeCursor).toMatchObject({ sessionId: launches[1]?.resumeSessionId });
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toMatchObject({
        prompt: expect.arrayContaining([{ type: "text", text: "Changed direction" }]),
      });
      expect(admitted.turnId).toBe(original.turnId);
      expect(events.filter((event) => event.type === "session.exited")).toHaveLength(0);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
    }),
  );
});
