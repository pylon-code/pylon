import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState,
  assetUrlStateFromResult,
  EMPTY_ASSET_URL_ATOM,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection, usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl, type AssetUrlState } from "@t3tools/client-runtime/state/assets";

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  return assetUrlStateFromResult(
    result,
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
  );
}

export function useAssetUrlRefresh(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): (signal?: AbortSignal) => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const prepared = connection._tag === "Some" ? connection.value : null;
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(
    async (signal?: AbortSignal) => {
      if (environmentId === null || resource === null || prepared === null) return null;
      const timeout = AbortSignal.timeout(60_000);
      const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      // A capability belongs to the connection that authorized it. A reconnect may change
      // both credentials and origin while the query waits, so authorize again on that connection.
      for (let attempt = 0; attempt < 2; attempt++) {
        operationSignal.throwIfAborted();
        const before = readPreparedConnection(environmentId);
        if (!before) return null;
        const result = await refresh(
          { environmentId, input: { resource } },
          { signal: operationSignal },
        );
        operationSignal.throwIfAborted();
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        const current = readPreparedConnection(environmentId);
        if (!current) return null;
        if (current !== before) continue;
        return resolveAssetUrl(current.httpBaseUrl, result.value.relativeUrl);
      }
      throw new Error("The environment reconnected. Please try again.");
      // A new prepared identity restarts mounted preview effects, including credential-only changes.
    },
    [environmentId, resource, refresh, prepared],
  );
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources,
    }),
  );
  return useMemo(
    () =>
      preparedConnection._tag === "None"
        ? resources.map(() => null)
        : results.map((result) =>
            AsyncResult.isSuccess(result)
              ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
              : null,
          ),
    [preparedConnection, resources, results],
  );
}
