import { createDeviceEnvironmentAtoms } from "@t3tools/client-runtime/state/device";
import { resolveDeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  currentDeviceHubAccess,
  currentDeviceState,
} from "../features/devices/deviceHubAccessScope";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentQuery } from "./query";
import { environmentSession, usePreparedConnection } from "./session";

export const deviceEnvironment = createDeviceEnvironmentAtoms(connectionAtomRuntime);

export function useLiveDeviceState(environmentId: EnvironmentId) {
  const connectionResult = useAtomValue(environmentCatalog.stateAtom(environmentId));
  const query = useEnvironmentQuery(deviceEnvironment.state({ environmentId, input: {} }));
  return {
    ...query,
    data: currentDeviceState({
      connection: Option.getOrNull(AsyncResult.value(connectionResult)),
      connectionPending: connectionResult.waiting,
      state: query.data,
      statePending: query.isPending,
      stateError: query.error,
    }),
  };
}

const deviceHubAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const connectionResult = get(environmentCatalog.stateAtom(environmentId));
      const connection = Option.getOrNull(AsyncResult.value(connectionResult));
      // Follow credential changes as a trigger, but never trust this stream's
      // waitingFrom value as the ticket's identity. Read the live supervisor.
      get(environmentSession.preparedConnectionValueAtom(environmentId));
      if (connectionResult.waiting || connection?.phase !== "connected") return Effect.never;
      return EnvironmentRegistry.pipe(
        Effect.flatMap((registry) =>
          registry.run(
            environmentId,
            EnvironmentSupervisor.pipe(
              Effect.flatMap((supervisor) =>
                Effect.all([
                  SubscriptionRef.get(supervisor.state),
                  SubscriptionRef.get(supervisor.prepared),
                ]).pipe(
                  Effect.flatMap(([liveState, livePrepared]) =>
                    liveState.phase === "connected" &&
                    liveState.generation === connection.generation &&
                    Option.isSome(livePrepared)
                      ? resolveDeviceHubAccess({
                          prepared: livePrepared.value,
                          hubBasePath: "/api/device-hub",
                        }).pipe(
                          Effect.map((access) => ({
                            prepared: livePrepared.value,
                            generation: liveState.generation,
                            access,
                          })),
                        )
                      : Effect.never,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`mobile-device-hub-access:${environmentId}`)),
);

export function refreshDeviceHubAccess(environmentId: EnvironmentId) {
  appAtomRegistry.refresh(deviceHubAccessAtom(environmentId));
}

export function useDeviceHubAccess(environmentId: EnvironmentId, hostId: string) {
  const prepared = usePreparedConnection(environmentId);
  const connectionResult = useAtomValue(environmentCatalog.stateAtom(environmentId));
  const query = useEnvironmentQuery(deviceHubAccessAtom(environmentId));
  const access = useMemo(
    () =>
      currentDeviceHubAccess({
        prepared: Option.getOrNull(prepared),
        connection: Option.getOrNull(AsyncResult.value(connectionResult)),
        connectionPending: connectionResult.waiting,
        reading: query.data,
        readingPending: query.isPending,
        readingError: query.error,
        hostId,
      }),
    [query.data, query.error, query.isPending, prepared, connectionResult, hostId],
  );
  return { access, error: query.error, refresh: query.refresh };
}
