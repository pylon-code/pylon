import {
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  SessionInteractionRequestId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

describe("runtimeEventToActivities approval details", () => {
  it("preserves complete multiline command details", () => {
    const detail = `bun run release -- ${"long-argument ".repeat(20)}\nsecond line`;
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-request-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("approval-1"),
      payload: {
        requestType: "command_execution_approval",
        detail,
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);

    expect(activity?.kind).toBe("approval.requested");
    expect((activity?.payload as Record<string, unknown> | undefined)?.detail).toBe(detail);
  });

  it("maps interactions and presentation without retaining native payloads", () => {
    const requested = {
      type: "interaction.requested",
      eventId: EventId.make("evt-interaction-requested"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: SessionInteractionRequestId.make("interaction-1"),
      payload: {
        request: { kind: "confirm", title: "Continue?", message: "Proceed" },
      },
    } satisfies ProviderRuntimeEvent;
    const [requestedActivity] = runtimeEventToActivities(requested);
    expect(requestedActivity).toMatchObject({
      kind: "interaction.requested",
      payload: { requestId: "interaction-1", request: requested.payload.request },
    });

    const presentation = {
      type: "session-presentation.updated",
      eventId: EventId.make("evt-session-status"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-18T00:00:01.000Z",
      threadId: ThreadId.make("thread-1"),
      payload: {
        presentation: { kind: "status", key: "build", text: "Compiling" },
      },
    } satisfies ProviderRuntimeEvent;
    const [presentationActivity] = runtimeEventToActivities(presentation);
    expect(presentationActivity).toMatchObject({
      kind: "session-presentation.updated",
      payload: { presentation: presentation.payload.presentation },
    });
    expect(presentationActivity?.payload).not.toHaveProperty("raw");
    expect(presentationActivity?.payload).not.toHaveProperty("native");
  });
});
