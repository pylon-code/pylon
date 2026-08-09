import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo } from "react";

import {
  CommandId,
  MessageId,
  RuntimeTaskId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { deriveLatestContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { deriveLatestSessionAgentDepth } from "@t3tools/client-runtime/state/session-agent-depth";
import { deriveLatestSessionInputQueue } from "@t3tools/client-runtime/state/session-input-queue";
import { deriveLatestSessionResources } from "@t3tools/client-runtime/state/session-resources";
import {
  foldSubagentActivities,
  isActiveSubagentStatus,
  supportsSessionAgentCancel,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  toUploadChatImageAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import {
  resolveModelSelectionRuntimeMode,
  showModelSelectionInteractionModeToggle,
} from "../lib/modelOptions";
import { buildThreadFeed } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { useEnvironmentServerConfig } from "../state/entities";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import { enqueueThreadOutboxMessage } from "./thread-outbox";
import { useThreadOutboxMessages } from "./use-thread-outbox";
import { useAtomCommand } from "./use-atom-command";
import { threadEnvironment } from "./threads";

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? "";
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`);
  if (input.attachments && input.attachments.length > 0) {
    appendComposerDraftAttachments(threadKey, input.attachments);
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

export function useThreadComposerState() {
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const selectedThreadContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(selectedThreadDetail?.activities ?? []),
    [selectedThreadDetail?.activities],
  );
  const selectedThreadServerConfig = useEnvironmentServerConfig(
    selectedThreadShell?.environmentId ?? null,
  );
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const followUpInputQueue = useAtomCommand(threadEnvironment.followUpInputQueue, {
    reportFailure: false,
  });
  const cancelSessionAgent = useAtomCommand(threadEnvironment.cancelSessionAgent, {
    reportFailure: false,
  });
  const clearSessionInputQueue = useAtomCommand(threadEnvironment.clearSessionInputQueue, {
    reportFailure: false,
  });

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const selectedThreadFeed = useMemo(
    () => (selectedThreadDetail ? buildThreadFeed(selectedThreadDetail) : []),
    [selectedThreadDetail],
  );
  const selectedThreadAgents = useMemo(() => {
    const status = selectedThreadDetail?.session?.status;
    const sessionLive = status === "starting" || status === "ready" || status === "running";
    return foldSubagentActivities(selectedThreadDetail?.activities ?? [], { sessionLive });
  }, [selectedThreadDetail]);

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const selectedThreadResources = useMemo(
    () =>
      selectedThreadDetail && modelSelection
        ? deriveLatestSessionResources(selectedThreadDetail.activities, modelSelection.instanceId)
        : null,
    [modelSelection, selectedThreadDetail],
  );
  const selectedThreadAgentDepth = useMemo(() => {
    const instanceId = selectedThreadDetail?.session?.providerInstanceId;
    return selectedThreadDetail && instanceId
      ? deriveLatestSessionAgentDepth(selectedThreadDetail.activities, instanceId)
      : null;
  }, [selectedThreadDetail]);
  const selectedThreadInputQueue = useMemo(() => {
    const instanceId = selectedThreadDetail?.session?.providerInstanceId;
    return selectedThreadDetail && instanceId
      ? deriveLatestSessionInputQueue(selectedThreadDetail.activities, instanceId)
      : null;
  }, [selectedThreadDetail]);
  const selectedRuntimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const runtimeMode = selectedRuntimeMode
    ? resolveModelSelectionRuntimeMode(
        selectedThreadServerConfig,
        modelSelection,
        selectedRuntimeMode,
      )
    : null;
  const selectedInteractionMode =
    selectedDraft?.interactionMode ?? selectedThread?.interactionMode ?? null;
  const interactionMode = showModelSelectionInteractionModeToggle(
    selectedThreadServerConfig,
    modelSelection,
  )
    ? selectedInteractionMode
    : "default";

  const selectedThreadSessionActivity = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThreadDetail, selectedThreadShell]);

  const activeWorkStartedAt = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      null,
    );
  }, [selectedThreadDetail, selectedThreadSessionActivity, selectedThreadShell]);

  const activeThreadBusy =
    !!selectedThread &&
    (selectedThread.session?.status === "running" || selectedThread.session?.status === "starting");

  const onSendMessage = useCallback(async () => {
    if (!selectedThreadShell) {
      return null;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    const thread = selectedThreadDetail ?? selectedThreadShell;
    const text = draft.text.trim();
    const attachments = draft.attachments;
    if (text.length === 0 && attachments.length === 0) {
      return null;
    }

    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    const modelSelection = draft.modelSelection ?? thread.modelSelection;
    const runtimeMode = resolveModelSelectionRuntimeMode(
      selectedThreadServerConfig,
      modelSelection,
      draft.runtimeMode ?? thread.runtimeMode,
    );
    const interactionMode = showModelSelectionInteractionModeToggle(
      selectedThreadServerConfig,
      modelSelection,
    )
      ? (draft.interactionMode ?? thread.interactionMode)
      : "default";
    // Enqueue publishes the queued atom synchronously (the durable write
    // happens behind it), so clearing the draft here gives send feedback on
    // the tap frame instead of after file I/O. If the write fails the message
    // is rolled out of the queue and the content is merged back into the
    // draft, preserving anything typed since.
    const enqueuePromise = enqueueThreadOutboxMessage({
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      messageId,
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments,
      modelSelection,
      runtimeMode,
      interactionMode,
      createdAt: metadata.createdAt,
    });
    clearComposerDraftContent(threadKey);
    enqueuePromise.catch((error: unknown) => {
      // Restore text via merge (idempotent) but attachments via the uncapped
      // append: the merge path slots existing attachments first and truncates
      // at the send limit, which would silently drop this message's images if
      // the user attached new ones while the write was in flight.
      void mergeComposerDraftContent(threadKey, { text, attachments: [] });
      appendComposerDraftAttachments(threadKey, attachments);
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to save the queued message.",
      );
    });
    return messageId;
  }, [selectedThreadDetail, selectedThreadServerConfig, selectedThreadShell]);

  const onQueueFollowUp = useCallback(async () => {
    if (
      !selectedThreadShell ||
      selectedThreadDetail?.session?.status !== "running" ||
      selectedThreadDetail.session.activeTurnId == null
    ) {
      return null;
    }
    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    const text = draft.text.trim();
    const attachments = draft.attachments;
    if (text.length === 0 && attachments.length === 0) return null;

    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    clearComposerDraftContent(threadKey);
    const result = await followUpInputQueue({
      environmentId: selectedThreadShell.environmentId,
      input: {
        commandId: CommandId.make(metadata.commandId),
        threadId: selectedThreadShell.id,
        message: {
          messageId,
          role: "user",
          text,
          attachments: toUploadChatImageAttachments(attachments),
        },
        createdAt: metadata.createdAt,
      },
    });
    if (result._tag === "Failure") {
      await mergeComposerDraftContent(threadKey, { text, attachments: [] });
      appendComposerDraftAttachments(threadKey, attachments);
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to queue the follow-up.",
        );
      }
      return null;
    }
    return messageId;
  }, [
    followUpInputQueue,
    selectedThreadDetail?.session?.activeTurnId,
    selectedThreadDetail?.session?.status,
    selectedThreadShell,
  ]);

  const onCancelSessionAgent = useCallback(
    async (agentId: string) => {
      const session = selectedThreadDetail?.session;
      const provider =
        session?.providerInstanceId === undefined
          ? null
          : (selectedThreadServerConfig?.providers.find(
              (candidate) => candidate.instanceId === session.providerInstanceId,
            ) ?? null);
      const agent = selectedThreadAgents.find((candidate) => candidate.id === agentId);
      if (
        !selectedThreadShell ||
        session?.runtimeMode !== "full-access" ||
        (session.status !== "ready" && session.status !== "running") ||
        !supportsSessionAgentCancel(provider) ||
        agent === undefined ||
        !isActiveSubagentStatus(agent.status)
      ) {
        return false;
      }
      const result = await cancelSessionAgent({
        environmentId: selectedThreadShell.environmentId,
        input: { threadId: selectedThreadShell.id, agentId: RuntimeTaskId.make(agentId) },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setPendingConnectionError("Failed to stop the active agent.");
        }
        return false;
      }
      return true;
    },
    [
      cancelSessionAgent,
      selectedThreadAgents,
      selectedThreadDetail?.session,
      selectedThreadServerConfig?.providers,
      selectedThreadShell,
    ],
  );

  const onClearSessionInputQueue = useCallback(async () => {
    if (
      !selectedThreadShell ||
      selectedThreadDetail?.session?.status !== "running" ||
      selectedThreadDetail.session.activeTurnId == null
    ) {
      return false;
    }
    const result = await clearSessionInputQueue({
      environmentId: selectedThreadShell.environmentId,
      input: { threadId: selectedThreadShell.id },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setPendingConnectionError("Failed to clear pending session inputs.");
      }
      return false;
    }
    return true;
  }, [
    clearSessionInputQueue,
    selectedThreadDetail?.session?.activeTurnId,
    selectedThreadDetail?.session?.status,
    selectedThreadShell,
  ]);

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pickComposerImages({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      if (!selectedThreadKey) {
        return;
      }
      const thread = selectedThreadDetail ?? selectedThreadShell;
      const currentRuntimeMode = selectedDraft?.runtimeMode ?? thread?.runtimeMode;
      const currentInteractionMode = selectedDraft?.interactionMode ?? thread?.interactionMode;
      updateComposerDraftSettings(selectedThreadKey, {
        modelSelection: value,
        ...(currentRuntimeMode
          ? {
              runtimeMode: resolveModelSelectionRuntimeMode(
                selectedThreadServerConfig,
                value,
                currentRuntimeMode,
              ),
            }
          : {}),
        ...(!showModelSelectionInteractionModeToggle(selectedThreadServerConfig, value)
          ? { interactionMode: "default" as const }
          : currentInteractionMode
            ? { interactionMode: currentInteractionMode }
            : {}),
      });
    },
    [
      selectedDraft?.interactionMode,
      selectedDraft?.runtimeMode,
      selectedThreadDetail,
      selectedThreadKey,
      selectedThreadServerConfig,
      selectedThreadShell,
    ],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { interactionMode: value });
    },
    [selectedThreadKey],
  );

  return {
    selectedThreadFeed,
    selectedThreadAgents,
    selectedThreadContextWindow,
    selectedThreadResources,
    selectedThreadAgentDepth,
    selectedThreadInputQueue,
    selectedThreadQueueCount,
    activeWorkStartedAt,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    onChangeDraftMessage,
    onPickDraftImages,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onQueueFollowUp,
    onClearSessionInputQueue,
    onCancelSessionAgent,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
