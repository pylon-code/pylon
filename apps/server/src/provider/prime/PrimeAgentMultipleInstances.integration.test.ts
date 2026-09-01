// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  PrimeAgentSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makePrimeAgentAdapter } from "../Layers/PrimeAgentAdapter.ts";
import type { PrimeAgentAdapterShape } from "../Services/PrimeAgentAdapter.ts";
import { sanitizePrimeAgentDaemonEnvironment } from "./PrimeAgentDaemonBridge.ts";

const configuredExecutable = process.env.PYLON_REAL_PRIME_AGENT?.trim();
const configuredAuthHome = process.env.PYLON_REAL_PRIME_AGENT_AUTH_HOME?.trim();
const runMultipleInstanceProof = process.env.PYLON_REAL_PRIME_AGENT_MULTI_PROOF === "1";
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeSettings = Schema.decodeSync(PrimeAgentSettings);
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pylon-real-prime-multiple-instances-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface ProofInstance {
  readonly name: string;
  readonly home: string;
  readonly threadId: ThreadId;
  readonly adapter: PrimeAgentAdapterShape;
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

function proofEnvironment(home: string): Record<string, string> {
  return sanitizePrimeAgentDaemonEnvironment({
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    PRIME_AGENT_HOME: home,
    PRIME_AGENT_CODING_AGENT_DIR: home,
  });
}

async function processTreeForExecutable(executable: string) {
  const { stdout } = await execFile("/bin/ps", ["-axo", "pid=,ppid=,rss=,command="], {
    timeout: 2_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const rows = stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            rssKiB: Number(match[3]),
            command: match[4] ?? "",
          },
        ]
      : [];
  });
  const included = new Set(
    rows
      .filter(
        (row) =>
          row.command.includes(executable) &&
          (row.command.includes("--mode acp") || row.command.includes("--mode=acp")),
      )
      .map((row) => row.pid),
  );
  for (;;) {
    const before = included.size;
    for (const row of rows) if (included.has(row.ppid)) included.add(row.pid);
    if (included.size === before) break;
  }
  return rows.filter((row) => included.has(row.pid));
}

it.live.skipIf(!configuredExecutable || !runMultipleInstanceProof)(
  "gates Prime ACP A/B isolation and N=1/2/4 host resources before capability enablement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        if (!configuredExecutable || !NodePath.isAbsolute(configuredExecutable)) {
          return yield* Effect.die(new Error("PYLON_REAL_PRIME_AGENT must be absolute"));
        }
        const executablePath = configuredExecutable;
        const root = NodeFS.mkdtempSync(
          NodePath.join(process.env.TMPDIR ?? "/tmp", "pylon-prime-acp-proof-"),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
        );

        const makeInstance = Effect.fn("makeRealPrimeAcpProofInstance")(function* (name: string) {
          const home = NodePath.join(root, "homes", name);
          copyAuthFixture(home);
          NodeFS.writeFileSync(NodePath.join(home, "isolation-marker"), name, { mode: 0o600 });
          const instanceId = ProviderInstanceId.make(name);
          const threadId = ThreadId.make(`proof-${name}`);
          const adapter = yield* makePrimeAgentAdapter(
            decodeSettings({ binaryPath: executablePath, agentHomePath: home }),
            {
              instanceId,
              environment: proofEnvironment(home),
            },
          );
          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("primeAgent"),
            cwd: root,
            runtimeMode: "full-access",
            modelSelection: { instanceId, model: "default" },
          });
          return { name, home, threadId, adapter } satisfies ProofInstance;
        });

        const promptAndWait = Effect.fn("promptAndWaitForRealPrimeAcpProof")(function* (
          instance: ProofInstance,
          token: string,
        ) {
          const completed = yield* Deferred.make<void>();
          const events: ProviderRuntimeEvent[] = [];
          const drain = yield* instance.adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                events.push(event);
                if (event.type === "turn.completed" && event.threadId === instance.threadId) {
                  yield* Deferred.succeed(completed, undefined).pipe(Effect.ignore);
                }
              }),
            ),
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          const started = yield* instance.adapter.sendTurn({
            threadId: instance.threadId,
            input: `Reply with exactly ${token} and nothing else. Do not use tools.`,
            attachments: [],
          });
          yield* Deferred.await(completed).pipe(Effect.timeout(Duration.seconds(90)));
          yield* Fiber.interrupt(drain);
          const completedEvent = events.find(
            (event) => event.type === "turn.completed" && event.turnId === started.turnId,
          );
          expect(completedEvent).toMatchObject({ payload: { state: "completed" } });
          const thread = yield* instance.adapter.readThread(instance.threadId);
          expect(thread.turns.some((turn) => turn.id === started.turnId)).toBe(true);
        });

        // A/B use separate ACP subprocesses and homes. Their first turns overlap.
        const a = yield* makeInstance("prime_a");
        const b = yield* makeInstance("prime_b");
        yield* Effect.all(
          [promptAndWait(a, "PYLON_PRIME_A_OK"), promptAndWait(b, "PYLON_PRIME_B_OK")],
          { concurrency: "unbounded" },
        );
        expect(a.home).not.toBe(b.home);
        expect(NodeFS.readFileSync(NodePath.join(a.home, "isolation-marker"), "utf8")).toBe(
          "prime_a",
        );
        expect(NodeFS.readFileSync(NodePath.join(b.home, "isolation-marker"), "utf8")).toBe(
          "prime_b",
        );

        // Removing A cannot stop B's process or its next turn.
        yield* a.adapter.stopSession(a.threadId);
        expect(yield* a.adapter.hasSession(a.threadId)).toBe(false);
        expect(yield* b.adapter.hasSession(b.threadId)).toBe(true);
        yield* promptAndWait(b, "PYLON_PRIME_B_AFTER_A_REMOVAL");
        yield* b.adapter.stopSession(b.threadId);

        const resourceRows: Array<{
          instances: number;
          coldStartMs: number;
          promptMs: number;
          processCount: number;
          rssMiB: number;
        }> = [];
        for (const count of [1, 2, 4]) {
          const coldStartAt = performance.now();
          const instances = yield* Effect.forEach(Array.from({ length: count }), (_, index) =>
            makeInstance(`resource_${count}_${index}`),
          );
          const coldStartMs = performance.now() - coldStartAt;
          const promptAt = performance.now();
          yield* Effect.all(
            instances.map((instance, index) =>
              promptAndWait(instance, `PYLON_RESOURCE_${count}_${index}_OK`),
            ),
            { concurrency: "unbounded" },
          );
          const promptMs = performance.now() - promptAt;
          const processRows = yield* Effect.promise(() => processTreeForExecutable(executablePath));
          const rssMiB = processRows.reduce((sum, row) => sum + row.rssKiB, 0) / 1024;
          expect(processRows.length).toBeGreaterThanOrEqual(count);
          expect(rssMiB).toBeGreaterThan(0);
          resourceRows.push({
            instances: count,
            coldStartMs: Math.round(coldStartMs),
            promptMs: Math.round(promptMs),
            processCount: processRows.length,
            rssMiB: Math.round(rssMiB * 10) / 10,
          });
          yield* Effect.forEach(instances, (instance) =>
            instance.adapter.stopSession(instance.threadId),
          );
        }
        // @effect-diagnostics-next-line globalConsoleInEffect:off preferSchemaOverJson:off
        console.log(`PYLON_PRIME_MULTI_RESOURCE_PROOF=${JSON.stringify(resourceRows)}`);
      }),
    ).pipe(Effect.provide(testLayer)),
  300_000,
);
