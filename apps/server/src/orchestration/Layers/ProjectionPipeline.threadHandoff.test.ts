import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";

/**
 * The handoff link is only useful if it reaches a client, and clients read the
 * SQL projection rather than the in-memory read model. These cover the path
 * that actually serves them.
 */
const TestLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-handoff-test-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const NOW = "2026-08-05T00:00:00.000Z";
const PROJECT = ProjectId.make("project-1");
const PARENT = ThreadId.make("thread-work");
const CONTINUATION = ThreadId.make("thread-personal");

const projectCreated = {
  type: "project.created" as const,
  eventId: EventId.make("evt-project"),
  aggregateKind: "project" as const,
  aggregateId: PROJECT,
  occurredAt: NOW,
  commandId: CommandId.make("cmd-project"),
  causationEventId: null,
  correlationId: CommandId.make("cmd-project"),
  metadata: {},
  payload: {
    projectId: PROJECT,
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  },
};

const threadCreated = (input: {
  readonly threadId: ThreadId;
  readonly eventId: string;
  readonly instanceId: string;
  readonly continuedFromThreadId?: ThreadId;
}) => ({
  type: "thread.created" as const,
  eventId: EventId.make(input.eventId),
  aggregateKind: "thread" as const,
  aggregateId: input.threadId,
  occurredAt: NOW,
  commandId: CommandId.make(`cmd-${input.eventId}`),
  causationEventId: null,
  correlationId: CommandId.make(`cmd-${input.eventId}`),
  metadata: {},
  payload: {
    threadId: input.threadId,
    projectId: PROJECT,
    title: "Add retries to the client",
    modelSelection: {
      instanceId: ProviderInstanceId.make(input.instanceId),
      model: "claude-opus-5",
    },
    runtimeMode: "full-access" as const,
    branch: null,
    worktreePath: null,
    ...(input.continuedFromThreadId ? { continuedFromThreadId: input.continuedFromThreadId } : {}),
    createdAt: NOW,
    updatedAt: NOW,
  },
});

it.layer(TestLayer)("thread handoff projection", (it) => {
  it.effect("carries the handoff link into the thread detail clients read", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* eventStore.append(projectCreated);
      yield* eventStore.append(
        threadCreated({ threadId: PARENT, eventId: "evt-parent", instanceId: "claude_work" }),
      );
      yield* eventStore.append(
        threadCreated({
          threadId: CONTINUATION,
          eventId: "evt-continuation",
          instanceId: "claude_personal",
          continuedFromThreadId: PARENT,
        }),
      );
      yield* pipeline.bootstrap;

      const detail = yield* snapshotQuery.getThreadDetailById(CONTINUATION);
      assert.isTrue(Option.isSome(detail));
      assert.equal(Option.isSome(detail) ? detail.value.continuedFromThreadId : undefined, PARENT);

      // The handed-off thread stays open, and the only way it can point at
      // where its work went is for a client to find the shell pointing back
      // at it — so the link has to survive onto the shell too.
      const shells = yield* snapshotQuery.getShellSnapshot();
      const continuation = shells.threads.find((thread) => thread.id === CONTINUATION);
      const parent = shells.threads.find((thread) => thread.id === PARENT);

      assert.equal(continuation?.continuedFromThreadId, PARENT);
      // An ordinary thread must keep reading as one that started its own work.
      assert.equal(parent?.continuedFromThreadId, null);
    }),
  );
});
