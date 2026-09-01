import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import { getProviderAdmissionAvailability } from "@t3tools/client-runtime/providerAvailability";
import { resolveProviderContinuationTransition } from "@t3tools/client-runtime/providerContinuation";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ModelSelection as ModelSelectionType,
  type OrchestrationSessionStatus,
  type ProjectId as ProjectIdType,
  type ProviderInteractionMode as ProviderInteractionModeType,
  type RuntimeMode as RuntimeModeType,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { DraftComposerImageAttachmentSchema } from "../lib/composer-image-schema";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";

const THREAD_OUTBOX_SCHEMA_VERSION = 6;
const THREAD_OUTBOX_MAX_RETRY_DELAY_MS = 16_000;

const QueuedThreadCreationSchema = Schema.Struct({
  projectId: ProjectId,
  // Snapshot of the project's display metadata so a pending task stays
  // presentable in the thread list even when the project shell is not loaded.
  projectTitle: Schema.optional(Schema.String),
  projectCwd: Schema.optional(Schema.String),
  workspaceMode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

const ThreadOutboxDeliveryHoldSchema = Schema.Struct({
  kind: Schema.Literals([
    "provider-unavailable",
    "provider-binding-mismatch",
    "provider-binding-unresolved",
    "project-workspace-unavailable",
    "thread-missing",
    "admission-rejected",
  ]),
  reason: Schema.String,
  boundInstanceId: Schema.optional(Schema.String),
  queuedInstanceId: Schema.optional(Schema.String),
});

export const QueuedThreadMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2, 3, 4, 5, THREAD_OUTBOX_SCHEMA_VERSION]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  attachments: Schema.Array(DraftComposerImageAttachmentSchema),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  deliveryHold: Schema.optional(ThreadOutboxDeliveryHoldSchema),
  // Present when the queued item creates a brand-new thread (pending task)
  // instead of appending a turn to an existing one.
  creation: Schema.optional(QueuedThreadCreationSchema),
  // Existing sends retain enough provider-neutral destination metadata to be
  // explicitly retargeted if another device deletes the thread before send.
  destination: Schema.optional(QueuedThreadCreationSchema),
  createdAt: IsoDateTime,
});

const decodeStoredQueuedThreadMessage = Schema.decodeUnknownSync(QueuedThreadMessageSchema);
const encodeStoredQueuedThreadMessage = Schema.encodeUnknownSync(QueuedThreadMessageSchema);

export interface QueuedThreadCreation {
  readonly projectId: ProjectIdType;
  readonly projectTitle?: string;
  readonly projectCwd?: string;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean;
}

export interface ThreadOutboxDeliveryHold {
  readonly kind:
    | "provider-unavailable"
    | "provider-binding-mismatch"
    | "provider-binding-unresolved"
    | "project-workspace-unavailable"
    | "thread-missing"
    | "admission-rejected";
  readonly reason: string;
  readonly boundInstanceId?: string;
  readonly queuedInstanceId?: string;
}

export interface QueuedThreadMessage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly modelSelection?: ModelSelectionType;
  readonly runtimeMode?: RuntimeModeType;
  readonly interactionMode?: ProviderInteractionModeType;
  readonly deliveryHold?: ThreadOutboxDeliveryHold;
  readonly creation?: QueuedThreadCreation;
  readonly destination?: QueuedThreadCreation;
  readonly createdAt: string;
}

export interface ThreadSettingsSnapshot {
  readonly modelSelection: ModelSelectionType;
  readonly runtimeMode: RuntimeModeType;
  readonly interactionMode: ProviderInteractionModeType;
  readonly session?: {
    readonly providerInstanceId?: ModelSelectionType["instanceId"] | undefined;
  } | null;
}

export function resolveQueuedThreadSettings(
  message: QueuedThreadMessage,
  thread: ThreadSettingsSnapshot,
): ThreadSettingsSnapshot {
  return {
    modelSelection: message.modelSelection ?? thread.modelSelection,
    runtimeMode: message.runtimeMode ?? thread.runtimeMode,
    interactionMode: message.interactionMode ?? thread.interactionMode,
  };
}

export type ThreadOutboxAdmission =
  | { readonly action: "send"; readonly settings: ThreadSettingsSnapshot }
  | { readonly action: "wait" }
  | { readonly action: "hold"; readonly hold: ThreadOutboxDeliveryHold };

