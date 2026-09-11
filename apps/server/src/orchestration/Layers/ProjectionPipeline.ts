import {
  ApprovalRequestId,
  isImportedAgentSessionMessageId,
  NonNegativeInt,
  UserInputAttachmentAnswerPayload,
  type ChatAttachment,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  ThreadId,
} from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import {
  type ProjectionState,
  ProjectionStateRepository,
} from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { type ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  type ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
} from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  resolveThreadBrowserArtifactsDir,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  threads: "projection.threads",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
} as const;

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

/**
 * Turn state to settle still-running turns with when their session leaves the
 * "running" status, or null while the session is (re)starting or running and
 * turns must stay unsettled.
 */
function settledTurnStateForSessionStatus(
  status: OrchestrationSessionStatus,
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly apply: (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

interface AttachmentSideEffects {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
}

const materializeAttachmentsForProjection = Effect.fn("materializeAttachmentsForProjection")(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.make(requestId) : null;
}

function isStalePendingApprovalFailureDetail(detail: string | null): boolean {
  if (detail === null) {
    return false;
  }
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request")
  );
}

// A refresh reads each persisted summary source, so skip activities that cannot change the result.
function shouldRefreshThreadShellSummary(event: OrchestrationEvent): boolean {
  if (event.type !== "thread.activity-appended") {
    return true;
  }

  switch (event.payload.activity.kind) {
    case "approval.requested":
    case "approval.resolved":
    case "provider.approval.respond.failed":
    case "user-input.requested":
    case "user-input.resolved":
    case "provider.user-input.respond.failed":
    // Pylon's Prime adapter emits generic interaction activities for the same
    // pending-input shell count. Skipping these would leave the sidebar stale.
    case "interaction.requested":
    case "interaction.resolved":
    case "provider.interaction.respond.failed":
      return true;
    default:
      return false;
  }
}

function derivePendingUserInputCountFromActivities(
  activities: ReadonlyArray<ProjectionThreadActivity>,
): number {
  const openRequestIds = new Set<string>();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );

  for (const activity of ordered) {
    const requestId = extractActivityRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;

    if (activity.kind === "user-input.requested" || activity.kind === "interaction.requested") {
      openRequestIds.add(requestId);
      continue;
    }

    if (activity.kind === "user-input.resolved" || activity.kind === "interaction.resolved") {
      openRequestIds.delete(requestId);
      continue;
    }

    if (
      (activity.kind === "provider.user-input.respond.failed" ||
        activity.kind === "provider.interaction.respond.failed") &&
      detail !== null &&
      (detail.includes("stale pending user-input request") ||
        detail.includes("unknown pending user-input request") ||
        detail.includes("unknown pending user input request") ||
        detail.includes("unknown pending codex user input request") ||
        detail.includes("stale pending interaction request") ||
        detail.includes("unknown pending interaction request"))
    ) {
      openRequestIds.delete(requestId);
    }
  }

  return openRequestIds.size;
}

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system" || isImportedAgentSessionMessageId(message.messageId)) {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) =>
      message.role === "user" &&
      !isImportedAgentSessionMessageId(message.messageId) &&
      retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          compareDateTimeStrings(left.createdAt, right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) =>
      message.role === "assistant" &&
      !isImportedAgentSessionMessageId(message.messageId) &&
      retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          compareDateTimeStrings(left.createdAt, right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadActivity> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

const decodeQuestionAttachmentAnswer = Schema.decodeUnknownOption(UserInputAttachmentAnswerPayload);

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return new Set();
  }
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachment.id);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        continue;
      }
      const relativePath = attachmentRelativePath(attachment);
      if (relativePath) {
        relativePaths.add(relativePath);
      }
    }
  }
  return relativePaths;
}

/** Cursor row in `projection_state` for attachment cleanup. It is not a projector. */
const ATTACHMENT_CLEANUP_CURSOR = "projection.attachment-cleanup";

/** One thread's file cleanup, merged from its latest revert and delete. */
interface AttachmentCleanupTarget {
  readonly threadId: string;
  /** Remove every file unless the thread was re-created after this sequence. */
  readonly deletedAtSequence: number | null;
  /** Keep only files the thread's current messages and answers reference. */
  readonly pruned: boolean;
}

function attachmentCleanupTargets(
  event: OrchestrationEvent,
  sideEffects: AttachmentSideEffects,
): Array<AttachmentCleanupTarget> {
  const targets: Array<AttachmentCleanupTarget> = [...sideEffects.deletedThreadIds].map(
    (threadId) => ({
      threadId,
      deletedAtSequence: event.sequence,
      pruned: sideEffects.prunedThreadRelativePaths.has(threadId),
    }),
  );
  for (const threadId of sideEffects.prunedThreadRelativePaths.keys()) {
    if (!sideEffects.deletedThreadIds.has(threadId)) {
      targets.push({ threadId, deletedAtSequence: null, pruned: true });
    }
  }
  return targets;
}

/** Groups attachment directory entries by the thread segment in their attachment ids. */
function groupAttachmentFilesByThreadSegment(
  entries: ReadonlyArray<string>,
): Map<string, Array<string>> {
  const filesBySegment = new Map<string, Array<string>>();
  for (const entry of entries) {
    const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (relativePath.length === 0 || relativePath.includes("/")) {
      continue;
    }
    const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
    const threadSegment = attachmentId ? parseThreadSegmentFromAttachmentId(attachmentId) : null;
    if (!threadSegment) {
      continue;
    }
    const files = filesBySegment.get(threadSegment);
    if (files) {
      files.push(relativePath);
    } else {
      filesBySegment.set(threadSegment, [relativePath]);
    }
  }
  return filesBySegment;
}

