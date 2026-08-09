import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  OrchestrationSessionActivity,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const decodeSessionActivity = Schema.decodeUnknownSync(OrchestrationSessionActivity);
const provider = ProviderDriverKind.make("primeAgent");
const providerInstanceId = ProviderInstanceId.make("prime-work");
const threadId = ThreadId.make("thread-1");

function resourceEvent(input: {
  readonly eventId: string;
  readonly available: boolean;
}): Extract<ProviderRuntimeEvent, { readonly type: "session.resources.updated" }> {
  return {
    type: "session.resources.updated",
    eventId: EventId.make(input.eventId),
    provider,
    providerInstanceId,
    threadId,
    createdAt: "2026-08-09T00:00:00.000Z",
    payload: {
      available: input.available,
      skills: [{ name: "review", description: "Review a change", scope: "project" }],
      prompts: [{ name: "release", argumentHint: "<version>", scope: "user" }],
      commands: [{ name: "skill:review", source: "skill" }],
    },
  };
}

describe("session resource activity projection", () => {
  it("uses one provider-and-thread-scoped replacement identity", () => {
    const [first] = runtimeEventToActivities(
      resourceEvent({ eventId: "resources-1", available: true }),
    );
    const [replacement] = runtimeEventToActivities(
      resourceEvent({ eventId: "resources-2", available: false }),
    );

    assert.equal(first?.id, "session-resources:prime-work:thread-1");
    assert.equal(replacement?.id, first?.id);
    assert.equal(replacement?.kind, "session.resources.updated");
    assert.equal(replacement?.turnId, null);
    assert.deepStrictEqual(replacement?.payload, {
      provider: "primeAgent",
      providerInstanceId: "prime-work",
      available: false,
      skills: [{ name: "review", description: "Review a change", scope: "project" }],
      prompts: [{ name: "release", argumentHint: "<version>", scope: "user" }],
      commands: [{ name: "skill:review", source: "skill" }],
    });
    assert.equal(decodeSessionActivity(replacement).kind, "session.resources.updated");
  });

  it("copies only the typed safe resource fields into client activity payload", () => {
    const event = resourceEvent({ eventId: "resources-unsafe", available: true });
    const unsafePayload = {
      ...event.payload,
      skills: [
        {
          ...event.payload.skills[0],
          path: "/private/skill",
          nativeId: "native-skill-secret",
          sourceInfo: { raw: true },
        },
      ],
      prompts: [{ ...event.payload.prompts[0], filePath: "/private/prompt" }],
      commands: [
        {
          ...event.payload.commands[0],
          registeredName: "native-registration-secret",
          raw: { secret: true },
        },
      ],
    };
    const [activity] = runtimeEventToActivities({
      ...event,
      payload: unsafePayload,
    } as ProviderRuntimeEvent);
    const encoded = JSON.stringify(activity?.payload);

    assert.equal(encoded.includes("/private"), false);
    assert.equal(encoded.includes("native-"), false);
    assert.equal(encoded.includes("sourceInfo"), false);
    assert.equal(encoded.includes("raw"), false);
  });
});

describe("session agent depth activity projection", () => {
  it("uses one provider-and-thread-scoped replacement identity", () => {
    const makeEvent = (
      eventId: string,
      maxDepth: number,
    ): Extract<ProviderRuntimeEvent, { readonly type: "session.agent-depth.updated" }> => ({
      type: "session.agent-depth.updated",
      eventId: EventId.make(eventId),
      provider,
      providerInstanceId,
      threadId,
      createdAt: "2026-08-09T00:00:00.000Z",
      payload: {
        maxDepth,
        source: "session",
        writable: true,
        settable: true,
        maxSettableDepth: 4,
      },
    });
    const [first] = runtimeEventToActivities(makeEvent("depth-1", 2));
    const [replacement] = runtimeEventToActivities(makeEvent("depth-2", 3));

    assert.equal(first?.id, "session-agent-depth:prime-work:thread-1");
    assert.equal(replacement?.id, first?.id);
    assert.equal(replacement?.kind, "session.agent-depth.updated");
    assert.equal(replacement?.turnId, null);
    assert.deepStrictEqual(replacement?.payload, {
      provider: "primeAgent",
      providerInstanceId: "prime-work",
      maxDepth: 3,
      source: "session",
      writable: true,
      settable: true,
      maxSettableDepth: 4,
    });
    assert.equal(decodeSessionActivity(replacement).kind, "session.agent-depth.updated");
  });
});

describe("session goal activity projection", () => {
  it("uses one provider-and-thread-scoped privacy-safe replacement identity", () => {
    const makeEvent = (
      eventId: string,
      status: "active" | "complete",
    ): Extract<ProviderRuntimeEvent, { readonly type: "session.goal.updated" }> => ({
      type: "session.goal.updated",
      eventId: EventId.make(eventId),
      provider,
      providerInstanceId,
      threadId,
      createdAt: "2026-08-09T00:00:00.000Z",
      payload: {
        available: true,
        active: status === "active",
        status,
        objective: "Finish the integration",
        tokenBudget: 5_000,
        tokensUsed: status === "active" ? 1_000 : 4_500,
        timeUsedSeconds: 120,
        continuationsUsed: 2,
      },
    });
    const [first] = runtimeEventToActivities(makeEvent("goal-1", "active"));
    const [replacement] = runtimeEventToActivities(makeEvent("goal-2", "complete"));

    assert.equal(first?.id, "session-goal:prime-work:thread-1");
    assert.equal(replacement?.id, first?.id);
    assert.equal(replacement?.kind, "session.goal.updated");
    assert.equal(replacement?.turnId, null);
    assert.deepStrictEqual(replacement?.payload, {
      provider: "primeAgent",
      providerInstanceId: "prime-work",
      available: true,
      active: false,
      status: "complete",
      objective: "Finish the integration",
      tokenBudget: 5_000,
      tokensUsed: 4_500,
      timeUsedSeconds: 120,
      continuationsUsed: 2,
    });
    assert.equal(decodeSessionActivity(replacement).kind, "session.goal.updated");
  });

  it("copies only allowlisted provider-neutral goal fields", () => {
    const event = {
      type: "session.goal.updated",
      eventId: EventId.make("goal-private"),
      provider,
      providerInstanceId,
      threadId,
      createdAt: "2026-08-09T00:00:00.000Z",
      payload: {
        available: true,
        active: true,
        status: "active",
        objective: "Safe objective",
        tokenBudget: 500,
        tokensUsed: 100,
        timeUsedSeconds: 20,
        continuationsUsed: 1,
        goalId: "native-goal-secret",
        createdAt: 123,
        updatedAt: 456,
        lastReason: "private reason",
        lastError: "private error",
      },
    } as unknown as ProviderRuntimeEvent;
    const [activity] = runtimeEventToActivities(event);
    const encoded = JSON.stringify(activity?.payload);

    assert.equal(encoded.includes("native-goal-secret"), false);
    assert.equal(encoded.includes("private reason"), false);
    assert.equal(encoded.includes("private error"), false);
    assert.equal(encoded.includes("createdAt"), false);
    assert.equal(encoded.includes("updatedAt"), false);
  });
});
