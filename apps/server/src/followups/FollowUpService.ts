import {
  CommandId,
  EventId,
  FollowUp,
  FollowUpEventPayload,
  FollowUpEventType,
  FollowUpGate,
  FollowUpOperationError,
  FollowUpResolution,
  FollowUpSnapshot,
  FollowUpId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  type FollowUpEvent,
  type FollowUpFileInput,
  type FollowUpStreamItem,
  type FollowUpUpdateStatusInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { decideFollowUpCommand, type FollowUpDomainCommand } from "./decider.ts";

interface FollowUpServiceShape {
  readonly file: (input: FollowUpFileInput) => Effect.Effect<FollowUp, FollowUpOperationError>;
  readonly updateStatus: (
    input: FollowUpUpdateStatusInput,
  ) => Effect.Effect<FollowUp, FollowUpOperationError>;
  readonly getSnapshot: Effect.Effect<FollowUpSnapshot, FollowUpOperationError>;
  readonly openBlockersForBranch: (
    ref: string,
  ) => Effect.Effect<ReadonlyArray<FollowUp>, FollowUpOperationError>;
  readonly stream: Stream.Stream<FollowUpStreamItem, FollowUpOperationError>;
}

export class FollowUpService extends Context.Service<FollowUpService, FollowUpServiceShape>()(
  "pylon/followups/FollowUpService",
) {}

const EmptyRequest = Schema.Struct({});
const CommandLookup = Schema.Struct({ commandId: CommandId });
const ProjectLookup = Schema.Struct({ projectId: ProjectId });
const ThreadLookup = Schema.Struct({ threadId: ThreadId });

const ProjectRow = Schema.Struct({ projectId: ProjectId });
const ThreadRow = Schema.Struct({ projectId: ProjectId });
const SequenceRow = Schema.Struct({ sequence: NonNegativeInt });

const AppendEventRequest = Schema.Struct({
  eventId: EventId,
  commandId: CommandId,
  itemId: FollowUpId,
  type: FollowUpEventType,
  occurredAt: Schema.String,
  payload: FollowUpEventPayload,
});

const PersistedEventRow = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  commandId: CommandId,
  type: FollowUpEventType,
  occurredAt: Schema.String,
  payload: Schema.fromJsonString(FollowUpEventPayload),
});

const PersistedFollowUpRow = FollowUp.mapFields(
  Struct.assign({
    evidence: Schema.fromJsonString(FollowUp.fields.evidence),
    gate: Schema.NullOr(Schema.fromJsonString(FollowUpGate)),
    resolution: Schema.NullOr(Schema.fromJsonString(FollowUpResolution)),
  }),
);

const BranchLookup = Schema.Struct({ ref: Schema.String });
const isFollowUpOperationError = Schema.is(FollowUpOperationError);

function persistenceError(): FollowUpOperationError {
  return new FollowUpOperationError({
    code: "persistence",
    message: "Follow-ups could not update their local store.",
  });
}

function invalidProjectError(): FollowUpOperationError {
  return new FollowUpOperationError({
    code: "invalid-project",
    message: "That project is no longer available in this environment.",
  });
}

