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
  ProviderCancelSessionAgentResult,
  ProviderFollowUpInput,
  ProviderMessageSessionAgentResult,
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
  ThreadId,
  RuntimeTaskId,
  ProviderTurnStartResult,
  TurnId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";
export type ProviderConversationRollbackMode = "supported" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /**
   * Optional for adapter compatibility. Absence preserves the legacy behavior
   * where provider conversation rollback is assumed to be supported.
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
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
