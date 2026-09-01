/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderAbortSessionCompactionInput,
  ProviderAskSessionSideQuestionInput,
  ProviderAskSessionSideQuestionResult,
  ProviderCancelSessionAgentInput,
  ProviderCancelSessionSideQuestionInput,
  ProviderCancelSessionSideQuestionResult,
  ProviderCancelSessionAgentResult,
  ProviderClearSessionInputQueueInput,
  ProviderCompactSessionInput,
  ProviderFollowUpInput,
  ProviderMessageSessionAgentInput,
  ProviderMessageSessionAgentResult,
  ProviderWatchSessionAgentActivityInput,
  ProviderSessionAgentActivitySnapshot,
  ProviderGetSessionAgentDepthInput,
  ProviderGetSessionCompactionInput,
  ProviderGetSessionInputQueueInput,
  ProviderInterruptTurnInput,
  ProviderRemoveOnlySessionInputQueueItemInput,
  ProviderInstanceId,
  ProviderReloadSessionResourcesInput,
  ProviderRefineSessionHarnessInput,
  ProviderRefineSessionHarnessResult,
  ProviderSetSessionAgentDepthInput,
  ProviderSetSessionAutoCompactionInput,
  ProviderSetSessionInputQueueModeInput,
  SessionAgentDepthUpdatedPayload,
  SessionCompactionUpdatedPayload,
  SessionInputQueueUpdatedPayload,
  SessionResourcesUpdatedPayload,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRespondToInteractionInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  ThreadId,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderMaintenanceReservation {
  readonly token: string;
}

export type ProviderMaintenanceReservationResult =
  | { readonly status: "reserved"; readonly reservation: ProviderMaintenanceReservation }
  | { readonly status: "busy"; readonly reasons: ReadonlyArray<string> };

export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /** Adopt eligible surviving Prime executions before startup orphan reconciliation. */
  readonly recoverRestartSessions?: () => Effect.Effect<void, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider-neutral session interaction.
   */
  readonly respondToInteraction: (
    input: ProviderRespondToInteractionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Explicitly reload an active provider session's resource catalog.
   */
  readonly reloadSessionResources: (
    input: ProviderReloadSessionResourcesInput,
  ) => Effect.Effect<SessionResourcesUpdatedPayload, ProviderServiceError>;

  readonly askSessionSideQuestion: (
    input: ProviderAskSessionSideQuestionInput,
  ) => Effect.Effect<ProviderAskSessionSideQuestionResult, ProviderServiceError>;

  readonly cancelSessionSideQuestion: (
    input: ProviderCancelSessionSideQuestionInput,
  ) => Effect.Effect<ProviderCancelSessionSideQuestionResult, ProviderServiceError>;

  readonly cancelSessionAgent: (
    input: ProviderCancelSessionAgentInput,
  ) => Effect.Effect<ProviderCancelSessionAgentResult, ProviderServiceError>;

  readonly messageSessionAgent: (
    input: ProviderMessageSessionAgentInput,
  ) => Effect.Effect<ProviderMessageSessionAgentResult, ProviderServiceError>;

  readonly watchSessionAgentActivity: (
    input: ProviderWatchSessionAgentActivityInput,
  ) => Stream.Stream<ProviderSessionAgentActivitySnapshot, ProviderServiceError>;

  readonly getSessionAgentDepth: (
    input: ProviderGetSessionAgentDepthInput,
  ) => Effect.Effect<SessionAgentDepthUpdatedPayload, ProviderServiceError>;

  readonly setSessionAgentDepth: (
    input: ProviderSetSessionAgentDepthInput,
  ) => Effect.Effect<SessionAgentDepthUpdatedPayload, ProviderServiceError>;

  readonly followUp: (
    input: ProviderFollowUpInput,
  ) => Effect.Effect<SessionInputQueueUpdatedPayload, ProviderServiceError>;

  readonly getSessionInputQueue: (
    input: ProviderGetSessionInputQueueInput,
  ) => Effect.Effect<SessionInputQueueUpdatedPayload, ProviderServiceError>;

  readonly clearSessionInputQueue: (
    input: ProviderClearSessionInputQueueInput,
  ) => Effect.Effect<SessionInputQueueUpdatedPayload, ProviderServiceError>;

  readonly removeOnlySessionInputQueueItem: (
    input: ProviderRemoveOnlySessionInputQueueItemInput,
  ) => Effect.Effect<SessionInputQueueUpdatedPayload, ProviderServiceError>;

  readonly setSessionInputQueueMode: (
    input: ProviderSetSessionInputQueueModeInput,
  ) => Effect.Effect<SessionInputQueueUpdatedPayload, ProviderServiceError>;

  readonly getSessionCompaction: (
    input: ProviderGetSessionCompactionInput,
  ) => Effect.Effect<SessionCompactionUpdatedPayload, ProviderServiceError>;

  readonly compactSession: (
    input: ProviderCompactSessionInput,
  ) => Effect.Effect<SessionCompactionUpdatedPayload, ProviderServiceError>;

  readonly abortSessionCompaction: (
    input: ProviderAbortSessionCompactionInput,
  ) => Effect.Effect<SessionCompactionUpdatedPayload, ProviderServiceError>;

  readonly setSessionAutoCompaction: (
    input: ProviderSetSessionAutoCompactionInput,
  ) => Effect.Effect<SessionCompactionUpdatedPayload, ProviderServiceError>;

  readonly refineSessionHarness: (
    input: ProviderRefineSessionHarnessInput,
  ) => Effect.Effect<ProviderRefineSessionHarnessResult, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /** Read the exact durable continuation even when no adapter runtime is live. */
  readonly getSessionContinuation?: (
    threadId: ThreadId,
  ) => Effect.Effect<
    { readonly providerInstanceId: ProviderInstanceId; readonly resumeCursor: unknown } | null,
    ProviderServiceError
  >;

  /** Inventory exactly one configured provider instance without coupling failures. */
  readonly listSessionsForInstance?: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ProviderSession>, ProviderServiceError>;

  /** Atomically fences new starts/admissions, then inventories exact instance quiescence. */
  readonly reserveProviderMaintenance?: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderMaintenanceReservationResult, ProviderServiceError>;

  readonly releaseProviderMaintenance?: (
    reservation: ProviderMaintenanceReservation,
  ) => Effect.Effect<void>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Upload a thread and return the provider's shareable feedback identifier.
   */
  readonly uploadFeedback: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "t3/provider/Services/ProviderService",
) {}
