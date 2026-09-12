import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";

export const QUEUED_MODEL_CATALOG_REFRESH_TIMEOUT_MS = 30_000;

/** One bounded discovery per saved user request/account; callers re-read all dispatch authority afterward. */
export function createQueuedModelCatalogRefresh(
  refresh: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly instanceId: ModelSelection["instanceId"];
      readonly refreshModels: true;
    };
  }) => Promise<unknown>,
) {
  const attempted = new Map<string, { accounts: Set<string>; pending: number }>();
  let queuedKeys: ReadonlySet<string> | undefined;
  const messageKey = (target: {
    readonly environmentId: EnvironmentId;
    readonly messageId: string;
  }) => JSON.stringify([target.environmentId, target.messageId]);
  const prune = () => {
    if (queuedKeys === undefined) return;
    for (const [key, entry] of attempted) {
      if (entry.pending === 0 && !queuedKeys.has(key)) attempted.delete(key);
    }
  };
  const discover = async (target: {
    readonly environmentId: EnvironmentId;
    readonly messageId: string;
    readonly selection: ModelSelection;
  }): Promise<boolean> => {
    const key = messageKey(target);
    const entry = attempted.get(key) ?? { accounts: new Set<string>(), pending: 0 };
    if (entry.accounts.has(target.selection.instanceId)) return false;
    entry.accounts.add(target.selection.instanceId);
    entry.pending += 1;
    attempted.set(key, entry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        refresh({
          environmentId: target.environmentId,
          input: { instanceId: target.selection.instanceId, refreshModels: true },
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, QUEUED_MODEL_CATALOG_REFRESH_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // The next live admission read preserves the request with the current provider/catalog reason.
    } finally {
      clearTimeout(timer);
      entry.pending -= 1;
      prune();
    }
    return true;
  };
  return {
    discover,
    retainQueuedMessages(
      messages: ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly messageId: string;
      }>,
    ) {
      queuedKeys = new Set(messages.map(messageKey));
      prune();
    },
  };
}
