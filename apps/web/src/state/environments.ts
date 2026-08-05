import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { Discovery } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations, useEnvironmentPresentation } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { useEnvironmentQuery } from "./query";
import { relayEnvironmentDiscovery } from "./relay";
import { usePreparedConnection } from "./session";
import {
  serverConfigSynchronizedAtom,
  serverConfigSynchronizationByEnvironmentAtom,
} from "./server";

export interface EnvironmentPresentation extends BaseEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
  readonly serverConfigSynchronized: boolean;
}

function projectEnvironmentPresentation(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
  serverConfigSynchronized: boolean,
): EnvironmentPresentation {
  return {
    ...presentation,
    environmentId,
    label: presentation.entry.target.label,
    displayUrl: connectionCatalogDisplayUrl(presentation.entry),
    relayManaged: presentation.entry.target._tag === "RelayConnectionTarget",
    serverConfigSynchronized,
  };
}

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);
  const serverConfigSynchronizationByEnvironment = useAtomValue(
    serverConfigSynchronizationByEnvironmentAtom,
  );

  const environments = useMemo(
    () =>
      [...presentationById.entries()].map(([environmentId, presentation]) =>
        projectEnvironmentPresentation(
          environmentId,
          presentation,
          serverConfigSynchronizationByEnvironment.get(environmentId) ?? false,
        ),
      ),
    [presentationById, serverConfigSynchronizationByEnvironment],
  );

  return {
    isReady: catalog.isReady,
    networkStatus,
    environments,
    presentationById,
  };
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return useAtomValue(primaryEnvironmentIdAtom);
}

export function useEnvironment(
  environmentId: EnvironmentId | null,
): EnvironmentPresentation | null {
  const { presentation } = useEnvironmentPresentation(environmentId);
  const serverConfigSynchronized = useAtomValue(serverConfigSynchronizedAtom(environmentId));
  return useMemo(
    () =>
      environmentId === null || presentation === null
        ? null
        : projectEnvironmentPresentation(environmentId, presentation, serverConfigSynchronized),
    [environmentId, presentation, serverConfigSynchronized],
  );
}

export function usePrimaryEnvironment(): EnvironmentPresentation | null {
  return useEnvironment(usePrimaryEnvironmentId());
}

export function useEnvironmentHttpBaseUrl(environmentId: EnvironmentId | null): string | null {
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
}

export function useRelayEnvironmentDiscovery(): Discovery.RelayEnvironmentDiscoveryState {
  return useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
}

export function useEnvironmentConnectionState(environmentId: EnvironmentId) {
  return useEnvironmentQuery(environmentCatalog.stateAtom(environmentId));
}
