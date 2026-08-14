// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

import type { PrimeDaemonEvent } from "./PrimeAgentDaemonEvents.ts";
import { makePrimeAgentDaemonManager } from "./PrimeAgentDaemonManager.ts";
import {
  makePrimeAgentDaemonSessionRuntime,
  type PrimeAgentDaemonSessionRuntime,
} from "./PrimeAgentDaemonSessionRuntime.ts";

const configuredExecutable = process.env.PYLON_REAL_PRIME_AGENT?.trim();
const configuredAuthHome = process.env.PYLON_REAL_PRIME_AGENT_AUTH_HOME?.trim();
const providerInstanceId = ProviderInstanceId.make("prime-real-integration");

type TurnCompleted = Extract<PrimeDaemonEvent, { readonly _tag: "TurnCompleted" }>;

function drainEvents(input: {
  readonly runtime: PrimeAgentDaemonSessionRuntime;
  readonly turnStarted?: Deferred.Deferred<void>;
  readonly turnCompleted?: Deferred.Deferred<TurnCompleted>;
  readonly runCompleted?: Deferred.Deferred<void>;
  readonly aborted?: Deferred.Deferred<void>;
}) {
  return input.runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (event._tag === "TurnStarted" && input.turnStarted !== undefined) {
          yield* Deferred.succeed(input.turnStarted, undefined);
        }
        if (event._tag === "TurnCompleted") {
          if (input.turnCompleted !== undefined) {
            yield* Deferred.succeed(input.turnCompleted, event);
          }
          if (event.message.stopReason === "aborted" && input.aborted !== undefined) {
            yield* Deferred.succeed(input.aborted, undefined);
          }
        }
        if (
          event._tag === "AssistantStream" &&
          event.phase === "error" &&
          event.message?.stopReason === "aborted" &&
          input.aborted !== undefined
        ) {
          yield* Deferred.succeed(input.aborted, undefined);
        }
        if (event._tag === "RunCompleted") {
          if (input.runCompleted !== undefined) {
            yield* Deferred.succeed(input.runCompleted, undefined);
          }
          if (
            event.messages.some(
              (message) => message.role === "assistant" && message.stopReason === "aborted",
            ) &&
            input.aborted !== undefined
          ) {
            yield* Deferred.succeed(input.aborted, undefined);
          }
        }
      }),
    ),
    Effect.forkScoped,
  );
}

