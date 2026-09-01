import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type MessageId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { scopedThreadKey } from "../lib/scopedEntities";
import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { toUploadChatImageAttachments } from "../lib/composerImages";
import { randomHex } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { useThreadShells } from "./entities";
import {
  confirmThreadOutboxMessageQueued,
  ensureThreadOutboxLoaded,
  removeThreadOutboxMessage,
  threadOutboxManager,
  updateThreadOutboxMessage,
} from "./thread-outbox";
import {
  isQueuedThreadCreationSendable,
  resolveConfirmedThreadOutboxPlan,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  threadOutboxDeliveryHoldsEqual,
  threadOutboxRetryDelayMs,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
  type ThreadSettingsSnapshot,
} from "./thread-outbox-model";
import { environmentThreadShells, threadEnvironment } from "./threads";
import { environmentProjects } from "./projects";
import { environmentPresentations } from "./presentation";
import { environmentShell } from "./shell";
import { environmentServerConfigsAtom } from "./server";
import { useAtomCommand } from "./use-atom-command";
import {
  editingQueuedMessageIdsAtom,
  useThreadOutboxMessages,
  useThreadOutboxShellStatuses,
} from "./use-thread-outbox";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";

export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:dispatching-message-id"),
);

function beginDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, queuedMessageId);
}

function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const current = appAtomRegistry.get(dispatchingQueuedMessageIdAtom);
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, current === queuedMessageId ? null : current);
}

function findThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined {
  return threads.find(
    (candidate) =>
      candidate.environmentId === message.environmentId && candidate.id === message.threadId,
  );
}

function findCreationProject(
  projects: ReadonlyArray<EnvironmentProject>,
  message: QueuedThreadMessage,
): EnvironmentProject | undefined {
  return projects.find(
    (candidate) =>
      candidate.environmentId === message.environmentId &&
      candidate.id === message.creation?.projectId,
  );
}

