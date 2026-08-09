import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  RUNTIME_RESOURCE_CATALOG_MAX_ITEMS,
  ProviderRuntimeEvent,
  SessionResourcesUpdatedPayload,
} from "./providerRuntime.ts";

const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const decodePayload = Schema.decodeUnknownSync(SessionResourcesUpdatedPayload);

describe("session.resources.updated", () => {
  it("decodes a bounded provider-neutral safe inventory", () => {
    const decoded = decodeEvent({
      type: "session.resources.updated",
      eventId: "resource-event-1",
      provider: "primeAgent",
      providerInstanceId: "prime-work",
      createdAt: "2026-08-09T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        available: true,
        skills: [
          {
            name: " review ",
            description: "Review a change",
            scope: "project",
            path: "/private/skill",
            nativeId: "secret-skill-id",
          },
        ],
        prompts: [
          {
            name: "release",
            argumentHint: "<version>",
            scope: "user",
            filePath: "/private/prompt",
          },
        ],
        commands: [
          {
            name: "skill:review",
            source: "skill",
            registeredName: "private-registration",
            raw: { secret: true },
          },
        ],
      },
    });

    assert.equal(decoded.type, "session.resources.updated");
    if (decoded.type !== "session.resources.updated") return;
    assert.deepStrictEqual(decoded.payload, {
      available: true,
      skills: [{ name: "review", description: "Review a change", scope: "project" }],
      prompts: [{ name: "release", argumentHint: "<version>", scope: "user" }],
      commands: [{ name: "skill:review", source: "skill" }],
    });
  });

  it("rejects oversized catalogs and diagnostic/native envelopes", () => {
    const oversized = Array.from(
      { length: RUNTIME_RESOURCE_CATALOG_MAX_ITEMS + 1 },
      (_, index) => ({ name: `skill-${index}` }),
    );
    assert.throws(() =>
      decodePayload({ available: true, skills: oversized, prompts: [], commands: [] }),
    );
    assert.throws(() =>
      decodeEvent({
        type: "session.resources.updated",
        eventId: "resource-event-unsafe",
        provider: "primeAgent",
        createdAt: "2026-08-09T00:00:00.000Z",
        threadId: "thread-1",
        raw: { source: "prime-agent.daemon", payload: { secret: true } },
        payload: { available: false, skills: [], prompts: [], commands: [] },
      }),
    );
  });
});
