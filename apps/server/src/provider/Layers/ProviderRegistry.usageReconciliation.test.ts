import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderRegistryLive } from "./ProviderRegistry.ts";

it.effect(
  "rejects mismatched account readings and interrupts a replaced instance's in-flight reconciliation",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claude-personal");
      const driver = ProviderDriverKind.make("claudeAgent");
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const initialProvider = {
        instanceId,
        driver,
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated", email: "a@example.test" },
        checkedAt,
        version: "2.1.220",
        models: [],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const reads = yield* Ref.make(0);
      const interrupted = yield* Ref.make(false);
      let block = false;
      let oldIsCurrent = Effect.succeed(true);
      const instance = {
        instanceId,
        driverKind: driver,
        displayName: undefined,
        enabled: true,
        continuationIdentity: { driverKind: driver, continuationKey: "claude:test" },
        snapshot: {
          resolveMaintenance: () =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: driver,
                packageName: null,
              }),
            ),
          getSnapshot: Effect.succeed(initialProvider),
          refresh: Effect.never,
          streamChanges: Stream.never,
        },
        adapter: {} as ProviderInstance["adapter"],
        textGeneration: {} as ProviderInstance["textGeneration"],
        reconcileUsage: ({ isCurrent }) =>
          Effect.gen(function* () {
            yield* Ref.update(reads, (n) => n + 1);
            oldIsCurrent = isCurrent;
            if (block) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release).pipe(
                Effect.onInterrupt(() => Ref.set(interrupted, true)),
              );
            }
            return {
              accountIdentity: "wrong@example.test",
              usageLimits: {
                checkedAt: DateTime.formatIso(yield* DateTime.now),
                windows: [{ label: "Weekly (wrong account)", usedPercent: 99 }],
              },
            };
          }),
      } satisfies ProviderInstance;
      const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([instance]);
      const changes = yield* PubSub.unbounded<void>();
      const registryLayer = ProviderRegistryLive.pipe(
        Layer.provideMerge(
          Layer.succeed(ProviderInstanceRegistry, {
            getInstance: (id) =>
              Ref.get(instances).pipe(
                Effect.map((items) => items.find((item) => item.instanceId === id)),
              ),
            listInstances: Ref.get(instances),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.fromPubSub(changes),
            subscribeChanges: PubSub.subscribe(changes),
          }),
        ),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "pylon-claude-reconciliation-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        yield* registry.refreshProviderCapacity(instanceId);
        yield* TestClock.adjust("1 minute");
        assert.strictEqual(yield* Ref.get(reads), 1);
        assert.strictEqual((yield* registry.getProviders)[0]?.usageLimits, undefined);

        block = true;
        yield* registry.refreshProviderCapacity(instanceId);
        yield* TestClock.adjust("1 minute");
        yield* Deferred.await(started);
        const nextProvider: ServerProvider = {
          ...initialProvider,
          auth: { status: "authenticated", email: "b@example.test" },
          checkedAt: DateTime.formatIso(yield* DateTime.now),
        };
        const replacement: ProviderInstance = {
          ...instance,
          snapshot: { ...instance.snapshot, getSnapshot: Effect.succeed(nextProvider) },
          reconcileUsage: () =>
            DateTime.now.pipe(
              Effect.map((now) => ({
                accountIdentity: "b@example.test",
                usageLimits: {
                  checkedAt: DateTime.formatIso(now),
                  windows: [{ label: "Weekly (new account)", usedPercent: 7 }],
                },
              })),
            ),
        };
        const replaced = yield* (yield* registry.subscribeChanges).pipe(
          Stream.filter((items) => items[0]?.auth.email === "b@example.test"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Ref.set(instances, [replacement]);
        yield* PubSub.publish(changes, undefined);
        yield* Fiber.join(replaced);
        assert.strictEqual(yield* Ref.get(interrupted), true);
        assert.strictEqual(yield* oldIsCurrent, false);
        yield* Deferred.succeed(release, undefined);
        const reconciled = yield* (yield* registry.subscribeChanges).pipe(
          Stream.filter((items) => items[0]?.usageLimits !== undefined),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.forkChild,
        );
        yield* registry.refreshProviderCapacity(instanceId);
        yield* TestClock.adjust("1 minute");
        assert.deepStrictEqual((yield* Fiber.join(reconciled))[0]?.usageLimits?.windows, [
          { label: "Weekly (new account)", usedPercent: 7 },
        ]);
      }).pipe(Effect.provide(registryLayer));
    }),
);
