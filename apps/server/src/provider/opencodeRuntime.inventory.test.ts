import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";

import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

const testLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("OpenCodeRuntime inventory", (it) => {
  it.effect("aborts pending SDK requests when inventory loading is interrupted", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const started = yield* Queue.make<void>();
      const aborted = yield* Queue.make<string>();
      const client = createOpencodeClient({
        baseUrl: "http://opencode.test",
        fetch: Object.assign(
          (input: string | Request | URL) => {
            const request = input instanceof Request ? input : new Request(input.toString());
            return new Promise<Response>((_resolve, reject) => {
              request.signal.addEventListener(
                "abort",
                () => {
                  Queue.offerUnsafe(aborted, new URL(request.url).pathname);
                  reject(request.signal.reason);
                },
                { once: true },
              );
              Queue.offerUnsafe(started, undefined);
            });
          },
          { preconnect: () => undefined },
        ),
      });

      const inventoryFiber = yield* runtime.loadOpenCodeInventory(client).pipe(Effect.forkChild);
      yield* Queue.takeN(started, 3);
      yield* Fiber.interrupt(inventoryFiber);

      NodeAssert.deepEqual((yield* Queue.takeAll(aborted)).toSorted(), [
        "/agent",
        "/provider",
        "/skill",
      ]);
    }),
  );

  it.effect("keeps provider inventory when agent discovery fails", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: {
                connected: ["openai"],
                all: [],
                default: {},
              },
            }),
        },
        app: {
          agents: () => Promise.reject(new Error("agents endpoint unavailable")),
          skills: () => Promise.resolve({ data: [] }),
        },
      } as unknown as OpencodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client);

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.deepEqual(inventory.agents, []);
      NodeAssert.deepEqual(inventory.skills, []);
    }),
  );

  it.effect("keeps provider inventory when skill discovery fails", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: {
                connected: ["openai"],
                all: [],
                default: {},
              },
            }),
        },
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () => Promise.reject(new Error("skills endpoint unavailable")),
        },
      } as unknown as OpencodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client);

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.deepEqual(inventory.agents, []);
      NodeAssert.deepEqual(inventory.skills, []);
    }),
  );

  it.effect("keeps only SDK skill metadata in inventory", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: {
                connected: ["openai"],
                all: [],
                default: {},
              },
            }),
        },
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () =>
            Promise.resolve({
              data: [
                {
                  name: "review",
                  description: "Review code changes",
                  location: "/skills/review/SKILL.md",
                  content: "unused skill content",
                },
              ],
            }),
        },
      } as unknown as OpencodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client);

      NodeAssert.deepEqual(inventory.skills, [
        {
          name: "review",
          description: "Review code changes",
          location: "/skills/review/SKILL.md",
        },
      ]);
    }),
  );

  it.effect("drops oversized CLI skill output without losing the model inventory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const executablePath = yield* HostProcessExecutablePath;
      const hostPlatform = yield* HostProcessPlatform;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-inventory-" });
      const isWindows = hostPlatform === "win32";
      const binaryPath = path.join(tempDir, isWindows ? "opencode.cmd" : "opencode");
      const scriptPath = path.join(tempDir, "opencode.mjs");
      const oversizedContentBytes = 8 * 1024 * 1024 + 1;

      yield* fs.writeFileString(
        scriptPath,
        [
          'if (process.argv[2] === "models") {',
          '  process.stdout.write(`openai/gpt-test\\n{"id":"gpt-test","providerID":"openai","name":"GPT Test"}\\n`);',
          '} else if (process.argv[2] === "debug") {',
          `  const content = "x".repeat(${oversizedContentBytes});`,
          '  process.stdout.write(`[{"name":"oversized","content":"${content}"}]`);',
          "}",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        binaryPath,
        [
          ...(isWindows ? ["@echo off"] : ["#!/bin/sh"]),
          isWindows
            ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
            : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
          "",
        ].join("\n"),
      );
      if (!isWindows) {
        yield* fs.chmod(binaryPath, 0o755);
      }

      const runtime = yield* OpenCodeRuntime;
      const inventory = yield* runtime.loadInventoryFromCli({
        binaryPath,
        cwd: tempDir,
        environment: {
          ...hostEnvironment,
          T3_TEST_NODE_BINARY: executablePath,
          T3_TEST_OPENCODE_SCRIPT: scriptPath,
        },
      });

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.equal(inventory.skills.length, 0);
    }),
  );

  it.effect("caps and drains command stdout and stderr when requested", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const executablePath = yield* HostProcessExecutablePath;
      const outputBytes = 2 * 1024 * 1024;
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: executablePath,
        args: [
          "-e",
          `process.stdout.write("o".repeat(${outputBytes})); process.stderr.write("e".repeat(${outputBytes}));`,
        ],
        maxOutputBytes: 64,
      });

      NodeAssert.equal(result.stdout, "o".repeat(64));
      NodeAssert.equal(result.stderr, "e".repeat(64));
      NodeAssert.equal(result.code, 0);
    }),
  );
});

for (const retry of [false, true]) {
  it.effect(
    `runs CLI inventory commands without overlapping database owners (retry=${retry})`,
    () =>
      Effect.gen(function* () {
        const started = yield* Queue.make<{
          args: readonly string[];
          finish: Deferred.Deferred<number>;
        }>();
        let active = 0;
        let maximumActive = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            NodeAssert.equal(ChildProcess.isStandardCommand(command), true);
            if (!ChildProcess.isStandardCommand(command))
              return yield* Effect.die("Expected standard command");
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            const finish = yield* Deferred.make<number>();
            yield* Queue.offer(started, { args: command.args, finish });
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Deferred.await(finish).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    active -= 1;
                  }),
                ),
                Effect.map(ChildProcessSpawner.ExitCode),
              ),
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.make(
                new TextEncoder().encode(
                  command.args[0] === "models"
                    ? 'openai/gpt-test\n{"id":"gpt-test","providerID":"openai","name":"GPT Test"}\n'
                    : command.args[0] === "debug"
                      ? "[]"
                      : "",
                ),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );
        const runtime = yield* OpenCodeRuntime.pipe(
          Effect.provide(
            OpenCodeRuntimeLive.pipe(
              Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
              // Mock children have no OS process group; cleanup goes through the mock handle.
              Layer.provide(Layer.succeed(HostProcessPlatform, "win32")),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        const loading = yield* runtime
          .loadInventoryFromCli({ binaryPath: "opencode", cwd: process.cwd() })
          .pipe(Effect.forkChild);
        for (let pass = 0; pass < (retry ? 2 : 1); pass += 1) {
          if (pass > 0) yield* TestClock.adjust("1 second");
          for (const expected of [
            ["models", "--verbose"],
            ["agent", "list"],
            ["debug", "skill"],
          ]) {
            const command = yield* Queue.take(started);
            NodeAssert.deepEqual(command.args, expected);
            yield* Deferred.succeed(command.finish, retry && pass === 0 ? 1 : 0);
          }
        }
        const inventory = yield* Fiber.join(loading);
        NodeAssert.equal(maximumActive, 1);
        NodeAssert.equal(active, 0);
        NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      }),
  );
}
