import {
  CommandId,
  DelegationFollowThroughDeliveredPayload,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { isChildOfParent } from "../mcp/toolkits/delegation/logic.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  observeDelegatedChild,
  isActionableDelegationObservation,
  isDelegationParentEligible,
  formatDelegationFollowThroughPrompt,
} from "./delegationFollowThrough.logic.ts";

const OBSERVED = "delegation.child-state";
const DELIVERED = "delegation.follow-through.delivered";
const PAUSED = "delegation.follow-through.paused";
const MESSAGE_PREFIX = "delegation-follow-through:";
const MAX_AUTOMATIC_TURNS = 3;
const ObservationReceipt = Schema.Struct({
  childThreadId: ThreadId,
  noticeKey: Schema.String,
  notificationId: EventId,
  baseline: Schema.optional(Schema.Boolean),
});
const decodeObservation = Schema.decodeUnknownOption(ObservationReceipt);
const decodeDelivered = Schema.decodeUnknownOption(DelegationFollowThroughDeliveredPayload);

function parentIdOf(id: ThreadId): ThreadId | null {
  const match = /^delegated:(.+):[0-9a-f]{16}$/.exec(id);
  return match?.[1] ? ThreadId.make(match[1]) : null;
}

function relevantEvent(event: OrchestrationEvent): boolean {
  if (event.metadata.historyImport === true) return false;
  switch (event.type) {
    case "thread.created":
    case "thread.session-set":
    case "thread.turn-start-requested":
    case "thread.turn-interrupt-requested":
    case "thread.turn-diff-completed":
    case "thread.unarchived":
      return true;
    case "thread.activity-appended":
      // Claude carries meaningful task status changes on progress events too.
      // Usage/heartbeat progress without status must not schedule database work.
      if (event.payload.activity.kind === "task.progress") {
        const payload = event.payload.activity.payload;
        return (
          typeof payload === "object" &&
          payload !== null &&
          "status" in payload &&
          typeof payload.status === "string"
        );
      }
      return [
        "approval.requested",
        "approval.resolved",
        "user-input.requested",
        "user-input.resolved",
        "runtime.error",
        "provider.turn.start.failed",
        "task.started",
        "task.updated",
        "task.completed",
      ].includes(event.payload.activity.kind);
    default:
      return false;
  }
}

export class DelegationFollowThroughReactor extends Context.Service<
  DelegationFollowThroughReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/DelegationFollowThroughReactor") {}

