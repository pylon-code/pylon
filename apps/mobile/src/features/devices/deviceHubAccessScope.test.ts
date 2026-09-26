import { describe, expect, it } from "vite-plus/test";
import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";

import { currentDeviceHubAccess, currentDeviceState } from "./deviceHubAccessScope";

const connected = (generation: number): SupervisorConnectionState => ({
  desired: true,
  network: "online",
  phase: "connected",
  stage: null,
  attempt: 1,
  generation,
  lastFailure: null,
  retryAt: null,
});

const access = {
  httpBase: "https://environment.test/api/device-hub",
  wsBase: "wss://environment.test/api/device-hub",
  credentials: false,
  query: { wsTicket: "fixture-ticket" },
};

describe("mobile device access scope", () => {
  it("hides A's pending ticket and preview through a B reconnect until B's receipt arrives", () => {
    const preparedA = { session: "A" };
    const preparedB = { session: "B" };
    const readingA = { prepared: preparedA, generation: 1, access };
    const view = (input: {
      prepared: typeof preparedA;
      generation: number;
      reading: typeof readingA;
      pending?: boolean;
    }) =>
      currentDeviceHubAccess({
        prepared: input.prepared,
        connection: connected(input.generation),
        connectionPending: false,
        reading: input.reading,
        readingPending: input.pending ?? false,
        readingError: null,
        hostId: "selected-host",
      });

    expect(view({ prepared: preparedA, generation: 1, reading: readingA })).toEqual({
      ...access,
      query: { wsTicket: "fixture-ticket", hostId: "selected-host" },
    });
    expect(
      view({ prepared: preparedA, generation: 1, reading: readingA, pending: true }),
    ).toBeNull();
    expect(view({ prepared: preparedB, generation: 1, reading: readingA })).toBeNull();
    expect(view({ prepared: preparedB, generation: 2, reading: readingA })).toBeNull();
    const readingB = { prepared: preparedB, generation: 2, access };
    // The supervisor may already be connected to B while the separate
    // prepared-connection stream still exposes A's prior value.
    expect(view({ prepared: preparedA, generation: 2, reading: readingB })).toBeNull();
    expect(
      view({
        prepared: preparedB,
        generation: 2,
        reading: readingB,
      }),
    ).not.toBeNull();

    const oldPreview = { sessions: ["A"] };
    expect(
      currentDeviceState({
        connection: connected(2),
        connectionPending: false,
        state: oldPreview,
        statePending: true,
        stateError: null,
      }),
    ).toBeNull();
    expect(
      currentDeviceState({
        connection: { ...connected(2), phase: "connecting" },
        connectionPending: false,
        state: oldPreview,
        statePending: false,
        stateError: null,
      }),
    ).toBeNull();
  });
});
