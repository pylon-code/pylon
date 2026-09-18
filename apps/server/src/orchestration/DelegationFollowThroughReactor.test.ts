import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as Reactor from "./DelegationFollowThroughReactor.ts";

const NOW = "2026-09-17T00:00:00.000Z";
const PARENT = ThreadId.make("parent");
const CHILD = ThreadId.make("delegated:parent:0123456789abcdef");
const CHILD2 = ThreadId.make("delegated:parent:fedcba9876543210");
function shell(id: ThreadId, running = false): OrchestrationThreadShell {
  const turnId = TurnId.make(`turn-${id}`);
  return {
    id,
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: {
      turnId,
      state: running ? "running" : "completed",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: running ? null : NOW,
      assistantMessageId: null,
    },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId: id,
      status: running ? "running" : "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: running ? turnId : null,
      lastError: null,
      updatedAt: NOW,
    },
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}
function detail(parent: OrchestrationThreadShell): OrchestrationThread {
  return {
    ...parent,
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
  };
}
const makeHarness = Effect.fn(function* (
  initial: readonly OrchestrationThreadShell[],
  enabled = true,
  persisted: OrchestrationThread = detail(shell(PARENT)),
) {
  let threads = [...initial];
  let parentDetail = persisted;
  let hideDetailActivities = false;
  const commands: OrchestrationCommand[] = [];
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  let read = yield* Deferred.make<void>();
  let sequence = 0;
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Effect.succeed({ snapshotSequence: sequence, projects: [], threads, updatedAt: NOW }),
      getThreadShellById: (id) =>
        Deferred.succeed(read, undefined).pipe(
          Effect.as(Option.fromNullishOr(threads.find((thread) => thread.id === id))),
        ),
      getThreadDetailById: () =>
        Effect.succeed(
          Option.some(hideDetailActivities ? { ...parentDetail, activities: [] } : parentDetail),
        ),
      getPendingRequestActivities: () => Effect.succeed([]),
      getDelegationObservationActivities: () =>
        Effect.succeed(
          parentDetail.activities.filter((activity) => activity.kind === "delegation.child-state"),
        ),
      getDeliveredDelegationNotificationIds: ({ notificationIds }) =>
        Effect.succeed(
          notificationIds.filter((id) =>
            parentDetail.activities.some(
              (activity) =>
                activity.kind === "delegation.follow-through.delivered" &&
                JSON.stringify(activity.payload).includes(id),
            ),
          ),
        ),
    }),
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, enableAgentDelegation: enabled }),
    }),
    Layer.mock(OrchestrationEngineService)({
      subscribeDomainEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "thread.activity.append")
            parentDetail = {
              ...parentDetail,
              activities: [
                ...parentDetail.activities.filter(
                  (activity) => activity.id !== command.activity.id,
                ),
                command.activity,
              ],
            };
          if (command.type === "thread.delegation.follow-through")
            parentDetail = {
              ...parentDetail,
              activities: [
                ...parentDetail.activities,
                {
                  id: EventId.make(`delivery-${sequence}`),
                  kind: "delegation.follow-through.delivered",
                  tone: "info",
                  summary: "Delivered",
                  payload: {
                    notificationIds: command.notificationIds,
                    messageId: command.messageId,
                  },
                  turnId: null,
                  createdAt: NOW,
                },
              ],
            };
          return { sequence: ++sequence };
        }),
    }),
    Layer.succeed(ServerActivation, Effect.void),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, bytes) => Effect.succeed(bytes),
      }),
    ),
  );
  const service = yield* Reactor.make.pipe(Effect.provide(dependencies));
  yield* service.start();
  yield* Deferred.await(read);
  yield* service.drain;
  const publish = (id: ThreadId, kind?: string, historyImport = false, status?: string) =>
    Effect.gen(function* () {
      const thread = threads.find((entry) => entry.id === id)!;
      const base = {
        eventId: EventId.make(`event-${++sequence}`),
        sequence,
        aggregateKind: "thread" as const,
        aggregateId: id,
        occurredAt: NOW,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: { historyImport },
      };
      const event: OrchestrationEvent =
        kind === undefined
          ? {
              ...base,
              type: "thread.session-set",
              payload: { threadId: id, session: thread.session! },
            }
          : {
              ...base,
              type: "thread.activity-appended",
              payload: {
                threadId: id,
                activity: {
                  id: base.eventId,
                  kind,
                  tone: "info",
                  summary: kind,
                  payload: status === undefined ? {} : { status },
                  turnId: null,
                  createdAt: NOW,
                },
              },
            };
      yield* PubSub.publish(events, event);
    });
  return {
    commands,
    hideDetailActivities: () => {
      hideDetailActivities = true;
    },
    get persisted() {
      return parentDetail;
    },
    replace: (thread: OrchestrationThreadShell) => {
      threads = [...threads.filter((entry) => entry.id !== thread.id), thread];
    },
    emit: (id: ThreadId, kind?: string, historyImport = false, status?: string) =>
      Effect.gen(function* () {
        read = yield* Deferred.make<void>();
        yield* publish(id, kind, historyImport, status);
        if (historyImport || (id !== PARENT && !id.startsWith("delegated:")))
          yield* publish(PARENT);
        yield* Deferred.await(read);
        yield* service.drain;
      }),
    wakes: () => commands.filter((command) => command.type === "thread.delegation.follow-through"),
  };
});

