import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ClientOrchestrationCommand,
  EventId,
  OrchestrationSessionActivity,
  OrchestrationThreadActivity,
  SessionInteractionRequestId,
  ThreadId,
  decodeOrchestrationSessionActivity,
} from "./index.ts";

const decodeCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);
const decodeSessionActivity = Schema.decodeUnknownSync(OrchestrationSessionActivity);
const decodeThreadActivity = Schema.decodeUnknownSync(OrchestrationThreadActivity);

const requestedActivity = {
  id: EventId.make("evt-interaction-requested"),
  tone: "info" as const,
  kind: "interaction.requested" as const,
  summary: "Choose",
  payload: {
    requestId: SessionInteractionRequestId.make("interaction-1"),
    request: {
      kind: "select" as const,
      title: "Choose",
      options: ["A", "B"],
    },
  },
  turnId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

it("decodes thread.interaction.respond commands", () => {
  const decoded = decodeCommand({
    type: "thread.interaction.respond",
    commandId: "cmd-interaction-1",
    threadId: ThreadId.make("thread-1"),
    requestId: "interaction-1",
    response: { kind: "selected", value: "A" },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(decoded.type, "thread.interaction.respond");
});

it("strictly decodes bounded interaction activities", () => {
  const decoded = decodeSessionActivity(requestedActivity);
  assert.equal(decoded.kind, "interaction.requested");
  assert.equal(Option.isSome(decodeOrchestrationSessionActivity(requestedActivity)), true);

  assert.throws(() =>
    decodeSessionActivity({
      ...requestedActivity,
      payload: {
        ...requestedActivity.payload,
        requestId: "x".repeat(129),
      },
    }),
  );
});

it("keeps legacy generic thread activities decodable", () => {
  const decoded = decodeThreadActivity({
    ...requestedActivity,
    kind: "legacy.provider.activity",
    payload: { nativeShapeFromOldServer: true },
  });
  assert.equal(decoded.kind, "legacy.provider.activity");
});
