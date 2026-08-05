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

export type FollowUpAvailability = "pending" | "available" | "unavailable";

function resolveEnvironmentFollowUpAvailability(
  environment: FollowUpEnvironmentAvailabilityState,
): FollowUpAvailability {
  if (
    environment.connection.phase === "connected" &&
    environment.serverConfig?.settings.followUpsEnabled === true
  ) {
    return "available";
  }
  switch (environment.connection.phase) {
    case "available":
    case "connecting":
    case "reconnecting":
      return "pending";
    case "connected":
      return environment.serverConfig === null || environment.serverConfig === undefined
        ? "pending"
        : "unavailable";
    case "offline":
    case "error":
      return "unavailable";
  }
}

export function resolveFollowUpAvailability(
  catalogReady: boolean,
  environments: ReadonlyArray<FollowUpEnvironmentAvailabilityState>,
): FollowUpAvailability {
  if (!catalogReady) return "pending";
  let pending = false;
  for (const environment of environments) {
    const availability = resolveEnvironmentFollowUpAvailability(environment);
    if (availability === "available") return "available";
    if (availability === "pending") pending = true;
  }
  return pending ? "pending" : "unavailable";
}

export function isFollowUpEnvironmentAvailable(
  environment: FollowUpEnvironmentAvailabilityState,
): boolean {
  return resolveEnvironmentFollowUpAvailability(environment) === "available";
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

export function areAvailableFollowUpShellsBootstrapped(
  environments: ReadonlyArray<{
    readonly available: boolean;
    readonly shellBootstrapped: boolean;
  }>,
): boolean {
  return environments.every(
    (environment) => !environment.available || environment.shellBootstrapped,
  );
}

export const availableFollowUpShellsBootstrappedAtom = Atom.make((get) => {
  const shellStates: Array<{ available: boolean; shellBootstrapped: boolean }> = [];
  for (const [environmentId, environment] of get(environmentPresentations.presentationsAtom)) {
    const available = isFollowUpEnvironmentAvailable(environment);
    shellStates.push({
      available,
      shellBootstrapped:
        !available || Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot),
    });
  }
  return areAvailableFollowUpShellsBootstrapped(shellStates);
}).pipe(Atom.withLabel("available-follow-up-shells-bootstrapped"));
