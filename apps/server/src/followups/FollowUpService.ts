import {
  CommandId,
  EventId,
  FollowUp,
  FollowUpEventPayload,
  FollowUpEventType,
  FollowUpGate,
  FollowUpOperationError,
  FollowUpResolution,
  FollowUpValidation,
  FollowUpSnapshot,
  FollowUpId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  type FollowUpEvent,
  type FollowUpFileCommand,
  type FollowUpRecordValidationCommand,
  type FollowUpStreamItem,
  type FollowUpUpdateStatusCommand,
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
  readonly file: (input: FollowUpFileCommand) => Effect.Effect<FollowUp, FollowUpOperationError>;
  readonly updateStatus: (
    input: FollowUpUpdateStatusCommand,
  ) => Effect.Effect<FollowUp, FollowUpOperationError>;
  readonly recordValidation: (
    input: FollowUpRecordValidationCommand,
  ) => Effect.Effect<FollowUp, FollowUpOperationError>;
  readonly getSnapshot: (
    projectId: ProjectId,
  ) => Effect.Effect<FollowUpSnapshot, FollowUpOperationError>;
  readonly openBlockersForBranch: (
    projectId: ProjectId,
    ref: string,
  ) => Effect.Effect<ReadonlyArray<FollowUp>, FollowUpOperationError>;
  readonly stream: (
    projectId: ProjectId,
  ) => Stream.Stream<FollowUpStreamItem, FollowUpOperationError>;
  readonly projectIdForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectId, FollowUpOperationError>;
  readonly projectIdForRepositoryPath: (
    cwd: string,
  ) => Effect.Effect<ProjectId, FollowUpOperationError>;
}

export class FollowUpService extends Context.Service<FollowUpService, FollowUpServiceShape>()(
  "t3/followups/FollowUpService",
) {}

const EmptyRequest = Schema.Struct({});
const CommandLookup = Schema.Struct({ commandId: CommandId });
const ProjectLookup = Schema.Struct({ projectId: ProjectId });
const ThreadLookup = Schema.Struct({ threadId: ThreadId });
const ItemLookup = Schema.Struct({ itemId: FollowUpId });
const RepositoryPathLookup = Schema.Struct({ cwd: Schema.String });

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
    lastValidation: Schema.NullOr(Schema.fromJsonString(FollowUpValidation)),
  }),
);

const BranchLookup = Schema.Struct({ projectId: ProjectId, ref: Schema.String });
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