/** Revalidate the exact live binding before any queued command is dispatched. */
export function resolveQueuedThreadAdmission(input: {
  readonly message: QueuedThreadMessage;
  readonly thread: ThreadSettingsSnapshot;
  readonly providers: ReadonlyArray<ServerProvider> | null | undefined;
}): ThreadOutboxAdmission {
  const providers = input.providers ?? [];
  const boundInstanceId = input.thread.session?.providerInstanceId;
  const queuedInstanceId = input.message.modelSelection?.instanceId;
  const queuedTransition =
    boundInstanceId !== undefined &&
    queuedInstanceId !== undefined &&
    queuedInstanceId !== boundInstanceId
      ? resolveProviderContinuationTransition({
          providers,
          currentInstanceId: boundInstanceId,
          targetInstanceId: queuedInstanceId,
        })
      : null;
  if (queuedTransition?.compatible === false) {
    return {
      action: "hold",
      hold: {
        kind: "provider-binding-mismatch",
        reason: `${queuedTransition.reason} Reconcile this pending send or delete it.`,
        boundInstanceId,
        ...(queuedInstanceId === undefined ? {} : { queuedInstanceId }),
      },
    };
  }

  const modelSelection =
    boundInstanceId === undefined
      ? (input.message.modelSelection ?? input.thread.modelSelection)
      : input.message.modelSelection !== undefined &&
          (input.message.modelSelection.instanceId === boundInstanceId ||
            queuedTransition?.compatible === true)
        ? input.message.modelSelection
        : input.thread.modelSelection.instanceId === boundInstanceId
          ? input.thread.modelSelection
          : null;
  if (modelSelection === null) {
    return {
      action: "hold",
      hold: {
        kind: "provider-binding-unresolved",
        reason: `This thread is bound to '${boundInstanceId}', but no model selection exists for that exact provider. Select a bound model or delete the pending send.`,
        ...(boundInstanceId === undefined ? {} : { boundInstanceId }),
      },
    };
  }

  const provider = providers.find(
    (candidate) => candidate.instanceId === modelSelection.instanceId,
  );
  const providerAvailability = getProviderAdmissionAvailability({
    provider,
    instanceId: String(modelSelection.instanceId),
    providerSnapshotKnown: input.providers !== null && input.providers !== undefined,
  });
  if (providerAvailability.status === "unknown") {
    return { action: "wait" };
  }
  if (providerAvailability.status === "unavailable") {
    return {
      action: "hold",
      hold: {
        kind: "provider-unavailable",
        reason: providerAvailability.reason,
        ...(boundInstanceId === undefined ? {} : { boundInstanceId }),
        queuedInstanceId: modelSelection.instanceId,
      },
    };
  }

  return {
    action: "send",
    settings: {
      modelSelection,
      runtimeMode: input.message.runtimeMode ?? input.thread.runtimeMode,
      interactionMode: input.message.interactionMode ?? input.thread.interactionMode,
      session: input.thread.session,
    },
  };
}

export function resolveQueuedCreationAdmission(input: {
  readonly message: QueuedThreadMessage;
  readonly providers: ReadonlyArray<ServerProvider> | null | undefined;
}): Exclude<ThreadOutboxAdmission, { readonly action: "send" }> | { readonly action: "send" } {
  const modelSelection = input.message.modelSelection;
  if (modelSelection === undefined) return { action: "wait" };
  const provider = input.providers?.find(
    (candidate) => candidate.instanceId === modelSelection.instanceId,
  );
  const availability = getProviderAdmissionAvailability({
    provider,
    instanceId: String(modelSelection.instanceId),
    providerSnapshotKnown: input.providers !== null && input.providers !== undefined,
  });
  if (availability.status === "unknown") return { action: "wait" };
  if (availability.status === "unavailable") {
    return {
      action: "hold",
      hold: {
        kind: "provider-unavailable",
        reason: availability.reason,
        queuedInstanceId: modelSelection.instanceId,
      },
    };
  }
  return { action: "send" };
}

