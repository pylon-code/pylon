import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-09T00:00:00.000Z";
const threadId = ThreadId.make("thread-queue");
const turnId = TurnId.make("turn-active");

function readModel(running: boolean): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Queue thread",
        modelSelection: { instanceId: ProviderInstanceId.make("prime-work"), model: "prime/model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: running
          ? {
              turnId,
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            }
          : null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: running
          ? {
              threadId,
              status: "running",
              providerName: "primeAgent",
              providerInstanceId: ProviderInstanceId.make("prime-work"),
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: NOW,
            }
          : null,
      },
    ],
  };
}

it.layer(NodeServices.layer)("input queue follow-up decider", (it) => {
  it.effect("persists the user message on the active turn before requesting admission", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.input-queue.follow-up",
          commandId: CommandId.make("cmd-follow-up"),
          threadId,
          message: {
            messageId: MessageId.make("message-follow-up"),
            role: "user",
            text: "continue with tests",
            attachments: [],
          },
          createdAt: NOW,
        },
        readModel: readModel(true),
      });
      expect(Array.isArray(result)).toBe(true);
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.input-queue-follow-up-requested",
      ]);
      expect(events[0]).toMatchObject({ payload: { turnId } });
      expect(events[1]).toMatchObject({ causationEventId: events[0]?.eventId });
    }),
  );

  it.effect("wakes a snoozed running thread before admitting follow-up intent", () =>
    Effect.gen(function* () {
      const model = readModel(true);
      const thread = model.threads[0]!;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.input-queue.follow-up",
          commandId: CommandId.make("cmd-follow-up-wake"),
          threadId,
          message: {
            messageId: MessageId.make("message-follow-up-wake"),
            role: "user",
            text: "wake and continue",
            attachments: [],
          },
          createdAt: NOW,
        },
        readModel: {
          ...model,
          threads: [{ ...thread, snoozedUntil: "2026-08-10T00:00:00.000Z" }],
        },
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.unsnoozed",
        "thread.message-sent",
        "thread.input-queue-follow-up-requested",
      ]);
    }),
  );

  it.effect("rejects reusing a durable user message id for follow-up admission", () =>
    Effect.gen(function* () {
      const model = readModel(true);
      const thread = model.threads[0]!;
      const messageId = MessageId.make("message-follow-up-duplicate");
      const existing = {
        id: messageId,
        role: "user",
        text: "first intent",
        turnId,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      } as OrchestrationThread["messages"][number];
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.input-queue.follow-up",
          commandId: CommandId.make("cmd-follow-up-duplicate"),
          threadId,
          message: {
            messageId,
            role: "user",
            text: "second intent",
            attachments: [],
          },
          createdAt: NOW,
        },
        readModel: { ...model, threads: [{ ...thread, messages: [existing] }] },
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );

  it.effect("rejects follow-up intent without a running Pylon turn", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.input-queue.follow-up",
          commandId: CommandId.make("cmd-follow-up-idle"),
          threadId,
          message: {
            messageId: MessageId.make("message-follow-up-idle"),
            role: "user",
            text: "too late",
            attachments: [],
          },
          createdAt: NOW,
        },
        readModel: readModel(false),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
