// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  EnvironmentId,
  PrimeAgentSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { clearMcpProviderSession, setMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { makePrimeAgentDaemonAdapter } from "./PrimeAgentDaemonAdapter.ts";
import type { PrimeAgentAdapterShape } from "../Services/PrimeAgentAdapter.ts";
import type { PrimeAgentDaemonClient } from "./PrimeAgentDaemonBridge.ts";
import { sanitizePrimeAgentDaemonEnvironment } from "./PrimeAgentDaemonBridge.ts";
import {
  makePrimeAgentDaemonManager,
  type PrimeAgentDaemonManager,
} from "./PrimeAgentDaemonManager.ts";
import {
  makePrimeAgentDaemonSessionRuntime,
  type PrimeAgentDaemonSessionRuntimeInput,
} from "./PrimeAgentDaemonSessionRuntime.ts";
import type { PrimeAgentRuntimeContext } from "./PrimeAgentRuntimeContext.ts";

const configuredExecutable = process.env.PYLON_REAL_PRIME_AGENT?.trim();
const configuredAuthHome = process.env.PYLON_REAL_PRIME_AGENT_AUTH_HOME?.trim();
const runMultipleInstanceProof = process.env.PYLON_REAL_PRIME_AGENT_MULTI_PROOF === "1";
const configuredCount = Number(process.env.PYLON_REAL_PRIME_AGENT_MULTI_COUNT ?? "2");
const RESOURCE_CEILINGS = new Map<
  number,
  {
    readonly readinessMs: number;
    readonly processCount: number;
    readonly rssMiB: number;
    readonly fdCount: number;
  }
>([
  [1, { readinessMs: 120_000, processCount: 32, rssMiB: 8 * 1024, fdCount: 62_500 }],
  [2, { readinessMs: 180_000, processCount: 64, rssMiB: 16 * 1024, fdCount: 125_000 }],
  [4, { readinessMs: 240_000, processCount: 128, rssMiB: 32 * 1024, fdCount: 250_000 }],
] as const);
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeSettings = Schema.decodeSync(PrimeAgentSettings);
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pylon-real-prime-multiple-instances-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface ProofInstance {
  readonly name: string;
  readonly home: string;
  readonly scope: Scope.Scope;
  readonly manager: PrimeAgentDaemonManager;
  readonly adapter: PrimeAgentAdapterShape;
  readonly threadId: ThreadId;
  readonly checkpointRef: string;
  readonly modelSentinel: string;
  readonly credentialSentinel: string;
  readonly completed: Set<TurnId>;
  readonly failed: Set<TurnId>;
  readonly completionWaiters: Map<TurnId, Deferred.Deferred<void>>;
  readonly drain: Fiber.Fiber<void, never>;
  readonly reconnectObserved: Deferred.Deferred<void>;
  readonly reconnectToolObserved: Deferred.Deferred<void>;
  readonly clientIds: string[];
  readonly supervisorGenerations: string[];
  readonly activeSessionIds: string[];
  readonly sessionDirectories: string[];
  readonly openCount: { value: number };
  readonly close: Effect.Effect<void>;
  disconnectTransport: (() => void) | undefined;
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKiB: number;
}

interface ResourceSnapshot {
  readonly processCount: number;
  readonly rssMiB: number;
  readonly fdCount: number;
  readonly socketCount: number;
}

function copyAuthFixture(home: string): void {
  NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!configuredAuthHome) return;
  for (const fileName of ["auth.json", "settings.json"]) {
    const source = NodePath.join(configuredAuthHome, fileName);
    if (!NodeFS.existsSync(source)) continue;
    const destination = NodePath.join(home, fileName);
    NodeFS.copyFileSync(source, destination);
    NodeFS.chmodSync(destination, 0o600);
  }
}

