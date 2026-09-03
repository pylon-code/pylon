// @effect-diagnostics nodeBuiltinImport:off
import type {
  OrchestrationClientOrigin,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { CommandId, OrchestrationCommand } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { RollbackAdmission } from "../../rollback/RollbackAdmission.ts";
import { RollbackSagaRepository } from "../../persistence/Services/RollbackSagas.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandIdConflictError = Schema.is(OrchestrationCommandIdConflictError);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

function canonicalWorkspacePath(cwd: string): string {
  try {
    return NodeFS.realpathSync(cwd);
  } catch {
    return cwd;
  }
}

interface CommandEnvelope {
  command: OrchestrationCommand;
  origin: OrchestrationClientOrigin | undefined;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const rollbackAdmission = yield* Effect.serviceOption(RollbackAdmission);
  const rollbackRepository = yield* Effect.serviceOption(RollbackSagaRepository);

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const assertRollbackFenceAllows = Effect.fn("OrchestrationEngine.assertRollbackFenceAllows")(
    function* (command: OrchestrationCommand) {
      if (Option.isNone(rollbackRepository)) return;
      const active = yield* rollbackRepository.value.listNonterminalForFence().pipe(
        Effect.mapError(
          () =>
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Rollback mutation fence could not be verified.",
            }),
        ),
      );
      if (active.length === 0) return;
      if (
        command.type === "project.create" ||
        command.type === "project.meta.update" ||
        command.type === "project.delete"
      ) {
        if (
          command.type !== "project.create" &&
          active.some((record) => record.projectId === command.projectId)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "This project is fenced by an active rollback operation.",
          });
        }
        return;
      }
      const safeForOwnedThread =
        command.type === "thread.rollback.status.set" ||
        command.type === "thread.revert.complete" ||
        (command.type === "thread.session.set" &&
          ["idle", "ready", "interrupted", "stopped", "error"].includes(command.session.status));
      const owned = active.find((record) => record.threadId === command.threadId);
      if (owned !== undefined && !safeForOwnedThread) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This thread is fenced by an active rollback operation.",
        });
      }
      if (
        command.type !== "thread.turn.start" &&
        command.type !== "thread.input-queue.follow-up" &&
        command.type !== "thread.approval.respond" &&
        command.type !== "thread.user-input.respond" &&
        command.type !== "thread.turn.diff.complete" &&
        command.type !== "thread.checkpoint.revert"
      )
        return;
      const thread = commandReadModel.threads.find(
        (candidate) => candidate.id === command.threadId,
      );
      const project =
        thread === undefined
          ? undefined
          : commandReadModel.projects.find((candidate) => candidate.id === thread.projectId);
      if (!thread || !project) return;
      const candidateCwd = canonicalWorkspacePath(thread.worktreePath ?? project.workspaceRoot);
      if (active.some((record) => record.state.workspaceCwd === candidateCwd)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This workspace is fenced by another thread's active rollback operation.",
        });
      }
    },
  );

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          // A receipt only proves this exact command was handled. Replaying it
          // for a command aimed at another aggregate would report success for
          // work that never happened.
          if (
            existingReceipt.value.aggregateKind !== aggregateRef.aggregateKind ||
            existingReceipt.value.aggregateId !== aggregateRef.aggregateId
          ) {
            return yield* new OrchestrationCommandIdConflictError({
              commandId: envelope.command.commandId,
              receiptAggregateKind: existingReceipt.value.aggregateKind,
              receiptAggregateId: existingReceipt.value.aggregateId,
              commandAggregateKind: aggregateRef.aggregateKind,
              commandAggregateId: aggregateRef.aggregateId,
            });
          }
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        if (
          envelope.command.type === "thread.checkpoint.revert" &&
          Option.isSome(rollbackRepository)
        ) {
          const active = yield* rollbackRepository.value
            .getActiveByThread(envelope.command.threadId)
            .pipe(
              Effect.mapError(
                () =>
                  new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail: "Rollback admission state could not be read.",
                  }),
              ),
            );
          if (Option.isSome(active)) {
            if (
              active.value.state.targetRevision !== envelope.command.turnCount ||
              active.value.state.sourceRevision !== envelope.command.expectedSourceRevision
            ) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: envelope.command.type,
                detail: "Another rollback target already owns this thread.",
              });
            }
            yield* commandReceiptRepository.upsert({
              commandId: envelope.command.commandId,
              aggregateKind: "thread",
              aggregateId: envelope.command.threadId,
              acceptedAt: yield* nowIso,
              resultSequence: commandReadModel.snapshotSequence,
              status: "accepted",
              error: null,
            });
            return { sequence: commandReadModel.snapshotSequence };
          }
        }

        yield* assertRollbackFenceAllows(envelope.command);

        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel: commandReadModel,
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            isOrchestrationCommandInvariantError(cause)
              ? cause
              : new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Failed to generate an event identifier.",
                  cause,
                }),
          ),
        );
        const commandEvents = Array.isArray(eventBase) ? eventBase : [eventBase];
        const preparedRollback =
          envelope.command.type === "thread.checkpoint.revert" &&
          Option.isSome(rollbackAdmission) &&
          commandEvents[0]?.type === "thread.checkpoint-revert-requested"
            ? yield* rollbackAdmission.value.prepare({
                command: envelope.command,
                readModel: commandReadModel,
                requestEventId: commandEvents[0].eventId,
              })
            : Option.none();
        const pendingRollbackEvent = Option.isSome(preparedRollback)
          ? yield* decideOrchestrationCommand({
              command: {
                type: "thread.rollback.status.set",
                commandId: CommandId.make(
                  `server:rollback-admitted:${preparedRollback.value.operationId}`,
                ),
                threadId: preparedRollback.value.threadId,
                status: "pending",
                targetTurnCount: preparedRollback.value.targetRevision,
                sourceRevision: preparedRollback.value.sourceRevision,
                detail:
                  "Rewriting the provider conversation, Pylon history, and workspace to the selected message.",
                allowedActions: [],
                createdAt: preparedRollback.value.createdAt,
              },
              readModel: commandReadModel,
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.mapError(
                (cause) =>
                  new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail: "Failed to persist the durable rollback status.",
                    cause,
                  }),
              ),
            )
          : null;
        const plannedEvents =
          pendingRollbackEvent === null
            ? commandEvents
            : [
                ...commandEvents,
                ...(Array.isArray(pendingRollbackEvent)
                  ? pendingRollbackEvent
                  : [pendingRollbackEvent]),
              ];
        // Stamp the dispatching client's origin onto every event the command
        // produced. The decider stays pure; attribution is an engine concern.
        const eventBases =
          envelope.origin === undefined
            ? plannedEvents
            : plannedEvents.map((planned) => ({
                ...planned,
                metadata: { ...planned.metadata, origin: envelope.origin },
              }));
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (Option.isSome(preparedRollback)) {
                if (Option.isNone(rollbackRepository)) {
                  return yield* new OrchestrationCommandInvariantError({
                    commandType: envelope.command.type,
                    detail: "Durable rollback persistence is unavailable.",
                  });
                }
                yield* rollbackRepository.value.admit(preparedRollback.value).pipe(
                  Effect.mapError(
                    () =>
                      new OrchestrationCommandInvariantError({
                        commandType: envelope.command.type,
                        detail:
                          "Rollback admission lost its operation or workspace lease compare-and-set.",
                      }),
                  ),
                );
              }
              const committedEvents: OrchestrationEvent[] = [];
              let nextCommandReadModel = commandReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                yield* projectionPipeline.projectEvent(savedEvent);
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              const acceptsStaleNoEvent =
                envelope.command.type === "thread.meta.update" ||
                envelope.command.type === "thread.runtime-mode.set" ||
                envelope.command.type === "thread.interaction-mode.set" ||
                envelope.command.type === "thread.turn.admission.accept" ||
                envelope.command.type === "thread.turn.admission.fail" ||
                envelope.command.type === "thread.session.bind-pending" ||
                envelope.command.type === "thread.session.apply-lifecycle";
              if (lastSavedEvent === null && !acceptsStaleNoEvent) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }
              const resultSequence =
                lastSavedEvent?.sequence ?? nextCommandReadModel.snapshotSequence;
              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent?.aggregateKind ?? aggregateRef.aggregateKind,
                aggregateId: lastSavedEvent?.aggregateId ?? aggregateRef.aggregateId,
                acceptedAt: lastSavedEvent?.occurredAt ?? (yield* nowIso),
                resultSequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                lastSequence: resultSequence,
                nextCommandReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        commandReadModel = committedCommand.nextCommandReadModel;
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        return {
          sequence: committedCommand.lastSequence,
          eventCount: committedCommand.committedEvents.length,
        };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`), (processCommand) =>
        envelope.command.type === "thread.checkpoint.revert" && Option.isSome(rollbackRepository)
          ? rollbackRepository.value.withMutationFence(processCommand)
          : processCommand,
      ),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (
            !isOrchestrationCommandPreviouslyRejectedError(error) &&
            !isOrchestrationCommandIdConflictError(error)
          ) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (isOrchestrationCommandInvariantError(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command, options) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, {
        command,
        origin: options?.origin,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      return yield* Deferred.await(result);
    });

  return {
    readEvents,
    dispatch,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    // The command read model's snapshotSequence tracks the latest committed
    // event sequence (updated on the worker fiber). A plain property read is a
    // consistent, committed value — reassignment of `commandReadModel` is
    // atomic on the single-threaded event loop.
    latestSequence: Effect.sync(() => commandReadModel.snapshotSequence),
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