export function preserveQueuedThreadDeliveryHold(
  message: QueuedThreadMessage | null | undefined,
  identity: {
    readonly threadId: string;
    readonly commandId: string;
    readonly messageId: string;
    readonly createdAt: string;
  },
): ThreadOutboxDeliveryHold | undefined {
  return message !== null &&
    message !== undefined &&
    identity.threadId === message.threadId &&
    identity.commandId === message.commandId &&
    identity.messageId === message.messageId &&
    identity.createdAt === message.createdAt
    ? message.deliveryHold
    : undefined;
}

export function retryQueuedThreadMessage(
  message: QueuedThreadMessage,
  input: {
    readonly commandId: CommandId;
    readonly createdAt: string;
    readonly modelSelection?: ModelSelectionType;
    readonly runtimeMode?: RuntimeModeType;
    readonly interactionMode?: ProviderInteractionModeType;
  },
): QueuedThreadMessage {
  const { deliveryHold: _hold, ...retry } = message;
  return {
    ...retry,
    commandId: input.commandId,
    createdAt: input.createdAt,
    ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
    ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
    ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
  };
}

export function threadOutboxDeliveryHoldsEqual(
  left: ThreadOutboxDeliveryHold | undefined,
  right: ThreadOutboxDeliveryHold | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function modelSelectionsEqual(left: ModelSelectionType, right: ModelSelectionType): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

export function encodeQueuedThreadMessage(message: QueuedThreadMessage): unknown {
  return encodeStoredQueuedThreadMessage({
    schemaVersion: THREAD_OUTBOX_SCHEMA_VERSION,
    ...message,
  });
}

export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage {
  const { schemaVersion: _, ...message } = decodeStoredQueuedThreadMessage(value);
  return message;
}

export function groupQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
): Record<string, ReadonlyArray<QueuedThreadMessage>> {
  const deduplicated = new Map<MessageId, QueuedThreadMessage>();
  for (const message of messages) {
    deduplicated.set(message.messageId, message);
  }

  const grouped: Record<string, Array<QueuedThreadMessage>> = {};
  for (const message of deduplicated.values()) {
    const threadKey = scopedThreadKey(message.environmentId, message.threadId);
    (grouped[threadKey] ??= []).push(message);
  }
  for (const queue of Object.values(grouped)) {
    queue.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return grouped;
}

export function flattenQueuedThreadMessages(
  queues: Record<string, ReadonlyArray<QueuedThreadMessage>>,
): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(queues).flat();
}

export function threadOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_OUTBOX_MAX_RETRY_DELAY_MS);
}

export type ThreadOutboxDeliveryAction = "confirm" | "wait" | "remove" | "send";

export function queuedCreationWorkspaceHold(input: {
  readonly message: QueuedThreadMessage;
  readonly project: { readonly workspaceRoot: string | null | undefined } | null | undefined;
  readonly shellStatus: EnvironmentShellStatus;
}): ThreadOutboxDeliveryHold | null {
  if (input.message.creation === undefined || input.shellStatus !== "live") return null;
  if (input.project?.workspaceRoot?.trim()) return null;
  return {
    kind: "project-workspace-unavailable",
    reason:
      "The queued task's project workspace is missing. Retarget it to a valid project or delete it.",
  };
}

export function resolveThreadOutboxDeliveryAction(input: {
  readonly isCreation: boolean;
  readonly threadExists: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly environmentConnected: boolean;
  readonly threadStatus: OrchestrationSessionStatus | null;
  readonly hasDeliveryHold?: boolean;
}): ThreadOutboxDeliveryAction {
  if (input.hasDeliveryHold === true) return "wait";
  if (input.isCreation) {
    // A pending task creates its thread on delivery. If the thread already
    // exists the creation command went through and only cleanup remains.
    if (input.threadExists) {
      return "remove";
    }
    // Wait for the shell to be live before sending: until the thread list has
    // synchronized, a previously delivered creation whose cleanup failed would
    // look missing and get re-issued, duplicating the thread.
    return input.environmentConnected && input.shellStatus === "live" ? "send" : "wait";
  }
  if (!input.threadExists) {
    // A synchronized missing thread still crosses durable confirmation before
    // it is converted to a provider-neutral hold. Nothing removes it here.
    return input.shellStatus === "live" ? "confirm" : "wait";
  }
  if (!input.environmentConnected || input.threadStatus === "starting") {
    return "wait";
  }
  return "send";
}