describe("DelegationFollowThroughReactor", () => {
  it.effect("baselines historical terminal children without waking the parent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness([shell(PARENT), shell(CHILD)]);
        assert.strictEqual(h.wakes().length, 0);
      }),
    ),
  );
  it.effect("keeps a historical terminal baseline across later lifecycle events and restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness([shell(PARENT), shell(CHILD)]);
        yield* h.emit(CHILD);
        assert.strictEqual(h.wakes().length, 0);
        const restored = yield* makeHarness([shell(PARENT), shell(CHILD)], true, h.persisted);
        yield* restored.emit(CHILD);
        assert.strictEqual(restored.wakes().length, 0);
        restored.replace(shell(CHILD, true));
        yield* restored.emit(CHILD);
        restored.replace({
          ...shell(CHILD),
          latestTurn: { ...shell(CHILD).latestTurn!, turnId: TurnId.make("new-turn") },
        });
        yield* restored.emit(CHILD);
        assert.strictEqual(restored.wakes().length, 1);
      }),
    ),
  );
  it.effect("does not treat imported terminal history as a new child update", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness([shell(PARENT), shell(CHILD, true)]);
        h.replace(shell(CHILD2));
        yield* h.emit(CHILD2, undefined, true);
        assert.strictEqual(h.wakes().length, 0);
      }),
    ),
  );
  it.effect("wakes after background tasks finish inside a Pylon child", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness([
          shell(PARENT),
          { ...shell(CHILD), backgroundLiveness: "working" },
        ]);
        h.replace(shell(CHILD));
        yield* h.emit(CHILD, "task.completed");
        assert.strictEqual(h.wakes().length, 1);
      }),
    ),
  );
  it.effect("delivers pending child results when the parent background tasks finish", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness([
          { ...shell(PARENT), backgroundLiveness: "working" },
          shell(CHILD, true),
        ]);
        h.replace(shell(CHILD));
        yield* h.emit(CHILD);
        assert.strictEqual(h.wakes().length, 0);
        h.replace(shell(PARENT));
        yield* h.emit(PARENT, "task.completed");
        assert.strictEqual(h.wakes().length, 1);
      }),
    ),
  );
  it.effect(
    "uses durable observations and delivery receipts beyond the detail activity window",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness([shell(PARENT), shell(CHILD, true), shell(CHILD2, true)]);
          h.replace(shell(CHILD));
          yield* h.emit(CHILD);
          assert.strictEqual(h.wakes().length, 1);
          h.hideDetailActivities();
          h.replace(shell(CHILD2));
          yield* h.emit(CHILD2);
          assert.strictEqual(h.wakes().length, 2);
          assert.deepEqual(
            h.wakes()[1]!.children.map((child) => child.threadId),
            [CHILD2],
          );
          const historical = yield* makeHarness([shell(PARENT), shell(CHILD)]);
          historical.hideDetailActivities();
          yield* historical.emit(CHILD);
          assert.strictEqual(historical.wakes().length, 0);
        }),
      ),
  );
  it.effect("observes explicit Claude progress status when background tasks settle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness([
          shell(PARENT),
          { ...shell(CHILD), backgroundLiveness: "working" },
        ]);
        h.replace(shell(CHILD));
        yield* h.emit(CHILD, "task.progress", false, "completed");
        assert.strictEqual(h.wakes().length, 1);
      }),
    ),
  );
  it.effect("arms running children and delivers a terminal generation only once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness([shell(PARENT), shell(CHILD, true)]);
        h.replace(shell(CHILD));
        yield* h.emit(CHILD);
        yield* h.emit(CHILD);
        assert.strictEqual(h.wakes().length, 1);
        assert.include(h.wakes()[0]!.text, "completed");
      }),
    ),
  );
  it.effect("coalesces two child completions while the parent is busy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness([
          shell(PARENT, true),
          shell(CHILD, true),
          shell(CHILD2, true),
        ]);
        h.replace(shell(CHILD));
        yield* h.emit(CHILD);
        h.replace(shell(CHILD2));
        yield* h.emit(CHILD2);
        assert.strictEqual(h.wakes().length, 0);
        h.replace(shell(PARENT));
        yield* h.emit(PARENT);
        assert.strictEqual(h.wakes().length, 1);
        assert.strictEqual(h.wakes()[0]!.children.length, 2);
      }),
    ),
  );
  it.effect("does not wake a parent for a completion a tool already handed it in-turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The child finishes while the parent is mid-turn, so the reactor records
        // the observation without delivering it.
        const busy = yield* makeHarness([shell(PARENT, true), shell(CHILD, true)]);
        busy.replace(shell(CHILD));
        yield* busy.emit(CHILD);
        assert.strictEqual(busy.wakes().length, 0);
        // pair_await or delegated_thread_status then returns that completion to the
        // parent and rewrites the same receipt with baseline: true.
        const consumed = {
          ...busy.persisted,
          activities: busy.persisted.activities.map((activity) =>
            activity.kind === "delegation.child-state"
              ? { ...activity, payload: { ...Object(activity.payload), baseline: true } }
              : activity,
          ),
        };
        assert.isTrue(
          consumed.activities.some((activity) => activity.kind === "delegation.child-state"),
        );
        const idle = yield* makeHarness([shell(PARENT), shell(CHILD)], true, consumed);
        yield* idle.emit(PARENT);
        assert.strictEqual(idle.wakes().length, 0);
      }),
    ),
  );
  it.effect(
    "recovers a persisted pending observation and respects a persisted delivery receipt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* makeHarness([shell(PARENT, true), shell(CHILD, true)]);
          first.replace(shell(CHILD));
          yield* first.emit(CHILD);
          const recovered = yield* makeHarness(
            [shell(PARENT), shell(CHILD)],
            true,
            first.persisted,
          );
          assert.strictEqual(recovered.wakes().length, 1);
          const delivered = yield* makeHarness(
            [shell(PARENT), shell(CHILD)],
            true,
            recovered.persisted,
          );
          assert.strictEqual(delivered.wakes().length, 0);
        }),
      ),
  );
  it.effect("drops a resolved blocker before the parent becomes ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness([shell(PARENT, true), shell(CHILD, true)]);
        h.replace({ ...shell(CHILD, true), hasPendingApprovals: true });
        yield* h.emit(CHILD);
        h.replace(shell(CHILD, true));
        yield* h.emit(CHILD);
        h.replace(shell(PARENT));
        yield* h.emit(PARENT);
        assert.strictEqual(h.wakes().length, 0);
      }),
    ),
  );
  it.effect("does not wake when delegation is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness([shell(PARENT), shell(CHILD, true)], false);
        h.replace(shell(CHILD));
        yield* h.emit(CHILD);
        assert.strictEqual(h.commands.length, 0);
      }),
    ),
  );
  it.effect("enforces the persisted three-turn budget without a wake loop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = detail(shell(PARENT));
        const messages = [1, 2, 3].map((n) => ({
          id: MessageId.make(`delegation-follow-through:${n}`),
          role: "user" as const,
          text: "notice",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        }));
        const h = yield* makeHarness([shell(PARENT), shell(CHILD, true)], true, {
          ...parent,
          messages,
        });
        h.replace(shell(CHILD));
        yield* h.emit(CHILD);
        yield* h.emit(CHILD);
        assert.strictEqual(h.wakes().length, 0);
        assert.isTrue(
          h.commands.some(
            (command) =>
              command.type === "thread.activity.append" &&
              command.activity.kind === "delegation.follow-through.paused",
          ),
        );
      }),
    ),
  );
  it.effect("does not interpret native agent IDs as Pylon children", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const native = ThreadId.make("native-agent");
        const h = yield* makeHarness([shell(PARENT), shell(CHILD, true), shell(native, true)]);
        h.replace(shell(native));
        yield* h.emit(native);
        assert.strictEqual(h.wakes().length, 0);
      }),
    ),
  );
  it.effect("baselines an observation whose key changed while the server was down", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // First run: the child is running, so it is armed (not baselined).
        const first = yield* makeHarness([shell(PARENT), shell(CHILD, true)]);
        yield* first.emit(CHILD);
        assert.strictEqual(first.wakes().length, 0);
        // Restart: the child now reads as completed. Nothing observed that live.
        const restored = yield* makeHarness([shell(PARENT), shell(CHILD)], true, first.persisted);
        assert.strictEqual(restored.wakes().length, 0);
        // A later live event on the same terminal state still does not wake.
        yield* restored.emit(CHILD);
        assert.strictEqual(restored.wakes().length, 0);
        // A genuinely new turn after the restart does wake.
        restored.replace(shell(CHILD, true));
        yield* restored.emit(CHILD);
        restored.replace({
          ...shell(CHILD),
          latestTurn: { ...shell(CHILD).latestTurn!, turnId: TurnId.make("after-restart") },
        });
        yield* restored.emit(CHILD);
        assert.strictEqual(restored.wakes().length, 1);
      }),
    ),
  );
});
