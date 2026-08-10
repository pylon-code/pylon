import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("session.harness-refinement.updated", () => {
  it("retains only the session-incarnation lifecycle status", () => {
    const decoded = decodeEvent({
      type: "session.harness-refinement.updated",
      eventId: "evt-refinement",
      provider: "primeAgent",
      providerInstanceId: "prime-work",
      threadId: "thread-1",
      createdAt: "2026-08-09T00:00:00.000Z",
      payload: {
        sessionStartedAt: "2026-08-09T00:00:00.000Z",
        status: "outcome-unknown",
        nativeId: "private-id",
        summary: "private summary",
        edits: ["private edit"],
      },
    });
    expect(decoded).toMatchObject({
      type: "session.harness-refinement.updated",
      payload: {
        sessionStartedAt: "2026-08-09T00:00:00.000Z",
        status: "outcome-unknown",
      },
    });
    expect(JSON.stringify(decoded)).not.toMatch(/private|summary|edits|nativeId/);
  });
});
