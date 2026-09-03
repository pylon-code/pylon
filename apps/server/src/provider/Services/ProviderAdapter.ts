/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderAskSessionSideQuestionResult,
  ProviderCancelSessionSideQuestionResult,
  ProviderSessionSideQuestionRequestId,
  ProviderCancelSessionAgentResult,
  ProviderFollowUpInput,
  ProviderMessageSessionAgentResult,
  ProviderRemoveOnlySessionInputQueueItemInput,
  ProviderRefineSessionHarnessResult,
  ProviderSessionAgentActivitySnapshot,
  ProviderDriverKind,
  ProviderSetSessionAutoCompactionInput,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  SessionInteractionRequestId,
  SessionInteractionResponse,
  SessionAgentDepthUpdatedPayload,
  SessionCompactionUpdatedPayload,
  SessionInputQueueUpdatedPayload,
  SessionResourcesUpdatedPayload,
  ProviderSendTurnInput,
  ProviderSetSessionInputQueueModeInput,
  ProviderSession,
  ProviderSessionStartInput,
  CheckpointRef,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  ThreadId,
  RuntimeTaskId,
  ProviderTurnStartResult,
  TurnId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { Json } from "effect/Schema";
import type { ProviderRuntimeFence } from "../ProviderDriver.ts";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";
export type ProviderConversationRollbackMode = "absolute" | "relative" | "unsupported";

export const BUILT_IN_ADAPTER_CONVERSATION_ROLLBACK_MODES = {
  codex: "relative",
  claude: "relative",
  cursor: "unsupported",
  grok: "unsupported",
  openCode: "relative",
  prime: "unsupported",
  primeDaemon: "unsupported",
} as const satisfies Record<string, ProviderConversationRollbackMode>;

export interface ProviderConversationAnchorReceipt {
  /** Provider-private absolute identity. It must never enter public events or logs. */
  readonly anchor: Json;
  /** Provider-private stable digest used only for equality checks inside the saga. */
  readonly digest: string;
}

export type ProviderConversationAnchorBinding =
  | {
      readonly kind: "checkpoint";
      readonly checkpointTurnCount: number;
      readonly turnId: TurnId | null;
      readonly checkpointRef: CheckpointRef;
      readonly checkpointOid: string;
      readonly sourceRevision: number;
    }
  | {
      readonly kind: "source";
      readonly sourceRevision: number;
      readonly checkpointRef: CheckpointRef;
      readonly checkpointOid: string;
      readonly turnId: TurnId | null;
    };