/** Child notifications reuse persisted activities, command receipts, and normal turn admission. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const parents = new Set<ThreadId>();
  const digest = (text: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(text))
      .pipe(
        Effect.map((bytes) =>
          Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        ),
      );
  type Work = { parentId: ThreadId; liveChildId?: ThreadId; causeId: string };
  const process = Effect.fn("DelegationFollowThroughReactor.process")(function* (work: Work) {
    const parentOption = yield* snapshots.getThreadShellById(work.parentId);
    if (Option.isNone(parentOption)) return;
    const parent = parentOption.value;
    const settings = resolveProjectSettings(
      yield* settingsService.getSettings,
      parent.projectId,
    ).settings;
    if (!settings.enableAgentDelegation) return;
    const snapshot = yield* snapshots.getShellSnapshot();
    const children = snapshot.threads.filter((child) => isChildOfParent(child.id, parent.id));
    if (children.length === 0) return;
    const detailOption = yield* snapshots.getThreadDetailById(parent.id, {
      activityKinds: [OBSERVED, DELIVERED, PAUSED],
    });
    if (Option.isNone(detailOption)) return;
    const detail = detailOption.value;
    const previous = new Map<ThreadId, typeof ObservationReceipt.Type>();
    const delivered = new Set<EventId>();
    const observations = yield* snapshots.getDelegationObservationActivities({
      threadId: parent.id,
      childThreadIds: children.map((child) => child.id),
    });
    for (const activity of [...detail.activities, ...observations]) {
      if (activity.kind === OBSERVED) {
        const decoded = decodeObservation(activity.payload);
        if (Option.isSome(decoded)) previous.set(decoded.value.childThreadId, decoded.value);
      } else if (activity.kind === DELIVERED) {
        const decoded = decodeDelivered(activity.payload);
        if (Option.isSome(decoded))
          for (const id of decoded.value.notificationIds) delivered.add(id);
      }
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const pending: {
      observation: NonNullable<ReturnType<typeof observeDelegatedChild>>;
      notificationId: EventId;
      updatedAt: string;
    }[] = [];
    for (const child of children) {
      const requests =
        child.hasPendingApprovals || child.hasPendingUserInput
          ? yield* snapshots.getPendingRequestActivities({ threadId: child.id })
          : [];
      const observation = observeDelegatedChild(child, {
        approvalIds: requests
          .filter((entry) => entry.kind === "approval.requested")
          .map((entry) => entry.id),
        inputIds: requests
          .filter((entry) => entry.kind === "user-input.requested")
          .map((entry) => entry.id),
      });
      if (observation === null) continue;
      const old = previous.get(child.id);
      // Startup baselines old terminal children. Previously armed or pending work
      // recovers from its persisted observation; new lifecycle events are live.
      const baseline =
        old?.noticeKey === observation.noticeKey
          ? old.baseline === true
          : !old && work.liveChildId !== child.id && isActionableDelegationObservation(observation);
      const notificationId = EventId.make(
        `delegation-notice:${yield* digest(observation.noticeKey)}`,
      );
      if (old?.noticeKey !== observation.noticeKey) {
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(
            `delegation-observe:${yield* digest(`${child.id}:${work.causeId}:${observation.noticeKey}`)}`,
          ),
          threadId: parent.id,
          activity: {
            id: EventId.make(`delegation-observation:${child.id}`),
            kind: OBSERVED,
            tone: "info",
            summary: `Pylon child ${observation.phase}`,
            payload: {
              childThreadId: child.id,
              noticeKey: observation.noticeKey,
              notificationId,
              baseline,
            },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        });
      }
      if (
        !baseline &&
        isActionableDelegationObservation(observation) &&
        !delivered.has(notificationId)
      )
        pending.push({ observation, notificationId, updatedAt: child.updatedAt });
    }
    if (pending.length === 0) return;
    const persistedDelivered = yield* snapshots.getDeliveredDelegationNotificationIds({
      threadId: parent.id,
      notificationIds: pending.map((item) => item.notificationId),
    });
    const persistedDeliveredSet = new Set(persistedDelivered);
    const undelivered = pending.filter((item) => !persistedDeliveredSet.has(item.notificationId));
    if (undelivered.length === 0) return;

    // Reload after our observation writes; the decider repeats eligibility and
    // freshness checks atomically so a user Stop cannot be raced by this wake.
    const current = yield* snapshots.getThreadShellById(parent.id);
    if (Option.isNone(current) || !isDelegationParentEligible(current.value, Date.parse(now)))
      return;
    let automaticTurns = 0;
    let lastUserMessageId = "initial";
    for (const message of detail.messages) {
      if (message.role !== "user") continue;
      if (message.id.startsWith(MESSAGE_PREFIX)) automaticTurns++;
      else {
        automaticTurns = 0;
        lastUserMessageId = message.id;
      }
    }
    if (automaticTurns >= MAX_AUTOMATIC_TURNS) {
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(
          `delegation-follow-through-limit:${parent.id}:${lastUserMessageId}`,
        ),
        threadId: parent.id,
        activity: {
          id: EventId.make(`delegation-follow-through-limit:${parent.id}:${lastUserMessageId}`),
          kind: PAUSED,
          tone: "info",
          summary: "Automatic delegation follow-through paused",
          payload: {
            detail:
              "Three automatic follow-through turns have run. Send a message to continue; child statuses remain available in Agents.",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      });
      return;
    }
    const ids = undelivered.map((item) => item.notificationId).sort();
    const deliveryKey = yield* digest(ids.join("\n"));
    yield* engine.dispatch({
      type: "thread.delegation.follow-through",
      commandId: CommandId.make(
        `delegation-wake:${deliveryKey}:${yield* digest(current.value.updatedAt)}`,
      ),
      threadId: parent.id,
      expectedParentUpdatedAt: current.value.updatedAt,
      expectedSourceEpoch: current.value.sourceEpoch ?? 0,
      children: undelivered.map((item) => ({
        threadId: item.observation.childThreadId,
        updatedAt: item.updatedAt,
      })),
      messageId: MessageId.make(`${MESSAGE_PREFIX}${deliveryKey}`),
      text: formatDelegationFollowThroughPrompt(undelivered.map((item) => item.observation)),
      notificationIds: ids,
      createdAt: now,
    });
  });
  const worker = yield* makeDrainableWorker((work: Work) =>
    process(work).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Pylon delegation follow-through failed", {
              parentId: work.parentId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );
  const processEvent = (event: OrchestrationEvent) => {
    if (!relevantEvent(event) || !("threadId" in event.payload)) return Effect.void;
    const threadId = event.payload.threadId;
    const parentId = parentIdOf(threadId);
    if (parentId) {
      parents.add(parentId);
      return worker.enqueue({ parentId, liveChildId: threadId, causeId: event.eventId });
    }
    return parents.has(threadId)
      ? worker.enqueue({ parentId: threadId, causeId: event.eventId })
      : Effect.void;
  };
  const start = Effect.fn("DelegationFollowThroughReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
    yield* forkParked(
      Effect.gen(function* () {
        const snapshot = yield* snapshots.getShellSnapshot();
        for (const child of snapshot.threads) {
          const parentId = parentIdOf(child.id);
          if (parentId) parents.add(parentId);
        }
        for (const parentId of parents)
          yield* worker.enqueue({ parentId, causeId: `startup:${snapshot.snapshotSequence}` });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Pylon delegation recovery failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    );
  });
  return { start, drain: worker.drain };
});
export const layer = Layer.effect(DelegationFollowThroughReactor, make);
