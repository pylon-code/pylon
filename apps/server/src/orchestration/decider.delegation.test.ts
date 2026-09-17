import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";
const NOW = "2026-01-01T00:00:00.000Z";
const SNOOZED_AT = NOW;
function makeReadModel(input: {
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  readonly archivedAt?: string | null;
  readonly activities?: OrchestrationThread["activities"];
  readonly messages?: OrchestrationThread["messages"];
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: input.snoozedUntil ?? null,
        snoozedAt: input.snoozedAt ?? (input.snoozedUntil != null ? SNOOZED_AT : null),
        deletedAt: null,
        messages: input.messages ?? [],
        proposedPlans: [],
        activities: input.activities ?? [],
        checkpoints: [],
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      },
    ],
    updatedAt: NOW,
  };
}

const childId = ThreadId.make("delegated:thread-1:0123456789abcdef");
function fixture(parentPatch: Partial<OrchestrationThread> = {}) {
  const initial = makeReadModel({});
  const parent = { ...initial.threads[0]!, ...parentPatch };
  return { ...initial, threads: [parent, { ...initial.threads[0]!, id: childId }] };
}
function command(): Extract<OrchestrationCommand, { type: "thread.delegation.follow-through" }> {
  return {
    type: "thread.delegation.follow-through",
    commandId: CommandId.make("follow"),
    threadId: ThreadId.make("thread-1"),
    expectedParentUpdatedAt: NOW,
    expectedSourceEpoch: 0,
    children: [{ threadId: childId, updatedAt: NOW }],
    messageId: MessageId.make("notice"),
    text: "Child needs review",
    notificationIds: [EventId.make("child-event")],
    createdAt: NOW,
  };
}
it.layer(NodeServices.layer)("delegation admission", (it) => {
  it.effect("atomically admits a parent turn and receipt while preserving configuration", () =>
    Effect.gen(function* () {
      const readModel = fixture({ interactionMode: "plan" });
      const result = yield* decideOrchestrationCommand({ readModel, command: command() });
      const events = Array.isArray(result) ? result : [result];
      const start = events.find((event) => event.type === "thread.turn-start-requested");
      expect(start?.payload).toMatchObject({
        modelSelection: readModel.threads[0]!.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "plan",
        admissionIntent: { kind: "start" },
      });
      expect(events.at(-1)?.payload).toMatchObject({
        activity: {
          kind: "delegation.follow-through.delivered",
          payload: { notificationIds: ["child-event"], messageId: "notice" },
        },
      });
    }),
  );
  for (const status of [
    "running",
    "starting",
    "stopped",
    "interrupted",
    "error",
    "idle",
  ] as const) {
    it.effect(`does not restart or steer a ${status} parent`, () =>
      Effect.gen(function* () {
        const base = fixture();
        const readModel = fixture({ session: { ...base.threads[0]!.session!, status } });
        expect(yield* decideOrchestrationCommand({ readModel, command: command() })).toEqual([]);
      }),
    );
  }
  for (const marker of [
    "pendingTurnRequestId",
    "pendingStopRequestId",
    "failedTurnRequestId",
  ] as const) {
    it.effect(`blocks ${marker} even when session reports ready`, () =>
      Effect.gen(function* () {
        const base = fixture();
        const readModel = fixture({
          session: { ...base.threads[0]!.session!, [marker]: CommandId.make("pending") },
        });
        expect(yield* decideOrchestrationCommand({ readModel, command: command() })).toEqual([]);
      }),
    );
  }
  for (const patch of [
    { updatedAt: "2026-01-02T00:00:00.000Z" },
    { sourceEpoch: 1 },
    { archivedAt: NOW },
    { deletedAt: NOW },
    { settledOverride: "settled" as const },
    { snoozedUntil: NOW },
  ]) {
    it.effect(`rejects stale or suppressed parent ${Object.keys(patch)[0]}`, () =>
      Effect.gen(function* () {
        expect(
          yield* decideOrchestrationCommand({ readModel: fixture(patch), command: command() }),
        ).toEqual([]);
      }),
    );
  }
  for (const state of ["running", "interrupted", "error"] as const) {
    it.effect(`blocks a latest ${state} turn even with a ready session`, () =>
      Effect.gen(function* () {
        const readModel = fixture({
          latestTurn: {
            turnId: TurnId.make("turn"),
            state,
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
            assistantMessageId: null,
          },
        });
        expect(yield* decideOrchestrationCommand({ readModel, command: command() })).toEqual([]);
      }),
    );
  }
  it.effect("blocks an active turn even if session readiness is stale", () =>
    Effect.gen(function* () {
      const base = fixture();
      expect(
        yield* decideOrchestrationCommand({
          readModel: fixture({
            session: { ...base.threads[0]!.session!, activeTurnId: TurnId.make("turn") },
          }),
          command: command(),
        }),
      ).toEqual([]);
    }),
  );
  it.effect("suppresses compaction and rollback ownership", () =>
    Effect.gen(function* () {
      const base = fixture();
      const compacting = fixture({
        session: {
          ...base.threads[0]!.session!,
          compactionQueue: { requestId: CommandId.make("compact"), phase: "running", queued: [] },
        },
      });
      expect(
        yield* decideOrchestrationCommand({ readModel: compacting, command: command() }),
      ).toEqual([]);
      for (const state of ["pending", "recovering", "manual-recovery"] as const) {
        expect(
          yield* decideOrchestrationCommand({
            readModel: fixture({ rollbackStatus: { state, updatedAt: NOW } }),
            command: command(),
          }),
        ).toEqual([]);
      }
    }),
  );
  it.effect("rejects disabled settings, duplicate messages, and partial batch replay", () =>
    Effect.gen(function* () {
      for (const delegationAdmission of [
        { enabled: false, messageExists: false, deliveredNotificationIds: [] },
        { enabled: true, messageExists: true, deliveredNotificationIds: [] },
        {
          enabled: true,
          messageExists: false,
          deliveredNotificationIds: [EventId.make("child-event")],
        },
      ]) {
        expect(
          yield* decideOrchestrationCommand({
            readModel: fixture(),
            command: {
              ...command(),
              notificationIds: [EventId.make("child-event"), EventId.make("new-event")],
            },
            delegationAdmission,
          }),
        ).toEqual([]);
      }
    }),
  );
  it.effect("does not deliver updates for archived or deleted children", () =>
    Effect.gen(function* () {
      for (const patch of [{ archivedAt: NOW }, { deletedAt: NOW }]) {
        const readModel = fixture();
        readModel.threads[1] = { ...readModel.threads[1]!, ...patch };
        expect(yield* decideOrchestrationCommand({ readModel, command: command() })).toEqual([]);
      }
    }),
  );
  it.effect("rejects changed children and cross-parent ownership", () =>
    Effect.gen(function* () {
      for (const child of [
        { threadId: childId, updatedAt: "2026-01-02T00:00:00.000Z" },
        { threadId: ThreadId.make("thread-1"), updatedAt: NOW },
      ]) {
        expect(
          yield* decideOrchestrationCommand({
            readModel: fixture(),
            command: { ...command(), children: [child] },
          }),
        ).toEqual([]);
      }
    }),
  );
  it.effect("honors durable pending requests even when startup command history is empty", () =>
    Effect.gen(function* () {
      expect(
        yield* decideOrchestrationCommand({
          readModel: fixture(),
          command: command(),
          pendingRequestActivities: [
            {
              id: EventId.make("approval"),
              kind: "approval.requested",
              summary: "approval",
              tone: "info",
              turnId: TurnId.make("turn"),
              payload: { requestId: "request" },
              createdAt: NOW,
            },
          ],
        }),
      ).toEqual([]);
    }),
  );
});
