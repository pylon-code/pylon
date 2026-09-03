import {
  CommandId,
  OrchestrationRollbackRecoveryError,
  type CheckpointRef,
  type OrchestrationRollbackRecoveryAction,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { RuntimeReceiptBus } from "../orchestration/Services/RuntimeReceiptBus.ts";
import {
  RollbackSagaRepository,
  type RollbackSagaRecord,
  type RollbackSagaState,
} from "../persistence/Services/RollbackSagas.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { RollbackWorkspace, type RollbackWorkspacePreimage } from "./RollbackWorkspace.ts";

export type RollbackFaultHook = (label: string, operationId: string) => Effect.Effect<void>;
export const RollbackFaultInjector = Context.Reference<RollbackFaultHook>(
  "t3/rollback/RollbackFaultInjector",
  { defaultValue: () => () => Effect.void },
);

export interface RollbackSagaRunnerShape {
  readonly run: (operationId: string, recovering: boolean) => Effect.Effect<void>;
  readonly recover: (input: {
    readonly threadId: ThreadId;
    readonly action: OrchestrationRollbackRecoveryAction;
  }) => Effect.Effect<void, OrchestrationRollbackRecoveryError>;
}
export class RollbackSagaRunner extends Context.Service<
  RollbackSagaRunner,
  RollbackSagaRunnerShape
>()("t3/rollback/RollbackSagaRunner") {}

const MAX_PROVIDER_TARGET_ATTEMPTS = 3;
const privatePreimage = (state: RollbackSagaState) =>
  state.preimage as RollbackWorkspacePreimage | null;

export const make = Effect.gen(function* () {
  const repository = yield* RollbackSagaRepository;
  const workspace = yield* RollbackWorkspace;
  const provider = yield* ProviderService;
  const engine = yield* OrchestrationEngineService;
  const checkpointStore = yield* CheckpointStore;
  const receipts = yield* RuntimeReceiptBus;
  const fault = yield* RollbackFaultInjector;
  const captureConversationAnchor = provider.captureConversationAnchor;
  const inspectConversationAnchor = provider.inspectConversationAnchor;
  const applyConversationAnchor = provider.applyConversationAnchor;
  const releaseConversationAnchor = provider.releaseConversationAnchor;
  const ownerId = yield* (yield* Crypto.Crypto).randomUUIDv4;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const publishPhase = (state: RollbackSagaState) =>
    receipts.publish({
      type: "rollback.saga.phase",
      operationId: state.operationId,
      phase: state.phase,
      createdAt: state.updatedAt,
    });
  const after = (label: string, operationId: string) => fault(label, operationId);
  const statusCommand = Effect.fn("RollbackSagaRunner.statusCommand")(function* (
    state: RollbackSagaState,
    status: "pending" | "recovering" | "manual-recovery" | "completed" | "failed" | null,
  ) {
    const createdAt = yield* nowIso;
    const allowedActions =
      status !== "manual-recovery"
        ? []
        : state.projectionCommitSequence !== null
          ? (["retry-verification"] as const)
          : state.compensation === "manual"
            ? (["resume-compensation"] as const)
            : [];
    const detail =
      status === "pending"
        ? "Rewriting the provider conversation, Pylon history, and workspace to the selected message."
        : status === "recovering"
          ? "Verifying the provider conversation, Pylon history, and workspace before releasing the thread."
          : status === "manual-recovery"
            ? `The thread remains fenced because automatic rollback recovery could not be proved (${state.lastErrorCode ?? "verification unavailable"}).`
            : status === "completed"
              ? "Rollback completed and all rewritten state was verified."
              : status === "failed"
                ? "Rollback did not complete. Pylon restored and verified the original provider conversation and workspace; no thread content was removed."
                : undefined;
    yield* engine.dispatch({
      type: "thread.rollback.status.set",
      commandId: CommandId.make(
        `server:rollback-status:${state.operationId}:${status ?? "clear"}:${state.phase}:${state.updatedAt}`,
      ),
      threadId: state.threadId,
      status,
      targetTurnCount: state.targetRevision,
      sourceRevision: state.sourceRevision,
      ...(detail === undefined ? {} : { detail }),
      allowedActions: [...allowedActions],
      createdAt,
    });
  });

  const update = Effect.fn("RollbackSagaRunner.update")(function* (
    record: RollbackSagaRecord,
    patch: Partial<RollbackSagaState> & Pick<RollbackSagaState, "phase">,
    terminal = false,
  ) {
    const state = {
      ...record.state,
      ...patch,
      updatedAt: yield* nowIso,
    } satisfies RollbackSagaState;
    const updated = yield* repository.updateOwned({
      operationId: record.operationId,
      ownerId,
      expectedVersion: record.version,
      state,
      terminal,
    });
    if (Option.isNone(updated)) return Option.none<RollbackSagaRecord>();
    yield* publishPhase(updated.value.state);
    yield* after(`persisted:${state.phase}`, state.operationId);
    return updated;
  });

  const manual = Effect.fn("RollbackSagaRunner.manual")(function* (
    record: RollbackSagaRecord,
    code: string,
  ) {
    const next = yield* update(record, {
      phase: "manual-recovery",
      compensation: "manual",
      lastErrorCode: code,
    });
    if (Option.isSome(next))
      yield* statusCommand(next.value.state, "manual-recovery").pipe(Effect.ignore);
  });

  const releaseTerminal = Effect.fn("RollbackSagaRunner.releaseTerminal")(function* (
    record: RollbackSagaRecord,
    state: RollbackSagaState,
  ) {
    const released = yield* repository.releaseLeaseOwned({
      operationId: record.operationId,
      ownerId,
      expectedVersion: record.version,
      state: { ...state, updatedAt: yield* nowIso },
    });
    if (Option.isSome(released)) {
      yield* publishPhase(released.value.state);
      yield* after(`persisted:${released.value.state.phase}`, released.value.operationId);
    }
    return released;
  });

  const compensate = Effect.fn("RollbackSagaRunner.compensate")(function* (
    initial: RollbackSagaRecord,
    code: string,
  ) {
    let record = initial;
    let workspaceProved = privatePreimage(record.state) === null;
    let providerProved = record.state.sourceAnchorDigest === null;

    const workspaceStarted = yield* update(record, {
      phase: "compensation-workspace-started",
      compensation: "workspace",
      lastErrorCode: code,
    });
    if (Option.isNone(workspaceStarted)) return;
    record = workspaceStarted.value;
    const preimage = privatePreimage(record.state);
    if (preimage !== null) {
      workspaceProved = yield* workspace
        .restorePreimage({
          cwd: record.state.workspaceCwd,
          preimage,
        })
        .pipe(
          Effect.tap(() => after("side-effect:workspace-compensated", record.operationId)),
          Effect.match({
            onFailure: () => false,
            onSuccess: (receipt) => receipt.digest === preimage.digest,
          }),
        );
    }

    const workspaceComplete = yield* update(record, {
      phase: "compensation-workspace-complete",
      compensation: "provider",
      lastErrorCode: workspaceProved ? code : "workspace-compensation-unproved",
    });
    if (Option.isNone(workspaceComplete)) return;
    record = workspaceComplete.value;

    const providerStarted = yield* update(record, {
      phase: "compensation-provider-started",
      compensation: "provider",
    });
    if (Option.isNone(providerStarted)) return;
    record = providerStarted.value;
    if (record.state.sourceAnchor !== null && record.state.sourceAnchorDigest !== null) {
      providerProved = yield* inspectConversationAnchor!(record.state.threadId).pipe(
        Effect.flatMap((inspected) => {
          if (inspected.digest === record.state.sourceAnchorDigest) return Effect.succeed(true);
          return applyConversationAnchor!({
            threadId: record.state.threadId,
            anchor: record.state.sourceAnchor,
          }).pipe(
            Effect.tap(() => after("side-effect:provider-compensated", record.operationId)),
            Effect.andThen(inspectConversationAnchor!(record.state.threadId)),
            Effect.map((post) => post.digest === record.state.sourceAnchorDigest),
          );
        }),
        Effect.orElseSucceed(() => false),
      );
    }

    if (!workspaceProved || !providerProved) {
      yield* manual(
        record,
        !workspaceProved ? "workspace-compensation-unproved" : "provider-compensation-unproved",
      );
      return;
    }
    if (releaseConversationAnchor === undefined || record.state.sourceAnchor === null) {
      yield* manual(record, "provider-quarantine-release-unavailable");
      return;
    }
    const releasedProvider = yield* releaseConversationAnchor({
      threadId: record.state.threadId,
      anchor: record.state.sourceAnchor,
    }).pipe(Effect.result);
    if (releasedProvider._tag === "Failure") {
      yield* manual(record, "provider-quarantine-release-unproved");
      return;
    }
    const preimageForCleanup = privatePreimage(record.state);
    if (preimageForCleanup !== null) {
      const cleaned = yield* workspace.cleanupPreimage(preimageForCleanup).pipe(Effect.result);
      if (cleaned._tag === "Failure") {
        yield* manual(record, "cleanup-failed-after-compensation");
        return;
      }
    }
    const terminalState: RollbackSagaState = {
      ...record.state,
      phase: "compensated",
      compensation: "proved",
      cleanup: "complete",
      sourceAnchor: null,
      sourceAnchorDigest: null,
      desiredAnchor: null,
      desiredAnchorDigest: null,
      preimage: null,
      updatedAt: yield* nowIso,
    };
    const persisted = yield* update(record, terminalState);
    if (Option.isNone(persisted)) return;
    const statusPublished = yield* statusCommand(persisted.value.state, "failed").pipe(
      Effect.result,
    );
    if (statusPublished._tag === "Failure") return;
    yield* releaseTerminal(persisted.value, persisted.value.state);
  });

  const step = Effect.fn("RollbackSagaRunner.step")(function* (initial: RollbackSagaRecord) {
    let record = initial;
    while (true) {
      const state = record.state;
      switch (state.phase) {
        case "source-anchor-capture-started": {
          const source = yield* captureConversationAnchor!({
            threadId: state.threadId,
            binding: {
              kind: "source",
              sourceRevision: state.sourceRevision,
              checkpointRef: state.sourceCheckpointRef,
              checkpointOid: state.sourceCheckpointOid,
              turnId: state.sourceTurnId,
            },
          }).pipe(Effect.result);
          yield* after("side-effect:source-anchor-captured", state.operationId);
          if (source._tag === "Failure")
            return yield* compensate(record, "source-anchor-capture-failed");
          const next = yield* update(record, {
            phase: "source-anchor-captured",
            sourceAnchor: source.success.anchor,
            sourceAnchorDigest: source.success.digest,
          });
          if (Option.isNone(next)) return;
          record = next.value;
          continue;
        }
        case "source-anchor-captured": {
          const next = yield* update(record, { phase: "preimage-capture-started" });
          if (Option.isNone(next)) return;
          record = next.value;
          continue;
        }
        case "preimage-capture-started": {
          const captured = yield* workspace
            .capturePreimage({
              operationId: state.operationId,
              cwd: state.workspaceCwd,
              targetCheckpointOid: state.targetCheckpointOid,
            })
            .pipe(Effect.result);
          yield* after("side-effect:preimage-captured", state.operationId);
          if (captured._tag === "Failure")
            return yield* compensate(record, "preimage-capture-failed");
          const next = yield* update(record, {
            phase: "preimage-captured",
            preimage: captured.success,
          });
          if (Option.isNone(next)) return;
          record = next.value;
          continue;
        }
        case "preimage-captured": {
          const next = yield* update(record, { phase: "workspace-apply-started" });
          if (Option.isNone(next)) return;
          record = next.value;
          continue;
        }
        case "workspace-apply-started": {
          const applied = yield* workspace
            .applyCheckpoint({
              cwd: state.workspaceCwd,
              checkpointOid: state.targetCheckpointOid,
            })
            .pipe(Effect.result);
          yield* after("side-effect:workspace-target-applied", state.operationId);
          if (applied._tag === "Failure")
            return yield* compensate(record, "workspace-target-failed");
          const next = yield* update(record, {
            phase: "workspace-applied",
            workspaceReceiptDigest: applied.success.digest,
          });
          if (Option.isNone(next)) return;
          record = next.value;
          continue;
        }
        case "workspace-applied": {
          const next = yield* update(record, { phase: "provider-apply-started" });
          if (Option.isNone(next)) return;
          record = next.value;
          continue;
        }
        case "provider-apply-started": {
          if (
            state.sourceAnchorDigest === null ||
            state.desiredAnchorDigest === null ||
            state.desiredAnchor === null
          ) {
            return yield* manual(record, "provider-anchor-receipt-missing");
          }
          const before = yield* inspectConversationAnchor!(state.threadId).pipe(Effect.result);
          if (before._tag === "Success" && before.success.digest === state.desiredAnchorDigest) {
            const next = yield* update(record, {
              phase: "provider-applied",
              providerReceiptDigest: before.success.digest,
            });
            if (Option.isNone(next)) return;
            record = next.value;
            continue;
          }
          if (before._tag === "Success" && before.success.digest !== state.sourceAnchorDigest) {
            return yield* manual(record, "provider-anchor-neither-source-nor-target");
          }
          const applied = yield* applyConversationAnchor!({
            threadId: state.threadId,
            anchor: state.desiredAnchor,
          }).pipe(Effect.result);
          yield* after("side-effect:provider-target-applied", state.operationId);
          const inspected = yield* inspectConversationAnchor!(state.threadId).pipe(Effect.result);
          if (
            inspected._tag === "Success" &&
            inspected.success.digest === state.desiredAnchorDigest
          ) {
            const next = yield* update(record, {
              phase: "provider-applied",
              providerReceiptDigest: inspected.success.digest,
            });
            if (Option.isNone(next)) return;
            record = next.value;
            continue;
          }
          if (
            inspected._tag === "Success" &&
            inspected.success.digest === state.sourceAnchorDigest
          ) {
            if (state.attempt + 1 < MAX_PROVIDER_TARGET_ATTEMPTS) {
              const next = yield* update(record, {
                phase: "provider-apply-started",
                attempt: state.attempt + 1,
                lastErrorCode:
                  applied._tag === "Failure"
                    ? "provider-target-unknown-source"
                    : "provider-target-stayed-source",
              });
              if (Option.isNone(next)) return;
              record = next.value;
              continue;
            }
            return yield* compensate(record, "provider-target-retry-exhausted");
          }
          return yield* manual(record, "provider-target-outcome-unknown");
        }
        case "provider-applied": {
          const workspaceReceipt = yield* workspace
            .inspectCheckpoint({
              cwd: state.workspaceCwd,
              checkpointOid: state.targetCheckpointOid,
            })
            .pipe(Effect.result);
          let providerReceipt = yield* inspectConversationAnchor!(state.threadId).pipe(
            Effect.result,
          );
          if (
            providerReceipt._tag === "Success" &&
            providerReceipt.success.digest === state.sourceAnchorDigest &&
            state.desiredAnchor !== null
          ) {
            yield* applyConversationAnchor!({
              threadId: state.threadId,
              anchor: state.desiredAnchor,
            }).pipe(Effect.result);
            yield* after("side-effect:provider-target-reapplied", state.operationId);
            providerReceipt = yield* inspectConversationAnchor!(state.threadId).pipe(Effect.result);
          }
          if (
            providerReceipt._tag === "Success" &&
            providerReceipt.success.digest !== state.desiredAnchorDigest &&
            providerReceipt.success.digest !== state.sourceAnchorDigest
          ) {
            return yield* manual(record, "provider-anchor-neither-source-nor-target");
          }
          if (
            workspaceReceipt._tag === "Failure" ||
            workspaceReceipt.success.digest !== state.workspaceReceiptDigest ||
            providerReceipt._tag === "Failure"
          ) {
            return yield* manual(record, "precommit-postcondition-lost");
          }
          if (providerReceipt.success.digest !== state.desiredAnchorDigest) {
            if (state.attempt + 1 < MAX_PROVIDER_TARGET_ATTEMPTS) {
              const next = yield* update(record, {
                phase: "provider-applied",
                attempt: state.attempt + 1,
                lastErrorCode: "provider-target-stayed-source-after-reconnect",
              });
              if (Option.isNone(next)) return;
              record = next.value;
              continue;
            }
            return yield* compensate(record, "provider-target-retry-exhausted");
          }
          const next = yield* update(record, { phase: "projection-commit-started" });
          if (Option.isNone(next)) return;
          record = next.value;
          continue;
        }
        case "projection-commit-started": {
          const committed = yield* engine
            .dispatch({
              type: "thread.revert.complete",
              commandId: CommandId.make(`server:rollback-complete:${state.operationId}`),
              threadId: state.threadId,
              operationId: state.operationId,
              sourceRevision: state.sourceRevision,
              targetRevision: state.targetRevision,
              turnCount: state.targetRevision,
              createdAt: yield* nowIso,
            })
            .pipe(Effect.result);
          yield* after("side-effect:projection-committed", state.operationId);
          if (committed._tag === "Failure") {
            return yield* compensate(record, "projection-commit-cas-failed");
          }
          const next = yield* update(record, {
            phase: "projection-committed",
            projectionCommitSequence: committed.success.sequence,
          });
          if (Option.isNone(next)) return;
          record = next.value;
          continue;
        }
        case "projection-committed": {
          let providerReceipt = yield* inspectConversationAnchor!(state.threadId).pipe(
            Effect.result,
          );
          if (
            providerReceipt._tag === "Success" &&
            providerReceipt.success.digest === state.sourceAnchorDigest &&
            state.desiredAnchor !== null
          ) {
            yield* applyConversationAnchor!({
              threadId: state.threadId,
              anchor: state.desiredAnchor,
            }).pipe(Effect.result);
            yield* after("side-effect:provider-target-reapplied", state.operationId);
            providerReceipt = yield* inspectConversationAnchor!(state.threadId).pipe(Effect.result);
          }
          if (
            providerReceipt._tag === "Success" &&
            providerReceipt.success.digest !== state.desiredAnchorDigest &&
            providerReceipt.success.digest !== state.sourceAnchorDigest
          ) {
            return yield* manual(record, "provider-anchor-neither-source-nor-target");
          }
          if (
            providerReceipt._tag !== "Success" ||
            providerReceipt.success.digest !== state.desiredAnchorDigest
          ) {
            if (state.attempt + 1 < MAX_PROVIDER_TARGET_ATTEMPTS) {
              const retried = yield* update(record, {
                phase: "projection-committed",
                attempt: state.attempt + 1,
                lastErrorCode: "provider-target-unproved-after-projection",
              });
              if (Option.isNone(retried)) return;
              record = retried.value;
              continue;
            }
            return yield* manual(record, "provider-target-unproved-after-projection");
          }
          const next = yield* update(record, { phase: "cleanup-started", cleanup: "running" });
          if (Option.isNone(next)) return;
          record = next.value;
          continue;
        }
        case "cleanup-started": {
          const staleRefs: CheckpointRef[] = [];
          for (
            let revision = state.targetRevision + 1;
            revision <= state.sourceRevision;
            revision += 1
          ) {
            staleRefs.push(checkpointRefForThreadTurn(state.threadId, revision));
          }
          const cleanup = yield* Effect.gen(function* () {
            if (staleRefs.length > 0)
              yield* checkpointStore.deleteCheckpointRefs({
                cwd: state.workspaceCwd,
                checkpointRefs: staleRefs,
              });
            yield* repository.deleteCheckpointAnchorsAfter({
              threadId: state.threadId,
              checkpointTurnCount: state.targetRevision,
            });
            if (state.desiredAnchor === null) return yield* Effect.die("provider anchor missing");
            yield* releaseConversationAnchor!({
              threadId: state.threadId,
              anchor: state.desiredAnchor,
            });
            const preimage = privatePreimage(state);
            if (preimage !== null) yield* workspace.cleanupPreimage(preimage);
          }).pipe(Effect.result);
          yield* after("side-effect:cleanup", state.operationId);
          if (cleanup._tag === "Failure") return;
          const terminalState: RollbackSagaState = {
            ...state,
            phase: "complete",
            cleanup: "complete",
            sourceAnchor: null,
            sourceAnchorDigest: null,
            desiredAnchor: null,
            desiredAnchorDigest: null,
            preimage: null,
            updatedAt: yield* nowIso,
          };
          const persisted = yield* update(record, terminalState);
          if (Option.isNone(persisted)) return;
          const statusPublished = yield* statusCommand(persisted.value.state, "completed").pipe(
            Effect.result,
          );
          if (statusPublished._tag === "Failure") return;
          yield* releaseTerminal(persisted.value, persisted.value.state);
          return;
        }
        case "compensation-workspace-started":
        case "compensation-workspace-complete":
        case "compensation-provider-started":
          return yield* compensate(record, state.lastErrorCode ?? "reconcile-compensation");
        case "manual-recovery":
          return;
        case "compensated": {
          const statusPublished = yield* statusCommand(state, "failed").pipe(Effect.result);
          if (statusPublished._tag === "Success") {
            yield* releaseTerminal(record, state);
          }
          return;
        }
        case "complete": {
          const statusPublished = yield* statusCommand(state, "completed").pipe(Effect.result);
          if (statusPublished._tag === "Success") {
            yield* releaseTerminal(record, state);
          }
          return;
        }
      }
    }
  });

  const run: RollbackSagaRunnerShape["run"] = Effect.fn("RollbackSagaRunner.run")(
    function* (operationId, recovering) {
      const claimed = yield* repository.claim(operationId, ownerId).pipe(Effect.result);
      if (claimed._tag === "Failure" || Option.isNone(claimed.success)) return;
      const record = claimed.success.value;
      yield* statusCommand(
        record.state,
        record.state.phase === "manual-recovery"
          ? "manual-recovery"
          : recovering
            ? "recovering"
            : "pending",
      ).pipe(Effect.ignore);
      yield* step(record).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          return repository.get(operationId).pipe(
            Effect.flatMap((latest) =>
              Option.isSome(latest) ? manual(latest.value, "unexpected-saga-failure") : Effect.void,
            ),
            Effect.ignore,
          );
        }),
      );
      yield* repository.releaseOwnerOwned(operationId, ownerId).pipe(Effect.ignore);
    },
  );

  const recoveryError = (
    reason: "not-found" | "action-not-allowed" | "operation-busy",
    message: string,
  ) => new OrchestrationRollbackRecoveryError({ reason, message });

  const recover: RollbackSagaRunnerShape["recover"] = Effect.fn("RollbackSagaRunner.recover")(
    function* (input) {
      const active = yield* repository
        .getActiveByThread(input.threadId)
        .pipe(
          Effect.mapError(() =>
            recoveryError("not-found", "Pylon could not read the fenced rollback operation."),
          ),
        );
      if (Option.isNone(active)) {
        return yield* recoveryError(
          "not-found",
          "No fenced rollback operation exists for this thread.",
        );
      }
      const state = active.value.state;
      const allowed =
        state.phase === "manual-recovery" &&
        ((input.action === "retry-verification" && state.projectionCommitSequence !== null) ||
          (input.action === "resume-compensation" &&
            state.projectionCommitSequence === null &&
            state.compensation === "manual"));
      if (!allowed) {
        return yield* recoveryError(
          "action-not-allowed",
          "That recovery action is not safe for the rollback's current durable phase.",
        );
      }

      const claimed = yield* repository
        .claim(active.value.operationId, ownerId)
        .pipe(
          Effect.mapError(() =>
            recoveryError("operation-busy", "Another client is already recovering this rollback."),
          ),
        );
      if (Option.isNone(claimed)) {
        return yield* recoveryError(
          "operation-busy",
          "Another client is already recovering this rollback.",
        );
      }
      const claimedState = claimed.value.state;
      const nextState: RollbackSagaState = {
        ...claimedState,
        phase:
          input.action === "retry-verification"
            ? "projection-committed"
            : "compensation-workspace-started",
        attempt: 0,
        compensation: input.action === "retry-verification" ? "none" : "required",
        lastErrorCode: null,
        updatedAt: yield* nowIso,
      };
      const updated = yield* repository
        .updateOwned({
          operationId: claimed.value.operationId,
          ownerId,
          expectedVersion: claimed.value.version,
          state: nextState,
        })
        .pipe(
          Effect.mapError(() =>
            recoveryError(
              "operation-busy",
              "The rollback recovery phase changed on another client.",
            ),
          ),
        );
      if (Option.isNone(updated)) {
        yield* repository.releaseOwnerOwned(claimed.value.operationId, ownerId).pipe(Effect.ignore);
        return yield* recoveryError(
          "operation-busy",
          "The rollback recovery phase changed on another client.",
        );
      }
      yield* publishPhase(updated.value.state);
      yield* repository.releaseOwnerOwned(updated.value.operationId, ownerId).pipe(Effect.ignore);
      yield* run(updated.value.operationId, true);
    },
  );

  return RollbackSagaRunner.of({ run, recover });
});

export const layer = Layer.effect(RollbackSagaRunner, make);