function invalidThreadError(): FollowUpOperationError {
  return new FollowUpOperationError({
    code: "invalid-thread",
    message: "That thread is unavailable or belongs to another project.",
  });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.unbounded<FollowUpEvent>();
  const mutationMutex = yield* Semaphore.make(1);

  const listItems = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: PersistedFollowUpRow,
    execute: () => sql`
      SELECT
        item_id AS "id",
        project_id AS "projectId",
        kind,
        status,
        title,
        observation,
        defer_reason AS "deferReason",
        verify_check AS "verifyCheck",
        evidence_json AS evidence,
        gate_json AS gate,
        source_kind AS "sourceKind",
        source_thread_id AS "sourceThreadId",
        resolution_json AS resolution,
        revision,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM follow_ups
      ORDER BY created_at, item_id
    `,
  });

  const listOpenBlockers = SqlSchema.findAll({
    Request: BranchLookup,
    Result: PersistedFollowUpRow,
    execute: () => sql`
      SELECT
        item_id AS "id",
        project_id AS "projectId",
        kind,
        status,
        title,
        observation,
        defer_reason AS "deferReason",
        verify_check AS "verifyCheck",
        evidence_json AS evidence,
        gate_json AS gate,
        source_kind AS "sourceKind",
        source_thread_id AS "sourceThreadId",
        resolution_json AS resolution,
        revision,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM follow_ups
      WHERE kind = 'blocker' AND status = 'open'
      ORDER BY created_at, item_id
    `,
  });

  const getLatestSequence = SqlSchema.findOne({
    Request: EmptyRequest,
    Result: SequenceRow,
    execute: () => sql`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM follow_up_events
    `,
  });

  const getEventByCommandId = SqlSchema.findOneOption({
    Request: CommandLookup,
    Result: PersistedEventRow,
    execute: ({ commandId }) => sql`
      SELECT
        sequence,
        event_id AS "eventId",
        command_id AS "commandId",
        event_type AS "type",
        occurred_at AS "occurredAt",
        payload_json AS payload
      FROM follow_up_events
      WHERE command_id = ${commandId}
    `,
  });

  const appendEvent = SqlSchema.findOne({
    Request: AppendEventRequest,
    Result: SequenceRow,
    execute: (event) => sql`
      INSERT INTO follow_up_events (
        event_id,
        command_id,
        item_id,
        event_type,
        occurred_at,
        payload_json
      ) VALUES (
        ${event.eventId},
        ${event.commandId},
        ${event.itemId},
        ${event.type},
        ${event.occurredAt},
        ${JSON.stringify(event.payload)}
      )
      RETURNING sequence
    `,
  });

  const upsertItem = SqlSchema.void({
    Request: FollowUp,
    execute: (item) => sql`
      INSERT INTO follow_ups (
        item_id,
        project_id,
        kind,
        status,
        title,
        observation,
        defer_reason,
        verify_check,
        evidence_json,
        gate_json,
        source_kind,
        source_thread_id,
        resolution_json,
        revision,
        created_at,
        updated_at
      ) VALUES (
        ${item.id},
        ${item.projectId},
        ${item.kind},
        ${item.status},
        ${item.title},
        ${item.observation},
        ${item.deferReason},
        ${item.verifyCheck},
        ${JSON.stringify(item.evidence)},
        ${item.gate === null ? null : JSON.stringify(item.gate)},
        ${item.sourceKind},
        ${item.sourceThreadId},
        ${item.resolution === null ? null : JSON.stringify(item.resolution)},
        ${item.revision},
        ${item.createdAt},
        ${item.updatedAt}
      )
      ON CONFLICT (item_id) DO UPDATE SET
        project_id = excluded.project_id,
        kind = excluded.kind,
        status = excluded.status,
        title = excluded.title,
        observation = excluded.observation,
        defer_reason = excluded.defer_reason,
        verify_check = excluded.verify_check,
        evidence_json = excluded.evidence_json,
        gate_json = excluded.gate_json,
        source_kind = excluded.source_kind,
        source_thread_id = excluded.source_thread_id,
        resolution_json = excluded.resolution_json,
        revision = excluded.revision,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const getProject = SqlSchema.findOneOption({
    Request: ProjectLookup,
    Result: ProjectRow,
    execute: ({ projectId }) => sql`
      SELECT project_id AS "projectId"
      FROM projection_projects
      WHERE project_id = ${projectId} AND deleted_at IS NULL
    `,
  });

  const getThread = SqlSchema.findOneOption({
    Request: ThreadLookup,
    Result: ThreadRow,
    execute: ({ threadId }) => sql`
      SELECT project_id AS "projectId"
      FROM projection_threads
      WHERE thread_id = ${threadId} AND deleted_at IS NULL
    `,
  });

  const mapPersistence = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, FollowUpOperationError, R> =>
    effect.pipe(Effect.mapError(() => persistenceError()));

  const getSnapshot = Effect.fn("FollowUpService.getSnapshot")(function* () {
    const [items, latest] = yield* Effect.all([
      mapPersistence(listItems({})),
      mapPersistence(getLatestSequence({})),
    ]);
    return {
      sequence: latest.sequence,
      items,
    } satisfies FollowUpSnapshot;
  });

  const validateProject = Effect.fn("FollowUpService.validateProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* mapPersistence(getProject({ projectId }));
    if (Option.isNone(project)) {
      return yield* invalidProjectError();
    }
  });

  const validateThread = Effect.fn("FollowUpService.validateThread")(function* (
    threadId: ThreadId,
    projectId: ProjectId,
  ) {
    const thread = yield* mapPersistence(getThread({ threadId }));
    if (Option.isNone(thread) || thread.value.projectId !== projectId) {
      return yield* invalidThreadError();
    }
  });

  const validateCommandLinks = Effect.fn("FollowUpService.validateCommandLinks")(function* (
    command: FollowUpDomainCommand,
  ) {
    if (command.type !== "file") {
      return;
    }
    yield* validateProject(command.input.projectId);
    if (command.input.sourceThreadId !== undefined && command.input.sourceThreadId !== null) {
      yield* validateThread(command.input.sourceThreadId, command.input.projectId);
    }
  });

  const projectEvent = Effect.fn("FollowUpService.projectEvent")(function* (event: FollowUpEvent) {
    yield* mapPersistence(upsertItem(event.payload.item));
  });

  const runCommand = (command: FollowUpDomainCommand) =>
    mutationMutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* mapPersistence(
          getEventByCommandId({ commandId: command.input.commandId }),
        );
        if (Option.isSome(existing)) {
          return existing.value.payload.item;
        }

        const event = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const snapshot = yield* getSnapshot();
              yield* validateCommandLinks(command);
              const now = DateTime.formatIso(yield* DateTime.now);
              const decision = decideFollowUpCommand(snapshot, command, now);
              if (decision.kind === "rejected") {
                return yield* decision.error;
              }

              const eventId = EventId.make(yield* crypto.randomUUIDv4);
              const inserted = yield* mapPersistence(
                appendEvent({
                  eventId,
                  commandId: command.input.commandId,
                  itemId: decision.event.payload.item.id,
                  type: decision.event.type,
                  occurredAt: now,
                  payload: decision.event.payload,
                }),
              );
              const persisted: FollowUpEvent = {
                sequence: inserted.sequence,
                eventId,
                commandId: command.input.commandId,
                type: decision.event.type,
                occurredAt: now,
                payload: decision.event.payload,
              };
              yield* projectEvent(persisted);
              return persisted;
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              isFollowUpOperationError(cause) ? cause : persistenceError(),
            ),
          );

        yield* PubSub.publish(changes, event);
        return event.payload.item;
      }),
    );

  const openBlockersForBranch = Effect.fn("FollowUpService.openBlockersForBranch")(function* (
    ref: string,
  ) {
    const items = yield* mapPersistence(listOpenBlockers({ ref }));
    return items.filter((item) => item.gate?.ref === ref);
  });

  const stream = Stream.unwrap(
    mutationMutex.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const latest = yield* getSnapshot();
        return Stream.concat(
          Stream.succeed<FollowUpStreamItem>({ kind: "snapshot", snapshot: latest }),
          Stream.fromSubscription(subscription).pipe(
            Stream.map((event): FollowUpStreamItem => ({ kind: "event", event })),
          ),
        );
      }),
    ),
  );

  return FollowUpService.of({
    file: (input) => runCommand({ type: "file", input }),
    updateStatus: (input) => runCommand({ type: "update-status", input }),
    getSnapshot: getSnapshot(),
    openBlockersForBranch,
    stream,
  });
});

export const layer = Layer.effect(FollowUpService, make);
