import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";

export interface ScopedDeviceHubAccess<Prepared extends object> {
  readonly prepared: Prepared;
  readonly generation: number;
  readonly access: DeviceHubAccess;
}

/** A waiting atom may carry the previous session's still-valid ticket. */
export function currentDeviceHubAccess<Prepared extends object>(input: {
  readonly prepared: Prepared | null;
  readonly connection: SupervisorConnectionState | null;
  readonly reading: ScopedDeviceHubAccess<Prepared> | null;
  readonly readingPending: boolean;
  readonly readingError: string | null;
  readonly hostId: string;
}): DeviceHubAccess | null {
  if (
    input.connection?.phase !== "connected" ||
    input.prepared === null ||
    input.readingPending ||
    input.readingError !== null ||
    input.reading === null ||
    input.reading.prepared !== input.prepared ||
    input.reading.generation !== input.connection.generation
  ) {
    return null;
  }
  return {
    ...input.reading.access,
    query: { ...input.reading.access.query, hostId: input.hostId },
  };
}

export function currentDeviceState<State>(input: {
  readonly connection: SupervisorConnectionState | null;
  readonly sessionOwner: object | null;
  readonly reading: {
    readonly state: State;
    readonly sessionOwner: object;
    readonly generation: number;
  } | null;
  readonly stateError: string | null;
}): State | null {
  return input.connection?.phase === "connected" &&
    input.sessionOwner !== null &&
    input.reading?.sessionOwner === input.sessionOwner &&
    input.reading.generation === input.connection.generation &&
    input.stateError === null
    ? input.reading.state
    : null;
}
