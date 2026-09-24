import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { rpcSessionOwner } from "@t3tools/client-runtime/rpc/session-owner";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Linking from "expo-linking";
import { useEffect } from "react";
import { AppState } from "react-native";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentPresentations } from "../state/presentation";
import { environmentSession } from "../state/session";
import { serverEnvironment } from "../state/server";
import { publishSubscriptionUsage } from "./publishSubscriptionUsage";
import { createSubscriptionUsagePublisher } from "./subscriptionUsagePublisher";
import { buildSubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";
import { selectWidgetPresentation } from "./subscriptionUsageSources";

const usageUrl = Linking.createURL("settings/usage", { queryParams: { tab: "limits" } });
const publish = createSubscriptionUsagePublisher(publishSubscriptionUsage, (error) => {
  console.warn("Could not update subscription usage widget", error);
});

// The current owner comes from the live supervisor. Cached auth and config
// values may still describe a previous session of this environment.
const widgetSessionOwnerAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime.atom((get) => {
    get(environmentCatalog.catalogValueAtom);
    const connection = Option.getOrNull(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
    );
    if (connection?.phase !== "connected") return Effect.succeed(null);
    return EnvironmentRegistry.pipe(
      Effect.flatMap((registry) =>
        registry.run(
          environmentId,
          EnvironmentSupervisor.pipe(
            Effect.flatMap((supervisor) =>
              Effect.all([
                SubscriptionRef.get(supervisor.state),
                SubscriptionRef.get(supervisor.session),
              ]).pipe(
                Effect.map(([liveState, session]) =>
                  liveState.phase === "connected" &&
                  liveState.generation === connection.generation &&
                  Option.isSome(session)
                    ? { owner: rpcSessionOwner(session.value), generation: liveState.generation }
                    : null,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }),
);

const widgetPresentationsAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, EnvironmentPresentation> => {
    const current = get(environmentPresentations.presentationsAtom);
    return new Map(
      [...current].flatMap(([environmentId, presentation]) => {
        if (presentation.connection.phase !== "connected") return [];
        const connection = Option.getOrNull(
          AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
        );
        if (connection?.phase !== "connected") return [];
        const ownerResult = get(widgetSessionOwnerAtom(environmentId));
        const owner = ownerResult.waiting ? null : Option.getOrNull(AsyncResult.value(ownerResult));
        if (!owner || owner.generation !== connection.generation) return [];
        const session = Option.getOrNull(
          AsyncResult.value(get(environmentSession.sessionStateAtom(environmentId))),
        );
        const authenticated =
          session?.authenticated === true && session.sessionOwner === owner.owner;
        if (!authenticated) return [];
        const projection = Option.getOrNull(
          AsyncResult.value(
            get(
              serverEnvironment.configProjection({
                environmentId,
                input: {},
              }),
            ),
          ),
        );
        const selected = selectWidgetPresentation(
          presentation,
          authenticated,
          projection,
          owner.owner,
        );
        return selected === null ? [] : [[environmentId, selected]];
      }),
    );
  },
);

function publishCurrent(isReady: boolean) {
  const snapshot = buildSubscriptionUsageSnapshot(
    isReady ? appAtomRegistry.get(widgetPresentationsAtom) : new Map(),
    usageUrl,
  );
  void publish(snapshot);
}

export function SubscriptionUsageCoordinator() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const presentations = useAtomValue(widgetPresentationsAtom);

  useEffect(() => {
    void publish(
      buildSubscriptionUsageSnapshot(catalog.isReady ? presentations : new Map(), usageUrl),
    );
  }, [catalog.isReady, presentations]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") publishCurrent(catalog.isReady);
    });
    return () => subscription.remove();
  }, [catalog.isReady]);
  return null;
}