export type ConfirmedThreadOutboxPlan =
  | { readonly action: "wait" }
  | { readonly action: "remove" }
  | {
      readonly action: "hold";
      readonly hold: ThreadOutboxDeliveryHold;
      readonly creation?: QueuedThreadCreation;
    }
  | { readonly action: "send-existing"; readonly settings: ThreadSettingsSnapshot }
  | { readonly action: "send-creation"; readonly projectCwd: string };

/** Recompute every delivery authority after the durable-confirmation boundary. */
export function resolveConfirmedThreadOutboxPlan(input: {
  readonly message: QueuedThreadMessage;
  readonly thread:
    | (ThreadSettingsSnapshot & {
        readonly session?:
          | (NonNullable<ThreadSettingsSnapshot["session"]> & {
              readonly status: OrchestrationSessionStatus;
            })
          | null;
      })
    | null
    | undefined;
  readonly shellStatus: EnvironmentShellStatus;
  readonly environmentConnected: boolean;
  readonly providers: ReadonlyArray<ServerProvider> | null | undefined;
  readonly project: { readonly workspaceRoot: string | null | undefined } | null | undefined;
}): ConfirmedThreadOutboxPlan {
  if (input.message.deliveryHold !== undefined) return { action: "wait" };
  const creation = input.message.creation;
  if (creation === undefined && input.thread == null) {
    if (input.shellStatus !== "live") return { action: "wait" };
    return {
      action: "hold",
      hold: {
        kind: "thread-missing",
        reason:
          "This thread was deleted on another device before the pending send landed. Retarget it to a new thread or delete it.",
      },
      ...(input.message.destination === undefined ? {} : { creation: input.message.destination }),
    };
  }

  const deliveryAction = resolveThreadOutboxDeliveryAction({
    isCreation: creation !== undefined,
    threadExists: input.thread != null,
    shellStatus: input.shellStatus,
    environmentConnected: input.environmentConnected,
    threadStatus: input.thread?.session?.status ?? null,
  });
  if (deliveryAction === "wait") return { action: "wait" };
  if (deliveryAction === "remove") return { action: "remove" };

  if (creation === undefined) {
    const admission = resolveQueuedThreadAdmission({
      message: input.message,
      thread: input.thread!,
      providers: input.providers,
    });
    return admission.action === "send"
      ? { action: "send-existing", settings: admission.settings }
      : admission;
  }
  if (!isQueuedThreadCreationSendable(input.message)) return { action: "wait" };
  const workspaceHold = queuedCreationWorkspaceHold({
    message: input.message,
    project: input.project,
    shellStatus: input.shellStatus,
  });
  if (workspaceHold !== null) return { action: "hold", hold: workspaceHold };
  const admission = resolveQueuedCreationAdmission({
    message: input.message,
    providers: input.providers,
  });
  if (admission.action !== "send") return admission;
  const projectCwd = input.project?.workspaceRoot?.trim();
  return projectCwd
    ? { action: "send-creation", projectCwd }
    : {
        action: "hold",
        hold: {
          kind: "project-workspace-unavailable",
          reason:
            "The queued task's project workspace is missing. Retarget it to a valid project or delete it.",
        },
      };
}

/**
 * A queued creation can only be dispatched once its payload would pass server
 * validation; incomplete payloads stay pending until the user edits them.
 */
export function isQueuedThreadCreationSendable(message: QueuedThreadMessage): boolean {
  if (!message.creation) {
    return false;
  }
  if (message.text.trim().length === 0 || message.modelSelection === undefined) {
    return false;
  }
  return message.creation.workspaceMode !== "worktree" || Boolean(message.creation.branch);
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return typeof error === "string" ? error : null;
}

export function shouldRetryThreadOutboxDelivery(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ConnectionTransientError"
  ) {
    return true;
  }
  return isTransportConnectionErrorMessage(errorMessage(error));
}

export type ThreadOutboxCommandStage = "settings-sync" | "start-turn";
export type ThreadOutboxFailureAction = "retry" | "hold";

export function resolveThreadOutboxFailureAction(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
}): ThreadOutboxFailureAction {
  if (input.interrupted || shouldRetryThreadOutboxDelivery(input.error)) {
    return "retry";
  }
  return "hold";
}
