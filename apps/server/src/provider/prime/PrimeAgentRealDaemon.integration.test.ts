// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { makePrimeAgentDaemonManager } from "./PrimeAgentDaemonManager.ts";
import { makePrimeAgentDaemonSessionRuntime } from "./PrimeAgentDaemonSessionRuntime.ts";

const configuredExecutable = process.env.PYLON_REAL_PRIME_AGENT?.trim();

it.live.skipIf(!configuredExecutable || process.platform === "win32")(
  "creates and disposes a client-owned session through a real Prime Agent daemon",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
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

        const manager = yield* makePrimeAgentDaemonManager({
          executablePath: configuredExecutable,
          settings: { agentHomePath },
          environment: process.env,
          stateDir,
          providerInstanceId: ProviderInstanceId.make("prime-real-integration"),
          tempDir: "/tmp",
        });
        const readinessClient = yield* manager.openClient();
        readinessClient.close();
        const runtime = yield* makePrimeAgentDaemonSessionRuntime({
          manager,
          cwd: root,
          sessionDir: NodePath.join(manager.sessionDir, "integration-thread"),
          disableExtensionDiscovery: true,
        });

        expect(runtime.resumeCursor).toEqual({
          schemaVersion: 3,
          kind: "prime-agent-daemon-session",
          continue: true,
        });
        expect(runtime.sessionId).toMatch(/^[A-Za-z0-9_-]{1,256}$/u);
        expect(runtime.initialInputQueue).toMatchObject({ steeringCount: 0, followUpCount: 0 });
        yield* runtime.dispose;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