it.live.skipIf(!configuredExecutable)(
  "covers real daemon Phase-1 turn, control, restart, interruption, and cleanup",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        if (platform === "win32") return;
        if (!configuredExecutable || !NodePath.isAbsolute(configuredExecutable)) {
          return yield* Effect.die(
            new Error("PYLON_REAL_PRIME_AGENT must be an absolute executable path"),
          );
        }

        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pylon-real-prime-daemon-",
        });
        const stateDir = NodePath.join(root, "state");
        const agentHomePath = NodePath.join(root, "agent-home");
        yield* fileSystem.makeDirectory(stateDir, { recursive: true, mode: 0o700 });
        yield* fileSystem.makeDirectory(agentHomePath, { recursive: true, mode: 0o700 });
        if (configuredAuthHome !== undefined) {
          if (!NodePath.isAbsolute(configuredAuthHome)) {
            return yield* Effect.die(
              new Error("PYLON_REAL_PRIME_AGENT_AUTH_HOME must be an absolute directory path"),
            );
          }
          // Copy only the minimum auth/model selection inputs into scoped state;
          // the live Prime home remains read-only and receives no sessions.
          for (const fileName of ["auth.json", "settings.json"]) {
            const source = NodePath.join(configuredAuthHome, fileName);
            if (NodeFS.existsSync(source)) {
              const destination = NodePath.join(agentHomePath, fileName);
              NodeFS.copyFileSync(source, destination);
              NodeFS.chmodSync(destination, 0o600);
            }
          }
        }

        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const manager = yield* makePrimeAgentDaemonManager({
              executablePath: configuredExecutable,
              settings: { agentHomePath },
              environment: process.env,
              stateDir,
              providerInstanceId,
              tempDir: "/tmp",
            });
            yield* manager.prepare();

            const primary = yield* makePrimeAgentDaemonSessionRuntime({
              manager,
              cwd: root,
              sessionDir: NodePath.join(manager.sessionDir, "phase-1-primary"),
              thinkingLevel: "off",
              disableExtensionDiscovery: true,
            });
            const interrupted = yield* makePrimeAgentDaemonSessionRuntime({
              manager,
              cwd: root,
              sessionDir: NodePath.join(manager.sessionDir, "phase-1-interrupted"),
              thinkingLevel: "off",
              disableExtensionDiscovery: true,
            });

            expect(primary.sessionId).not.toBe(interrupted.sessionId);
            expect(primary.activeSessionId).not.toBe(interrupted.activeSessionId);

            const completedTurn = yield* Deferred.make<TurnCompleted>();
            const completedRun = yield* Deferred.make<void>();
            const primaryDrain = yield* drainEvents({
              runtime: primary,
              turnCompleted: completedTurn,
              runCompleted: completedRun,
            });
            const interruptStarted = yield* Deferred.make<void>();
            const interruptFinished = yield* Deferred.make<void>();
            const interruptedDrain = yield* drainEvents({
              runtime: interrupted,
              turnStarted: interruptStarted,
              aborted: interruptFinished,
            });

            const catalog = yield* primary.discoverAvailableModels;
            expect(catalog.length).toBeGreaterThan(0);
            expect(new Set(catalog.map((model) => `${model.provider}/${model.id}`)).size).toBe(
              catalog.length,
            );
            const preferredModel =
              catalog.find(
                (model) => model.provider === "openai-codex" && model.id === "gpt-5.6-sol",
              ) ?? catalog.find((model) => model.provider === "openai-codex");
            if (preferredModel !== undefined) {
              const model = `${preferredModel.provider}/${preferredModel.id}`;
              const expected = { id: preferredModel.id, provider: preferredModel.provider };
              expect(yield* primary.setModel(model)).toMatchObject(expected);
              expect(yield* interrupted.setModel(model)).toMatchObject(expected);
            }

            const interruptedPrompt = yield* interrupted
              .prompt({
                text: "Do not use tools. Wait to answer until you are interrupted.",
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(interruptStarted);
            yield* interrupted.abort;
            yield* Fiber.await(interruptedPrompt);
            yield* Deferred.await(interruptFinished);

            yield* primary.prompt({
              text: "Reply with exactly PYLON_PHASE_1_OK and nothing else. Do not use tools.",
            });
            const completion = yield* Deferred.await(completedTurn);
            yield* Deferred.await(completedRun);

            const sameModel = catalog.find(
              (model) =>
                model.provider === completion.message.provider &&
                model.id === completion.message.model,
            );
            if (sameModel !== undefined) {
              const selected = yield* primary.setModel(`${sameModel.provider}/${sameModel.id}`);
              expect(selected).toMatchObject({
                id: sameModel.id,
                provider: sameModel.provider,
              });
            }

            const sessionId = primary.sessionId;
            const sessionFile = primary.sessionFile;
            const resumeCursor = primary.resumeCursor;
            yield* primary.dispose;
            yield* interrupted.dispose;
            yield* Fiber.await(primaryDrain);
            yield* Fiber.await(interruptedDrain);

            const disposedError = yield* Effect.flip(
              primary.prompt({ text: "This must not reach the provider." }),
            );
            expect(disposedError).toMatchObject({ reason: "disposed" });

            return {
              socket: manager.socket,
              sessionId,
              sessionFile,
              resumeCursor,
              answer: completion.message.text.trim(),
              stopReason: completion.message.stopReason,
              usage: completion.message.usage,
              catalogSize: catalog.length,
            };
          }),
        );

        expect(yield* fileSystem.exists(first.socket)).toBe(false);
        expect(yield* fileSystem.exists(first.sessionFile)).toBe(true);

        const restarted = yield* Effect.scoped(
          Effect.gen(function* () {
            const manager = yield* makePrimeAgentDaemonManager({
              executablePath: configuredExecutable,
              settings: { agentHomePath },
              environment: process.env,
              stateDir,
              providerInstanceId,
              tempDir: "/tmp",
            });
            const runtime = yield* makePrimeAgentDaemonSessionRuntime({
              manager,
              cwd: root,
              sessionDir: NodePath.join(manager.sessionDir, "phase-1-primary"),
              disableExtensionDiscovery: true,
              resumeCursor: first.resumeCursor,
              resumeSessionId: first.sessionId,
            });
            const eventDrain = yield* drainEvents({ runtime });

            expect(runtime.sessionId).toBe(first.sessionId);
            expect(runtime.sessionFile).toBe(first.sessionFile);
            expect(runtime.initialSnapshot.state.sessionId).toBe(first.sessionId);
            expect(
              runtime.initialSnapshot.messages.some(
                (message) => message.role === "assistant" && message.text.trim() === first.answer,
              ),
            ).toBe(true);

            yield* runtime.dispose;
            yield* Fiber.await(eventDrain);
            return { socket: manager.socket };
          }),
        );

        expect(restarted.socket).toBe(first.socket);
        expect(yield* fileSystem.exists(restarted.socket)).toBe(false);
        expect(first.catalogSize).toBeGreaterThan(0);
        expect(first.answer).toBe("PYLON_PHASE_1_OK");
        expect(first.stopReason).toBe("stop");
        expect(first.usage.totalTokens).toBeGreaterThan(0);
        expect(first.usage.totalCostUsd).toBeGreaterThanOrEqual(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  180_000,
);
