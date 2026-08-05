import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { createFollowUpEnvironmentAtoms } from "@t3tools/client-runtime/state/followups";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import type { EnvironmentPresentation } from "./environments";
import { environmentPresentations } from "./presentation";
import { serverConfigSynchronizedAtom } from "./server";
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
  readonly serverConfigSynchronized: boolean;
}

export type FollowUpPendingReason =
  | "catalog"
  | "connecting"
  | "server-config"
  | "reconnecting"
  | "offline";

export type FollowUpUnavailableReason = "disabled" | "connection-error" | "no-environments";

export type FollowUpAvailability =
  | { readonly status: "pending"; readonly reason: FollowUpPendingReason }
  | { readonly status: "available" }
  | { readonly status: "unavailable"; readonly reason: FollowUpUnavailableReason };

const AVAILABLE_FOLLOW_UPS = { status: "available" } as const;

function pendingFollowUps(reason: FollowUpPendingReason): FollowUpAvailability {
  return { status: "pending", reason };
}

function unavailableFollowUps(reason: FollowUpUnavailableReason): FollowUpAvailability {
  return { status: "unavailable", reason };
}

function resolveEnvironmentFollowUpAvailability(
  environment: FollowUpEnvironmentAvailabilityState,
): FollowUpAvailability {
  switch (environment.connection.phase) {
    case "available":
    case "connecting":
      return pendingFollowUps("connecting");
    case "reconnecting":
      return pendingFollowUps("reconnecting");
    case "offline":
      return pendingFollowUps("offline");
    case "connected": {
      if (!environment.serverConfigSynchronized || environment.serverConfig == null) {
        return pendingFollowUps("server-config");
      }
      return environment.serverConfig.settings.followUpsEnabled
        ? AVAILABLE_FOLLOW_UPS
        : unavailableFollowUps("disabled");
    }
    case "error":
      return unavailableFollowUps("connection-error");
  }
}

const PENDING_REASON_PRIORITY: Readonly<Record<FollowUpPendingReason, number>> = {
  catalog: 0,
  offline: 1,
  "server-config": 2,
  connecting: 3,
  reconnecting: 4,
};

export function resolveFollowUpAvailability(
  catalogReady: boolean,
  environments: ReadonlyArray<FollowUpEnvironmentAvailabilityState>,
): FollowUpAvailability {
  if (!catalogReady) return pendingFollowUps("catalog");
  if (environments.length === 0) return unavailableFollowUps("no-environments");

  let pendingReason: FollowUpPendingReason | null = null;
  let unavailableReason: FollowUpUnavailableReason = "disabled";
  for (const environment of environments) {
    const availability = resolveEnvironmentFollowUpAvailability(environment);
    if (availability.status === "available") return AVAILABLE_FOLLOW_UPS;
    if (availability.status === "pending") {
      if (
        pendingReason === null ||
        PENDING_REASON_PRIORITY[availability.reason] > PENDING_REASON_PRIORITY[pendingReason]
      ) {
        pendingReason = availability.reason;
      }
      continue;
    }
    if (availability.reason === "connection-error") unavailableReason = "connection-error";
  }
  return pendingReason === null
    ? unavailableFollowUps(unavailableReason)
    : pendingFollowUps(pendingReason);
}

export function isFollowUpEnvironmentAvailable(
  environment: FollowUpEnvironmentAvailabilityState,
): boolean {
  return resolveEnvironmentFollowUpAvailability(environment).status === "available";
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
    const available = isFollowUpEnvironmentAvailable({
      ...environment,
      serverConfigSynchronized: get(serverConfigSynchronizedAtom(environmentId)),
    });
    shellStates.push({
      available,
      shellBootstrapped:
        !available || Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot),
    });
  }
  return areAvailableFollowUpShellsBootstrapped(shellStates);
}).pipe(Atom.withLabel("available-follow-up-shells-bootstrapped"));
