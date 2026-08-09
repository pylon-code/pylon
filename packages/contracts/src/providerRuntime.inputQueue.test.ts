import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  PROVIDER_SESSION_INPUT_QUEUE_MAX_COUNT,
  ProviderRuntimeEvent,
  SessionInputQueueUpdatedPayload,
} from "./providerRuntime.ts";

const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const decodePayload = Schema.decodeUnknownSync(SessionInputQueueUpdatedPayload);

describe("session.input-queue.updated", () => {
  it("decodes counts while stripping provider-native queue contents", () => {
    const decoded = decodeEvent({
      type: "session.input-queue.updated",
      eventId: "queue-event-1",
      provider: "primeAgent",
      providerInstanceId: "prime-work",
      createdAt: "2026-08-09T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        steeringCount: 1,
        followUpCount: 2,
        steeringMode: "all-at-once",
        followUpMode: "one-at-a-time",
        steering: ["private steering text"],
        followUps: ["private follow-up text"],
      },
    });
    assert.equal(decoded.type, "session.input-queue.updated");
    if (decoded.type !== "session.input-queue.updated") return;
    assert.deepStrictEqual(decoded.payload, {
      steeringCount: 1,
      followUpCount: 2,
      steeringMode: "all-at-once",
      followUpMode: "one-at-a-time",
    });
  });

  it("rejects oversized counts and raw native envelopes", () => {
    assert.throws(() =>
      decodePayload({
        steeringCount: PROVIDER_SESSION_INPUT_QUEUE_MAX_COUNT + 1,
        followUpCount: 0,
      }),
    );
    assert.throws(() =>
      decodePayload({
        steeringCount: 0,
        followUpCount: 0,
        steeringMode: "private-native-mode",
      }),
    );
    assert.deepStrictEqual(decodePayload({ steeringCount: 0, followUpCount: 0 }), {
      steeringCount: 0,
      followUpCount: 0,
    });
    assert.throws(() =>
      decodeEvent({
        type: "session.input-queue.updated",
        eventId: "queue-event-unsafe",
        provider: "primeAgent",
        createdAt: "2026-08-09T00:00:00.000Z",
        threadId: "thread-1",
        raw: { followUps: ["secret"] },
        payload: { steeringCount: 0, followUpCount: 1 },
      }),
    );
  });
});
