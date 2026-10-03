import { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export class LegacyAdapterMaintenanceBusyError extends Schema.TaggedError<LegacyAdapterMaintenanceBusyError>()(
  "LegacyAdapterMaintenanceBusyError",
  { instanceId: ProviderInstanceId },
) {
  override get message() {
    return `Provider instance '${this.instanceId}' is reserved for managed maintenance.`;
  }
}

interface Reservation {
  readonly token: string;
}
type ReservationResult =
  | { readonly status: "reserved"; readonly reservation: Reservation }
  | { readonly status: "busy"; readonly reasons: ReadonlyArray<string> };

export interface LegacyAdapterV2MaintenanceShape {
  readonly acquireRuntime: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<void, LegacyAdapterMaintenanceBusyError, Scope.Scope>;
  readonly reserveProviderMaintenance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReservationResult>;
  readonly releaseProviderMaintenance: (reservation: Reservation) => Effect.Effect<void>;
  readonly streamDrainedInstances: Stream.Stream<ProviderInstanceId>;
}

/** Prime's maintenance admission fence follows the v2 runtime scopes. */
export class LegacyAdapterV2Maintenance extends Context.Service<
  LegacyAdapterV2Maintenance,
  LegacyAdapterV2MaintenanceShape
>()("t3/provider/legacy/LegacyAdapterV2Maintenance") {}

export const make = Effect.fn("LegacyAdapterV2Maintenance.make")(function* () {
  const runtimeCounts = new Map<ProviderInstanceId, number>();
  const reservations = new Map<ProviderInstanceId, string>();
  let nextReservation = 0;
  const drained = yield* PubSub.unbounded<ProviderInstanceId>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(drained));
  const releaseRuntime = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const count = (runtimeCounts.get(instanceId) ?? 1) - 1;
      if (count > 0) runtimeCounts.set(instanceId, count);
      else {
        runtimeCounts.delete(instanceId);
        yield* PubSub.publish(drained, instanceId);
      }
    });
  return LegacyAdapterV2Maintenance.of({
    acquireRuntime: (instanceId) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          if (reservations.has(instanceId))
            return Effect.fail(new LegacyAdapterMaintenanceBusyError({ instanceId }));
          runtimeCounts.set(instanceId, (runtimeCounts.get(instanceId) ?? 0) + 1);
          return Effect.void;
        }),
        () => releaseRuntime(instanceId),
      ),
    reserveProviderMaintenance: (instanceId) =>
      Effect.sync(() => {
        if (reservations.has(instanceId) || (runtimeCounts.get(instanceId) ?? 0) > 0)
          return {
            status: "busy",
            reasons: ["an active provider runtime or maintenance reservation exists"],
          } as const;
        const token = `legacy-maintenance:${++nextReservation}`;
        reservations.set(instanceId, token);
        return { status: "reserved", reservation: { token } } as const;
      }),
    releaseProviderMaintenance: ({ token }) =>
      Effect.sync(() => {
        for (const [instanceId, current] of reservations)
          if (current === token) {
            reservations.delete(instanceId);
            break;
          }
      }),
    streamDrainedInstances: Stream.fromPubSub(drained),
  });
});

export const layer = Layer.effect(LegacyAdapterV2Maintenance, make());