/** The lowest projector cursor, or undefined while any projector has none. */
function lowestProjectorCursor(
  states: ReadonlyArray<ProjectionState>,
): ProjectionState | undefined {
  const byProjector = new Map(states.map((state) => [state.projector, state]));
  let lowest: ProjectionState | undefined;
  for (const name of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
    const state = byProjector.get(name);
    if (!state) {
      return undefined;
    }
    if (!lowest || state.lastAppliedSequence < lowest.lastAppliedSequence) {
      lowest = state;
    }
  }
  return lowest;
}

const AttachmentCleanupEventRow = Schema.Struct({
  sequence: NonNegativeInt,
  type: Schema.Literals(["thread.reverted", "thread.deleted"]),
  threadId: ThreadId,
});
const decodeAttachmentCleanupEventRow = Schema.decodeUnknownOption(AttachmentCleanupEventRow);

const makeOrchestrationProjectionPipeline = Effect.fn("makeOrchestrationProjectionPipeline")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* OrchestrationEventStore;
    const projectionStateRepository = yield* ProjectionStateRepository;
    const projectionProjectRepository = yield* ProjectionProjectRepository;
    const projectionThreadRepository = yield* ProjectionThreadRepository;
    const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
    const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
    const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
    const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    const applyProjectsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyProjectsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "project.created":
          yield* projectionProjectRepository.upsert({
            projectId: event.payload.projectId,
            title: event.payload.title,
            workspaceRoot: event.payload.workspaceRoot,
            defaultModelSelection: event.payload.defaultModelSelection,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: event.payload.faviconPath ?? null,
            projectIcon: event.payload.projectIcon ?? null,
            scripts: event.payload.scripts,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          });
          return;

        case "project.meta-updated": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: event.payload.workspaceRoot }
              : {}),
            ...(event.payload.defaultModelSelection !== undefined
              ? { defaultModelSelection: event.payload.defaultModelSelection }
              : {}),
            ...(event.payload.defaultThreadEnvMode !== undefined
              ? { defaultThreadEnvMode: event.payload.defaultThreadEnvMode }
              : {}),
            ...(event.payload.autoPull !== undefined ? { autoPull: event.payload.autoPull } : {}),
            ...(event.payload.faviconPath !== undefined
              ? { faviconPath: event.payload.faviconPath }
              : {}),
            ...(event.payload.projectIcon !== undefined
              ? { projectIcon: event.payload.projectIcon }
              : {}),
            ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "project.deleted": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const refreshThreadShellSummary = Effect.fn("refreshThreadShellSummary")(function* (
      threadId: ThreadId,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }

      const [latestUserMessageAt, hasActionableProposedPlan, activities, pendingApprovalCount] =
        yield* Effect.all([
          projectionThreadMessageRepository.getLatestUserMessageAt({ threadId }),
          projectionThreadProposedPlanRepository.hasActionableByThreadId({
            threadId,
            latestTurnId: existingRow.value.latestTurnId,
          }),
          projectionThreadActivityRepository.listUserInputLifecycleByThreadId({ threadId }),
          projectionPendingApprovalRepository.countPendingByThreadId({ threadId }),
        ]);

      const pendingUserInputCount = derivePendingUserInputCountFromActivities(activities);

      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        latestUserMessageAt,
        pendingApprovalCount,
        pendingUserInputCount,
        hasActionableProposedPlan: hasActionableProposedPlan ? 1 : 0,
      });
    });

    const applyThreadsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadsProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            modelSelection: event.payload.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            linkedPullRequest: null,
            branchPullRequest: null,
            latestTurnId: null,
            rollbackStatus: null,
            rollbackUpdatedAt: null,
            sourceEpoch: 0,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            continuedFromThreadId: event.payload.continuedFromThreadId ?? null,
            pinOrderKey: null,
            activeOrderKey: null,
            titleRegenerationRequestId: null,
            titleRegenerationStartedAt: null,
            latestUserMessageAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            deletedAt: null,
          });
          return;

        case "thread.archived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: event.payload.archivedAt,
            titleRegenerationRequestId: null,
            titleRegenerationStartedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unarchived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.settled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: "settled",
            settledAt: event.payload.settledAt,
            unsettledAt: null,
            activeOrderKey: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsettled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: event.payload.reason === "user" ? "active" : null,
            settledAt: null,
            // Re-entry stamp for active-list ordering. A thread already pinned
            // active keeps its stamp: the activity reset that clears the pin
            // is not a re-entry and must not reorder the list.
            unsettledAt:
              existingRow.value.settledOverride === "active"
                ? existingRow.value.unsettledAt
                : event.payload.updatedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.snoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: event.payload.snoozedUntil,
            snoozedAt: event.payload.snoozedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsnoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: event.payload.pinnedAt,
            ...(event.payload.pinOrderKey !== undefined
              ? { pinOrderKey: event.payload.pinOrderKey }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unpinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: null,
            pinOrderKey: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pin-reordered": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinOrderKey: event.payload.orderKey,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.meta-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.activeOrderKey !== undefined
              ? { activeOrderKey: event.payload.activeOrderKey }
              : {}),
            ...(event.payload.titleRegeneration !== undefined
              ? {
                  titleRegenerationRequestId: event.payload.titleRegeneration?.requestId ?? null,
                  titleRegenerationStartedAt: event.payload.titleRegeneration?.startedAt ?? null,
                }
              : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            ...(event.payload.linkedPullRequest !== undefined
              ? { linkedPullRequest: event.payload.linkedPullRequest }
              : {}),
            ...(event.payload.branchPullRequest !== undefined
              ? { branchPullRequest: event.payload.branchPullRequest }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.interaction-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.deleted": {
          // A draft retry can re-create this id later in the log. During
          // replay the attachment files on disk already belong to that later
          // incarnation, so only an unsuperseded deletion removes them.
          const recreatedLater = yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: event.payload.threadId,
            type: "thread.created",
            sequenceExclusive: event.sequence,
          });
          if (!recreatedLater) {
            attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
          }
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        // A message cannot change any summary field except latestUserMessageAt,
        // which is a monotonic maximum that folds in directly. The full refresh
        // would re-read every message body in the thread per user message.
        case "thread.message-sent": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const previousLatest = existingRow.value.latestUserMessageAt;
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
            latestUserMessageAt:
              event.payload.role === "user" &&
              !isImportedAgentSessionMessageId(event.payload.messageId) &&
              (previousLatest === null || event.payload.createdAt > previousLatest)
                ? event.payload.createdAt
                : previousLatest,
          });
          return;
        }

        case "thread.proposed-plan-upserted":
        case "thread.activity-appended":
        case "thread.approval-response-requested":
        case "thread.user-input-response-requested":
        case "thread.interaction-response-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          });
          if (shouldRefreshThreadShellSummary(event)) {
            yield* refreshThreadShellSummary(event.payload.threadId);
          }
          return;
        }

        case "thread.session-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            // activeTurnId describes current work; a terminal session must not erase history.
            latestTurnId: event.payload.session.activeTurnId ?? existingRow.value.latestTurnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.turn-diff-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.turnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.rollback-status-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) return;
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            rollbackStatus: event.payload.status,
            rollbackUpdatedAt: event.payload.updatedAt,
            updatedAt: event.payload.updatedAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.reverted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }

          const retainedTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          let latestTurnId: ProjectionTurn["turnId"] = null;
          let latestCheckpointTurnCount = -1;
          for (let index = 0; index < retainedTurns.length; index += 1) {
            const turn = retainedTurns[index];
            if (
              !turn ||
              turn.turnId === null ||
              turn.checkpointTurnCount === null ||
              turn.checkpointTurnCount > event.payload.turnCount
            ) {
              continue;
            }
            if (turn.checkpointTurnCount > latestCheckpointTurnCount) {
              latestCheckpointTurnCount = turn.checkpointTurnCount;
              latestTurnId = turn.turnId;
            }
          }

          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId,
            rollbackStatus: null,
            rollbackUpdatedAt: event.occurredAt,
            sourceEpoch: existingRow.value.sourceEpoch + 1,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadMessagesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadMessagesProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        // A draft retry re-creates a soft-deleted thread id. Every projector
        // drops its own rows for the old incarnation here so replay from any
        // per-projector cursor rebuilds the new thread without stale history.
        case "thread.created":
          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.message-sent": {
          if (event.payload.streaming) {
            const attachments =
              event.payload.attachments !== undefined
                ? yield* materializeAttachmentsForProjection({
                    attachments: event.payload.attachments,
                  })
                : undefined;
            yield* projectionThreadMessageRepository.appendStreaming({
              messageId: event.payload.messageId,
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
              role: event.payload.role,
              text: event.payload.text,
              ...(attachments !== undefined ? { attachments: [...attachments] } : {}),
              createdAt: event.payload.createdAt,
              updatedAt: event.payload.updatedAt,
            });
            return;
          }

          const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
            messageId: event.payload.messageId,
          });
          const previousMessage = Option.getOrUndefined(existingMessage);
          const nextText = Option.match(existingMessage, {
            onNone: () => event.payload.text,
            onSome: (message) =>
              event.payload.text.length === 0 ? message.text : event.payload.text,
          });
          const nextAttachments =
            event.payload.attachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: event.payload.attachments,
                })
              : previousMessage?.attachments;
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            role: event.payload.role,
            text: nextText,
            ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
            isStreaming: false,
            createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionMessagesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          attachmentSideEffects.prunedThreadRelativePaths.set(
            event.payload.threadId,
            collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
          );
          return;
        }

        default:
          return;
      }
    });

    const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadProposedPlansProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.proposed-plan-upserted":
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionProposedPlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadActivitiesProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.activity-appended":
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionActivitiesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          attachmentSideEffects.prunedThreadRelativePaths.set(event.payload.threadId, new Set());
          return;
        }

        default:
          return;
      }
    });

    const applyThreadSessionsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadSessionsProjection",
    )(function* (event, _attachmentSideEffects) {
      if (event.type === "thread.created") {
        yield* projectionThreadSessionRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        return;
      }
      if (event.type === "thread.turn-start-requested") {
        const existing = yield* projectionThreadSessionRepository.getByThreadId({
          threadId: event.payload.threadId,
        });
        if (Option.isSome(existing) && existing.value.status === "running") return;
        const legacyAdmissionSentinel = "1970-01-01T00:00:00.000Z";
        const isLegacyAdmission = event.payload.admissionRequestedAt === undefined;
        // Preserve the legacy event fingerprint while making its deadline
        // immediately overdue. This lets full replay detect the same ambiguous
        // duplicate set that migration 048 sees in SQL.
        const requestedAt = event.payload.admissionRequestedAt ?? event.payload.createdAt;
        const deadlineAt = event.payload.admissionDeadlineAt ?? legacyAdmissionSentinel;
        const pendingSession = Option.getOrElse(existing, () => ({
          threadId: event.payload.threadId,
          status: "starting" as const,
          providerName: null,
          providerInstanceId: null,
          runtimeMode: event.payload.runtimeMode,
          restored: false,
          startedAt: null,
          sessionIncarnationId: null,
          harnessRefinementStatus: null,
          pendingTurnRequestId: null,
          pendingTurnRequestAmbiguous: false,
          pendingTurnMessageId: null,
          pendingTurnRequestedAt: null,
          pendingTurnDeadlineAt: null,
          pendingTurnSessionId: null,
          activeTurnRequestId: null,
          failedTurnRequestId: null,
          pendingStopRequestId: null,
          pendingStopProviderInstanceId: null,
          pendingStopSessionIncarnationId: null,
          pendingStopTurnRequestId: null,
          pendingStopTurnId: null,
          activeTurnId: null,
          lastError: null,
          updatedAt: event.occurredAt,
        }));
        const duplicatesCurrentLegacyAdmission =
          isLegacyAdmission &&
          pendingSession.status === "starting" &&
          pendingSession.pendingTurnMessageId === event.payload.messageId &&
          pendingSession.pendingTurnRequestedAt === event.payload.createdAt &&
          (pendingSession.pendingTurnRequestId !== null ||
            pendingSession.pendingTurnRequestAmbiguous);
        yield* projectionThreadSessionRepository.upsert({
          ...pendingSession,
          status: "starting",
          pendingTurnRequestId: duplicatesCurrentLegacyAdmission ? null : event.commandId,
          pendingTurnRequestAmbiguous: duplicatesCurrentLegacyAdmission,
          pendingTurnMessageId: event.payload.messageId,
          pendingTurnRequestedAt: requestedAt,
          pendingTurnDeadlineAt: deadlineAt,
          pendingTurnSessionId: pendingSession.sessionIncarnationId,
          activeTurnRequestId: null,
        });
        return;
      }
      if (event.type !== "thread.session-set") return;

      const incoming = event.payload.session;
      const existing = yield* projectionThreadSessionRepository.getByThreadId({
        threadId: event.payload.threadId,
      });
      const preserved = Option.getOrUndefined(existing);
      const preserveHistoricalPending =
        incoming.status === "starting" &&
        incoming.pendingTurnRequestId === undefined &&
        ((preserved?.pendingTurnRequestId !== null &&
          preserved?.pendingTurnRequestId !== undefined) ||
          preserved?.pendingTurnRequestAmbiguous === true);
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: incoming.status,
        providerName: incoming.providerName,
        providerInstanceId: incoming.providerInstanceId ?? null,
        runtimeMode: incoming.runtimeMode,
        restored: incoming.restored === true,
        startedAt: incoming.startedAt ?? null,
        sessionIncarnationId: incoming.sessionIncarnationId ?? null,
        harnessRefinementStatus: incoming.harnessRefinementStatus ?? null,
        pendingTurnRequestId: preserveHistoricalPending
          ? preserved.pendingTurnRequestId
          : (incoming.pendingTurnRequestId ?? null),
        pendingTurnRequestAmbiguous: preserveHistoricalPending
          ? preserved.pendingTurnRequestAmbiguous
          : false,
        pendingTurnMessageId: preserveHistoricalPending
          ? preserved.pendingTurnMessageId
          : (incoming.pendingTurnMessageId ?? null),
        pendingTurnRequestedAt: preserveHistoricalPending
          ? preserved.pendingTurnRequestedAt
          : (incoming.pendingTurnRequestedAt ?? null),
        pendingTurnDeadlineAt: preserveHistoricalPending
          ? preserved.pendingTurnDeadlineAt
          : (incoming.pendingTurnDeadlineAt ?? null),
        pendingTurnSessionId: preserveHistoricalPending
          ? (incoming.sessionIncarnationId ?? preserved.pendingTurnSessionId)
          : (incoming.pendingTurnSessionId ?? null),
        activeTurnRequestId: incoming.activeTurnRequestId ?? null,
        failedTurnRequestId: incoming.failedTurnRequestId ?? null,
        pendingStopRequestId: incoming.pendingStopRequestId ?? null,
        pendingStopProviderInstanceId:
          incoming.pendingStopRequestId === undefined
            ? null
            : (incoming.pendingStopProviderInstanceId ?? null),
        pendingStopSessionIncarnationId:
          incoming.pendingStopRequestId === undefined
            ? null
            : (incoming.pendingStopSessionIncarnationId ?? null),
        pendingStopTurnRequestId:
          incoming.pendingStopRequestId === undefined
            ? null
            : (incoming.pendingStopTurnRequestId ?? null),
        pendingStopTurnId:
          incoming.pendingStopRequestId === undefined ? null : (incoming.pendingStopTurnId ?? null),
        activeTurnId: incoming.activeTurnId,
        lastError: incoming.lastError,
        updatedAt: incoming.updatedAt,
      });
    });

    const applyThreadTurnsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadTurnsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.turn-start-requested": {
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isSome(pendingTurnStart)) {
            const pendingMessage = yield* projectionThreadMessageRepository.getByMessageId({
              messageId: pendingTurnStart.value.messageId,
            });
            if (
              Option.isSome(pendingMessage) &&
              pendingMessage.value.role === "user" &&
              (pendingMessage.value.attachments?.length ?? 0) === 0 &&
              pendingMessage.value.text.trim().toLowerCase() === "/compact"
            ) {
              return;
            }
          }
          yield* projectionTurnRepository.replacePendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.activity-appended": {
          if (event.payload.activity.kind === "context-compaction") {
            const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId(
              event.payload,
            );
            if (
              Option.isNone(pendingTurnStart) ||
              String(pendingTurnStart.value.messageId) !==
                extractActivityRequestId(event.payload.activity.payload)
            ) {
              return;
            }
            yield* projectionTurnRepository.deletePendingTurnStartByThreadId(event.payload);
            return;
          }
          if (event.payload.activity.kind !== "provider.turn.start.failed") return;
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId(
            event.payload,
          );
          if (
            Option.isNone(pendingTurnStart) ||
            String(pendingTurnStart.value.messageId) !==
              extractActivityRequestId(event.payload.activity.payload)
          ) {
            return;
          }
          yield* projectionTurnRepository.deletePendingTurnStartByThreadId(event.payload);
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (turnId === null || event.payload.session.status !== "running") {
            if (
              (event.payload.session.status === "ready" &&
                event.commandId?.startsWith("server:provider-session-set:") === true) ||
              event.payload.session.status === "error" ||
              event.payload.session.status === "stopped" ||
              event.payload.session.status === "interrupted"
            ) {
              yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
                threadId: event.payload.threadId,
              });
            }
            // Leaving the "running" session status is the turn-end signal:
            // settle still-running turns so their duration reflects the whole
            // turn rather than the last assistant message.
            const settledTurnState = settledTurnStateForSessionStatus(event.payload.session.status);
            if (settledTurnState === null) {
              return;
            }
            const existingTurns = yield* projectionTurnRepository.listByThreadId({
              threadId: event.payload.threadId,
            });
            yield* Effect.forEach(
              existingTurns.filter((turn) => turn.turnId !== null && turn.state === "running"),
              (turn) =>
                turn.turnId === null
                  ? Effect.void
                  : projectionTurnRepository.upsertByTurnId({
                      ...turn,
                      turnId: turn.turnId,
                      state: settledTurnState,
                      // A running turn's completedAt can only hold a mid-turn
                      // placeholder checkpoint timestamp — the session leaving
                      // "running" is the authoritative turn end.
                      completedAt: event.payload.session.updatedAt,
                    }),
              { concurrency: 1 },
            );
            return;
          }

          // A new active turn supersedes any still-running turn on the same
          // thread — steering can open a new turn without the provider ever
          // completing the previous one.
          const otherRunningTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            otherRunningTurns.filter(
              (turn) => turn.turnId !== null && turn.turnId !== turnId && turn.state === "running",
            ),
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                    state: "completed",
                    completedAt: event.payload.session.updatedAt,
                  }),
            { concurrency: 1 },
          );

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId,
          });
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isSome(existingTurn)) {
            const nextState =
              existingTurn.value.state === "completed" || existingTurn.value.state === "error"
                ? existingTurn.value.state
                : "running";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: nextState,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanThreadId:
                existingTurn.value.sourceProposedPlanThreadId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanThreadId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt:
                existingTurn.value.startedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              threadId: event.payload.threadId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state: "running",
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              startedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            });
          }

          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          // A completed assistant message only settles the turn once the
          // session is no longer running it — providers may emit several
          // assistant messages per turn (commentary between tool calls), and
          // the turn must stay unsettled until the provider reports turn end
          // (projected as thread.session-set leaving the "running" status).
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          const turnStillRunning =
            Option.isSome(session) &&
            session.value.status === "running" &&
            session.value.activeTurnId === event.payload.turnId;
          const settlesTurn = !event.payload.streaming && !turnStillRunning;
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state: settlesTurn
                ? existingTurn.value.state === "interrupted"
                  ? "interrupted"
                  : existingTurn.value.state === "error"
                    ? "error"
                    : "completed"
                : existingTurn.value.state,
              completedAt: settlesTurn
                ? (existingTurn.value.completedAt ?? event.payload.updatedAt)
                : existingTurn.value.completedAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: settlesTurn ? "completed" : "running",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: settlesTurn ? event.payload.updatedAt : null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          if (event.payload.turnId === undefined) {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: "interrupted",
              completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "interrupted",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-diff-completed": {
          // Mid-turn diff updates produce placeholder checkpoints; record the
          // checkpoint, but don't settle a turn its session is still running.
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          const turnStillRunning =
            Option.isSome(session) &&
            session.value.status === "running" &&
            session.value.activeTurnId === event.payload.turnId;
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          const nextState = event.payload.status === "error" ? "error" : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.assistantMessageId,
              state:
                turnStillRunning || existingTurn.value.state === "interrupted"
                  ? existingTurn.value.state
                  : nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: turnStillRunning ? "running" : nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

    const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyPendingApprovalsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionPendingApprovalRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          return;

        case "thread.activity-appended": {
          const requestId =
            extractActivityRequestId(event.payload.activity.payload) ??
            event.metadata.requestId ??
            null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId,
          });
          if (event.payload.activity.kind === "approval.resolved") {
            const resolvedDecisionRaw =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null &&
              "decision" in event.payload.activity.payload
                ? (event.payload.activity.payload as { decision?: unknown }).decision
                : null;
            const resolvedDecision =
              resolvedDecisionRaw === "accept" ||
              resolvedDecisionRaw === "acceptForSession" ||
              resolvedDecisionRaw === "acceptAlways" ||
              resolvedDecisionRaw === "decline" ||
              resolvedDecisionRaw === "cancel"
                ? resolvedDecisionRaw
                : null;
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: Option.isSome(existingRow)
                ? existingRow.value.threadId
                : event.payload.threadId,
              turnId: Option.isSome(existingRow)
                ? existingRow.value.turnId
                : event.payload.activity.turnId,
              status: "resolved",
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : event.payload.activity.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            });
            return;
          }
          if (event.payload.activity.kind === "provider.approval.respond.failed") {
            const payload =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null
                ? (event.payload.activity.payload as Record<string, unknown>)
                : null;
            const detail =
              typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
            if (isStalePendingApprovalFailureDetail(detail)) {
              if (Option.isNone(existingRow)) {
                return;
              }
              if (existingRow.value.status === "resolved") {
                return;
              }
              yield* projectionPendingApprovalRepository.upsert({
                requestId,
                threadId: existingRow.value.threadId,
                turnId: existingRow.value.turnId,
                status: "resolved",
                decision: null,
                createdAt: existingRow.value.createdAt,
                resolvedAt: event.payload.activity.createdAt,
              });
              return;
            }
            if (Option.isNone(existingRow) || existingRow.value.status !== "resolved") {
              return;
            }

            // Sending a reply clears the badge before the provider accepts it.
            // A failed reply must restore the request unless a terminal event
            // already closed it, including a reply from another client.
            const requestActivities = (yield* projectionThreadActivityRepository.listByThreadId({
              threadId: existingRow.value.threadId,
            })).filter((activity) => extractActivityRequestId(activity.payload) === requestId);
            const wasRequested = requestActivities.some(
              (activity) => activity.kind === "approval.requested",
            );
            const wasResolved = requestActivities.some((activity) => {
              if (activity.kind === "approval.resolved") {
                return true;
              }
              if (activity.kind !== "provider.approval.respond.failed") {
                return false;
              }
              const activityPayload =
                typeof activity.payload === "object" && activity.payload !== null
                  ? (activity.payload as Record<string, unknown>)
                  : null;
              return isStalePendingApprovalFailureDetail(
                typeof activityPayload?.detail === "string"
                  ? activityPayload.detail.toLowerCase()
                  : null,
              );
            });
            if (wasRequested && !wasResolved) {
              yield* projectionPendingApprovalRepository.upsert({
                ...existingRow.value,
                status: "pending",
                decision: null,
                resolvedAt: null,
              });
            }
            return;
          }
          // Only approval-requested activities should create pending-approval
          // rows.  Other activity kinds that happen to carry a requestId
          // (e.g. user-input.requested / user-input.resolved) must not
          // pollute this projection — they have their own accounting via
          // derivePendingUserInputCountFromActivities.
          if (event.payload.activity.kind !== "approval.requested") {
            return;
          }
          if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
            return;
          }
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            status: "pending",
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.activity.createdAt,
            resolvedAt: null,
          });
          return;
        }

        case "thread.approval-response-requested": {
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId: event.payload.requestId,
          });
          yield* projectionPendingApprovalRepository.upsert({
            requestId: event.payload.requestId,
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
            status: "resolved",
            decision: event.payload.decision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.createdAt,
            resolvedAt: event.payload.createdAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const projectors: ReadonlyArray<ProjectorDefinition> = [
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.projects,
        apply: applyProjectsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
        apply: applyThreadMessagesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
        apply: applyThreadProposedPlansProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
        apply: applyThreadActivitiesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
        apply: applyThreadSessionsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
        apply: applyThreadTurnsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
        apply: applyCheckpointsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
        apply: applyPendingApprovalsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threads,
        apply: applyThreadsProjection,
      },
    ];

    const attachmentsRootDir = serverConfig.attachmentsDir;

    // File failures are logged and reported as false so the remaining files still run.
    const removeAttachmentFile = (relativePath: string) =>
      fileSystem.remove(path.join(attachmentsRootDir, relativePath), { force: true }).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("failed to remove attachment file", { relativePath, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );

    const pruneAttachmentFile = (relativePath: string) =>
      fileSystem.stat(path.join(attachmentsRootDir, relativePath)).pipe(
        Effect.flatMap((info) =>
          info.type === "File" ? removeAttachmentFile(relativePath) : Effect.succeed(true),
        ),
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed(true)
              : Effect.logWarning("failed to inspect attachment file", {
                  relativePath,
                  cause,
                }).pipe(Effect.as(false)),
        }),
      );

    // Read after every projector has applied the event, so later references are included.
    const readRetainedThreadAttachmentPaths = Effect.fn("readRetainedThreadAttachmentPaths")(
      function* (threadId: ThreadId) {
        const messages = yield* projectionThreadMessageRepository.listByThreadId({ threadId });
        const retainedPaths = collectThreadAttachmentRelativePaths(threadId, messages);
        const answers = yield* projectionThreadActivityRepository.listByThreadId({
          threadId,
          activityKinds: ["user-input.answer-submitted"],
        });
        for (const activity of answers) {
          const payload = decodeQuestionAttachmentAnswer(activity.payload);
          if (Option.isNone(payload)) continue;
          for (const attachment of Object.values(payload.value.attachmentsByQuestionId).flat()) {
            const relativePath = attachmentRelativePath(attachment);
            if (relativePath) retainedPaths.add(relativePath);
          }
        }
        return retainedPaths;
      },
    );

    // Transferred recordings and saved snapshots live outside the attachments directory, so
    // revert pruning never sees them; only deleting the thread removes them.
    const removeThreadBrowserArtifacts = (threadId: string) => {
      const directory = resolveThreadBrowserArtifactsDir({
        browserArtifactsDir: serverConfig.browserArtifactsDir,
        threadId,
      });
      if (directory === null) {
        return Effect.succeed(true);
      }
      return fileSystem.remove(directory, { recursive: true, force: true }).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("failed to remove thread browser artifacts", { threadId, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
    };

    const cleanupThreadAttachmentFiles = Effect.fn("cleanupThreadAttachmentFiles")(function* (
      target: AttachmentCleanupTarget,
      files: ReadonlyArray<string>,
      hasBrowserArtifacts: boolean,
    ) {
      const threadId = ThreadId.make(target.threadId);
      if (target.deletedAtSequence !== null) {
        // A draft retry can re-create the id; its files then belong to the later incarnation.
        const recreatedLater = yield* eventStore.hasEventAfter({
          aggregateKind: "thread",
          aggregateId: threadId,
          type: "thread.created",
          sequenceExclusive: target.deletedAtSequence,
        });
        if (!recreatedLater) {
          const removed = yield* Effect.forEach(files, removeAttachmentFile, { concurrency: 1 });
          const artifactsRemoved = hasBrowserArtifacts
            ? yield* removeThreadBrowserArtifacts(target.threadId)
            : true;
          return artifactsRemoved && removed.every(Boolean);
        }
      }
      if (!target.pruned) {
        return true;
      }
      const retainedPaths = yield* readRetainedThreadAttachmentPaths(threadId);
      const pruned = yield* Effect.forEach(
        files.filter((file) => !retainedPaths.has(file)),
        pruneAttachmentFile,
        { concurrency: 1 },
      );
      return pruned.every(Boolean);
    });

    /**
     * Lists the attachments directory once (and the browser artifacts directory once when a
     * target deletes a thread) and cleans each target's files. Threads without files cost no
     * reads. Returns false when any thread, file, or the artifacts listing failed (each is
     * logged); fails only when the attachments directory cannot be listed.
     */
    const cleanupAttachments = Effect.fn("cleanupAttachments")(function* (
      targets: ReadonlyArray<AttachmentCleanupTarget>,
    ) {
      const safeTargets: Array<{ target: AttachmentCleanupTarget; threadSegment: string }> = [];
      for (const target of targets) {
        const threadSegment = toSafeThreadAttachmentSegment(target.threadId);
        if (threadSegment) {
          safeTargets.push({ target, threadSegment });
        } else {
          yield* Effect.logWarning("skipping attachment cleanup for unsafe thread id", {
            threadId: target.threadId,
          });
        }
      }
      if (safeTargets.length === 0) {
        return true;
      }
      const entries = yield* fileSystem
        .readDirectory(attachmentsRootDir, { recursive: false })
        .pipe(
          Effect.catchTags({
            PlatformError: (cause) =>
              cause.reason._tag === "NotFound"
                ? Effect.succeed<ReadonlyArray<string>>([])
                : Effect.fail(cause),
          }),
        );
      const filesBySegment = groupAttachmentFilesByThreadSegment(entries);
      let complete = true;
      const browserArtifactSegments = new Set<string>();
      if (safeTargets.some(({ target }) => target.deletedAtSequence !== null)) {
        const artifactEntries = yield* fileSystem
          .readDirectory(serverConfig.browserArtifactsDir, { recursive: false })
          .pipe(
            Effect.catchTags({
              PlatformError: (cause) =>
                cause.reason._tag === "NotFound"
                  ? Effect.succeed<ReadonlyArray<string> | null>([])
                  : Effect.logWarning("failed to list browser artifacts", { cause }).pipe(
                      Effect.as<ReadonlyArray<string> | null>(null),
                    ),
            }),
          );
        if (artifactEntries === null) {
          complete = false;
        } else {
          for (const entry of artifactEntries) {
            browserArtifactSegments.add(entry.replace(/^[/\\]+/, ""));
          }
        }
      }
      for (const { target, threadSegment } of safeTargets) {
        const files = filesBySegment.get(threadSegment) ?? [];
        const hasBrowserArtifacts =
          target.deletedAtSequence !== null && browserArtifactSegments.has(threadSegment);
        if (files.length === 0 && !hasBrowserArtifacts) continue;
        const cleaned = yield* cleanupThreadAttachmentFiles(
          target,
          files,
          hasBrowserArtifacts,
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to clean thread attachments", {
              threadId: target.threadId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        complete = complete && cleaned;
      }
      return complete;
    });

    // Cleanup has finished for every event up to this cursor. Live projection writes it with the
    // projector cursors, so it trails the head by the command whose cleanup has not run yet. It is
    // null before bootstrap and after a failed cleanup, which leaves the persisted cursor behind
    // that event for the next bootstrap to retry.
    let cleanupDone: ProjectionState | null = null;

    const applyAttachmentSideEffects = Effect.fn("applyAttachmentSideEffects")(function* (
      event: OrchestrationEvent,
      sideEffects: AttachmentSideEffects,
    ) {
      const targets = attachmentCleanupTargets(event, sideEffects);
      const complete =
        targets.length === 0 ||
        (yield* cleanupAttachments(targets).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to apply projected attachment side-effects", {
              sequence: event.sequence,
              eventType: event.type,
              cause,
            }).pipe(Effect.as(false)),
          ),
        ));
      cleanupDone =
        complete && cleanupDone !== null
          ? {
              projector: ATTACHMENT_CLEANUP_CURSOR,
              lastAppliedSequence: event.sequence,
              updatedAt: event.occurredAt,
            }
          : null;
    });

    // Selects only what cleanup needs, so no payload is decoded and old payloads cannot fail it.
    const readAttachmentCleanupEvents = Effect.fn("readAttachmentCleanupEvents")(function* (
      sequenceExclusive: number,
      sequenceInclusive: number,
    ) {
      const rows = yield* sql`
        SELECT sequence, event_type AS "type", stream_id AS "threadId"
        FROM orchestration_events
        WHERE sequence > ${sequenceExclusive}
          AND sequence <= ${sequenceInclusive}
          AND aggregate_kind = 'thread'
          AND event_type IN ('thread.reverted', 'thread.deleted')
        ORDER BY sequence ASC
      `;
      const events: Array<typeof AttachmentCleanupEventRow.Type> = [];
      for (const row of rows) {
        const decoded = decodeAttachmentCleanupEventRow(row);
        if (Option.isSome(decoded)) {
          events.push(decoded.value);
        } else {
          yield* Effect.logWarning("skipping attachment cleanup for an unreadable event", { row });
        }
      }
      return events;
    });

    /**
     * Cleans files for reverts and deletes past the cursor once every projector has caught up,
     * then moves the cursor to the projector head. File failures here are logged and not retried
     * again, so one persistent failure cannot pin the cursor. Returns the cursor live cleanup
     * continues from, or null when cleanup could not run and the next bootstrap should retry.
     */
    const cleanupAttachmentBacklog = Effect.fn("cleanupAttachmentBacklog")(
      function* (boundary: ProjectionState) {
        const head = lowestProjectorCursor(yield* projectionStateRepository.listAll());
        if (!head || head.lastAppliedSequence <= boundary.lastAppliedSequence) {
          return boundary;
        }
        const targetsByThread = new Map<string, AttachmentCleanupTarget>();
        for (const event of yield* readAttachmentCleanupEvents(
          boundary.lastAppliedSequence,
          head.lastAppliedSequence,
        )) {
          const current = targetsByThread.get(event.threadId) ?? {
            threadId: event.threadId,
            deletedAtSequence: null,
            pruned: false,
          };
          targetsByThread.set(
            event.threadId,
            event.type === "thread.deleted"
              ? { ...current, deletedAtSequence: event.sequence }
              : { ...current, pruned: true },
          );
        }
        yield* cleanupAttachments([...targetsByThread.values()]);
        const cursor = {
          projector: ATTACHMENT_CLEANUP_CURSOR,
          lastAppliedSequence: head.lastAppliedSequence,
          updatedAt: head.updatedAt,
        };
        yield* projectionStateRepository.upsert(cursor);
        return cursor;
      },
      (effect) =>
        effect.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("attachment cleanup did not run; the next start retries it", {
              cause,
            }).pipe(Effect.as(null)),
          ),
        ),
    );

    const runProjectorForEvent = Effect.fn("runProjectorForEvent")(function* (
      projector: ProjectorDefinition,
      event: OrchestrationEvent,
    ) {
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
      };

      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* projector.apply(event, attachmentSideEffects);
          yield* projectionStateRepository.upsert({
            projector: projector.name,
            lastAppliedSequence: event.sequence,
            updatedAt: event.occurredAt,
          });
        }),
      );
    });

    const bootstrapProjector = (projector: ProjectorDefinition) =>
      projectionStateRepository
        .getByProjector({
          projector: projector.name,
        })
        .pipe(
          Effect.flatMap((stateRow) =>
            Stream.runForEach(
              eventStore.readFromSequence(
                Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
                Number.MAX_SAFE_INTEGER,
              ),
              (event) => runProjectorForEvent(projector, event),
            ),
          ),
        );

    const projectEventDeferred: OrchestrationProjectionPipelineShape["projectEventDeferred"] =
      Effect.fn("projectEventDeferred")(
        function* (event) {
          const attachmentSideEffects: AttachmentSideEffects = {
            deletedThreadIds: new Set<string>(),
            prunedThreadRelativePaths: new Map<string, Set<string>>(),
          };
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* Effect.forEach(
                projectors,
                (projector) => projector.apply(event, attachmentSideEffects),
                { concurrency: 1, discard: true },
              );
              // Runtime projectors commit together. Bootstrap still advances each cursor separately.
              // The cleanup cursor rides in the same statement, at the last finished cleanup.
              yield* projectionStateRepository.upsertMany([
                ...projectors.map((projector) => ({
                  projector: projector.name,
                  lastAppliedSequence: event.sequence,
                  updatedAt: event.occurredAt,
                })),
                ...(cleanupDone === null ? [] : [cleanupDone]),
              ]);
            }),
          );
          // Return the cleanup effect so the caller runs it after the outer transaction commits.
          // @effect-diagnostics-next-line returnEffectInGen:off
          return applyAttachmentSideEffects(event, attachmentSideEffects);
        },
        Effect.catchTag("SqlError", (sqlError) =>
          Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
        ),
      );

    const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = Effect.fn(
      "projectEvent",
    )(function* (event) {
      const cleanup = yield* projectEventDeferred(event);
      yield* cleanup;
    });

    const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.gen(function* () {
      const states = yield* projectionStateRepository.listAll();
      const cleanupState = states.find((state) => state.projector === ATTACHMENT_CLEANUP_CURSOR);
      const projectorFloor = lowestProjectorCursor(states);
      const projectorStart = projectorFloor?.lastAppliedSequence ?? 0;
      // Projector replay cleaned files as it went before cleanup had its own cursor, so a
      // database without one starts where its projectors resume.
      const boundary: ProjectionState =
        cleanupState && cleanupState.lastAppliedSequence <= projectorStart
          ? cleanupState
          : {
              projector: ATTACHMENT_CLEANUP_CURSOR,
              lastAppliedSequence: projectorStart,
              updatedAt:
                cleanupState?.updatedAt ?? projectorFloor?.updatedAt ?? "1970-01-01T00:00:00.000Z",
            };
      if (boundary !== cleanupState) {
        // Persist this boundary before replay: a reset projector can encounter an old
        // revert, then fail after other projectors have committed past that event.
        yield* projectionStateRepository.upsert(boundary);
      }
      cleanupDone = null;
      yield* Effect.forEach(projectors, bootstrapProjector, { concurrency: 1, discard: true });
      cleanupDone = yield* cleanupAttachmentBacklog(boundary);
    }).pipe(
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("orchestration projection pipeline bootstrapped").pipe(
          Effect.annotateLogs({ projectors: projectors.length }),
        ),
      ),
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
      ),
    );

    return {
      bootstrap,
      projectEvent,
      projectEventDeferred,
    } satisfies OrchestrationProjectionPipelineShape;
  },
);

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline(),
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
