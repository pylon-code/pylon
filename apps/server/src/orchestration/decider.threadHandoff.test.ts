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

import type { OrchestrationEvent } from "@t3tools/contracts";

type PlannedResult = Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>;

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

/**
 * The decider plans events without a sequence; the store assigns one before
 * projection. Stamping one here is what lets a single test follow a command
 * all the way to the projected thread.
 */
const sequenced = (planned: PlannedResult) => {
  const event = Array.isArray(planned) ? planned[0] : planned;
  return { ...event, sequence: 1 } as OrchestrationEvent;
};

const NOW = "2026-08-05T00:00:00.000Z";
const PARENT = ThreadId.make("thread-work");
const CONTINUATION = ThreadId.make("thread-personal");
const PROJECT = ProjectId.make("project-1");

const emptyReadModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  updatedAt: NOW,
  projects: [
    {
      id: PROJECT,
      title: "Project",
      workspaceRoot: "/tmp/project",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
      defaultModelSelection: null,
      scripts: [],
      repositoryIdentity: null,
    } as unknown as OrchestrationReadModel["projects"][number],
  ],
  threads: [],
};

const createContinuation = (continuedFromThreadId: ThreadId | null | undefined) => ({
  type: "thread.create" as const,
  commandId: CommandId.make("cmd-continue"),
  threadId: CONTINUATION,
  projectId: PROJECT,
  title: "Continued work",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claude_personal"),
    model: "claude-opus-5",
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  ...(continuedFromThreadId !== undefined ? { continuedFromThreadId } : {}),
  createdAt: NOW,
});

it.effect(
  "carries the handoff link from command through event to the projected thread",
  () =>
    Effect.gen(function* () {
      const event = sequenced(
        yield* decideOrchestrationCommand({
          readModel: emptyReadModel,
          command: createContinuation(PARENT),
        }),
      );

      expect(event.type).toBe("thread.created");
      expect((event.payload as { continuedFromThreadId?: string }).continuedFromThreadId).toBe(
        PARENT,
      );

      // The link is only real once it survives projection — that is what the
      // UI reads to show the seam.
      const projected = yield* projectEvent(emptyReadModel, event);
      const thread = projected.threads.find((candidate) => candidate.id === CONTINUATION);

      expect(thread?.continuedFromThreadId).toBe(PARENT);
    }).pipe(Effect.provide(NodeServices.layer)),
);

// The overwhelming majority of threads are not continuations, and their
// payloads must stay exactly as they were before handoff existed.
it.effect("leaves an ordinary thread with no handoff link", () =>
  Effect.gen(function* () {
    const event = sequenced(
      yield* decideOrchestrationCommand({
        readModel: emptyReadModel,
        command: createContinuation(undefined),
      }),
    );

    expect(
      (event.payload as { continuedFromThreadId?: unknown }).continuedFromThreadId,
    ).toBeUndefined();

    const projected = yield* projectEvent(emptyReadModel, event);
    const thread = projected.threads.find((candidate) => candidate.id === CONTINUATION);

    expect(thread?.continuedFromThreadId).toBeNull();
  }).pipe(Effect.provide(NodeServices.layer)),
);
