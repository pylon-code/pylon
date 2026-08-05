import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { createFollowUpEnvironmentAtoms } from "@t3tools/client-runtime/state/followups";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import type { EnvironmentPresentation } from "./environments";
import { environmentPresentations } from "./presentation";
import { environmentShell } from "./shell";

export const followUpEnvironment = createFollowUpEnvironmentAtoms(connectionAtomRuntime);

export function isFollowUpBetaEnabled(settings: Pick<ServerSettings, "followUpsEnabled">): boolean {
  return settings.followUpsEnabled;
}

interface FollowUpEnvironmentAvailabilityState {
  readonly connection: Pick<EnvironmentPresentation["connection"], "phase">;
  readonly serverConfig:
    | { readonly settings: Pick<ServerSettings, "followUpsEnabled"> }
    | null
    | undefined;
}

export function isFollowUpEnvironmentAvailable(
  environment: FollowUpEnvironmentAvailabilityState,
): boolean {
  return (
    environment.connection.phase === "connected" &&
    environment.serverConfig?.settings.followUpsEnabled === true
  );
}

type FollowUpEnvironmentAvailability = FollowUpEnvironmentAvailabilityState & {
  readonly environmentId: EnvironmentId;
};

export function availableFollowUpEnvironmentIds(
  environments: ReadonlyArray<FollowUpEnvironmentAvailability>,
): ReadonlySet<EnvironmentId> {
  return new Set(
    environments
      .filter(isFollowUpEnvironmentAvailable)
      .map((environment) => environment.environmentId),
  );
}

export function hasAvailableFollowUpEnvironment(
  environments: ReadonlyArray<FollowUpEnvironmentAvailabilityState>,
): boolean {
  return environments.some(isFollowUpEnvironmentAvailable);
}

export const availableFollowUpShellsBootstrappedAtom = Atom.make((get) => {
  for (const [environmentId, environment] of get(environmentPresentations.presentationsAtom)) {
    if (!isFollowUpEnvironmentAvailable(environment)) continue;
    if (Option.isNone(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      return false;
    }
  }
  return true;
}).pipe(Atom.withLabel("available-follow-up-shells-bootstrapped"));
