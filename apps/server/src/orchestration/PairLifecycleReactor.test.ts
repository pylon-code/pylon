import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ServerActivation } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as Reactor from "./PairLifecycleReactor.ts";

const NOW = "2026-09-18T00:00:00.000Z";
const LEAD = ThreadId.make("lead");
const OTHER = ThreadId.make("other");
const executorOf = (lead: ThreadId) =>
  ThreadId.make(
    `delegated:${lead}:${NodeCrypto.createHash("sha256").update(`${lead}\npair`).digest("hex").slice(0, 16)}`,
  );
const EXECUTOR = executorOf(LEAD);
const FAN_OUT_CHILD = ThreadId.make(`delegated:${LEAD}:0123456789abcdef`);

function shell(
  id: ThreadId,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id,
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("antigravity"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const runningTurnId = TurnId.make("turn-running");
const running = (id: ThreadId) =>
  shell(id, {
    latestTurn: {
      turnId: runningTurnId,
      state: "running",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      assistantMessageId: null,
    },
    session: {
      threadId: id,
      status: "running",
      providerName: "antigravity",
      runtimeMode: "full-access",
      activeTurnId: runningTurnId,
      lastError: null,
      updatedAt: NOW,
    },
  });

const targetOf = (command: OrchestrationCommand | undefined) =>
  command !== undefined && "threadId" in command ? command.threadId : null;

type LifecycleEventType =
  | "thread.archived"
  | "thread.deleted"
  | "thread.settled"
  | "thread.checkpoint-revert-requested"
  | "thread.unarchived";

let nextEvent = 0;
function lifecycleEvent(
  type: LifecycleEventType,
  threadId: ThreadId,
  historyImport = false,
): OrchestrationEvent {
  const base = {
    eventId: EventId.make(`event-${++nextEvent}`),
    sequence: nextEvent,
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: { historyImport },
  };
  switch (type) {
    case "thread.archived":
      return { ...base, type, payload: { threadId, archivedAt: NOW, updatedAt: NOW } };
    case "thread.deleted":
      return { ...base, type, payload: { threadId, deletedAt: NOW } };
    case "thread.settled":
      return { ...base, type, payload: { threadId, settledAt: NOW, updatedAt: NOW } };
    case "thread.checkpoint-revert-requested":
      return { ...base, type, payload: { threadId, turnCount: 1, createdAt: NOW } };
    case "thread.unarchived":
      return { ...base, type, payload: { threadId, updatedAt: NOW } };
  }
}

const makeHarness = Effect.fn(function* (input: {
  readonly active?: readonly OrchestrationThreadShell[];
  readonly archived?: readonly OrchestrationThreadShell[];
}) {
  const active = [...(input.active ?? [])];
  const archived = [...(input.archived ?? [])];
  const commands: OrchestrationCommand[] = [];
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (id) =>
        Effect.succeed(Option.fromNullishOr(active.find((thread) => thread.id === id))),
      getArchivedShellSnapshot: () =>
        Effect.succeed({ snapshotSequence: 1, projects: [], threads: archived, updatedAt: NOW }),
    }),
    Layer.mock(OrchestrationEngineService)({
      subscribeDomainEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    }),
    Layer.succeed(ServerActivation, Effect.void),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) =>
          Effect.succeed(new Uint8Array(NodeCrypto.createHash("sha256").update(data).digest())),
      }),
    ),
  );
  const service = yield* Reactor.make.pipe(Effect.provide(dependencies));
  yield* service.start();
  const emit = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      yield* PubSub.publish(events, event);
      // Let the subscriber fiber take the event, then wait for the worker.
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* service.drain;
    });
  return { commands, emit };
});

