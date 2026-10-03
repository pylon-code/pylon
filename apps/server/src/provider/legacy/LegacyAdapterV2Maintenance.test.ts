// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../../config.ts";
import {
  PrimeAgentOwnershipReceiptStore,
  primeAgentOwnershipReceiptIsSafeLive,
} from "../prime/PrimeAgentOwnershipReceipt.ts";
import * as Maintenance from "./LegacyAdapterV2Maintenance.ts";

const testLayer = Maintenance.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "pylon-prime-maintenance-proof-" }),
  ),
  Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
  Layer.provide(NodeServices.layer),
);

describe("Prime native maintenance proof", () => {
  it.live(
    "blocks pending and admission-safe acquired receipts after local timeout until verified native cleanup",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const maintenance = yield* Maintenance.LegacyAdapterV2Maintenance;
          const instanceId = ProviderInstanceId.make("prime-owned");
          const home = NodePath.join(config.stateDir, "prime-home");
          yield* Effect.promise(() => NodeFSP.mkdir(home, { recursive: true }));
          const canonicalHome = yield* Effect.promise(() => NodeFSP.realpath(home));
          const store = new PrimeAgentOwnershipReceiptStore(config.stateDir, {
            inspectProcessIdentity: async (pid) => `test:${pid}`,
          });
          const runtime = yield* Scope.make();
          yield* maintenance.acquireRuntime(instanceId).pipe(Scope.provide(runtime));
          const handle = yield* Effect.promise(() =>
            store.begin({ instanceId, configRevision: "revision-a", effectiveHome: canonicalHome }),
          );
          yield* maintenance.observeRuntimeOwnership(instanceId);
          // A bounded stop can return while native teardown is still unresolved.
          yield* Scope.close(runtime, Exit.void);
          expect(yield* maintenance.reserveProviderMaintenance(instanceId)).toMatchObject({
            status: "busy",
          });
          const attachProof = {
            feature: "caller_owned_session_environment_cleanup_v1" as const,
            status: "attached" as const,
            daemon: {
              protocolName: "prime-agent.daemon",
              protocolVersion: 7,
              schemaRevision: 30,
              supervisorGeneration: "supervisor-a",
              transportGeneration: 1,
            },
          };
          yield* Effect.promise(() =>
            store.markAcquired(handle, {
              activeSessionId: "active-a",
              nativeSessionId: "native-a",
              attachProof,
            }),
          );
          const scan = yield* Effect.promise(() => store.scan());
          expect(primeAgentOwnershipReceiptIsSafeLive(scan.receipts[0]!)).toBe(true);
          expect(yield* maintenance.reserveProviderMaintenance(instanceId)).toMatchObject({
            status: "busy",
          });
          expect(yield* maintenance.acquireRuntime(instanceId).pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
          });
          expect(
            yield* Effect.promise(() =>
              store.clearAfterCleanup(handle, {
                activeSessionId: "active-a",
                nativeSessionId: "native-a",
                result: {
                  feature: "caller_owned_session_environment_cleanup_v1",
                  status: "completed",
                  started: attachProof,
                  observed: attachProof.daemon,
                  daemonReplaced: false,
                },
              }),
            ),
          ).toBe(true);
          expect(yield* maintenance.reserveProviderMaintenance(instanceId)).toMatchObject({
            status: "reserved",
          });
        }),
      ).pipe(Effect.provide(testLayer)),
  );

  it.live("fails closed on unreadable ownership records", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const maintenance = yield* Maintenance.LegacyAdapterV2Maintenance;
        const store = new PrimeAgentOwnershipReceiptStore(config.stateDir, {
          inspectProcessIdentity: async (pid) => `test:${pid}`,
        });
        yield* Effect.promise(() => store.scan());
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(store.directory, "00000000-0000-4000-8000-000000000001.json"),
            "invalid",
            { mode: 0o600 },
          ),
        );
        const instanceId = ProviderInstanceId.make("prime-corrupt");
        expect(yield* maintenance.reserveProviderMaintenance(instanceId)).toMatchObject({
          status: "busy",
        });
        expect(yield* maintenance.acquireRuntime(instanceId).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
