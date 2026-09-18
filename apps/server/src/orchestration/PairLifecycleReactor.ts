/**
 * Keeps a pair executor in step with its lead: archived, deleted, and settled
 * together, and stopped when the lead is rewound. A sidecar over existing
 * commands and domain events; it adds no command, event, or decider branch.
 *
 * @module orchestration/PairLifecycleReactor
 */
import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import { pairExecutorThreadId } from "../mcp/toolkits/pair/logic.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  type PairLifecycleIntent,
  orphanedExecutorIds,
  pairLifecycleApplies,
  pairLifecycleIntent,
} from "./pairLifecycle.logic.ts";

export class PairLifecycleReactor extends Context.Service<
  PairLifecycleReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/PairLifecycleReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  type Work = {
    readonly event: OrchestrationEvent;
    readonly intent: PairLifecycleIntent;
  };

  const process = Effect.fn("PairLifecycleReactor.process")(function* (work: Work) {
    const { event, intent } = work;
    const digest = yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(`${intent.leadThreadId}\npair`),
    );
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const executorId = pairExecutorThreadId(intent.leadThreadId, () => hex);

    let executor: OrchestrationThreadShell | null = null;
    const shellOption = yield* snapshots.getThreadShellById(executorId);
    if (Option.isSome(shellOption)) {
      executor = shellOption.value;
    } else if (intent.action === "delete") {
      const archivedSnapshot = yield* snapshots.getArchivedShellSnapshot();
      const found = archivedSnapshot.threads.find((thread) => thread.id === executorId);
      if (found !== undefined) {
        executor = found;
      }
    }
    if (executor === null) {
      return;
    }
    if (!pairLifecycleApplies(intent.action, executor)) {
      return;
    }

    const commandId = CommandId.make(
      `server:pair-lifecycle:${intent.action}:${executorId}:${event.eventId}`,
    );

    switch (intent.action) {
      case "archive":
        yield* engine.dispatch({
          type: "thread.archive",
          commandId,
          threadId: executorId,
        });
        break;
      case "settle":
        yield* engine.dispatch({
          type: "thread.settle",
          commandId,
          threadId: executorId,
        });
        break;
      case "delete":
        yield* engine.dispatch({
          type: "thread.delete",
          commandId,
          threadId: executorId,
        });
        break;
      case "interrupt": {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* engine.dispatch({
          type: "thread.turn.interrupt",
          commandId,
          threadId: executorId,
          createdAt,
        });
        break;
      }
    }
  });

  const worker = yield* makeDrainableWorker((work: Work) =>
    process(work).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Pylon pair lifecycle dispatch failed", {
              leadThreadId: work.intent.leadThreadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    const intent = pairLifecycleIntent(event);
    if (intent === null) return Effect.void;
    return worker.enqueue({ event, intent });
  };

  const sweep = Effect.gen(function* () {
    const activeSnapshot = yield* snapshots.getShellSnapshot();
    const archivedSnapshot = yield* snapshots.getArchivedShellSnapshot();
    const knownThreadIds = new Set<string>();
    for (const thread of activeSnapshot.threads) {
      knownThreadIds.add(thread.id);
    }
    for (const thread of archivedSnapshot.threads) {
      knownThreadIds.add(thread.id);
    }
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const orphanIds = orphanedExecutorIds({
      threads: activeSnapshot.threads,
      knownThreadIds,
      nowMs,
    });
    for (const executorId of orphanIds) {
      const commandId = CommandId.make(`server:pair-lifecycle:orphan:${executorId}`);
      yield* engine.dispatch({
        type: "thread.delete",
        commandId,
        threadId: executorId,
      });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Pylon pair orphan sweep failed", {
            cause: Cause.pretty(cause),
          }),
    ),
  );

  const start = Effect.fn("PairLifecycleReactor.start")(function* () {
    yield* sweep;
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return { start, drain: worker.drain };
});

export const layer = Layer.effect(PairLifecycleReactor, make);
