import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import * as Maintenance from "../legacy/LegacyAdapterV2Maintenance.ts";
import * as Drain from "./PrimeManagedMaintenanceDrain.ts";

describe("Prime managed maintenance server worker", () => {
  it.effect("resumes a persisted scheduled receipt when shutdown lost the final drain signal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstServer = yield* Scope.make();
        const firstMaintenance = yield* Maintenance.make();
        const instanceId = ProviderInstanceId.make("prime-scheduled-restart");
        let scheduled = true;
        const runtime = yield* Scope.make();
        yield* firstMaintenance.acquireRuntime(instanceId).pipe(Scope.provide(runtime));
        yield* Drain.start({
          subscribe: firstMaintenance.subscribeDrainedInstances,
          drain: () =>
            Effect.sync(() => {
              scheduled = false;
            }),
        }).pipe(Scope.provide(firstServer));
        // Shutdown closes the dependent maintenance worker before the core runtime.
        yield* Scope.close(firstServer, Exit.void);
        yield* Scope.close(runtime, Exit.void);
        expect(scheduled).toBe(true);
        const completed = yield* Deferred.make<void>();
        const restartedMaintenance = yield* Maintenance.make();
        yield* Drain.start({
          subscribe: restartedMaintenance.subscribeDrainedInstances,
          initialInstances: Effect.succeed([instanceId]),
          drain: (id) =>
            restartedMaintenance.reserveProviderMaintenance(id).pipe(
              Effect.flatMap((reservation) => {
                if (reservation.status !== "reserved") return Effect.void;
                scheduled = false;
                return Deferred.succeed(completed, undefined).pipe(Effect.asVoid);
              }),
            ),
        });
        yield* Deferred.await(completed);
        expect(scheduled).toBe(false);
      }),
    ),
  );

  it.effect("drains a scheduled receipt after all client scopes disconnect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(server, Exit.void));
        const maintenance = yield* Maintenance.make().pipe(Scope.provide(server));
        const instanceId = ProviderInstanceId.make("prime-disconnected");
        const completed = yield* Deferred.make<ProviderInstanceId>();
        yield* Drain.start({
          subscribe: maintenance.subscribeDrainedInstances,
          drain: (id) =>
            maintenance
              .reserveProviderMaintenance(id)
              .pipe(
                Effect.flatMap((reservation) =>
                  reservation.status === "reserved"
                    ? Deferred.succeed(completed, id).pipe(Effect.asVoid)
                    : Effect.void,
                ),
              ),
        }).pipe(Scope.provide(server));
        const runtime = yield* Scope.make();
        yield* maintenance.acquireRuntime(instanceId).pipe(Scope.provide(runtime));
        const firstClient = yield* Scope.make();
        const lastClient = yield* Scope.make();
        const fromClient = yield* Effect.service(Maintenance.LegacyAdapterV2Maintenance).pipe(
          Effect.provideService(Maintenance.LegacyAdapterV2Maintenance, maintenance),
          Scope.provide(firstClient),
        );
        expect(yield* fromClient.reserveProviderMaintenance(instanceId)).toMatchObject({
          status: "busy",
        });
        yield* Scope.close(firstClient, Exit.void);
        yield* Scope.close(lastClient, Exit.void);
        yield* Scope.close(runtime, Exit.void);
        expect(yield* Deferred.await(completed)).toBe(instanceId);
      }),
    ),
  );
});
