import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  CheckpointRef,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
} from "@t3tools/contracts";
import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const RollbackSagaPhase = Schema.Literals([
  "source-anchor-capture-started",
  "source-anchor-captured",
  "preimage-capture-started",
  "preimage-captured",
  "workspace-apply-started",
  "workspace-applied",
  "provider-apply-started",
  "provider-applied",
  "projection-commit-started",
  "projection-committed",
  "cleanup-started",
  "compensation-workspace-started",
  "compensation-workspace-complete",
  "compensation-provider-started",
  "compensated",
  "manual-recovery",
  "complete",
]);
export type RollbackSagaPhase = typeof RollbackSagaPhase.Type;

export const RollbackSagaState = Schema.Struct({
  operationId: Schema.String,
  requestEventId: Schema.String,
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceKey: Schema.String,
  workspaceCwd: Schema.String,
  sourceRevision: NonNegativeInt,
  targetRevision: NonNegativeInt,
  sourceCheckpointRef: CheckpointRef,
  sourceCheckpointOid: Schema.String,
  targetCheckpointRef: CheckpointRef,
  targetCheckpointOid: Schema.String,
  targetCheckpointDigest: Schema.String,
  providerInstanceId: ProviderInstanceId,
  sessionIncarnationId: RuntimeSessionId,
  phase: RollbackSagaPhase,
  attempt: NonNegativeInt,
  lastErrorCode: Schema.NullOr(Schema.String),
  compensation: Schema.Literals(["none", "required", "workspace", "provider", "proved", "manual"]),
  cleanup: Schema.Literals(["pending", "running", "complete"]),
  sourceAnchor: Schema.NullOr(Schema.Json),
  sourceAnchorDigest: Schema.NullOr(Schema.String),
  desiredAnchor: Schema.NullOr(Schema.Json),
  desiredAnchorDigest: Schema.NullOr(Schema.String),
  preimage: Schema.NullOr(Schema.Unknown),
  workspaceReceiptDigest: Schema.NullOr(Schema.String),
  providerReceiptDigest: Schema.NullOr(Schema.String),
  projectionCommitSequence: Schema.NullOr(NonNegativeInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type RollbackSagaState = typeof RollbackSagaState.Type;

export const RollbackSagaRecord = Schema.Struct({
  operationId: Schema.String,
  requestEventId: Schema.String,
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceKey: Schema.String,
  phase: RollbackSagaPhase,
  terminal: Schema.Boolean,
  ownerId: Schema.NullOr(Schema.String),
  version: NonNegativeInt,
  state: RollbackSagaState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type RollbackSagaRecord = typeof RollbackSagaRecord.Type;

export const RollbackCheckpointAnchor = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
  providerInstanceId: ProviderInstanceId,
  sessionIncarnationId: RuntimeSessionId,
  checkpointRef: CheckpointRef,
  checkpointOid: Schema.String,
  anchor: Schema.Json,
  anchorDigest: Schema.String,
  capturedAt: IsoDateTime,
});
export type RollbackCheckpointAnchor = typeof RollbackCheckpointAnchor.Type;

export type RollbackSagaRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface RollbackSagaRepositoryShape {
  readonly admit: (state: RollbackSagaState) => Effect.Effect<void, RollbackSagaRepositoryError>;
  readonly get: (
    operationId: string,
  ) => Effect.Effect<Option.Option<RollbackSagaRecord>, RollbackSagaRepositoryError>;
  readonly getByRequestEvent: (
    requestEventId: string,
  ) => Effect.Effect<Option.Option<RollbackSagaRecord>, RollbackSagaRepositoryError>;
  readonly getActiveByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<RollbackSagaRecord>, RollbackSagaRepositoryError>;
  readonly listNonterminal: () => Effect.Effect<
    ReadonlyArray<RollbackSagaRecord>,
    RollbackSagaRepositoryError
  >;
  /** Process-local hot-path view. The repository invalidates it on every admission/terminal CAS. */
  readonly listNonterminalForFence: () => Effect.Effect<
    ReadonlyArray<RollbackSagaRecord>,
    RollbackSagaRepositoryError
  >;
  readonly clearOwnersForStartup: () => Effect.Effect<void, RollbackSagaRepositoryError>;
  readonly claim: (
    operationId: string,
    ownerId: string,
  ) => Effect.Effect<Option.Option<RollbackSagaRecord>, RollbackSagaRepositoryError>;
  readonly updateOwned: (input: {
    readonly operationId: string;
    readonly ownerId: string;
    readonly expectedVersion: number;
    readonly state: RollbackSagaState;
    readonly terminal?: boolean;
  }) => Effect.Effect<Option.Option<RollbackSagaRecord>, RollbackSagaRepositoryError>;
  readonly releaseOwnerOwned: (
    operationId: string,
    ownerId: string,
  ) => Effect.Effect<void, RollbackSagaRepositoryError>;
  readonly releaseLeaseOwned: (input: {
    readonly operationId: string;
    readonly ownerId: string;
    readonly expectedVersion: number;
    readonly state: RollbackSagaState;
  }) => Effect.Effect<Option.Option<RollbackSagaRecord>, RollbackSagaRepositoryError>;
  readonly findLeaseByWorkspace: (
    workspaceKey: string,
  ) => Effect.Effect<
    Option.Option<{
      readonly operationId: string;
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    }>,
    RollbackSagaRepositoryError
  >;
  readonly putCheckpointAnchor: (
    anchor: RollbackCheckpointAnchor,
  ) => Effect.Effect<void, RollbackSagaRepositoryError>;
  readonly getCheckpointAnchor: (input: {
    readonly threadId: ThreadId;
    readonly checkpointTurnCount: number;
    readonly providerInstanceId: ProviderInstanceId;
    readonly sessionIncarnationId: RuntimeSessionId;
  }) => Effect.Effect<Option.Option<RollbackCheckpointAnchor>, RollbackSagaRepositoryError>;
  readonly deleteCheckpointAnchorsAfter: (input: {
    readonly threadId: ThreadId;
    readonly checkpointTurnCount: number;
  }) => Effect.Effect<void, RollbackSagaRepositoryError>;
}

export class RollbackSagaRepository extends Context.Service<
  RollbackSagaRepository,
  RollbackSagaRepositoryShape
>()("t3/persistence/Services/RollbackSagas/RollbackSagaRepository") {}