export interface ProviderAbsoluteConversationRollback<TError> {
  /** Exact per-thread gates. Static adapter capability alone is not enough. */
  readonly isAvailable: (threadId: ThreadId) => Effect.Effect<boolean, TError>;
  readonly captureAnchor: (input: {
    readonly threadId: ThreadId;
    readonly binding: ProviderConversationAnchorBinding;
  }) => Effect.Effect<ProviderConversationAnchorReceipt, TError>;
  readonly inspectAnchor: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderConversationAnchorReceipt, TError>;
  readonly applyAnchor: (threadId: ThreadId, anchor: Json) => Effect.Effect<void, TError>;
  /** Holds native output until the saga commits and proves the final leaf. */
  readonly releaseAnchor: (threadId: ThreadId, anchor: Json) => Effect.Effect<void, TError>;
  /** Installs quarantine before retained restart-adoption frames are released. */
  readonly prepareRecovery?: (input: {
    readonly threadId: ThreadId;
    readonly sourceAnchor: Json;
    readonly desiredAnchor: Json;
    readonly expectedAnchor: Json;
  }) => Effect.Effect<void, TError>;
}

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /**
   * Optional for adapter compatibility. An absent declaration is unsupported;
   * callers must never assume legacy rollback support.
   */
  readonly conversationRollback?: ProviderConversationRollbackMode;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;
  /** Server-private materialization fence. It never crosses provider contracts. */
  readonly runtimeFence?: ProviderRuntimeFence | undefined;

  /**
   * Exact provider conversation control. Production adapters intentionally omit
   * this until they can apply and inspect an immutable absolute anchor.
   */
  readonly absoluteConversationRollback?: ProviderAbsoluteConversationRollback<TError>;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /** Server-private hook. Prime uses it to replace an idle ordinary owner with a recoverable one. */
  readonly prepareTurnRecovery?: (input: ProviderSendTurnInput) => Effect.Effect<void, TError>;

  /** Server-private startup hook. It must fail closed and never submit provider input. */
  readonly recoverSession?: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: import("@t3tools/contracts").ProviderInstanceId;
    readonly sessionIncarnationId: import("@t3tools/contracts").RuntimeSessionId;
    readonly runtimeMode: ProviderSessionStartInput["runtimeMode"];
    readonly cwd: string;
    readonly modelSelection?: import("@t3tools/contracts").ModelSelection;
    readonly resumeCursor: unknown;
  }) => Effect.Effect<ProviderSession | null, TError>;

  /** Releases retained frames only after ProviderService installs exact incarnation fencing. */
  readonly activateRecoveredSession?: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /** Process shutdown can detach recoverable ownership instead of implementing explicit Stop. */
  readonly shutdown?: () => Effect.Effect<void, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a provider-neutral blocking session interaction. Optional so
   * adapters can explicitly surface unsupported interaction responses.
   */
  readonly respondToInteraction?: (
    threadId: ThreadId,
    requestId: SessionInteractionRequestId,
    response: SessionInteractionResponse,
  ) => Effect.Effect<void, TError>;

  /**
   * Reload one active session's provider-owned resource catalog. Optional so
   * adapters without a faithful session reload operation remain unsupported.
   */
  readonly reloadSessionResources?: (
    threadId: ThreadId,
  ) => Effect.Effect<SessionResourcesUpdatedPayload, TError>;

  /** Ask one ephemeral question against an already-active provider session. */
  readonly askSessionSideQuestion?: (
    threadId: ThreadId,
    requestId: ProviderSessionSideQuestionRequestId,
    question: string,
  ) => Effect.Effect<ProviderAskSessionSideQuestionResult, TError>;

  /** Cancel one in-flight ephemeral side question. */
  readonly cancelSessionSideQuestion?: (
    threadId: ThreadId,
    requestId: ProviderSessionSideQuestionRequestId,
  ) => Effect.Effect<ProviderCancelSessionSideQuestionResult, TError>;

  /** Cancel one known active provider agent belonging to this session. */
  readonly cancelSessionAgent?: (
    threadId: ThreadId,
    agentId: RuntimeTaskId,
  ) => Effect.Effect<ProviderCancelSessionAgentResult, TError>;

  /** Send bounded text to one known live provider agent without persisting content. */
  readonly messageSessionAgent?: (
    threadId: ThreadId,
    agentId: RuntimeTaskId,
    message: string,
  ) => Effect.Effect<ProviderMessageSessionAgentResult, TError>;

  /** Stream bounded assistant-only replacement snapshots for one known active agent. */
  readonly watchSessionAgentActivity?: (
    threadId: ThreadId,
    agentId: RuntimeTaskId,
  ) => Stream.Stream<ProviderSessionAgentActivitySnapshot, TError>;

  /** Read one active session's recursive agent-spawn depth. */
  readonly getSessionAgentDepth?: (
    threadId: ThreadId,
  ) => Effect.Effect<SessionAgentDepthUpdatedPayload, TError>;

  /** Set one active session's recursive agent-spawn depth. */
  readonly setSessionAgentDepth?: (
    threadId: ThreadId,
    maxDepth: number,
  ) => Effect.Effect<SessionAgentDepthUpdatedPayload, TError>;

  /** Admit a follow-up to the active provider run without starting a Pylon turn. */
  readonly followUp?: (
    input: ProviderFollowUpInput,
  ) => Effect.Effect<SessionInputQueueUpdatedPayload, TError>;

  /** Read the privacy-safe counts for one active session's input queue. */
  readonly getSessionInputQueue?: (
    threadId: ThreadId,
  ) => Effect.Effect<SessionInputQueueUpdatedPayload, TError>;

  /** Clear queued inputs without interrupting the active provider run. */
  readonly clearSessionInputQueue?: (
    threadId: ThreadId,
  ) => Effect.Effect<SessionInputQueueUpdatedPayload, TError>;

  /** Remove the current item only when the selected lane contains exactly one queued input. */
  readonly removeOnlySessionInputQueueItem?: (
    input: ProviderRemoveOnlySessionInputQueueItemInput,
  ) => Effect.Effect<SessionInputQueueUpdatedPayload, TError>;

  /** Configure how one category of queued inputs is delivered to the active session. */
  readonly setSessionInputQueueMode?: (
    input: ProviderSetSessionInputQueueModeInput,
  ) => Effect.Effect<SessionInputQueueUpdatedPayload, TError>;

  /** Read authoritative compaction control state for one active session. */
  readonly getSessionCompaction?: (
    threadId: ThreadId,
  ) => Effect.Effect<SessionCompactionUpdatedPayload, TError>;

  /** Admit one idle-only manual context compaction. */
  readonly compactSession?: (
    threadId: ThreadId,
  ) => Effect.Effect<SessionCompactionUpdatedPayload, TError>;

  /** Request cancellation without claiming a terminal compaction outcome. */
  readonly abortSessionCompaction?: (
    threadId: ThreadId,
  ) => Effect.Effect<SessionCompactionUpdatedPayload, TError>;

  /** Configure automatic compaction with provider-declared scope. */
  readonly setSessionAutoCompaction?: (
    input: ProviderSetSessionAutoCompactionInput,
  ) => Effect.Effect<SessionCompactionUpdatedPayload, TError>;

  /** Refine only the active session's local harness with provider-private inputs. */
  readonly refineSessionHarness?: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderRefineSessionHarnessResult, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Upload a thread to the provider when the adapter supports feedback.
   */
  readonly uploadFeedback?: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
