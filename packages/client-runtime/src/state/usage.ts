import type { EnvironmentId, ServerProvider, UsageSummaryInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { createEnvironmentPresentationAtoms } from "./presentation.ts";
import { executeAtomQuery, runAtomCommand, squashAtomCommandFailure } from "./runtime.ts";
import type { createServerEnvironmentAtoms } from "./server.ts";

const isEnvironmentRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

const limitsRefreshStates = new Map<
  EnvironmentId,
  { scope: string; refreshAfter: number; pending: Promise<unknown> | undefined }
>();

/** Account identity changes warrant a fresh probe; volatile readings do not. */
export function usageLimitsRefreshScope(
  providers: readonly Pick<ServerProvider, "instanceId" | "driver" | "auth">[],
): string {
  return JSON.stringify(
    providers
      .map(({ instanceId, driver, auth }) => [
        instanceId,
        driver,
        auth.status,
        auth.type ?? null,
        auth.accountId ?? null,
        auth.email ?? null,
        auth.label ?? null,
      ])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

/** A disconnected RPC must never satisfy a refresh requested on a later connection. */
export function invalidateUsageLimitsRefresh(environmentId: EnvironmentId): void {
  limitsRefreshStates.delete(environmentId);
}

export async function refreshUsageLimits<A>(
  environmentId: EnvironmentId,
  refresh: () => Promise<A>,
  automatic = false,
  scope = "",
): Promise<A | undefined> {
  const previous = limitsRefreshStates.get(environmentId);
  const state =
    previous?.scope === scope ? previous : { scope, refreshAfter: 0, pending: undefined };
  if (state !== previous) limitsRefreshStates.set(environmentId, state);
  const pending = state.pending;
  if (pending !== undefined) {
    // Manual refresh waits for the current check; automatic refresh does not repeat it.
    if (automatic) return undefined;
    try {
      const result = (await pending) as A;
      return limitsRefreshStates.get(environmentId) === state ? result : undefined;
    } catch (error) {
      if (limitsRefreshStates.get(environmentId) !== state) return undefined;
      throw error;
    }
  }
  // @effect-diagnostics-next-line globalDate:off
  if (automatic && Date.now() < state.refreshAfter) return;
  const current = Promise.resolve()
    .then(refresh)
    .finally(() => {
      if (limitsRefreshStates.get(environmentId) !== state) return;
      state.pending = undefined;
      // @effect-diagnostics-next-line globalDate:off
      state.refreshAfter = Date.now() + 5 * 60_000;
    });
  state.pending = current;
  try {
    const result = await current;
    return limitsRefreshStates.get(environmentId) === state ? result : undefined;
  } catch (error) {
    if (limitsRefreshStates.get(environmentId) !== state) return undefined;
    throw error;
  }
}

/** Refresh pricing, then await each selected environment's rescan while it remains connected. */
export async function refreshUsage({
  registry,
  server,
  presentations,
  environmentIds,
  input,
}: {
  registry: AtomRegistry.AtomRegistry;
  server: Pick<
    ReturnType<typeof createServerEnvironmentAtoms>,
    "usageSummary" | "refreshUsageRates"
  >;
  presentations: Pick<ReturnType<typeof createEnvironmentPresentationAtoms>, "presentationAtom">;
  environmentIds: readonly EnvironmentId[];
  input: UsageSummaryInput;
}): Promise<void> {
  await Promise.all(
    environmentIds.map(async (environmentId) => {
      const query = server.usageSummary({ environmentId, input });
      const presentation = presentations.presentationAtom(environmentId);
      const controller = new AbortController();
      const abortWhenDisconnected = () => {
        if (registry.get(presentation)?.connection.phase !== "connected") controller.abort();
      };
      const unsubscribe = registry.subscribe(presentation, abortWhenDisconnected);
      abortWhenDisconnected();
      try {
        const ratesResult = await runAtomCommand(
          registry,
          server.refreshUsageRates,
          { environmentId, input: {} },
          { reportFailure: false },
        );
        const sessionUnavailable =
          ratesResult._tag === "Failure" &&
          isEnvironmentRpcUnavailable(squashAtomCommandFailure(ratesResult));
        // Invalidate even on failure so reconnects cannot reuse the old summary.
        registry.refresh(query);
        if (sessionUnavailable || controller.signal.aborted) return;
        await executeAtomQuery(registry, query, {
          reportFailure: false,
          signal: controller.signal,
        });
      } finally {
        unsubscribe();
      }
    }),
  );
}
