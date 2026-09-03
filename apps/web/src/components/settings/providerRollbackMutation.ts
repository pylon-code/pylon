import { isRollbackActive } from "@t3tools/client-runtime/rollback";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

export interface RollbackProviderOwnershipShell {
  readonly environmentId: EnvironmentId;
  readonly rollbackStatus?: Parameters<typeof isRollbackActive>[0];
  readonly modelSelection: { readonly instanceId: ProviderInstanceId };
  readonly session?: { readonly providerInstanceId?: ProviderInstanceId | undefined } | null;
}

export function rollbackBusyProviderInstanceIds(
  threadShells: ReadonlyArray<RollbackProviderOwnershipShell>,
  environmentId: EnvironmentId,
): ReadonlySet<ProviderInstanceId> {
  return new Set(
    threadShells.flatMap((thread) => {
      if (thread.environmentId !== environmentId || !isRollbackActive(thread.rollbackStatus)) {
        return [];
      }
      return [thread.session?.providerInstanceId ?? thread.modelSelection.instanceId];
    }),
  );
}
