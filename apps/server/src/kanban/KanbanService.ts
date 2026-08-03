import {
  CommandId,
  EventId,
  KanbanCreateWorkItemInput,
  KanbanEvent,
  KanbanEventPayload,
  KanbanEventType,
  KanbanItemPosition,
  KanbanMoveWorkItemInput,
  KanbanOperationError,
  KanbanSnapshot,
  KanbanUpdateWorkItemInput,
  KanbanWorkItem,
  KanbanWorkItemId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  type KanbanArchiveWorkItemInput,
  type KanbanRestoreWorkItemInput,
  type KanbanStreamItem,
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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { decideKanbanCommand, type KanbanDomainCommand } from "./decider.ts";

interface KanbanServiceShape {
  readonly create: (
    input: KanbanCreateWorkItemInput,
  ) => Effect.Effect<KanbanWorkItem, KanbanOperationError>;
  readonly update: (
    input: KanbanUpdateWorkItemInput,
  ) => Effect.Effect<KanbanWorkItem, KanbanOperationError>;
  readonly move: (
    input: KanbanMoveWorkItemInput,
  ) => Effect.Effect<KanbanWorkItem, KanbanOperationError>;
  readonly archive: (
    input: KanbanArchiveWorkItemInput,
  ) => Effect.Effect<KanbanWorkItem, KanbanOperationError>;
  readonly restore: (
    input: KanbanRestoreWorkItemInput,
  ) => Effect.Effect<KanbanWorkItem, KanbanOperationError>;
  readonly getSnapshot: Effect.Effect<KanbanSnapshot, KanbanOperationError>;
  readonly stream: Stream.Stream<KanbanStreamItem, KanbanOperationError>;
}

export class KanbanService extends Context.Service<KanbanService, KanbanServiceShape>()(
  "t3/kanban/KanbanService",
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
  itemId: KanbanWorkItemId,
  type: KanbanEventType,
  occurredAt: Schema.String,
  payload: KanbanEventPayload,
});

const PersistedEventRow = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  commandId: CommandId,
  type: KanbanEventType,
  occurredAt: Schema.String,
  payload: Schema.fromJsonString(KanbanEventPayload),
});
const isKanbanOperationError = Schema.is(KanbanOperationError);

function persistenceError(): KanbanOperationError {
  return new KanbanOperationError({
    code: "persistence",
    message: "The board could not update its local store.",
  });
}

function invalidProjectError(): KanbanOperationError {
  return new KanbanOperationError({
    code: "invalid-project",
    message: "That project is no longer available in this environment.",
  });
}

function invalidThreadError(): KanbanOperationError {
  return new KanbanOperationError({
    code: "invalid-thread",
    message: "That thread is unavailable or belongs to another project.",
  });
}