export function useThreadOutboxDrain(): void {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const editingQueuedMessageIds = useAtomValue(editingQueuedMessageIdsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const shellStatuses = useThreadOutboxShellStatuses();
  const threads = useThreadShells();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<MessageId, number>());
  const retryNotBeforeRef = useRef(new Map<MessageId, number>());
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    ensureThreadOutboxLoaded();
    return () => {
      for (const timer of retryTimersRef.current.values()) {
        clearTimeout(timer);
      }
      retryTimersRef.current.clear();
    };
  }, []);

  const makeDeliveryHelpers = useCallback((queuedMessage: QueuedThreadMessage) => {
    const reportFailure = (
      commandResult: AtomCommandResult<unknown, unknown>,
      stage: ThreadOutboxCommandStage,
    ): "retry" | "hold" | null => {
      if (!AsyncResult.isFailure(commandResult)) {
        return null;
      }
      const action = resolveThreadOutboxFailureAction({
        stage,
        error: Cause.squash(commandResult.cause),
        interrupted: Cause.hasInterruptsOnly(commandResult.cause),
      });
      console.warn("[thread-outbox] queued message delivery failed", {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
        stage,
        cause: commandResult.cause,
        action,
      });
      return action;
    };
    const completeDelivery = async (
      deliveryResult: AtomCommandResult<unknown, unknown>,
    ): Promise<"complete" | "retry" | "held"> => {
      const failureAction = reportFailure(deliveryResult, "start-turn");
      if (failureAction === "retry") {
        return "retry";
      }
      if (failureAction === "hold" && AsyncResult.isFailure(deliveryResult)) {
        const error = Cause.squash(deliveryResult.cause);
        const reason =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "The server rejected this turn before accepting its message. Retry it or resolve the provider binding manually.";
        try {
          await updateThreadOutboxMessage({
            ...queuedMessage,
            deliveryHold: {
              kind: "admission-rejected",
              reason,
              ...(queuedMessage.modelSelection === undefined
                ? {}
                : { queuedInstanceId: queuedMessage.modelSelection.instanceId }),
            },
          });
          return "held";
        } catch (holdError) {
          console.warn("[thread-outbox] failed to persist rejected admission hold", {
            environmentId: queuedMessage.environmentId,
            threadId: queuedMessage.threadId,
            messageId: queuedMessage.messageId,
            error: holdError,
          });
          return "retry";
        }
      }

      try {
        await removeThreadOutboxMessage(queuedMessage);
        return "complete";
      } catch (error) {
        console.warn("[thread-outbox] failed to remove delivered queued message", {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
          error,
        });
        return "retry";
      }
    };
    return { reportFailure, completeDelivery };
  }, []);

  const sendQueuedMessage = useCallback(
    async (
      queuedMessage: QueuedThreadMessage,
      settings: ThreadSettingsSnapshot,
    ): Promise<"complete" | "retry" | "held"> => {
      const { completeDelivery } = makeDeliveryHelpers(queuedMessage);
      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: queuedMessage.commandId,
          threadId: queuedMessage.threadId,
          message: {
            messageId: queuedMessage.messageId,
            role: "user",
            text: queuedMessage.text,
            attachments: toUploadChatImageAttachments(queuedMessage.attachments),
          },
          modelSelection: settings.modelSelection,
          runtimeMode: settings.runtimeMode,
          interactionMode: settings.interactionMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      return completeDelivery(deliveryResult);
    },
    [makeDeliveryHelpers, startTurn],
  );

  const sendQueuedCreation = useCallback(
    async (
      queuedMessage: QueuedThreadMessage,
      creation: QueuedThreadCreation,
      projectCwd: string,
    ) => {
      const modelSelection = queuedMessage.modelSelection;
      if (modelSelection === undefined) {
        return "retry" as const;
      }
      const { completeDelivery } = makeDeliveryHelpers(queuedMessage);
      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input: buildProjectThreadStartTurnInput({
          projectId: creation.projectId,
          projectCwd,
          threadId: queuedMessage.threadId,
          commandId: queuedMessage.commandId,
          messageId: queuedMessage.messageId,
          createdAt: queuedMessage.createdAt,
          text: queuedMessage.text.trim(),
          attachments: queuedMessage.attachments,
          modelSelection,
          runtimeMode: queuedMessage.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: queuedMessage.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceMode: creation.workspaceMode,
          branch: creation.branch,
          worktreePath: creation.worktreePath,
          startFromOrigin: creation.startFromOrigin ?? false,
          worktreeBranchName: buildTemporaryWorktreeBranchName(randomHex),
        }),
      });
      return completeDelivery(deliveryResult);
    },
    [makeDeliveryHelpers, startTurn],
  );

  useEffect(() => {
    if (dispatchingQueuedMessageId !== null) {
      return;
    }

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
      const nextQueuedMessage = queuedMessages[0];
      if (!nextQueuedMessage) {
        continue;
      }
      if (editingQueuedMessageIds[nextQueuedMessage.messageId]) {
        continue;
      }
      if ((retryNotBeforeRef.current.get(nextQueuedMessage.messageId) ?? 0) > Date.now()) {
        continue;
      }

      const thread = findThread(threads, nextQueuedMessage);
      if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
        continue;
      }

      const creation = nextQueuedMessage.creation;
      const environment = connectedEnvironments.find(
        (candidate) => candidate.environmentId === nextQueuedMessage.environmentId,
      );
      const shellStatus = shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty";
      const deliveryAction = resolveThreadOutboxDeliveryAction({
        isCreation: creation !== undefined,
        threadExists: thread !== undefined,
        shellStatus,
        environmentConnected: environment?.connectionState === "connected",
        threadStatus: thread?.session?.status ?? null,
        hasDeliveryHold: nextQueuedMessage.deliveryHold !== undefined,
      });
      if (deliveryAction === "wait") {
        continue;
      }
      // An incomplete pending task (e.g. worktree mode without a branch) stays
      // queued until the user finishes it in the editor.
      if (deliveryAction === "send" && creation !== undefined) {
        if (!isQueuedThreadCreationSendable(nextQueuedMessage)) {
          continue;
        }
      }
      beginDispatchingQueuedMessage(nextQueuedMessage.messageId);
      // Enqueues publish optimistically before their durable write settles.
      // Confirm the write landed (and the message wasn't rolled back) before
      // sending, so a failed write can never chase an already-delivered turn.
      const delivery = confirmThreadOutboxMessageQueued(nextQueuedMessage).then((queued) => {
        if (!queued) {
          // Rolled back by a failed write; nothing to deliver or retry.
          return "complete" as const;
        }
        const latestQueuedMessage = Object.values(
          appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
        )
          .flat()
          .find(
            (candidate) =>
              candidate.environmentId === nextQueuedMessage.environmentId &&
              candidate.messageId === nextQueuedMessage.messageId,
          );
        if (latestQueuedMessage === undefined) return "complete" as const;
        if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[latestQueuedMessage.messageId]) {
          return "complete" as const;
        }

        // Confirmation is an async boundary. Re-read every dispatch authority
        // from live atoms instead of using the optimistic render snapshot that
        // selected this item before its durable write settled.
        const latestThread = findThread(
          appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
          latestQueuedMessage,
        );
        const latestShellStatus = appAtomRegistry.get(
          environmentShell.stateValueAtom(latestQueuedMessage.environmentId),
        ).status;
        const latestEnvironment = appAtomRegistry.get(
          environmentPresentations.presentationAtom(latestQueuedMessage.environmentId),
        );
        const latestEnvironmentConnected = latestEnvironment?.connection.phase === "connected";
        const latestServerConfig = appAtomRegistry
          .get(environmentServerConfigsAtom)
          .get(latestQueuedMessage.environmentId);
        const latestProviders = latestServerConfig?.providers;
        const latestCreation = latestQueuedMessage.creation;
        const latestProject =
          latestCreation === undefined
            ? null
            : findCreationProject(
                appAtomRegistry.get(environmentProjects.projectsAtom),
                latestQueuedMessage,
              );
        const confirmedPlan = resolveConfirmedThreadOutboxPlan({
          message: latestQueuedMessage,
          thread: latestThread,
          shellStatus: latestShellStatus,
          environmentConnected: latestEnvironmentConnected,
          providers: latestProviders,
          project: latestProject,
        });
        const persistHold = (
          hold: NonNullable<QueuedThreadMessage["deliveryHold"]>,
          retargetCreation?: QueuedThreadCreation,
        ) => {
          const alreadyPersisted =
            threadOutboxDeliveryHoldsEqual(latestQueuedMessage.deliveryHold, hold) &&
            (retargetCreation === undefined || latestQueuedMessage.creation === retargetCreation);
          return alreadyPersisted
            ? Promise.resolve("held" as const)
            : updateThreadOutboxMessage({
                ...latestQueuedMessage,
                deliveryHold: hold,
                ...(retargetCreation === undefined ? {} : { creation: retargetCreation }),
              }).then(
                () => "held" as const,
                (error) => {
                  console.warn("[thread-outbox] failed to persist delivery hold", {
                    messageId: latestQueuedMessage.messageId,
                    error,
                  });
                  return "retry" as const;
                },
              );
        };
        if (confirmedPlan.action === "wait") {
          return latestQueuedMessage.deliveryHold === undefined
            ? ("complete" as const)
            : ("held" as const);
        }
        if (confirmedPlan.action === "hold") {
          return persistHold(confirmedPlan.hold, confirmedPlan.creation);
        }
        if (confirmedPlan.action === "remove") {
          return removeThreadOutboxMessage(latestQueuedMessage).then(
            () => "complete" as const,
            (error) => {
              console.warn("[thread-outbox] failed to remove confirmed queued message", {
                messageId: latestQueuedMessage.messageId,
                error,
              });
              return "retry" as const;
            },
          );
        }
        if (confirmedPlan.action === "send-existing") {
          return sendQueuedMessage(latestQueuedMessage, confirmedPlan.settings);
        }
        return sendQueuedCreation(latestQueuedMessage, latestCreation!, confirmedPlan.projectCwd);
      });
      void delivery
        .then((outcome) => {
          if (outcome === "complete" || outcome === "held") {
            retryAttemptRef.current.delete(nextQueuedMessage.messageId);
            retryNotBeforeRef.current.delete(nextQueuedMessage.messageId);
            const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
            if (pendingTimer !== undefined) {
              clearTimeout(pendingTimer);
              retryTimersRef.current.delete(nextQueuedMessage.messageId);
            }
            return;
          }

          const retryAttempt = (retryAttemptRef.current.get(nextQueuedMessage.messageId) ?? 0) + 1;
          retryAttemptRef.current.set(nextQueuedMessage.messageId, retryAttempt);
          const retryDelayMs = threadOutboxRetryDelayMs(retryAttempt);
          retryNotBeforeRef.current.set(nextQueuedMessage.messageId, Date.now() + retryDelayMs);
          const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
          if (pendingTimer !== undefined) {
            clearTimeout(pendingTimer);
          }
          const retryTimer = setTimeout(() => {
            retryTimersRef.current.delete(nextQueuedMessage.messageId);
            setRetryTick((current) => current + 1);
          }, retryDelayMs);
          retryTimersRef.current.set(nextQueuedMessage.messageId, retryTimer);
        })
        .finally(() => {
          finishDispatchingQueuedMessage(nextQueuedMessage.messageId);
        });
      return;
    }
  }, [
    connectedEnvironments,
    dispatchingQueuedMessageId,
    editingQueuedMessageIds,
    queuedMessagesByThreadKey,
    retryTick,
    sendQueuedCreation,
    sendQueuedMessage,
    shellStatuses,
    threads,
  ]);
}
