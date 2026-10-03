import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { isElectron } from "../../env";
import { primarySessionStateAtom } from "../../environments/primary";
import { environmentSession } from "../../state/session";
import {
  type ProviderOperateAccess,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";

export interface ProviderOperateAccessTarget {
  readonly environmentId: EnvironmentId;
  readonly isPrimary: boolean;
}

const EMPTY_ACCESS: ReadonlyMap<EnvironmentId, ProviderOperateAccess> = new Map();

const PRIMARY_PREFIX = "p:";
const REMOTE_PREFIX = "r:";

/**
 * Operate access for several environments at once, resolved exactly as the
 * selected-environment provider settings resolve it: the desktop app owns its
 * primary outright, a browser checks its primary cookie session, and every
 * other environment reports the scopes of this client's credential. Keyed by
 * the target list so each environment's session query is shared with the
 * panel's own reader.
 */
const providerOperateAccessAtom = Atom.family((key: string) =>
  Atom.make((get): ReadonlyMap<EnvironmentId, ProviderOperateAccess> => {
    const access = new Map<EnvironmentId, ProviderOperateAccess>();
    for (const part of key.split("\n")) {
      if (part.startsWith(PRIMARY_PREFIX)) {
        const environmentId = EnvironmentId.make(part.slice(PRIMARY_PREFIX.length));
        if (isElectron) {
          access.set(environmentId, "granted");
          continue;
        }
        const result = get(primarySessionStateAtom);
        access.set(
          environmentId,
          resolvePrimaryOperateAccess({
            isPrimary: true,
            hasDesktopBridge: false,
            session: Option.getOrNull(AsyncResult.value(result)),
            isPending: result.waiting,
            hasError: result._tag === "Failure",
          }),
        );
        continue;
      }
      if (part.startsWith(REMOTE_PREFIX)) {
        const environmentId = EnvironmentId.make(part.slice(REMOTE_PREFIX.length));
        const result = get(environmentSession.sessionStateAtom(environmentId));
        access.set(
          environmentId,
          resolveRemoteOperateAccess({
            session: Option.getOrNull(AsyncResult.value(result)),
            isPending: result.waiting,
            hasError: result._tag === "Failure",
          }),
        );
      }
    }
    return access;
  }).pipe(Atom.withLabel(`web-provider-operate-access:${key}`)),
);

const EMPTY_ACCESS_ATOM = Atom.make(EMPTY_ACCESS).pipe(
  Atom.withLabel("web-provider-operate-access:empty"),
);

/**
 * Operate access for each target environment. Only the listed environments'
 * sessions are read, so callers should pass just the environments they might
 * act on.
 */
export function useProviderOperateAccessByEnvironment(
  targets: ReadonlyArray<ProviderOperateAccessTarget>,
): ReadonlyMap<EnvironmentId, ProviderOperateAccess> {
  const key = useMemo(
    () =>
      targets
        .map(
          (target) =>
            `${target.isPrimary ? PRIMARY_PREFIX : REMOTE_PREFIX}${String(target.environmentId)}`,
        )
        .toSorted()
        .join("\n"),
    [targets],
  );
  return useAtomValue(key.length === 0 ? EMPTY_ACCESS_ATOM : providerOperateAccessAtom(key));
}
