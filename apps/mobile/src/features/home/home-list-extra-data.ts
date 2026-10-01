import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import type { SavedRemoteConnection } from "../../lib/connection";

/**
 * The legacy Home list's `extraData`. A recycled LegendList cell re-renders
 * only when its item changes or this identity changes — a new render closure
 * alone does not — so every non-item input a row reads must be listed here.
 * The capability sets gate row menu items (title regeneration, auto-settle)
 * and arrive with server configs, which can land after the threads or change
 * when a server is upgraded or downgraded.
 */
export function useLegacyHomeListExtraData(input: {
  readonly projectCwdByKey: ReadonlyMap<string, string>;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly searchQuery: string;
  readonly threadSearchMatchByKey: ReadonlyMap<string, EnvironmentThreadSearchMatch>;
  readonly autoSettleOptOutEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly titleRegenerationEnvironmentIds: ReadonlySet<EnvironmentId>;
}) {
  const {
    projectCwdByKey,
    savedConnectionsById,
    searchQuery,
    threadSearchMatchByKey,
    autoSettleOptOutEnvironmentIds,
    titleRegenerationEnvironmentIds,
  } = input;
  return useMemo(
    () => ({
      projectCwdByKey,
      savedConnectionsById,
      searchQuery,
      threadSearchMatchByKey,
      autoSettleOptOutEnvironmentIds,
      titleRegenerationEnvironmentIds,
    }),
    [
      projectCwdByKey,
      savedConnectionsById,
      searchQuery,
      threadSearchMatchByKey,
      autoSettleOptOutEnvironmentIds,
      titleRegenerationEnvironmentIds,
    ],
  );
}