function ambiguousProjectError(): FollowUpOperationError {
  return new FollowUpOperationError({
    code: "invalid-project",
    message: "Multiple projects own that repository path in this environment.",
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
    Request: ProjectLookup,
    Result: PersistedFollowUpRow,
    execute: ({ projectId }) => sql`
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
        last_validation_json AS "lastValidation",
        revision,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM follow_ups
      WHERE project_id = ${projectId}
      ORDER BY created_at, item_id
    `,
  });

  const listOpenBlockers = SqlSchema.findAll({
    Request: BranchLookup,
    Result: PersistedFollowUpRow,
    execute: ({ projectId }) => sql`
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
        last_validation_json AS "lastValidation",
        revision,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM follow_ups
      WHERE project_id = ${projectId}
        AND kind = 'blocker' AND status = 'open'
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
        last_validation_json,
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
        ${item.lastValidation === null ? null : JSON.stringify(item.lastValidation)},
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
        last_validation_json = excluded.last_validation_json,
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

  const getItemProject = SqlSchema.findOneOption({
    Request: ItemLookup,
    Result: ProjectRow,
    execute: ({ itemId }) => sql`
      SELECT project_id AS "projectId"
      FROM follow_ups
      WHERE item_id = ${itemId}
    `,
  });

  const getProjectsForRepositoryPath = SqlSchema.findAll({
    Request: RepositoryPathLookup,
    Result: ProjectRow,
    execute: ({ cwd }) => sql`
      SELECT project_id AS "projectId"
      FROM projection_projects
      WHERE workspace_root = ${cwd} AND deleted_at IS NULL
      UNION
      SELECT thread.project_id AS "projectId"
      FROM projection_threads AS thread
      INNER JOIN projection_projects AS project
        ON project.project_id = thread.project_id AND project.deleted_at IS NULL
      WHERE thread.worktree_path = ${cwd} AND thread.deleted_at IS NULL
    `,
  });

  const mapPersistence = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, FollowUpOperationError, R> =>
    effect.pipe(Effect.mapError(() => persistenceError()));

  const loadSnapshot = Effect.fn("FollowUpService.loadSnapshot")(function* (projectId: ProjectId) {
    const [items, latest] = yield* Effect.all([
      mapPersistence(listItems({ projectId })),
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

  const getSnapshot = Effect.fn("FollowUpService.getSnapshot")(function* (projectId: ProjectId) {
    yield* validateProject(projectId);
    return yield* loadSnapshot(projectId);
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
    yield* validateProject(command.input.projectId);
    if (command.type === "file") {
      if (command.input.sourceThreadId !== undefined && command.input.sourceThreadId !== null) {
        yield* validateThread(command.input.sourceThreadId, command.input.projectId);
      }
      return;
    }
    if (command.type === "update-status") {
      const resolutionThreadId = command.input.resolution?.threadId ?? null;
      if (resolutionThreadId !== null) {
        yield* validateThread(resolutionThreadId, command.input.projectId);
      }
      return;
    }
    yield* validateThread(command.input.threadId, command.input.projectId);
  });

  const validateItemProject = Effect.fn("FollowUpService.validateItemProject")(function* (
    command: FollowUpDomainCommand,
  ) {
    const owner = yield* mapPersistence(getItemProject({ itemId: command.input.itemId }));
    if (Option.isSome(owner) && owner.value.projectId !== command.input.projectId) {
      return yield* invalidProjectError();
    }
  });

  const projectEvent = Effect.fn("FollowUpService.projectEvent")(function* (event: FollowUpEvent) {
    yield* mapPersistence(upsertItem(event.payload.item));
  });

  const runCommand = (command: FollowUpDomainCommand) =>
    mutationMutex.withPermits(1)(
      Effect.gen(function* () {
        yield* validateProject(command.input.projectId);
        const existing = yield* mapPersistence(
          getEventByCommandId({ commandId: command.input.commandId }),
        );
        if (Option.isSome(existing)) {
          if (existing.value.payload.item.projectId !== command.input.projectId) {
            return yield* invalidProjectError();
          }
          return existing.value.payload.item;
        }

        const event = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const snapshot = yield* loadSnapshot(command.input.projectId);
              yield* validateItemProject(command);
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
    projectId: ProjectId,
    ref: string,
  ) {
    yield* validateProject(projectId);
    const items = yield* mapPersistence(listOpenBlockers({ projectId, ref }));
    return items.filter((item) => item.gate?.ref === ref);
  });

  const stream = (projectId: ProjectId) =>
    Stream.unwrap(
      mutationMutex.withPermits(1)(
        Effect.gen(function* () {
          yield* validateProject(projectId);
          const subscription = yield* PubSub.subscribe(changes);
          const latest = yield* loadSnapshot(projectId);
          return Stream.concat(
            Stream.succeed<FollowUpStreamItem>({ kind: "snapshot", snapshot: latest }),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) => event.payload.item.projectId === projectId),
              Stream.map((event): FollowUpStreamItem => ({ kind: "event", event })),
            ),
          );
        }),
      ),
    );

  const projectIdForThread = Effect.fn("FollowUpService.projectIdForThread")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* mapPersistence(getThread({ threadId }));
    if (Option.isNone(thread)) {
      return yield* invalidThreadError();
    }
    return thread.value.projectId;
  });

  const projectIdForRepositoryPath = Effect.fn("FollowUpService.projectIdForRepositoryPath")(
    function* (cwd: string) {
      const projects = yield* mapPersistence(getProjectsForRepositoryPath({ cwd }));
      if (projects.length === 0) {
        return yield* invalidProjectError();
      }
      if (projects.length > 1) {
        return yield* ambiguousProjectError();
      }
      return projects[0]!.projectId;
    },
  );

  return FollowUpService.of({
    file: (input) => runCommand({ type: "file", input }),
    updateStatus: (input) => runCommand({ type: "update-status", input }),
    recordValidation: (input) => runCommand({ type: "record-validation", input }),
    getSnapshot,
    openBlockersForBranch,
    stream,
    projectIdForThread,
    projectIdForRepositoryPath,
  });
});

export const layer = Layer.effect(FollowUpService, make);
