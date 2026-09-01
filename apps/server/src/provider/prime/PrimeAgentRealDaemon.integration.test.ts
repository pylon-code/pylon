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
import { sanitizePrimeAgentDaemonEnvironment } from "./PrimeAgentDaemonBridge.ts";
import { makePrimeAgentDaemonManager } from "./PrimeAgentDaemonManager.ts";
import {
  makePrimeAgentDaemonSessionRuntime,
  type PrimeAgentDaemonSessionRuntime,
} from "./PrimeAgentDaemonSessionRuntime.ts";

const configuredExecutable = process.env.PYLON_REAL_PRIME_AGENT?.trim();
const configuredAuthHome = process.env.PYLON_REAL_PRIME_AGENT_AUTH_HOME?.trim();
const providerInstanceId = ProviderInstanceId.make("prime-real-integration");

const makeTestIdentity = (agentHomePath: string) => ({
  instanceId: providerInstanceId,
  generation: { _tag: "PrimeAgentRuntimeGeneration" as const },
  configRevision: "real-integration-test",
  effectiveHome: agentHomePath,
  launchEnv: sanitizePrimeAgentDaemonEnvironment({
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    PRIME_AGENT_HOME: agentHomePath,
    PRIME_AGENT_CODING_AGENT_DIR: agentHomePath,
  }),
  settings: {
    enabled: true,
    binaryPath: configuredExecutable ?? "prime-agent",
    agentHomePath,
    launchArgs: "",
    customModels: [],
  },
});

const makeTestRuntimeContext = (identity: ReturnType<typeof makeTestIdentity>) => ({
  ...identity,
  backendKind: "daemon" as const,
  backendIdentity: {
    kind: "daemon" as const,
    proof: {
      sdkFeatures: [
        "negotiated_daemon_session_capabilities_v1",
        "caller_owned_session_environment_cleanup_v1",
      ],
      requiredServerCapabilities: [
        "caller_owned_session_environment_cleanup_v1",
        "authoritative_owned_session_cleanup_v1",
      ] as const,
    },
  },
});

type TurnCompleted = Extract<PrimeDaemonEvent, { readonly _tag: "TurnCompleted" }>;