describe("PairLifecycleReactor", () => {
  it.effect("archives, settles, and deletes the executor with its lead", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({ active: [shell(LEAD), shell(EXECUTOR)] });
        const archive = lifecycleEvent("thread.archived", LEAD);
        const settle = lifecycleEvent("thread.settled", LEAD);
        const remove = lifecycleEvent("thread.deleted", LEAD);
        yield* h.emit(archive);
        yield* h.emit(settle);
        yield* h.emit(remove);
        assert.deepStrictEqual(h.commands, [
          {
            type: "thread.archive",
            commandId: CommandId.make(
              `server:pair-lifecycle:archive:${EXECUTOR}:${archive.eventId}`,
            ),
            threadId: EXECUTOR,
          },
          {
            type: "thread.settle",
            commandId: CommandId.make(`server:pair-lifecycle:settle:${EXECUTOR}:${settle.eventId}`),
            threadId: EXECUTOR,
          },
          {
            type: "thread.delete",
            commandId: CommandId.make(`server:pair-lifecycle:delete:${EXECUTOR}:${remove.eventId}`),
            threadId: EXECUTOR,
          },
        ]);
      }),
    ),
  );

  it.effect("stops a running executor when its lead is rewound, and only then", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const busy = yield* makeHarness({ active: [shell(LEAD), running(EXECUTOR)] });
        const rewind = lifecycleEvent("thread.checkpoint-revert-requested", LEAD);
        yield* busy.emit(rewind);
        assert.strictEqual(busy.commands.length, 1);
        const [interrupt] = busy.commands;
        assert.strictEqual(interrupt?.type, "thread.turn.interrupt");
        assert.strictEqual(targetOf(interrupt), EXECUTOR);
        assert.strictEqual(
          interrupt?.commandId,
          `server:pair-lifecycle:interrupt:${EXECUTOR}:${rewind.eventId}`,
        );

        const idle = yield* makeHarness({ active: [shell(LEAD), shell(EXECUTOR)] });
        yield* idle.emit(lifecycleEvent("thread.checkpoint-revert-requested", LEAD));
        assert.deepStrictEqual(idle.commands, []);
      }),
    ),
  );

  it.effect("deletes an executor that was archived when the pair was turned off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({
          active: [shell(LEAD)],
          archived: [shell(EXECUTOR, { archivedAt: NOW })],
        });
        // Archiving and settling have nothing left to do for an archived executor.
        yield* h.emit(lifecycleEvent("thread.archived", LEAD));
        yield* h.emit(lifecycleEvent("thread.settled", LEAD));
        assert.deepStrictEqual(h.commands, []);
        yield* h.emit(lifecycleEvent("thread.deleted", LEAD));
        assert.deepStrictEqual(
          h.commands.map((command) => ({ type: command.type, threadId: targetOf(command) })),
          [{ type: "thread.delete", threadId: EXECUTOR }],
        );
      }),
    ),
  );

  it.effect("does nothing for threads without an executor or for other threads' events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness({
          active: [shell(LEAD), shell(OTHER), shell(EXECUTOR), shell(FAN_OUT_CHILD)],
        });
        // OTHER has no executor. A fan-out child of LEAD is not the pair.
        yield* h.emit(lifecycleEvent("thread.archived", OTHER));
        yield* h.emit(lifecycleEvent("thread.deleted", OTHER));
        // The executor's own lifecycle is how a user turns the pair off; it must not echo.
        yield* h.emit(lifecycleEvent("thread.archived", EXECUTOR));
        yield* h.emit(lifecycleEvent("thread.archived", FAN_OUT_CHILD));
        // Unarchiving a lead does not turn the pair back on, and imported history is inert.
        yield* h.emit(lifecycleEvent("thread.unarchived", LEAD));
        yield* h.emit(lifecycleEvent("thread.archived", LEAD, true));
        assert.deepStrictEqual(h.commands, []);
      }),
    ),
  );

  it.effect("keeps working after a dispatch is rejected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands: OrchestrationCommand[] = [];
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        let first = true;
        const dependencies = Layer.mergeAll(
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: (id) =>
              Effect.succeed(
                Option.fromNullishOr(
                  [shell(LEAD), shell(EXECUTOR)].find((thread) => thread.id === id),
                ),
              ),
            getArchivedShellSnapshot: () =>
              Effect.succeed({ snapshotSequence: 1, projects: [], threads: [], updatedAt: NOW }),
          }),
          Layer.mock(OrchestrationEngineService)({
            subscribeDomainEvents: PubSub.subscribe(events).pipe(
              Effect.map(Stream.fromSubscription),
            ),
            dispatch: (command) => {
              if (first) {
                first = false;
                return Effect.die(new Error("rejected"));
              }
              return Effect.sync(() => {
                commands.push(command);
                return { sequence: commands.length };
              });
            },
          }),
          Layer.succeed(ServerActivation, Effect.void),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size),
              digest: (_algorithm, data) =>
                Effect.succeed(
                  new Uint8Array(NodeCrypto.createHash("sha256").update(data).digest()),
                ),
            }),
          ),
        );
        const service = yield* Reactor.make.pipe(Effect.provide(dependencies));
        yield* service.start();
        for (const type of ["thread.archived", "thread.settled"] as const) {
          yield* PubSub.publish(events, lifecycleEvent(type, LEAD));
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          yield* service.drain;
        }
        // The first dispatch failed and was logged; the reactor did not die.
        assert.deepStrictEqual(
          commands.map(({ type }) => type),
          ["thread.settle"],
        );
      }),
    ),
  );
});
