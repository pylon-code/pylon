import {
  resolveThreadOutboxFailureAction,
  shouldRetryThreadOutboxDelivery,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
  type ThreadOutboxFailureAction,
} from "./thread-outbox-model";

// The UI's transport-message helper also matches a bare "RpcClientError". For
// logging, require an actual connection symptom so other RPC failures stay visible.
const ORDINARY_CONNECTION_MESSAGES = [
  /\bSocket(?:Read|Write|Open|Close)Error\b/i,
  /\bSocket is not connected\b/i,
  /Unable to connect to the T3 server WebSocket\./i,
  /\bis not connected\.$/i,
  /\bdisconnected\.$/i,
  /\bcould not establish a WebSocket connection\.$/i,
  /\bping timeout\b/i,
] as const;

function isOrdinaryTransportFailure(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "RpcClientError") {
      const reason: unknown = (error as { readonly reason?: unknown }).reason;
      if (typeof reason !== "object" || reason === null || !("_tag" in reason)) return false;
      return [
        "SocketReadError",
        "SocketWriteError",
        "SocketOpenError",
        "SocketCloseError",
      ].includes(String(reason._tag));
    }
    return [
      "ConnectionTransientError",
      "EnvironmentRpcUnavailableError",
      "EnvironmentNotRegisteredError",
    ].includes(String(error._tag));
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof error.message === "string"
          ? error.message
          : null;
  return message !== null && ORDINARY_CONNECTION_MESSAGES.some((pattern) => pattern.test(message));
}

function debugLog(event: string, details: Record<string, unknown>): void {
  // Queued sends naturally retry offline. Keep those diagnostics available
  // without writing a warning for every backoff attempt.
  if (
    (globalThis as { readonly __PYLON_OUTBOX_DEBUG__?: boolean }).__PYLON_OUTBOX_DEBUG__ === true
  ) {
    console.log(`[pylon-thread-outbox] ${event}`, details);
  }
}

export function reportOutboxDeliveryFailure(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
  readonly context: Record<string, unknown>;
}): ThreadOutboxFailureAction {
  const action = resolveThreadOutboxFailureAction(input);
  const details = { ...input.context, stage: input.stage, action };
  if (action === "retry" && (input.interrupted || isOrdinaryTransportFailure(input.error))) {
    debugLog("queued message delivery failed; retrying", details);
  } else {
    console.warn("[thread-outbox] queued message delivery failed", details);
  }
  return action;
}

export function reportOutboxUploadFailure(
  message: Pick<QueuedThreadMessage, "environmentId" | "threadId" | "messageId">,
  error: unknown,
): void {
  const details = {
    environmentId: message.environmentId,
    threadId: message.threadId,
    messageId: message.messageId,
    error,
  };
  if (shouldRetryThreadOutboxDelivery(error) && isOrdinaryTransportFailure(error)) {
    debugLog("attachment upload failed; retrying", details);
  } else {
    console.warn("[thread-outbox] failed to upload attachments", details);
  }
}

export function reportOutboxEditedAfterDelivery(
  message: Pick<QueuedThreadMessage, "environmentId" | "threadId" | "messageId">,
): void {
  debugLog("delivered message was edited before cleanup", {
    environmentId: message.environmentId,
    threadId: message.threadId,
    messageId: message.messageId,
  });
}
