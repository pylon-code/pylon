import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ProviderRuntimeEvent, SessionCompactionUpdatedPayload } from "./providerRuntime.ts";

const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const decodePayload = Schema.decodeUnknownSync(SessionCompactionUpdatedPayload);

describe("session.compaction.updated", () => {
  it("decodes only provider-neutral control state", () => {
    const decoded = decodeEvent({
      type: "session.compaction.updated",
      eventId: "evt-compaction",
      provider: "primeAgent",
      providerInstanceId: "prime-work",
      threadId: "thread-1",
      createdAt: "2026-08-09T00:00:00.000Z",
      payload: {
        available: true,
        status: "compacting",
        abortable: true,
        autoCompactionEnabled: true,
        autoCompactionWritable: true,
        manualCompactionSettable: false,
        autoCompactionScope: "session-and-provider-default",
        customInstructions: "private",
        summary: "private",
        details: { path: "/Users/private" },
        errorMessage: "private",
      },
    });
    expect(decoded.type).toBe("session.compaction.updated");
    if (decoded.type !== "session.compaction.updated") return;
    expect(decoded.payload).toEqual({
      available: true,
      status: "compacting",
      abortable: true,
      autoCompactionEnabled: true,
      autoCompactionWritable: true,
      manualCompactionSettable: false,
      autoCompactionScope: "session-and-provider-default",
    });
    expect(JSON.stringify(decoded)).not.toContain("private");
    expect(JSON.stringify(decoded)).not.toContain("/Users/");
  });

  it("rejects malformed control states", () => {
    expect(() =>
      decodePayload({
        available: true,
        status: "native-secret",
        abortable: false,
        autoCompactionEnabled: true,
        autoCompactionWritable: true,
        manualCompactionSettable: false,
      }),
    ).toThrow();
    expect(() =>
      decodePayload({
        available: true,
        status: "idle",
        abortable: false,
        autoCompactionWritable: "yes",
        manualCompactionSettable: true,
      }),
    ).toThrow();
  });
});