function proofEnvironment(
  home: string,
  modelSentinel: string,
  credentialSentinel: string,
): Readonly<Record<string, string>> {
  return sanitizePrimeAgentDaemonEnvironment({
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    PRIME_AGENT_HOME: home,
    PRIME_AGENT_CODING_AGENT_DIR: home,
    PYLON_PRIME_MODEL_SENTINEL: modelSentinel,
    PYLON_PRIME_CREDENTIAL_SENTINEL: credentialSentinel,
  });
}

function safeResponseField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function activeSessionFromList(value: unknown):
  | {
      readonly activeSessionId: string;
      readonly sessionDirectory: string;
    }
  | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const data = (value as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return undefined;
  const sessions = (data as Record<string, unknown>).sessions;
  if (!Array.isArray(sessions)) return undefined;
  const active = sessions.flatMap((session) => {
    const activeSessionId = safeResponseField(session, "activeSessionId");
    const sessionFile = safeResponseField(session, "sessionFile");
    return activeSessionId === undefined || sessionFile === undefined
      ? []
      : [{ activeSessionId, sessionDirectory: NodePath.dirname(sessionFile) }];
  });
  return active.length === 1 ? active[0] : undefined;
}

function hasTruthyStopRequest(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasTruthyStopRequest);
  if (typeof value !== "object" || value === null) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "stopRequestedAt" && child !== null && child !== undefined && child !== false) {
      return true;
    }
    if (hasTruthyStopRequest(child)) return true;
  }
  return false;
}

function directoryHasTruthyStopRequest(root: string): boolean {
  if (!NodeFS.existsSync(root)) return false;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of NodeFS.readdirSync(current, { withFileTypes: true })) {
      const path = NodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          if (hasTruthyStopRequest(JSON.parse(NodeFS.readFileSync(path, "utf8")))) return true;
        } catch {
          // A concurrently-written or non-JSON file is not lifecycle evidence.
        }
      }
    }
  }
  return false;
}

