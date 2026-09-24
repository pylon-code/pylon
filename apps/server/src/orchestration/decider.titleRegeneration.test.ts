import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Manual title",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: UPDATED_AT,
};

it.layer(NodeServices.layer)("title regeneration decider", (it) => {
  const generatedCompletion = (model: OrchestrationReadModel, expectedVersion: CommandId) =>
    decideOrchestrationCommand({
      command: {
        type: "thread.title.generate.complete",
        commandId: CommandId.make("cmd-generation-complete"),
        threadId: ThreadId.make("thread-1"),
        expectedTitle: "Manual title",
        expectedVersion,
        title: "Generated title",
      },
      readModel: model,
    });

  it.effect("keeps a manual rename even when its text returns to the original title", () =>
    Effect.gen(function* () {
      const thread = readModel.threads[0]!;
      const renamed = {
        ...readModel,
        threads: [
          {
            ...thread,
            titleState: { source: "manual" as const, version: CommandId.make("cmd-rename-again") },
          },
        ],
      };
      const result = yield* generatedCompletion(renamed, CommandId.make("cmd-original-title"));
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.title).toBeUndefined();
        expect(event.payload.titleState).toBeUndefined();
        expect(event.payload.updatedAt).toBe(UPDATED_AT);
      }
    }),
  );

  it.effect("accepts only the current generated version and an active thread", () =>
    Effect.gen(function* () {
      const thread = readModel.threads[0]!;
      const version = CommandId.make("cmd-earlier-generated-title");
      const current = {
        ...readModel,
        threads: [{ ...thread, titleState: { source: "generated" as const, version } }],
      };
      const accepted = yield* generatedCompletion(current, version);
      const acceptedEvent = Array.isArray(accepted) ? accepted[0] : accepted;
      expect(acceptedEvent.type).toBe("thread.meta-updated");
      if (acceptedEvent.type === "thread.meta-updated") {
        expect(acceptedEvent.payload.title).toBe("Generated title");
        expect(acceptedEvent.payload.titleState).toEqual({
          source: "generated",
          version: CommandId.make("cmd-generation-complete"),
        });
      }
      for (const changed of [
        { titleState: { source: "generated" as const, version: CommandId.make("cmd-newer") } },
        { archivedAt: UPDATED_AT },
        { deletedAt: UPDATED_AT },
        { titleRegeneration: { requestId: CommandId.make("cmd-regen"), startedAt: UPDATED_AT } },
      ]) {
        const result = yield* generatedCompletion(
          { ...readModel, threads: [{ ...thread, titleState: current.threads[0]!.titleState, ...changed }] },
          version,
        );
        const event = Array.isArray(result) ? result[0] : result;
        if (event.type === "thread.meta-updated") {
          expect(event.payload.title).toBeUndefined();
          expect(event.payload.updatedAt).toBe(UPDATED_AT);
        }
      }
    }),
  );

  it.effect("invalidates a pending title when a thread is archived and later reopened", () =>
    Effect.gen(function* () {
      const version = CommandId.make("cmd-title-before-archive");
      const thread = {
        ...readModel.threads[0]!,
        titleState: { source: "generated" as const, version },
      };
      const archive = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive-during-title"),
          threadId: thread.id,
        },
        readModel: { ...readModel, threads: [thread] },
      });
      const archiveEvent = Array.isArray(archive) ? archive[0] : archive;
      expect(archiveEvent.type).toBe("thread.archived");
      if (archiveEvent.type !== "thread.archived") return;
      expect(archiveEvent.payload.titleState).toEqual({
        source: "generated",
        version: CommandId.make("cmd-archive-during-title"),
      });
      const reopened = {
        ...readModel,
        threads: [{ ...thread, titleState: archiveEvent.payload.titleState, archivedAt: null }],
      };
      const result = yield* generatedCompletion(reopened, version);
      const event = Array.isArray(result) ? result[0] : result;
      if (event.type === "thread.meta-updated") expect(event.payload.title).toBeUndefined();
    }),
  );

  it.effect("preserves updatedAt for a stale completion", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.title.regeneration.complete",
          commandId: CommandId.make("cmd-regeneration-complete"),
          threadId: ThreadId.make("thread-1"),
          requestId: CommandId.make("cmd-old-regeneration-request"),
          title: "Generated title",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload).toEqual({
          threadId: ThreadId.make("thread-1"),
          updatedAt: UPDATED_AT,
        });
      }
    }),
  );
});
