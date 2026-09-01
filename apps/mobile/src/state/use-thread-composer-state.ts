import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import * as Cause from "effect/Cause";

import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  RuntimeTaskId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  codexFeedbackMessage,
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { deriveLatestContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import {
  deriveLatestSessionCompaction,
  isAcceptedSessionCompactionMutationResult,
  isCurrentSessionCompactionRequest,
  isSessionCompactionInProgress,
  isSessionCompactionSubmissionBlocked,
  sessionCompactionScopeKey,
  supportsSessionCompaction,
  type SessionCompactionControlSnapshot,
} from "@t3tools/client-runtime/state/context-compaction";
import { deriveActiveSessionGoal } from "@t3tools/client-runtime/state/session-goal";
import { deriveLatestSessionAgentDepth } from "@t3tools/client-runtime/state/session-agent-depth";
import {
  deriveLatestSessionInputQueue,
  hasSessionInputQueueModes,
  supportsSessionInputQueueRemove,
  supportsSessionInputQueueSetModes,
} from "@t3tools/client-runtime/state/session-input-queue";
import { deriveCurrentSessionResources } from "@t3tools/client-runtime/state/session-resources";
import {
  canMessageSessionAgent,
  foldSubagentActivities,
  isActiveSubagentStatus,
  isSessionAgentMessageDeliveryUnknown,
  supportsSessionAgentCancel,
  supportsSessionAgentMessage,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerFiles,
  pickComposerMedia,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { prepareTurnAttachments, validateDraftFileAttachments } from "../lib/attachmentUpload";
import { scopedThreadKey } from "../lib/scopedEntities";
import {
  resolveModelSelectionRuntimeMode,
  showModelSelectionInteractionModeToggle,
} from "../lib/modelOptions";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { buildThreadFeed } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import { serverEnvironment } from "../state/server";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  scheduleUnusedComposerAttachmentCleanup,
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
    // Capped: a review comment is new content, not a send-failure restore, so
    // it must not push the draft over the send limit. Overflow is released.
    const rejectedCount = appendComposerDraftAttachments(threadKey, input.attachments);
    if (rejectedCount > 0) {
      setPendingConnectionError(
        `${rejectedCount} comment attachment${rejectedCount === 1 ? " was" : "s were"} not added. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
    }
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
  const { selectedThread: selectedThreadShell, selectedEnvironmentRuntime } = useThreadSelection();
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
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const followUpInputQueue = useAtomCommand(threadEnvironment.followUpInputQueue, {
    reportFailure: false,
  });
  const cancelSessionAgent = useAtomCommand(threadEnvironment.cancelSessionAgent, {
    reportFailure: false,
  });
  const messageSessionAgent = useAtomCommand(threadEnvironment.messageSessionAgent, {
    reportFailure: false,
  });
  const clearSessionInputQueue = useAtomCommand(threadEnvironment.clearSessionInputQueue, {
    reportFailure: false,
  });
  const removeOnlySessionInputQueueItem = useAtomCommand(
    threadEnvironment.removeOnlySessionInputQueueItem,
    { reportFailure: false },
  );
  const setSessionInputQueueMode = useAtomCommand(threadEnvironment.setSessionInputQueueMode, {
    reportFailure: false,
  });
  const getSessionCompaction = useAtomCommand(threadEnvironment.getSessionCompaction, {
    reportFailure: false,
  });
  const compactSession = useAtomCommand(threadEnvironment.compactSession, { reportFailure: false });
  const abortSessionCompaction = useAtomCommand(threadEnvironment.abortSessionCompaction, {
    reportFailure: false,
  });
  const setSessionAutoCompaction = useAtomCommand(threadEnvironment.setSessionAutoCompaction, {
    reportFailure: false,
  });
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
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
  const selectedThreadFeed = useMemo(() => {
    if (!selectedThreadDetail) {
      return [];
    }
    const submissions = selectedThreadKey
      ? (feedbackSubmissionsByThreadKey[selectedThreadKey] ?? [])
      : [];
    return buildThreadFeed(selectedThreadDetail, {
      localMessages: submissions.flatMap((submission) =>
        submission.status === "interrupted"
          ? []
          : [codexFeedbackMessage(submission), codexFeedbackMessage(submission, "assistant")],
      ),
    });
  }, [feedbackSubmissionsByThreadKey, selectedThreadDetail, selectedThreadKey]);
  const selectedThreadAgents = useMemo(() => {
    const status = selectedThreadDetail?.session?.status;
    const sessionLive = status === "starting" || status === "ready" || status === "running";
    return foldSubagentActivities(selectedThreadDetail?.activities ?? [], { sessionLive });
  }, [selectedThreadDetail]);
  const sessionAgentMessageScopeRef = useRef({
    threadKey: selectedThreadKey,
    thread: selectedThreadShell,
    session: selectedThreadDetail?.session ?? null,
    agents: selectedThreadAgents,
    providers: selectedThreadServerConfig?.providers ?? [],
  });
  sessionAgentMessageScopeRef.current = {
    threadKey: selectedThreadKey,
    thread: selectedThreadShell,
    session: selectedThreadDetail?.session ?? null,
    agents: selectedThreadAgents,
    providers: selectedThreadServerConfig?.providers ?? [],
  };

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const selectedThreadResources = useMemo(() => {
    const session = selectedThreadDetail?.session;
    const instanceId = session?.providerInstanceId;
    return selectedThreadDetail && instanceId
      ? deriveCurrentSessionResources(
          selectedThreadDetail.activities,
          instanceId,
          session.startedAt,
        )
      : null;
  }, [selectedThreadDetail]);
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
  const selectedThreadGoal = useMemo(() => {
    const session = selectedThreadDetail?.session;
    const provider = selectedThreadServerConfig?.providers.find(
      (candidate) => candidate.instanceId === session?.providerInstanceId,
    );
    return deriveActiveSessionGoal({
      activities: selectedThreadDetail?.activities ?? [],
      provider,
      providerInstanceId: session?.providerInstanceId,
      runtimeMode: session?.runtimeMode,
      sessionStatus: session?.status,
    });
  }, [selectedThreadDetail, selectedThreadServerConfig]);
  const sessionCompactionScope = useMemo(() => {
    const session = selectedThreadDetail?.session;
    const instanceId = session?.providerInstanceId;
    if (
      !selectedThreadShell ||
      !session ||
      instanceId === undefined ||
      (session.status !== "ready" && session.status !== "running")
    ) {
      return null;
    }
    const provider =
      selectedThreadServerConfig?.providers.find(
        (candidate) => candidate.instanceId === instanceId,
      ) ?? null;
    if (!supportsSessionCompaction(provider)) return null;
    return {
      key: sessionCompactionScopeKey({
        environmentId: selectedThreadShell.environmentId,
        threadId: selectedThreadShell.id,
        providerInstanceId: instanceId,
      }),
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      providerInstanceId: instanceId,
    } as const;
  }, [
    selectedThreadDetail?.session?.providerInstanceId,
    selectedThreadDetail?.session?.status,
    selectedThreadServerConfig,
    selectedThreadShell,
  ]);
  const activitySessionCompaction = useMemo(() => {
    if (!selectedThreadDetail || !sessionCompactionScope) return null;
    return deriveLatestSessionCompaction(
      selectedThreadDetail.activities,
      sessionCompactionScope.providerInstanceId,
    );
  }, [selectedThreadDetail, sessionCompactionScope]);
  const [authoritativeSessionCompaction, setAuthoritativeSessionCompaction] = useState<{
    readonly scopeKey: string;
    readonly snapshot: SessionCompactionControlSnapshot;
  } | null>(null);
  const [sessionCompactionMutation, setSessionCompactionMutation] = useState<{
    readonly scopeKey: string;
    readonly id: number;
    readonly action: "compact" | "abort" | "auto-enable" | "auto-disable";
  } | null>(null);
  const sessionCompactionScopeRef = useRef(sessionCompactionScope);
  sessionCompactionScopeRef.current = sessionCompactionScope;
  const sessionCompactionMutationRef = useRef(sessionCompactionMutation);
  sessionCompactionMutationRef.current = sessionCompactionMutation;
  const sessionCompactionRequestIdRef = useRef(0);
  const activitySupersededCompactionMutationsRef = useRef<Set<number>>(new Set());
  const lastCompactionActivityRef = useRef<{ scopeKey: string; updatedAt: string } | null>(null);
  const selectedThreadCompaction = isSessionCompactionInProgress(activitySessionCompaction)
    ? activitySessionCompaction
    : sessionCompactionScope &&
        authoritativeSessionCompaction?.scopeKey === sessionCompactionScope.key
      ? authoritativeSessionCompaction.snapshot
      : activitySessionCompaction;
  const sessionCompactionPendingAction = sessionCompactionMutation
    ? sessionCompactionMutation.action
    : null;
  const sessionCompactionPendingScopeKey = sessionCompactionMutation
    ? sessionCompactionMutation.scopeKey
    : null;
  const sessionCompactionBlocksSubmission = isSessionCompactionSubmissionBlocked({
    hasActiveScope: sessionCompactionScope !== null,
    current: selectedThreadCompaction,
    activity: activitySessionCompaction,
    compactPending:
      sessionCompactionPendingAction === "compact" &&
      sessionCompactionPendingScopeKey === (sessionCompactionScope?.key ?? null),
  });

  useEffect(() => {
    const scope = sessionCompactionScope;
    const requestId = ++sessionCompactionRequestIdRef.current;
    sessionCompactionMutationRef.current = null;
    activitySupersededCompactionMutationsRef.current.clear();
    setSessionCompactionMutation(null);
    if (!scope) {
      setAuthoritativeSessionCompaction(null);
      return;
    }
    if (activitySessionCompaction) {
      lastCompactionActivityRef.current = {
        scopeKey: scope.key,
        updatedAt: activitySessionCompaction.updatedAt,
      };
      setAuthoritativeSessionCompaction({
        scopeKey: scope.key,
        snapshot: activitySessionCompaction,
      });
    } else {
      lastCompactionActivityRef.current = null;
      setAuthoritativeSessionCompaction(null);
    }
    if (activitySessionCompaction?.available === false) return;
    void getSessionCompaction({
      environmentId: scope.environmentId,
      input: { threadId: scope.threadId },
    }).then((result) => {
      if (
        result._tag === "Success" &&
        isCurrentSessionCompactionRequest(
          sessionCompactionScopeRef.current?.key,
          sessionCompactionRequestIdRef.current,
          { scopeKey: scope.key, id: requestId },
        )
      ) {
        setAuthoritativeSessionCompaction({
          scopeKey: scope.key,
          snapshot: { ...result.value, updatedAt: new Date().toISOString() },
        });
      }
    });
  }, [getSessionCompaction, sessionCompactionScope?.key]);

  useEffect(() => {
    const scope = sessionCompactionScope;
    const snapshot = activitySessionCompaction;
    if (!scope || !snapshot) return;
    const last = lastCompactionActivityRef.current;
    if (last?.scopeKey === scope.key && last.updatedAt === snapshot.updatedAt) return;
    lastCompactionActivityRef.current = { scopeKey: scope.key, updatedAt: snapshot.updatedAt };
    sessionCompactionRequestIdRef.current += 1;
    const supersededMutation = sessionCompactionMutationRef.current;
    if (supersededMutation?.scopeKey === scope.key) {
      activitySupersededCompactionMutationsRef.current.add(supersededMutation.id);
    }
    sessionCompactionMutationRef.current = null;
    setSessionCompactionMutation(null);
    setAuthoritativeSessionCompaction({ scopeKey: scope.key, snapshot });
  }, [activitySessionCompaction, sessionCompactionScope]);

  const runSessionCompactionMutation = useCallback(
    async (action: "compact" | "abort" | "auto-enable" | "auto-disable"): Promise<boolean> => {
      const scope = sessionCompactionScopeRef.current;
      if (!scope || sessionCompactionMutationRef.current?.scopeKey === scope.key) return false;
      const id = ++sessionCompactionRequestIdRef.current;
      const mutation = { scopeKey: scope.key, id, action } as const;
      sessionCompactionMutationRef.current = mutation;
      setSessionCompactionMutation(mutation);
      const command =
        action === "compact"
          ? compactSession({
              environmentId: scope.environmentId,
              input: { threadId: scope.threadId },
            })
          : action === "abort"
            ? abortSessionCompaction({
                environmentId: scope.environmentId,
                input: { threadId: scope.threadId },
              })
            : setSessionAutoCompaction({
                environmentId: scope.environmentId,
                input: { threadId: scope.threadId, enabled: action === "auto-enable" },
              });
      const result = await command;
      if (
        !isCurrentSessionCompactionRequest(
          sessionCompactionScopeRef.current?.key,
          sessionCompactionRequestIdRef.current,
          mutation,
        )
      ) {
        const supersededByActivity = activitySupersededCompactionMutationsRef.current.delete(id);
        if (
          result._tag === "Failure" &&
          supersededByActivity &&
          sessionCompactionScopeRef.current?.key === mutation.scopeKey &&
          !isAtomCommandInterrupted(result)
        ) {
          setPendingConnectionError("Failed to update context compaction.");
        }
        return isAcceptedSessionCompactionMutationResult({
          succeeded: result._tag === "Success",
          isCurrent: false,
          supersededByActivity,
        });
      }
      activitySupersededCompactionMutationsRef.current.delete(id);
      sessionCompactionMutationRef.current = null;
      setSessionCompactionMutation((current) => (current?.id === id ? null : current));
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setPendingConnectionError("Failed to update context compaction.");
        }
        return false;
      }
      setAuthoritativeSessionCompaction({
        scopeKey: scope.key,
        snapshot: { ...result.value, updatedAt: new Date().toISOString() },
      });
      return true;
    },
    [abortSessionCompaction, compactSession, setSessionAutoCompaction],
  );
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
    if (!selectedThreadShell || sessionCompactionBlocksSubmission) {
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
    // A send-failure restore appends with allowOverflow so it never drops the
    // user's files, which can leave the draft over the cap. Sending it anyway
    // would enqueue a message that outbox recovery rejects forever, so block
    // here until the user removes attachments.
    if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      Alert.alert(
        "Too many attachments",
        `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
      );
      return null;
    }

    const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
      (entry) => entry.instanceId === thread.modelSelection.instanceId,
    );
    const feedbackCommand =
      attachments.length === 0 &&
      (provider?.driver === "codex" || thread.session?.providerName === "codex")
        ? parseCodexFeedbackCommand(text)
        : null;
    if (feedbackCommand) {
      if (thread.session === null) {
        Alert.alert("Start a Codex thread first", "Send a message before you submit feedback.");
        return null;
      }
      const metadata = makeQueuedMessageMetadata();
      const result = await submitCodexFeedback({
        submission: {
          id: MessageId.make(metadata.messageId),
          command: text,
          createdAt: metadata.createdAt,
        },
        clearDraft: () => clearComposerDraftContent(threadKey),
        onUpdate: (submission) => {
          setFeedbackSubmissionsByThreadKey((current) => {
            const existing = current[threadKey] ?? [];
            const found = existing.some((entry) => entry.id === submission.id);
            return {
              ...current,
              [threadKey]: found
                ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                : [...existing, submission],
            };
          });
        },
        upload: () =>
          uploadThreadFeedback({
            environmentId: selectedThreadShell.environmentId,
            input: {
              threadId: selectedThreadShell.id,
              ...feedbackCommand,
            },
          }),
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return null;
        }
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not send feedback to OpenAI",
          error instanceof Error ? error.message : "An error occurred.",
        );
        return null;
      }
      const feedbackId = result.value.feedbackId;
      Alert.alert("Feedback sent to OpenAI", `Thread ID: ${feedbackId}`, [
        { text: "OK", style: "cancel" },
        {
          text: "Copy ID",
          onPress: () => copyTextWithHaptic(feedbackId, { target: "Codex feedback thread ID" }),
        },
      ]);
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
    clearComposerDraftContent(threadKey, { deferAttachmentCleanup: true });
    enqueuePromise.then(
      () => {
        // The queued message owns the files now; the sweep sees that and
        // spares them. Deferred to here so a failed write cannot roll the
        // message out of the queue mid-sweep and lose the bytes.
        scheduleUnusedComposerAttachmentCleanup(attachments);
      },
      (error: unknown) => {
        // Restore text via merge (idempotent) but attachments via the uncapped
        // append: the merge path slots existing attachments first and truncates
        // at the send limit, which would silently drop this message's images if
        // the user attached new ones while the write was in flight.
        void mergeComposerDraftContent(threadKey, { text, attachments: [] });
        appendComposerDraftAttachments(threadKey, attachments, { allowOverflow: true });
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to save the queued message.",
        );
      },
    );
    return messageId;
  }, [
    selectedEnvironmentRuntime?.serverConfig?.providers,
    selectedThreadDetail,
    sessionCompactionBlocksSubmission,
    selectedThreadServerConfig,
    selectedThreadShell,
    uploadThreadFeedback,
  ]);

  const onQueueFollowUp = useCallback(async () => {
    if (
      !selectedThreadShell ||
      sessionCompactionBlocksSubmission ||
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

    if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      Alert.alert(
        "Too many attachments",
        `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
      );
      return null;
    }
    const attachmentError = validateDraftFileAttachments({
      attachments,
      serverConfig: appAtomRegistry.get(
        serverEnvironment.configValueAtom(selectedThreadShell.environmentId),
      ),
    });
    if (attachmentError !== null) {
      setPendingConnectionError(attachmentError);
      return null;
    }

    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    // The follow-up command takes the same attachment union as thread.turn.start
    // and the server normalizer branches on `"dataUrl" in attachment` for both,
    // so files belong here exactly as they do on a normal send. Upload them
    // first; sending the draft form would queue broken references.
    let prepared: Awaited<ReturnType<typeof prepareTurnAttachments>>;
    try {
      prepared = await prepareTurnAttachments({
        environmentId: selectedThreadShell.environmentId,
        attachments,
        persistUploadedReferences: async (draftAttachments) => {
          await mergeComposerDraftContent(threadKey, { text, attachments: draftAttachments });
          return "persisted";
        },
      });
    } catch (error) {
      setPendingConnectionError(
        error instanceof Error ? error.message : "An attachment could not upload.",
      );
      return null;
    }
    if (prepared.status !== "ready") {
      setPendingConnectionError("The attachments are no longer available.");
      return null;
    }

    // Defer cleanup: the sweep would otherwise delete the local bytes while the
    // queue call is still in flight, leaving a failure restore pointing at
    // files that no longer exist.
    clearComposerDraftContent(threadKey, { deferAttachmentCleanup: true });
    const result = await followUpInputQueue({
      environmentId: selectedThreadShell.environmentId,
      input: {
        commandId: CommandId.make(metadata.commandId),
        threadId: selectedThreadShell.id,
        message: {
          messageId,
          role: "user",
          text,
          attachments: prepared.attachments,
        },
        createdAt: metadata.createdAt,
      },
    });
    if (result._tag === "Failure") {
      prepared.releaseUploads();
      await mergeComposerDraftContent(threadKey, { text, attachments: [] });
      // Uncapped append, matching onSendMessage: the capped merge path would
      // silently drop this message's files if the user attached more while the
      // call was in flight.
      appendComposerDraftAttachments(threadKey, attachments, { allowOverflow: true });
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to queue the follow-up.",
        );
      }
      return null;
    }
    // Queued successfully, so the message owns the bytes now.
    scheduleUnusedComposerAttachmentCleanup(attachments);
    return messageId;
  }, [
    followUpInputQueue,
    selectedThreadDetail?.session?.activeTurnId,
    selectedThreadDetail?.session?.status,
    selectedThreadShell,
    sessionCompactionBlocksSubmission,
  ]);

  const onMessageSessionAgent = useCallback(
    async (
      agentId: string,
      rawMessage: string,
    ): Promise<"delivered" | "queued" | "delivery-unknown" | null> => {
      const scope = sessionAgentMessageScopeRef.current;
      const provider =
        scope.session?.providerInstanceId === undefined
          ? null
          : (scope.providers.find(
              (candidate) => candidate.instanceId === scope.session?.providerInstanceId,
            ) ?? null);
      const agent = scope.agents.find((candidate) => candidate.id === agentId);
      const message = rawMessage.trim();
      if (
        scope.threadKey === null ||
        scope.thread === null ||
        (scope.session?.status !== "ready" && scope.session?.status !== "running") ||
        scope.session.runtimeMode !== "full-access" ||
        !supportsSessionAgentMessage(provider) ||
        agent === undefined ||
        !canMessageSessionAgent(provider, agent) ||
        message.length === 0
      ) {
        return null;
      }
      const expectedScopeKey = JSON.stringify([
        scope.threadKey,
        scope.session.providerInstanceId,
        scope.session.runtimeMode,
      ]);
      const result = await messageSessionAgent({
        environmentId: scope.thread.environmentId,
        input: {
          threadId: scope.thread.id,
          agentId: RuntimeTaskId.make(agentId),
          message,
        },
      });
      const latest = sessionAgentMessageScopeRef.current;
      if (
        JSON.stringify([
          latest.threadKey,
          latest.session?.providerInstanceId,
          latest.session?.runtimeMode,
        ]) !== expectedScopeKey
      ) {
        return null;
      }
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return null;
        const error = squashAtomCommandFailure(result);
        return isSessionAgentMessageDeliveryUnknown(error) ? "delivery-unknown" : null;
      }
      return result.value.disposition;
    },
    [messageSessionAgent],
  );

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

  const onRemoveOnlySessionInputQueueItem = useCallback(
    async (queue: "steering" | "follow-up") => {
      const session = selectedThreadDetail?.session;
      const provider =
        session?.providerInstanceId === undefined
          ? null
          : (selectedThreadServerConfig?.providers.find(
              (candidate) => candidate.instanceId === session.providerInstanceId,
            ) ?? null);
      const count =
        queue === "steering"
          ? (selectedThreadInputQueue?.steeringCount ?? 0)
          : (selectedThreadInputQueue?.followUpCount ?? 0);
      if (
        !selectedThreadShell ||
        session?.status !== "running" ||
        session.activeTurnId == null ||
        count !== 1 ||
        !supportsSessionInputQueueRemove(provider)
      ) {
        return false;
      }
      const result = await removeOnlySessionInputQueueItem({
        environmentId: selectedThreadShell.environmentId,
        input: { threadId: selectedThreadShell.id, queue },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setPendingConnectionError("Failed to remove the pending session input.");
        }
        return false;
      }
      return true;
    },
    [
      removeOnlySessionInputQueueItem,
      selectedThreadDetail?.session,
      selectedThreadInputQueue?.followUpCount,
      selectedThreadInputQueue?.steeringCount,
      selectedThreadServerConfig?.providers,
      selectedThreadShell,
    ],
  );

  const onSetSessionInputQueueMode = useCallback(
    async (queue: "steering" | "follow-up", mode: "all-at-once" | "one-at-a-time") => {
      const session = selectedThreadDetail?.session;
      const provider =
        session?.providerInstanceId === undefined
          ? null
          : (selectedThreadServerConfig?.providers.find(
              (candidate) => candidate.instanceId === session.providerInstanceId,
            ) ?? null);
      if (
        !selectedThreadShell ||
        (session?.status !== "ready" && session?.status !== "running") ||
        !supportsSessionInputQueueSetModes(provider) ||
        !hasSessionInputQueueModes(selectedThreadInputQueue)
      ) {
        return false;
      }
      const currentMode =
        queue === "steering"
          ? selectedThreadInputQueue.steeringMode
          : selectedThreadInputQueue.followUpMode;
      if (currentMode === mode) return true;
      const result = await setSessionInputQueueMode({
        environmentId: selectedThreadShell.environmentId,
        input: { threadId: selectedThreadShell.id, queue, mode },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setPendingConnectionError("Failed to update session input delivery.");
        }
        return false;
      }
      return true;
    },
    [
      selectedThreadDetail?.session,
      selectedThreadInputQueue,
      selectedThreadServerConfig?.providers,
      selectedThreadShell,
      setSessionInputQueueMode,
    ],
  );

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

  const onPickDraftMedia = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
    const result = await pickComposerMedia({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
      maxVideoBytes:
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.attachments);
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Alert.alert("Could not attach photo or video", problems.join("\n\n"));
    }
  }, [composerDrafts, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPickDraftFiles = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }
    const maxBytes =
      selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.fileAttachments
        ?.maxUploadBytes;
    if (maxBytes === undefined) {
      Alert.alert("Could not attach file", "This server does not support file attachments.");
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    // pickComposerFiles clamps the advertised limit to the contract maximum.
    const result = await pickComposerFiles({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
      maxBytes,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.files);
    // The picker error and the live-cap rejection can both happen in one
    // pick; report both in a single alert.
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Alert.alert("Could not attach file", problems.join("\n\n"));
    }
  }, [composerDrafts, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    const rejectedPasteCount = appendComposerDraftAttachments(threadKey, result.images);
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    } else if (rejectedPasteCount > 0) {
      setPendingConnectionError(
        `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
      );
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
    selectedThreadGoal,
    selectedThreadCompaction,
    sessionCompactionScopeKey: sessionCompactionScope?.key ?? null,
    sessionCompactionPendingAction:
      sessionCompactionScope && sessionCompactionPendingScopeKey === sessionCompactionScope.key
        ? sessionCompactionPendingAction
        : null,
    selectedThreadQueueCount,
    activeWorkStartedAt,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    onChangeDraftMessage,
    onPickDraftMedia,
    onPickDraftFiles,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onQueueFollowUp,
    onClearSessionInputQueue,
    onRemoveOnlySessionInputQueueItem,
    onSetSessionInputQueueMode,
    onRunSessionCompactionAction: runSessionCompactionMutation,
    onCancelSessionAgent,
    onMessageSessionAgent,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