function drainEvents(input: {
  readonly runtime: PrimeAgentDaemonSessionRuntime;
  readonly turnStarted?: Deferred.Deferred<void>;
  readonly turnCompleted?: Deferred.Deferred<TurnCompleted>;
  readonly runCompleted?: Deferred.Deferred<void>;
  readonly toolPlanned?: Deferred.Deferred<void>;
  readonly resynced?: Deferred.Deferred<
    Extract<PrimeDaemonEvent, { readonly _tag: "SessionResynced" }>
  >;
  readonly aborted?: Deferred.Deferred<void>;
}) {
  return input.runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (event._tag === "TurnStarted" && input.turnStarted !== undefined) {
          yield* Deferred.succeed(input.turnStarted, undefined);
        }
        if (event._tag === "TurnCompleted") {
          if (
            input.turnCompleted !== undefined &&
            event.message.stopReason !== "toolUse" &&
            event.message.toolCalls.length === 0
          ) {
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
        if (
          event._tag === "MessageCompleted" &&
          event.message.role === "assistant" &&
          event.message.toolCalls.length > 0 &&
          input.toolPlanned !== undefined
        ) {
          yield* Deferred.succeed(input.toolPlanned, undefined);
        }
        if (
          event._tag === "SessionResynced" &&
          event.connectionGeneration !== undefined &&
          input.resynced !== undefined
        ) {
          yield* Deferred.succeed(input.resynced, event);
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
            const identity = makeTestIdentity(agentHomePath);
            const runtimeContext = makeTestRuntimeContext(identity);
            const manager = yield* makePrimeAgentDaemonManager({
              executablePath: configuredExecutable,
              identity,
              stateDir,
              tempDir: "/tmp",
            });
            yield* manager.prepare();

            const primary = yield* makePrimeAgentDaemonSessionRuntime({
              manager,
              runtimeContext,
              cwd: root,
              sessionDir: NodePath.join(manager.sessionDir, "phase-1-primary"),
              thinkingLevel: "off",
              disableExtensionDiscovery: true,
            });
            const interrupted = yield* makePrimeAgentDaemonSessionRuntime({
              manager,
              runtimeContext,
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

            let disconnectTransport: (() => void) | undefined;
            const reconnectManager = {
              ...manager,
              openClient: () =>
                manager.openClient().pipe(
                  Effect.tap((client) =>
                    Effect.sync(() => {
                      // Prime 0.8.0 has no public fault-injection hook. Destroy only
                      // this scoped client's socket; the daemon and worker stay alive.
                      const transport = (
                        client as typeof client & {
                          socket?: { destroy: (error?: Error) => void };
                        }
                      ).socket;
                      if (transport !== undefined) {
                        disconnectTransport = () =>
                          transport.destroy(new Error("Pylon real test transport fault"));
                      }
                    }),
                  ),
                ),
            };
            const reconnecting = yield* makePrimeAgentDaemonSessionRuntime({
              manager: reconnectManager,
              runtimeContext,
              cwd: root,
              sessionDir: NodePath.join(manager.sessionDir, "phase-1-reconnecting"),
              thinkingLevel: "off",
              disableExtensionDiscovery: true,
            });
            if (preferredModel !== undefined) {
              yield* reconnecting.setModel(`${preferredModel.provider}/${preferredModel.id}`);
            }
            const reconnectToolPlanned = yield* Deferred.make<void>();
            const reconnectResynced =
              yield* Deferred.make<
                Extract<PrimeDaemonEvent, { readonly _tag: "SessionResynced" }>
              >();
            const reconnectCompleted = yield* Deferred.make<TurnCompleted>();
            const reconnectRunCompleted = yield* Deferred.make<void>();
            const reconnectDrain = yield* drainEvents({
              runtime: reconnecting,
              toolPlanned: reconnectToolPlanned,
              resynced: reconnectResynced,
              turnCompleted: reconnectCompleted,
              runCompleted: reconnectRunCompleted,
            });
            const reconnectToken = "real-transport-reconnect:1";
            const reconnectPromptText =
              "Use the IPython tool exactly once to print PYLON_TRANSPORT_TOOL_OK, then reply with exactly PYLON_TRANSPORT_RECONNECT_OK and nothing else.";
            const reconnectPrompt = yield* reconnecting
              .prompt({
                text: reconnectPromptText,
                rlmQuiescenceToken: reconnectToken,
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(reconnectToolPlanned);
            const disconnect = disconnectTransport;
            if (disconnect === undefined) {
              return yield* Effect.die(
                new Error("The real Prime daemon client did not expose reconnect control."),
              );
            }
            disconnect();
            const resynced = yield* Deferred.await(reconnectResynced);
            expect(resynced).toMatchObject({
              replayContinuity: "complete",
              connectionGeneration: 1,
            });
            expect(reconnecting.resolveReconnectSnapshot(1, true)).toBe(true);
            yield* Fiber.join(reconnectPrompt);
            const reconnectCompletion = yield* Deferred.await(reconnectCompleted);
            yield* Deferred.await(reconnectRunCompleted);
            yield* reconnecting.waitForRlmQuiescence(reconnectToken, new AbortController().signal);
            expect(reconnectCompletion.message.text.trim()).toBe("PYLON_TRANSPORT_RECONNECT_OK");
            yield* reconnecting.dispose;
            yield* Fiber.await(reconnectDrain);
            expect(
              NodeFS.readFileSync(reconnecting.sessionFile, "utf8").split(reconnectPromptText),
            ).toHaveLength(2);

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
            const identity = makeTestIdentity(agentHomePath);
            const runtimeContext = makeTestRuntimeContext(identity);
            const manager = yield* makePrimeAgentDaemonManager({
              executablePath: configuredExecutable,
              identity,
              stateDir,
              tempDir: "/tmp",
            });
            const runtime = yield* makePrimeAgentDaemonSessionRuntime({
              manager,
              runtimeContext,
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
