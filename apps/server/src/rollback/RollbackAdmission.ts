import {
  RuntimeSessionId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import {
  RollbackSagaRepository,
  type RollbackSagaState,
} from "../persistence/Services/RollbackSagas.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { RollbackWorkspace } from "./RollbackWorkspace.ts";

function hasOpenInput(thread: OrchestrationReadModel["threads"][number]): boolean {
  const open = new Set<string>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (
      ["approval.requested", "user-input.requested", "interaction.requested"].includes(
        activity.kind,
      )
    ) {
      open.add(requestId);
    } else if (
      ["approval.resolved", "user-input.resolved", "interaction.resolved"].includes(activity.kind)
    ) {
      open.delete(requestId);
    }
  }
  return open.size > 0;
}

export interface RollbackAdmissionShape {
  readonly prepare: (input: {
    readonly command: Extract<OrchestrationCommand, { readonly type: "thread.checkpoint.revert" }>;
    readonly readModel: OrchestrationReadModel;
    readonly requestEventId: string;
  }) => Effect.Effect<Option.Option<RollbackSagaState>, OrchestrationCommandInvariantError>;
}
export class RollbackAdmission extends Context.Service<RollbackAdmission, RollbackAdmissionShape>()(
  "t3/rollback/RollbackAdmission",
) {}

const invariant = (detail: string) =>
  new OrchestrationCommandInvariantError({
    commandType: "thread.checkpoint.revert",
    detail,
  });

