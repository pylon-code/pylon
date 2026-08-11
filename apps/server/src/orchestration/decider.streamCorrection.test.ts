import {
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-11T09:00:00.000Z";
const threadId = ThreadId.make("thread-stream-correction");
const turnId = TurnId.make("turn-active");

function readModel(active = true): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Stream correction",
        modelSelection: {
          instanceId: ProviderInstanceId.make("prime-work"),
          model: "prime/model",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: active
          ? {
              turnId,
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: MessageId.make("assistant-active"),
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
        session: active
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

it.layer(NodeServices.layer)("stream correction decider", (it) => {
  it.effect("replaces assistant text with a streaming compensating event", () =>
    Effect.gen(function* () {
      const command = {
        type: "thread.message.assistant.replace",
        commandId: CommandId.make("cmd-replace"),
        threadId,
        messageId: MessageId.make("assistant-active"),
        text: "corrected text",
        turnId,
        streaming: true,
        createdAt: NOW,
      } as const;

      expect(Schema.is(OrchestrationCommand)(command)).toBe(true);
      expect(Schema.is(ClientOrchestrationCommand)(command)).toBe(false);

      const result = yield* decideOrchestrationCommand({ command, readModel: readModel() });
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "thread.message-replaced",
        payload: {
          threadId,
          messageId: MessageId.make("assistant-active"),
          text: "corrected text",
          turnId,
          streaming: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
    }),
  );

  it.effect("resets only the matching active turn and preserves retry counters", () =>
    Effect.gen(function* () {
      const command = {
        type: "thread.turn.output.reset",
        commandId: CommandId.make("cmd-reset"),
        threadId,
        turnId,
        attempt: 2,
        max: 4,
        createdAt: NOW,
      } as const;

      expect(Schema.is(OrchestrationCommand)(command)).toBe(true);
      expect(Schema.is(ClientOrchestrationCommand)(command)).toBe(false);

      const result = yield* decideOrchestrationCommand({ command, readModel: readModel() });
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "thread.turn-output-reset",
        payload: {
          threadId,
          turnId,
          attempt: 2,
          max: 4,
        },
      });
    }),
  );

  it.effect("rejects reset when the thread does not exist", () =>
    Effect.gen(function* () {
      const model = readModel();
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.output.reset",
          commandId: CommandId.make("cmd-reset-missing-thread"),
          threadId,
          turnId,
          attempt: 1,
          max: 3,
          createdAt: NOW,
        },
        readModel: { ...model, threads: [] },
      }).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );

  it.effect("rejects reset for an inactive or different active turn", () =>
    Effect.gen(function* () {
      for (const [suffix, model, resetTurnId] of [
        ["inactive", readModel(false), turnId],
        ["different", readModel(), TurnId.make("turn-other")],
      ] as const) {
        const error = yield* decideOrchestrationCommand({
          command: {
            type: "thread.turn.output.reset",
            commandId: CommandId.make(`cmd-reset-${suffix}`),
            threadId,
            turnId: resetTurnId,
            attempt: 1,
            max: 3,
            createdAt: NOW,
          },
          readModel: model,
        }).pipe(Effect.flip);

        expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      }
    }),
  );
});