function sortItems(items: ReadonlyArray<KanbanWorkItem>): KanbanWorkItem[] {
  return [...items].sort(
    (left, right) =>
      Number(left.archivedAt !== null) - Number(right.archivedAt !== null) ||
      left.status.localeCompare(right.status) ||
      left.position - right.position ||
      left.id.localeCompare(right.id),
  );
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.unbounded<KanbanEvent>();
  const mutationMutex = yield* Semaphore.make(1);

  const listItems = SqlSchema.findAll({
    Request: EmptyRequest,
    Result: KanbanWorkItem,
    execute: () => sql`
      SELECT
        item_id AS "id",
        project_id AS "projectId",
        thread_id AS "threadId",
        title,
        description,
        status,
        position,
        revision,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        archived_at AS "archivedAt"
      FROM kanban_work_items
      ORDER BY archived_at IS NOT NULL, status, position, item_id
    `,
  });

  const getLatestSequence = SqlSchema.findOne({
    Request: EmptyRequest,
    Result: SequenceRow,
    execute: () => sql`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM kanban_events
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
      FROM kanban_events
      WHERE command_id = ${commandId}
    `,
  });

  const appendEvent = SqlSchema.findOne({
    Request: AppendEventRequest,
    Result: SequenceRow,
    execute: (event) => sql`
      INSERT INTO kanban_events (
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
    Request: KanbanWorkItem,
    execute: (item) => sql`
      INSERT INTO kanban_work_items (
        item_id,
        project_id,
        thread_id,
        title,
        description,
        status,
        position,
        revision,
        created_at,
        updated_at,
        archived_at
      ) VALUES (
        ${item.id},
        ${item.projectId},
        ${item.threadId},
        ${item.title},
        ${item.description},
        ${item.status},
        ${item.position},
        ${item.revision},
        ${item.createdAt},
        ${item.updatedAt},
        ${item.archivedAt}
      )
      ON CONFLICT (item_id) DO UPDATE SET
        project_id = excluded.project_id,
        thread_id = excluded.thread_id,
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        position = excluded.position,
        revision = excluded.revision,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at
    `,
  });

  const updatePosition = SqlSchema.void({
    Request: KanbanItemPosition,
    execute: (position) => sql`
      UPDATE kanban_work_items
      SET status = ${position.status}, position = ${position.position}
      WHERE item_id = ${position.itemId}
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
  ): Effect.Effect<A, KanbanOperationError, R> =>
    effect.pipe(Effect.mapError(() => persistenceError()));

  const getSnapshot = Effect.fn("KanbanService.getSnapshot")(function* () {
    const [items, latest] = yield* Effect.all([
      mapPersistence(listItems({})),
      mapPersistence(getLatestSequence({})),
    ]);
    return {
      sequence: latest.sequence,
      items: sortItems(items),
    } satisfies KanbanSnapshot;
  });

  const validateProject = Effect.fn("KanbanService.validateProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* mapPersistence(getProject({ projectId }));
    if (Option.isNone(project)) {
      return yield* invalidProjectError();
    }
  });

  const validateThread = Effect.fn("KanbanService.validateThread")(function* (
    threadId: ThreadId,
    projectId: ProjectId,
  ) {
    const thread = yield* mapPersistence(getThread({ threadId }));
    if (Option.isNone(thread) || thread.value.projectId !== projectId) {
      return yield* invalidThreadError();
    }
  });

  const validateCommandLinks = Effect.fn("KanbanService.validateCommandLinks")(function* (
    command: KanbanDomainCommand,
    snapshot: KanbanSnapshot,
  ) {
    if (command.type === "create") {
      yield* validateProject(command.input.projectId);
      if (command.input.threadId !== undefined && command.input.threadId !== null) {
        yield* validateThread(command.input.threadId, command.input.projectId);
      }
      return;
    }

    if (
      command.type === "update" &&
      command.input.threadId !== undefined &&
      command.input.threadId !== null
    ) {
      const item = snapshot.items.find((candidate) => candidate.id === command.input.itemId);
      if (item !== undefined) {
        yield* validateThread(command.input.threadId, item.projectId);
      }
    }
  });

  const projectEvent = Effect.fn("KanbanService.projectEvent")(function* (event: KanbanEvent) {
    yield* mapPersistence(upsertItem(event.payload.item));
    yield* Effect.forEach(event.payload.positions, (position) =>
      mapPersistence(updatePosition(position)),
    );
  });

  const runCommand = (command: KanbanDomainCommand) =>
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
              yield* validateCommandLinks(command, snapshot);
              const now = DateTime.formatIso(yield* DateTime.now);
              const decision = decideKanbanCommand(snapshot, command, now);
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
              const persisted: KanbanEvent = {
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
              isKanbanOperationError(cause) ? cause : persistenceError(),
            ),
          );

        yield* PubSub.publish(changes, event);
        return event.payload.item;
      }),
    );

  const stream = Stream.unwrap(
    mutationMutex.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const latest = yield* getSnapshot();
        return Stream.concat(
          Stream.succeed<KanbanStreamItem>({ kind: "snapshot", snapshot: latest }),
          Stream.fromSubscription(subscription).pipe(
            Stream.map((event): KanbanStreamItem => ({ kind: "event", event })),
          ),
        );
      }),
    ),
  );

  return KanbanService.of({
    create: (input) => runCommand({ type: "create", input }),
    update: (input) => runCommand({ type: "update", input }),
    move: (input) => runCommand({ type: "move", input }),
    archive: (input) => runCommand({ type: "archive", input }),
    restore: (input) => runCommand({ type: "restore", input }),
    getSnapshot: getSnapshot(),
    stream,
  });
});

export const layer = Layer.effect(KanbanService, make);