export const make = Effect.gen(function* () {
  const provider = yield* ProviderService;
  const repository = yield* RollbackSagaRepository;
  const workspace = yield* RollbackWorkspace;
  const randomUUID = (yield* Crypto.Crypto).randomUUIDv4;

  const prepare: RollbackAdmissionShape["prepare"] = Effect.fn("RollbackAdmission.prepare")(
    function* ({ command, readModel, requestEventId }) {
      const thread = readModel.threads.find((candidate) => candidate.id === command.threadId);
      if (!thread) return yield* invariant("Thread does not exist.");
      const capabilities = yield* provider
        .getCapabilities(thread.modelSelection.instanceId)
        .pipe(Effect.option);
      if (Option.isNone(capabilities) || capabilities.value.conversationRollback !== "absolute") {
        return Option.none();
      }
      if (
        provider.hasAbsoluteConversationRollback === undefined ||
        provider.captureConversationAnchor === undefined ||
        provider.inspectConversationAnchor === undefined ||
        provider.applyConversationAnchor === undefined ||
        provider.releaseConversationAnchor === undefined ||
        !(yield* provider
          .hasAbsoluteConversationRollback(command.threadId)
          .pipe(
            Effect.mapError(() =>
              invariant("The absolute provider rollback contract could not be verified."),
            ),
          ))
      ) {
        return yield* invariant("The absolute provider rollback contract is incomplete.");
      }
      if (
        thread.session === null ||
        !["idle", "ready"].includes(thread.session.status) ||
        thread.session.activeTurnId !== null ||
        thread.session.pendingTurnRequestId !== undefined ||
        thread.session.activeTurnRequestId !== undefined ||
        thread.session.failedTurnRequestId !== undefined ||
        thread.latestTurn?.state === "running" ||
        hasOpenInput(thread)
      ) {
        return yield* invariant(
          "Rollback requires an exactly idle thread with no pending work or input.",
        );
      }

      const queue = yield* provider
        .getSessionInputQueue({ threadId: command.threadId })
        .pipe(
          Effect.mapError(() => invariant("The provider input queue could not be proved empty.")),
        );
      if (queue.steeringCount !== 0 || queue.followUpCount !== 0) {
        return yield* invariant("Rollback requires an empty provider input queue.");
      }

      const sessions = yield* provider
        .listSessions()
        .pipe(Effect.mapError(() => invariant("The exact provider session could not be listed.")));
      const session = sessions.find((candidate) => candidate.threadId === command.threadId);
      if (
        !session?.cwd ||
        !["idle", "ready"].includes(session.status) ||
        session.activeTurnId !== undefined ||
        session.providerInstanceId === undefined ||
        session.sessionIncarnationId === undefined
      ) {
        return yield* invariant("The exact idle provider session could not be resolved.");
      }
      const project = readModel.projects.find((candidate) => candidate.id === thread.projectId);
      if (!project || project.deletedAt !== null)
        return yield* invariant("Project does not exist.");
      const configuredCwd = thread.worktreePath ?? project.workspaceRoot;
      const sessionIdentity = yield* workspace
        .resolveIdentity(session.cwd)
        .pipe(
          Effect.mapError(() => invariant("The provider workspace identity could not be proved.")),
        );
      const configuredIdentity = yield* workspace
        .resolveIdentity(configuredCwd)
        .pipe(
          Effect.mapError(() =>
            invariant("The configured workspace identity could not be proved."),
          ),
        );
      if (sessionIdentity.workspaceKey !== configuredIdentity.workspaceKey) {
        return yield* invariant("The provider session is not bound to the exact thread workspace.");
      }

      const sourceRevision = thread.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );
      const checkpointsByRevision = new Map(
        thread.checkpoints.map((checkpoint) => [checkpoint.checkpointTurnCount, checkpoint]),
      );
      for (let revision = 1; revision <= sourceRevision; revision += 1) {
        if (!checkpointsByRevision.has(revision)) {
          return yield* invariant("Rollback requires a complete contiguous checkpoint history.");
        }
      }
      const checkpointTurnIds = new Set(thread.checkpoints.map((checkpoint) => checkpoint.turnId));
      if (
        thread.messages.some(
          (message) => message.turnId !== null && !checkpointTurnIds.has(message.turnId),
        )
      ) {
        return yield* invariant("Rollback requires checkpoint history for every projected turn.");
      }
      if (
        command.expectedSourceRevision === undefined ||
        command.expectedSourceRevision !== sourceRevision
      ) {
        return yield* invariant("The rollback source revision is stale or absent.");
      }
      if (command.turnCount >= sourceRevision) {
        return yield* invariant(
          "The rollback target must be older than the exact source revision.",
        );
      }
      const sourceSummary = checkpointsByRevision.get(sourceRevision);
      if (sourceSummary === undefined || sourceSummary.status !== "ready") {
        return yield* invariant("The immutable source checkpoint is missing or corrupt.");
      }
      const targetSummary =
        command.turnCount === 0 ? null : checkpointsByRevision.get(command.turnCount);
      if (command.turnCount > 0 && (!targetSummary || targetSummary.status !== "ready")) {
        return yield* invariant("The immutable target checkpoint is missing or corrupt.");
      }

      const sourceCheckpointRef = checkpointRefForThreadTurn(command.threadId, sourceRevision);
      const targetCheckpointRef = checkpointRefForThreadTurn(command.threadId, command.turnCount);
      const sourceIdentity = yield* workspace
        .resolveCheckpoint({
          cwd: sessionIdentity.cwd,
          checkpointRef: sourceCheckpointRef,
        })
        .pipe(Effect.mapError(() => invariant("The immutable source checkpoint is unavailable.")));
      const targetIdentity = yield* workspace
        .resolveCheckpoint({
          cwd: sessionIdentity.cwd,
          checkpointRef: targetCheckpointRef,
        })
        .pipe(
          Effect.mapError(() =>
            invariant("The explicit immutable target checkpoint is unavailable."),
          ),
        );

      const providerInstanceId = session.providerInstanceId;
      const sessionIncarnationId = RuntimeSessionId.make(session.sessionIncarnationId);
      const desired = yield* repository
        .getCheckpointAnchor({
          threadId: command.threadId,
          checkpointTurnCount: command.turnCount,
          providerInstanceId,
          sessionIncarnationId,
        })
        .pipe(
          Effect.mapError(() => invariant("The private target provider anchor is unavailable.")),
        );
      const targetTurnId = targetSummary?.turnId ?? null;
      if (
        Option.isNone(desired) ||
        desired.value.sourceRevision !== command.turnCount ||
        desired.value.turnId !== targetTurnId ||
        desired.value.checkpointRef !== targetCheckpointRef ||
        desired.value.checkpointOid !== targetIdentity.oid
      ) {
        return yield* invariant(
          "The private target provider anchor does not match the immutable checkpoint.",
        );
      }
      if (
        Option.isSome(
          yield* repository
            .getActiveByThread(command.threadId)
            .pipe(Effect.mapError(() => invariant("Rollback admission state could not be read."))),
        )
      ) {
        return yield* invariant("Another rollback operation is already active for this thread.");
      }
      if (
        Option.isSome(
          yield* repository
            .findLeaseByWorkspace(sessionIdentity.workspaceKey)
            .pipe(Effect.mapError(() => invariant("The workspace lease could not be read."))),
        )
      ) {
        return yield* invariant("Another rollback operation owns this workspace.");
      }

      const now = command.createdAt;
      return Option.some({
        operationId: yield* randomUUID.pipe(
          Effect.mapError(() =>
            invariant("A rollback operation identifier could not be generated."),
          ),
        ),
        requestEventId,
        threadId: command.threadId,
        projectId: thread.projectId,
        workspaceKey: sessionIdentity.workspaceKey,
        workspaceCwd: sessionIdentity.cwd,
        sourceRevision,
        targetRevision: command.turnCount,
        sourceTurnId: sourceSummary.turnId,
        targetTurnId,
        sourceCheckpointRef,
        sourceCheckpointOid: sourceIdentity.oid,
        targetCheckpointRef,
        targetCheckpointOid: targetIdentity.oid,
        targetCheckpointDigest: targetIdentity.digest,
        providerInstanceId,
        sessionIncarnationId,
        phase: "source-anchor-capture-started",
        attempt: 0,
        lastErrorCode: null,
        compensation: "none",
        cleanup: "pending",
        sourceAnchor: null,
        sourceAnchorDigest: null,
        desiredAnchor: desired.value.anchor,
        desiredAnchorDigest: desired.value.anchorDigest,
        preimage: null,
        workspaceReceiptDigest: null,
        providerReceiptDigest: null,
        projectionCommitSequence: null,
        createdAt: now,
        updatedAt: now,
      });
    },
  );
  return RollbackAdmission.of({ prepare });
});

export const layer = Layer.effect(RollbackAdmission, make);