async function socketOwnerPids(socket: string): Promise<ReadonlyArray<number>> {
  try {
    const { stdout } = await execFile("/usr/sbin/lsof", ["-t", "-a", "-U", socket], {
      timeout: 2_000,
      maxBuffer: 256 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

async function capturedResourceSnapshot(sockets: ReadonlyArray<string>): Promise<ResourceSnapshot> {
  const roots = new Set<number>();
  for (const socket of sockets) for (const pid of await socketOwnerPids(socket)) roots.add(pid);
  const { stdout } = await execFile("/bin/ps", ["-axo", "pid=,ppid=,rss="], {
    timeout: 2_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const rows = stdout.split("\n").flatMap((line): ReadonlyArray<ProcessRow> => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line);
    return match === null
      ? []
      : [{ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]) }];
  });
  const captured = new Set(roots);
  for (;;) {
    const before = captured.size;
    for (const row of rows) if (captured.has(row.ppid)) captured.add(row.pid);
    if (captured.size === before) break;
  }
  const capturedRows = rows.filter((row) => captured.has(row.pid));
  let fdCount = 0;
  for (const row of capturedRows) {
    try {
      const result = await execFile("/usr/sbin/lsof", ["-nP", "-p", String(row.pid)], {
        timeout: 2_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      fdCount += Math.max(0, result.stdout.split("\n").length - 2);
    } catch {
      // A short-lived child may exit between the captured ps and lsof calls.
    }
  }
  return {
    processCount: capturedRows.length,
    rssMiB: Math.round((capturedRows.reduce((sum, row) => sum + row.rssKiB, 0) / 1024) * 10) / 10,
    fdCount,
    socketCount: sockets.filter((socket) => NodeFS.existsSync(socket)).length,
  };
}

function safeCauseCategory(cause: Cause.Cause<unknown>): string {
  const failure = Cause.findFail(cause);
  if (Result.isSuccess(failure)) {
    const error = failure.success.error;
    if (typeof error === "object" && error !== null) {
      const record = error as Record<string, unknown>;
      const parts = [record._tag, record.operation, record.reason].filter(
        (value): value is string =>
          typeof value === "string" && /^[A-Za-z][A-Za-z0-9-]{0,63}$/u.test(value),
      );
      if (parts.length > 0) return parts.join("/");
    }
    return "typed-failure";
  }
  return Cause.hasInterruptsOnly(cause) ? "interrupted" : "defect";
}

it.live.skipIf(!configuredExecutable || !runMultipleInstanceProof)(
  "proves exact native Prime N=1/N=2/N=4 isolation, removal, and reconnect without ACP",
  () => {
    const lifecycle = {
      phase: "validation",
      ready: 0,
      closed: 0,
      reconnects: 0,
    };
    const proof = Effect.scoped(
      Effect.gen(function* () {
        if (!configuredExecutable || !NodePath.isAbsolute(configuredExecutable)) {
          return yield* Effect.die(new Error("The configured real Prime executable is invalid."));
        }
        const resourceCeiling = RESOURCE_CEILINGS.get(configuredCount);
        if (resourceCeiling === undefined) {
          return yield* Effect.die(
            new Error("The native instance proof count must be 1, 2, or 4."),
          );
        }
        if (configuredAuthHome !== undefined && !NodePath.isAbsolute(configuredAuthHome)) {
          return yield* Effect.die(new Error("The configured real Prime auth fixture is invalid."));
        }

        const platform = yield* HostProcessPlatform;
        const executablePath = configuredExecutable;
        const root = NodeFS.mkdtempSync(
          NodePath.join(process.env.TMPDIR ?? "/tmp", "pylon-prime-native-proof-"),
        );
        const reportSafePhase = (phase: string) => {
          lifecycle.phase = phase;
        };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );

        const makeInstance = Effect.fn("makeRealPrimeNativeProofInstance")(function* (
          index: number,
        ) {
          const name = `prime_${index}`;
          const home = NodePath.join(root, "homes", name);
          const stateDir = NodePath.join(root, "state", name);
          const modelSentinel = `model-${index}`;
          const credentialSentinel = `credential-${index}`;
          copyAuthFixture(home);
          NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
          NodeFS.writeFileSync(NodePath.join(home, "model-sentinel"), modelSentinel, {
            mode: 0o600,
          });
          NodeFS.writeFileSync(NodePath.join(home, "credential-sentinel"), credentialSentinel, {
            mode: 0o600,
          });

          const instanceId = ProviderInstanceId.make(name);
          const threadId = ThreadId.make(`native-proof-${index}`);
          const settings = decodeSettings({
            binaryPath: executablePath,
            agentHomePath: home,
          });
          const launchEnv = proofEnvironment(home, modelSentinel, credentialSentinel);
          const generation = { _tag: "PrimeAgentRuntimeGeneration" as const };
          const identity = {
            instanceId,
            generation,
            configRevision: `native-proof-${index}`,
            effectiveHome: home,
            launchEnv,
            nativeMultipleInstancesRequired: true,
            settings,
          };
          const runtimeContext: PrimeAgentRuntimeContext = {
            ...identity,
            backendKind: "daemon",
            backendIdentity: {
              kind: "daemon",
              proof: {
                sdkFeatures: [
                  "negotiated_daemon_session_capabilities_v1",
                  "caller_owned_session_environment_cleanup_v1",
                ],
                requiredServerCapabilities: [
                  "caller_owned_session_environment_cleanup_v1",
                  "authoritative_owned_session_cleanup_v1",
                ],
              },
            },
          };
          const scope = yield* Scope.make("sequential");
          let closed = false;
          const close = Effect.suspend(() => {
            if (closed) return Effect.void;
            closed = true;
            lifecycle.closed += 1;
            return Scope.close(scope, Exit.void);
          });
          yield* Effect.addFinalizer(() => close);

          const completed = new Set<TurnId>();
          const failed = new Set<TurnId>();
          const completionWaiters = new Map<TurnId, Deferred.Deferred<void>>();
          const reconnectObserved = yield* Deferred.make<void>();
          const reconnectToolObserved = yield* Deferred.make<void>();
          const openCount = { value: 0 };
          const clientIds: string[] = [];
          const supervisorGenerations: string[] = [];
          const activeSessionIds: string[] = [];
          const sessionDirectories: string[] = [];
          let disconnectTransport: (() => void) | undefined;
          let latestClient: PrimeAgentDaemonClient | undefined;

          const built = yield* Effect.gen(function* () {
            lifecycle.phase = `instance-${index}-manager`;
            const baseManager = yield* makePrimeAgentDaemonManager({
              executablePath,
              identity,
              stateDir,
              tempDir: process.env.TMPDIR ?? "/tmp",
            });
            const manager: PrimeAgentDaemonManager = {
              ...baseManager,
              openClient: () =>
                baseManager.openClient().pipe(
                  Effect.tap((client) =>
                    Effect.sync(() => {
                      openCount.value += 1;
                      latestClient = client;
                      if (typeof client.clientId === "string" && client.clientId.length > 0) {
                        clientIds.push(client.clientId);
                      }
                      const supervisorGeneration = client.hello?.supervisorGeneration;
                      if (
                        typeof supervisorGeneration === "string" &&
                        supervisorGeneration.length > 0
                      ) {
                        supervisorGenerations.push(supervisorGeneration);
                      }
                      const transport = (
                        client as PrimeAgentDaemonClient & {
                          socket?: { destroy: (error?: Error) => void };
                        }
                      ).socket;
                      if (transport !== undefined) {
                        disconnectTransport = () =>
                          transport.destroy(new Error("Native proof transport fault"));
                      }
                    }),
                  ),
                ),
            };
            const checkpointRef = checkpointRefForThreadTurn(threadId, 1);
            setMcpProviderSession({
              environmentId: EnvironmentId.make(`native-proof-${index}`),
              threadId,
              providerSessionId: `provider-session-${index}`,
              providerInstanceId: instanceId,
              endpoint: `http://127.0.0.1:9/mcp/native-proof-${index}`,
              authorizationHeader: `Bearer mcp-${credentialSentinel}`,
            });
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                clearMcpProviderSession(threadId);
              }),
            );
            yield* manager.prepare();
            lifecycle.phase = `instance-${index}-adapter`;
            const runtimeFactory = (input: PrimeAgentDaemonSessionRuntimeInput) =>
              makePrimeAgentDaemonSessionRuntime(input).pipe(
                Effect.map((runtime) => ({
                  ...runtime,
                  events: runtime.events.pipe(
                    Stream.tap((event) =>
                      event._tag === "SessionResynced" && event.initialSnapshot !== true
                        ? Effect.sync(() => {
                            lifecycle.reconnects += 1;
                          }).pipe(
                            Effect.andThen(Deferred.succeed(reconnectObserved, undefined)),
                            Effect.ignore,
                          )
                        : Effect.void,
                    ),
                  ),
                })),
              );
            const adapter = yield* makePrimeAgentDaemonAdapter(settings, manager, {
              instanceId,
              runtimeContext,
              runtimeFactory,
            });
            lifecycle.phase = `instance-${index}-start-session`;
            yield* adapter.startSession({
              threadId,
              provider: ProviderDriverKind.make("primeAgent"),
              providerInstanceId: instanceId,
              cwd: root,
              runtimeMode: "full-access",
              modelSelection: { instanceId, model: "default" },
            });
            return { manager, adapter, checkpointRef };
          }).pipe(Effect.provideService(Scope.Scope, scope));

          lifecycle.phase = `instance-${index}-session-inspection`;
          // Ask the runtime's exact owner client for its one native session
          // without serializing the private response.
          lifecycle.phase = `instance-${index}-owner-client`;
          const inspectionClient = latestClient;
          if (inspectionClient === undefined) {
            return yield* Effect.die(new Error("Native proof owner client was unavailable."));
          }
          lifecycle.phase = `instance-${index}-list-request`;
          const listed = yield* Effect.promise(() =>
            inspectionClient.request({ type: "list", includeClientOwned: true }),
          );
          lifecycle.phase = `instance-${index}-list-parse`;
          const session = activeSessionFromList(listed);
          if (session === undefined) {
            return yield* Effect.die(new Error("Native proof session inspection was unavailable."));
          }
          activeSessionIds.push(session.activeSessionId);
          sessionDirectories.push(session.sessionDirectory);

          lifecycle.phase = `instance-${index}-event-drain`;
          const drainReady = yield* Deferred.make<void>();
          const drain = yield* Effect.gen(function* () {
            yield* Deferred.succeed(drainReady, undefined);
            yield* built.adapter.streamEvents.pipe(
              Stream.runForEach((event: ProviderRuntimeEvent) =>
                Effect.gen(function* () {
                  if (
                    event.type === "item.started" &&
                    event.threadId === threadId &&
                    event.payload.itemType === "command_execution"
                  ) {
                    yield* Deferred.succeed(reconnectToolObserved, undefined).pipe(Effect.ignore);
                  }
                  if (
                    event.type !== "turn.completed" ||
                    event.threadId !== threadId ||
                    event.turnId === undefined
                  )
                    return;
                  if (event.payload.state === "completed") completed.add(event.turnId);
                  else failed.add(event.turnId);
                  const waiter = completionWaiters.get(event.turnId);
                  if (waiter !== undefined)
                    yield* Deferred.succeed(waiter, undefined).pipe(Effect.ignore);
                }),
              ),
            );
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(drainReady);
          lifecycle.ready += 1;

          return {
            name,
            home,
            scope,
            manager: built.manager,
            adapter: built.adapter,
            threadId,
            checkpointRef: built.checkpointRef,
            modelSentinel,
            credentialSentinel,
            completed,
            failed,
            completionWaiters,
            drain,
            reconnectObserved,
            reconnectToolObserved,
            clientIds,
            supervisorGenerations,
            activeSessionIds,
            sessionDirectories,
            openCount,
            close,
            get disconnectTransport() {
              return disconnectTransport;
            },
            set disconnectTransport(value: (() => void) | undefined) {
              disconnectTransport = value;
            },
          } satisfies ProofInstance;
        });

        const waitForTurn = Effect.fn("waitForRealPrimeNativeTurn")(function* (
          instance: ProofInstance,
          turnId: TurnId,
        ) {
          if (!instance.completed.has(turnId) && !instance.failed.has(turnId)) {
            const completion = yield* Deferred.make<void>();
            instance.completionWaiters.set(turnId, completion);
            if (!instance.completed.has(turnId) && !instance.failed.has(turnId)) {
              yield* Deferred.await(completion).pipe(Effect.timeout(Duration.seconds(120)));
            }
            instance.completionWaiters.delete(turnId);
          }
          expect(instance.failed.has(turnId)).toBe(false);
          expect(instance.completed.has(turnId)).toBe(true);
          const thread = yield* instance.adapter.readThread(instance.threadId);
          expect(thread.turns.some((turn) => turn.id === turnId)).toBe(true);
        });

        const promptAndWait = Effect.fn("promptAndWaitForRealPrimeNativeProof")(function* (
          instance: ProofInstance,
          token: string,
        ) {
          const started = yield* instance.adapter.sendTurn({
            threadId: instance.threadId,
            input: `Reply with exactly ${token} and nothing else. Do not use tools.`,
            attachments: [],
          });
          yield* waitForTurn(instance, started.turnId);
        });

        reportSafePhase("native-readiness");
        const readinessStartedAt = performance.now();
        const instances = yield* Effect.forEach(
          Array.from({ length: configuredCount }),
          (_, index) => makeInstance(index),
          { concurrency: 1 },
        );
        const readinessMs = performance.now() - readinessStartedAt;
        expect(lifecycle.ready).toBe(configuredCount);
        expect(readinessMs).toBeLessThan(resourceCeiling.readinessMs);

        const distinct = (values: ReadonlyArray<unknown>) => new Set(values).size;
        expect(distinct(instances.map((instance) => instance.manager.socket))).toBe(
          configuredCount,
        );
        expect(distinct(instances.map((instance) => instance.manager.sessionDir))).toBe(
          configuredCount,
        );
        expect(distinct(instances.map((instance) => instance.home))).toBe(configuredCount);
        expect(distinct(instances.map((instance) => instance.threadId))).toBe(configuredCount);
        expect(distinct(instances.map((instance) => instance.checkpointRef))).toBe(configuredCount);
        expect(distinct(instances.flatMap((instance) => instance.clientIds.slice(0, 1)))).toBe(
          configuredCount,
        );
        expect(
          distinct(instances.flatMap((instance) => instance.supervisorGenerations.slice(0, 1))),
        ).toBe(configuredCount);
        expect(distinct(instances.flatMap((instance) => instance.activeSessionIds))).toBe(
          configuredCount,
        );
        expect(distinct(instances.flatMap((instance) => instance.sessionDirectories))).toBe(
          configuredCount,
        );
        expect(distinct(instances.map((instance) => instance.modelSentinel))).toBe(configuredCount);
        expect(distinct(instances.map((instance) => instance.credentialSentinel))).toBe(
          configuredCount,
        );
        for (const instance of instances) {
          expect(NodeFS.readFileSync(NodePath.join(instance.home, "model-sentinel"), "utf8")).toBe(
            instance.modelSentinel,
          );
          expect(
            NodeFS.readFileSync(NodePath.join(instance.home, "credential-sentinel"), "utf8"),
          ).toBe(instance.credentialSentinel);
        }

        const beforeTurns =
          platform === "darwin"
            ? yield* Effect.promise(() =>
                capturedResourceSnapshot(instances.map((instance) => instance.manager.socket)),
              )
            : undefined;

        reportSafePhase("cold-turns");
        if (configuredCount === 2) {
          yield* promptAndWait(instances[0]!, "PYLON_NATIVE_A_COLD_OK");
          yield* promptAndWait(instances[1]!, "PYLON_NATIVE_B_COLD_OK");
        } else {
          yield* Effect.all(
            instances.map((instance, index) =>
              promptAndWait(instance, `PYLON_NATIVE_${index}_COLD_OK`),
            ),
            { concurrency: "unbounded" },
          );
        }

        reportSafePhase("overlapping-turns");
        yield* Effect.all(
          instances.map((instance, index) =>
            promptAndWait(instance, `PYLON_NATIVE_${index}_OVERLAP_OK`),
          ),
          { concurrency: "unbounded" },
        );

        const afterTurns =
          platform === "darwin"
            ? yield* Effect.promise(() =>
                capturedResourceSnapshot(instances.map((instance) => instance.manager.socket)),
              )
            : undefined;
        if (afterTurns !== undefined) {
          expect(afterTurns.processCount).toBeGreaterThanOrEqual(configuredCount);
          expect(afterTurns.processCount).toBeLessThan(resourceCeiling.processCount);
          expect(afterTurns.rssMiB).toBeGreaterThan(0);
          expect(afterTurns.rssMiB).toBeLessThan(resourceCeiling.rssMiB);
          expect(afterTurns.fdCount).toBeGreaterThan(0);
          expect(afterTurns.fdCount).toBeLessThan(resourceCeiling.fdCount);
          expect(afterTurns.socketCount).toBe(configuredCount);
        }

        reportSafePhase("remove-instances");
        const removed =
          configuredCount === 1
            ? []
            : configuredCount === 2
              ? [instances[0]!]
              : [instances[0]!, instances[2]!];
        const survivors =
          configuredCount === 1
            ? [instances[0]!]
            : configuredCount === 2
              ? [instances[1]!]
              : [instances[1]!, instances[3]!];
        const removedOpenCounts = removed.map((instance) => instance.openCount.value);
        // Scope close is the only remove action. Do not hand-close the session first.
        yield* Effect.forEach(removed, (instance) => instance.close, { discard: true });
        for (const instance of removed)
          expect(NodeFS.existsSync(instance.manager.socket)).toBe(false);
        for (const instance of survivors) {
          expect(NodeFS.existsSync(instance.manager.socket)).toBe(true);
          expect(directoryHasTruthyStopRequest(instance.manager.sessionDir)).toBe(false);
        }

        reportSafePhase("survivors-after-removal");
        yield* Effect.all(
          survivors.map((instance, index) =>
            promptAndWait(instance, `PYLON_NATIVE_SURVIVOR_${index}_OK`),
          ),
          { concurrency: "unbounded" },
        );
        expect(removed.map((instance) => instance.openCount.value)).toEqual(removedOpenCounts);

        reportSafePhase("survivor-reconnect");
        const reconnecting = survivors[0]!;
        const disconnect = reconnecting.disconnectTransport;
        if (disconnect === undefined) {
          return yield* Effect.die(new Error("Native proof reconnect control was unavailable."));
        }
        const reconnectTurn = yield* reconnecting.adapter.sendTurn({
          threadId: reconnecting.threadId,
          input:
            "Use the IPython tool exactly once to print PYLON_NATIVE_RECONNECT_TOOL_OK, then reply with exactly PYLON_NATIVE_AFTER_RECONNECT_OK and nothing else.",
          attachments: [],
        });
        yield* Deferred.await(reconnecting.reconnectToolObserved).pipe(
          Effect.timeout(Duration.seconds(60)),
        );
        disconnect();
        yield* Deferred.await(reconnecting.reconnectObserved).pipe(
          Effect.timeout(Duration.seconds(30)),
        );
        expect(NodeFS.existsSync(reconnecting.manager.socket)).toBe(true);
        yield* waitForTurn(reconnecting, reconnectTurn.turnId);
        expect(removed.map((instance) => instance.openCount.value)).toEqual(removedOpenCounts);

        reportSafePhase("final-teardown");
        yield* Effect.forEach(survivors, (instance) => instance.close, { discard: true });
        reportSafePhase("survivor-scopes-closed");
        // Event drains belong to this outer proof scope. They remain live across
        // participant removal and are interrupted only when the proof scope exits.
        expect(lifecycle.closed).toBe(configuredCount);

        if (afterTurns !== undefined) {
          const resourceProof = {
            instances: configuredCount,
            readinessMs: Math.round(readinessMs),
            processCount: afterTurns.processCount,
            aggregateRssMiB: afterTurns.rssMiB,
            deltaRssMiB:
              beforeTurns === undefined
                ? undefined
                : Math.round((afterTurns.rssMiB - beforeTurns.rssMiB) * 10) / 10,
            fdCount: afterTurns.fdCount,
            socketCount: afterTurns.socketCount,
          };
          // Aggregate measurements only. Never emit paths, PIDs, homes, or credentials.
          // @effect-diagnostics-next-line globalConsoleInEffect:off preferSchemaOverJson:off
          console.log(`PYLON_PRIME_NATIVE_MULTI_RESOURCE_PROOF=${JSON.stringify(resourceProof)}`);
        }
        reportSafePhase("effect-complete");
      }),
    );

    return proof.pipe(
      Effect.catchCause((cause) =>
        Effect.die(
          new Error(
            `Native Prime multiple-instance proof failed safely (${[
              `phase=${lifecycle.phase}`,
              `ready=${lifecycle.ready}`,
              `closed=${lifecycle.closed}`,
              `reconnects=${lifecycle.reconnects}`,
              `cause=${safeCauseCategory(cause)}`,
            ].join(", ")}).`,
          ),
        ),
      ),
      Effect.provide(testLayer),
    );
  },
  600_000,
);
