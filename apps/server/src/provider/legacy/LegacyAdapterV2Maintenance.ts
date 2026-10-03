import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { PrimeAgentOwnershipReceiptStore } from "../prime/PrimeAgentOwnershipReceipt.ts";

export class LegacyAdapterMaintenanceBusyError extends Schema.TaggedError<LegacyAdapterMaintenanceBusyError>()(
  "LegacyAdapterMaintenanceBusyError",
  { instanceId: ProviderInstanceId },
) {
  override get message() {
    return `Provider instance '${this.instanceId}' is reserved or its native cleanup is unresolved.`;
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
  readonly observeRuntimeOwnership: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
  readonly quarantineRuntime: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
  readonly reserveProviderMaintenance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReservationResult>;
  readonly releaseProviderMaintenance: (reservation: Reservation) => Effect.Effect<void>;
  readonly streamDrainedInstances: Stream.Stream<ProviderInstanceId>;
  readonly subscribeDrainedInstances: Effect.Effect<
    Stream.Stream<ProviderInstanceId>,
    never,
    Scope.Scope
  >;
}

/** Prime's maintenance admission fence follows the v2 runtime scopes. */
export class LegacyAdapterV2Maintenance extends Context.Service<
  LegacyAdapterV2Maintenance,
  LegacyAdapterV2MaintenanceShape
>()("t3/provider/legacy/LegacyAdapterV2Maintenance") {}

interface NativeOwnershipState {
  readonly quiescent: boolean;
  readonly hasOwnership: boolean;
}

export const make = Effect.fn("LegacyAdapterV2Maintenance.make")(function* (options?: {
  readonly inspectNativeOwnership: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<NativeOwnershipState>;
}) {
  const runtimeCounts = new Map<ProviderInstanceId, number>();
  const reservations = new Map<ProviderInstanceId, string>();
  const quarantined = new Set<ProviderInstanceId>();
  const observedNativeOwnership = new Set<ProviderInstanceId>();
  const gate = yield* Semaphore.make(1);
  let nextReservation = 0;
  const drained = yield* PubSub.unbounded<ProviderInstanceId>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(drained));
  const inspect = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const state =
        options === undefined
          ? { quiescent: true, hasOwnership: false }
          : yield* options.inspectNativeOwnership(instanceId);
      if (state.hasOwnership) observedNativeOwnership.add(instanceId);
      return (
        state.quiescent && (!quarantined.has(instanceId) || observedNativeOwnership.has(instanceId))
      );
    });
  const releaseRuntime = (instanceId: ProviderInstanceId) =>
    gate.withPermit(
      Effect.gen(function* () {
        const count = (runtimeCounts.get(instanceId) ?? 1) - 1;
        if (count > 0) runtimeCounts.set(instanceId, count);
        else {
          runtimeCounts.delete(instanceId);
          if (!(yield* inspect(instanceId))) {
            quarantined.add(instanceId);
            return;
          }
          quarantined.delete(instanceId);
          observedNativeOwnership.delete(instanceId);
          yield* PubSub.publish(drained, instanceId);
        }
      }),
    );
  return LegacyAdapterV2Maintenance.of({
    acquireRuntime: (instanceId) =>
      Effect.acquireRelease(
        gate.withPermit(
          Effect.gen(function* () {
            if (reservations.has(instanceId))
              return yield* new LegacyAdapterMaintenanceBusyError({ instanceId });
            const count = runtimeCounts.get(instanceId) ?? 0;
            if (quarantined.has(instanceId) && count > 0)
              return yield* new LegacyAdapterMaintenanceBusyError({ instanceId });
            if (count === 0 && !(yield* inspect(instanceId)))
              return yield* new LegacyAdapterMaintenanceBusyError({ instanceId });
            if (count === 0) {
              quarantined.delete(instanceId);
              observedNativeOwnership.delete(instanceId);
            }
            runtimeCounts.set(instanceId, count + 1);
          }),
        ),
        () => releaseRuntime(instanceId),
      ),
    observeRuntimeOwnership: (instanceId) =>
      gate.withPermit(inspect(instanceId).pipe(Effect.asVoid)),
    quarantineRuntime: (instanceId) =>
      gate.withPermit(Effect.sync(() => quarantined.add(instanceId))).pipe(Effect.asVoid),
    reserveProviderMaintenance: (instanceId) =>
      gate.withPermit(
        Effect.gen(function* () {
          if (reservations.has(instanceId) || (runtimeCounts.get(instanceId) ?? 0) > 0)
            return {
              status: "busy",
              reasons: ["an active provider runtime or maintenance reservation exists"],
            } as const;
          if (!(yield* inspect(instanceId))) {
            return {
              status: "busy",
              reasons: ["native provider cleanup has not been proved"],
            } as const;
          }
          quarantined.delete(instanceId);
          observedNativeOwnership.delete(instanceId);
          const token = `legacy-maintenance:${++nextReservation}`;
          reservations.set(instanceId, token);
          return { status: "reserved", reservation: { token } } as const;
        }),
      ),
    releaseProviderMaintenance: ({ token }) =>
      Effect.sync(() => {
        for (const [instanceId, current] of reservations)
          if (current === token) {
            reservations.delete(instanceId);
            break;
          }
      }),
    streamDrainedInstances: Stream.fromPubSub(drained),
    subscribeDrainedInstances: PubSub.subscribe(drained).pipe(
      Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
    ),
  });
});

export const layer = Layer.effect(
  LegacyAdapterV2Maintenance,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const platform = yield* HostProcessPlatform;
    const store = new PrimeAgentOwnershipReceiptStore(config.stateDir, { platform });
    return yield* make({
      inspectNativeOwnership: (instanceId) =>
        Effect.tryPromise({
          try: async () => {
            const scan = await store.scan();
            const hasOwnership = scan.receipts.some((receipt) => receipt.instanceId === instanceId);
            return {
              quiescent:
                !scan.corrupt &&
                scan.quarantinedHomes.length === 0 &&
                scan.quarantinedHomeDigests.length === 0 &&
                !hasOwnership,
              hasOwnership,
            };
          },
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => ({ quiescent: false, hasOwnership: false }))),
    });
  }),
);
