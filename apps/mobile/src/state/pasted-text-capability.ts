import { useAtomValue } from "@effect/atom-react";
import { connectedInitialConfigForState, type ConnectedInitialConfig } from "@t3tools/client-runtime/state/session";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "./atom-registry";
import { environmentSession } from "./session";

const EMPTY_RESULT = Atom.make(AsyncResult.initial<never, never>(false));

export function connectedPastedTextAttachmentLease(environmentId: EnvironmentId): ConnectedInitialConfig | null {
  const stateResult = appAtomRegistry.get(environmentCatalog.stateAtom(environmentId));
  const configResult = appAtomRegistry.get(environmentSession.connectedInitialConfigAtom(environmentId));
  if (stateResult.waiting || configResult.waiting) return null;
  const state = Option.getOrElse(AsyncResult.value(stateResult), () => Option.none());
  const observed = Option.getOrElse(AsyncResult.value(configResult), () => Option.none());
  const config = connectedInitialConfigForState(Option.getOrNull(state), observed);
  return config?.environment.capabilities.pastedTextAttachments === true &&
    config.environment.capabilities.attachmentUploads === true &&
    config.environment.capabilities.fileAttachments !== undefined &&
    Option.isSome(observed)
    ? observed.value
    : null;
}

export function useConnectedPastedTextAttachmentCapability(environmentId: EnvironmentId | null): boolean {
  const stateResult = useAtomValue(environmentId === null ? EMPTY_RESULT : environmentCatalog.stateAtom(environmentId));
  const configResult = useAtomValue(environmentId === null ? EMPTY_RESULT : environmentSession.connectedInitialConfigAtom(environmentId));
  if (environmentId === null || stateResult.waiting || configResult.waiting) return false;
  const state = Option.getOrElse(AsyncResult.value(stateResult), () => Option.none());
  const observed = Option.getOrElse(AsyncResult.value(configResult), () => Option.none());
  const capabilities = connectedInitialConfigForState(Option.getOrNull(state), observed)?.environment.capabilities;
  return capabilities?.pastedTextAttachments === true &&
    capabilities.attachmentUploads === true && capabilities.fileAttachments !== undefined;
}
