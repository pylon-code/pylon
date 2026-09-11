import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { useServerConfigs } from "./entities";
import { Alert } from "react-native";
import {
  questionAttachmentDraftKey,
  questionAttachmentDraftPrefix,
  questionAttachmentPreparationAtom,
} from "./question-attachments";
import { composerDraftsAtom, clearComposerDraft } from "./use-composer-drafts";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
  composerAttachmentUploadsAtom,
} from "./composer-attachment-uploads";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type UserInputQuestion,
  type SessionInteractionRequestId,
  type SessionInteractionResponse,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { threadEnvironment } from "../state/threads";
import { scopedRequestKey } from "../lib/scopedEntities";
import {
  buildPendingUserInputAnswers,
  sortThreadActivities,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../lib/threadActivity";
import {
  acquireInteractionSubmissionLock,
  beginInteractionSubmission,
  interactionCommandAccepted,
  interactionCommandFailed,
  interactionSubmissionMatchesActive,
  reconcileInteractionSubmission,
  releaseInteractionSubmissionLock,
  type InteractionSubmissionState,
} from "../lib/interactionSubmission";
import {
  buildSessionInteractionCommandInput,
  compactSessionPresentationText,
  foldSessionInteractionActivities,
} from "../lib/sessionInteractions";
import { appAtomRegistry } from "./atom-registry";
import { useSelectedThreadDetailState } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { useAtomCommand } from "./use-atom-command";

const userInputDraftsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:user-input-drafts"));

function setUserInputDraftOption(
  requestKey: string,
  question: UserInputQuestion,
  value: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: togglePendingUserInputOptionSelection(
        question,
        current[requestKey]?.[question.id],
        value,
      ),
    },
  });
}

function setUserInputDraftCustomAnswer(
  requestKey: string,
  question: UserInputQuestion,
  customAnswer: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: setPendingUserInputCustomAnswer(
        question,
        current[requestKey]?.[question.id],
        customAnswer,
      ),
    },
  });
}

function interactionResponseError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? compactSessionPresentationText(error.message)
    : "The response could not be sent. Try again.";
}

export function useSelectedThreadRequests() {
  const respondToApproval = useAtomCommand(
    threadEnvironment.respondToApproval,
    "thread approval response",
  );
  const respondToUserInput = useAtomCommand(
    threadEnvironment.respondToUserInput,
    "thread user input response",
  );
  const respondToInteraction = useAtomCommand(threadEnvironment.respondToInteraction, {
    label: "thread interaction response",
    reportFailure: false,
  });
  const dismissUserInput = useAtomCommand(
    threadEnvironment.dismissUserInput,
    "thread user input dismissal",
  );
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThreadState = useSelectedThreadDetailState();
  const selectedThread = Option.getOrNull(selectedThreadState.data);
  const selectedThreadLive = selectedThreadState.status === "live";
  const userInputDraftsByRequestKey = useAtomValue(userInputDraftsByRequestKeyAtom);
  const [respondingApprovalId, setRespondingApprovalId] = useState<ApprovalRequestId | null>(null);
  const userInputResponsesInFlight = useRef(new Set<string>());
  const [respondingUserInputId, setRespondingUserInputId] = useState<ApprovalRequestId | null>(
    null,
  );
  const [interactionSubmission, setInteractionSubmission] =
    useState<InteractionSubmissionState | null>(null);
  const interactionSubmissionLockRef = useRef<SessionInteractionRequestId | null>(null);
  const interactionSubmissionAttemptRef = useRef(0);

  // Prime interactions retain their own ordered lifecycle reducer.
  const sortedActivities = useMemo(
    () => (selectedThread ? sortThreadActivities(selectedThread.activities) : []),
    [selectedThread],
  );
  const sessionInteractionState = useMemo(
    () =>
      foldSessionInteractionActivities(sortedActivities, {
        terminalSession: selectedThreadShell?.session?.status === "stopped",
      }),
    [selectedThreadShell?.session?.status, sortedActivities],
  );
  const activePendingInteraction = sessionInteractionState.pending[0] ?? null;
  const activeInteractionFailure =
    sessionInteractionState.failures.find(
      (failure) => failure.requestId === activePendingInteraction?.requestId,
    ) ?? null;
  const { approvals: activePendingApprovals, userInputs: activePendingUserInputs } = useMemo(
    () => derivePendingRequests(selectedThread?.activities ?? []),
    [selectedThread?.activities],
  );
  const activePendingApproval = activePendingApprovals[0] ?? null;
  const activePendingUserInput = activePendingUserInputs[0] ?? null;
  const questionServerConfigs = useServerConfigs();
  const attachmentDrafts = useAtomValue(composerDraftsAtom);
  const preparationCounts = useAtomValue(questionAttachmentPreparationAtom);
  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  useEffect(() => {
    // A cached snapshot can predate the question, so only live data may discard its drafts.
    if (!selectedThreadLive || !selectedThreadShell || !selectedThread) return;
    const prefix = questionAttachmentDraftPrefix(
      selectedThreadShell.environmentId,
      selectedThreadShell.id,
    );
    const retained = new Set(
      activePendingUserInputs.flatMap((request) =>
        request.questions.map((question) =>
          questionAttachmentDraftKey(
            selectedThreadShell.environmentId,
            selectedThreadShell.id,
            request.requestId,
            question.id,
          ),
        ),
      ),
    );
    const counts = { ...appAtomRegistry.get(questionAttachmentPreparationAtom) };
    let changed = false;
    for (const key of new Set([...Object.keys(attachmentDrafts), ...Object.keys(counts)])) {
      if (!key.startsWith(prefix) || retained.has(key)) continue;
      if (attachmentDrafts[key]) clearComposerDraft(key);
      if (key in counts) {
        delete counts[key];
        changed = true;
      }
    }
    if (changed) appAtomRegistry.set(questionAttachmentPreparationAtom, counts);
  }, [
    activePendingUserInputs,
    attachmentDrafts,
    selectedThread,
    selectedThreadLive,
    selectedThreadShell,
  ]);
  const activePendingUserInputDrafts =
    activePendingUserInput && selectedThreadShell
      ? Object.fromEntries(
          activePendingUserInput.questions.map((question) => {
            const key = questionAttachmentDraftKey(
              selectedThreadShell.environmentId,
              selectedThreadShell.id,
              activePendingUserInput.requestId,
              question.id,
            );
            const attachments = attachmentDrafts[key]?.attachments ?? [];
            const uploadInput = {
              environmentId: selectedThreadShell.environmentId,
              attachments,
              serverConfig: questionServerConfigs.get(selectedThreadShell.environmentId) ?? null,
              states: uploadStates,
            };
            return [
              question.id,
              {
                ...userInputDraftsByRequestKey[
                  scopedRequestKey(
                    selectedThreadShell.environmentId,
                    activePendingUserInput.requestId,
                  )
                ]?.[question.id],
                attachmentCount: attachments.length,
                attachmentsBlocked:
                  (attachments.length > 0 &&
                    uploadInput.serverConfig?.environment.capabilities.questionAttachments !==
                      true) ||
                  (preparationCounts[key] ?? 0) > 0 ||
                  composerAttachmentsStillUploading(uploadInput) ||
                  composerAttachmentUploadBlockReason({
                    ...uploadInput,
                    connected: true,
                  }) !== null,
              },
            ];
          }),
        )
      : {};
  const activePendingUserInputAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingUserInputDrafts)
    : null;

  const onSelectUserInputOption = useCallback(
    (requestId: ApprovalRequestId, question: UserInputQuestion, value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftOption(requestKey, question, value);
    },
    [selectedThreadShell],
  );

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: ApprovalRequestId, questionId: string, customAnswer: string) => {
      const question = activePendingUserInputs
        .find((request) => request.requestId === requestId)
        ?.questions.find((entry) => entry.id === questionId);
      if (!selectedThreadShell || !question) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftCustomAnswer(requestKey, question, customAnswer);
    },
    [activePendingUserInputs, selectedThreadShell],
  );

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!selectedThreadShell) {
        return;
      }

      setRespondingApprovalId(requestId);
      const result = await respondToApproval({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          requestId,
          decision,
        },
      });
      setRespondingApprovalId((current) => (current === requestId ? null : current));
      return result;
    },
    [respondToApproval, selectedThreadShell],
  );

  const onSubmitUserInput = useCallback(async () => {
    if (!selectedThreadShell || !activePendingUserInput || !activePendingUserInputAnswers) {
      return;
    }

    const responseKey = questionAttachmentDraftKey(
      selectedThreadShell.environmentId,
      selectedThreadShell.id,
      activePendingUserInput.requestId,
      "",
    );
    if (userInputResponsesInFlight.current.has(responseKey)) return;
    const attachmentsByQuestionId = new Map<
      string,
      import("@t3tools/contracts").UserInputAttachments[string]
    >();
    for (const question of activePendingUserInput.questions) {
      const key = questionAttachmentDraftKey(
        selectedThreadShell.environmentId,
        selectedThreadShell.id,
        activePendingUserInput.requestId,
        question.id,
      );
      if ((appAtomRegistry.get(questionAttachmentPreparationAtom)[key] ?? 0) > 0) return;
      const attachments = appAtomRegistry.get(composerDraftsAtom)[key]?.attachments ?? [];
      if (attachments.length === 0) continue;
      if (
        attachments.some(
          (attachment) =>
            !attachment.uploadedAttachmentId ||
            attachment.uploadEnvironmentId !== selectedThreadShell.environmentId,
        )
      ) {
        Alert.alert(
          "Attachments are not ready",
          "Wait for uploads to finish, or retry failed uploads.",
        );
        return;
      }
      attachmentsByQuestionId.set(
        question.id,
        attachments.map((attachment) => ({
          type: attachment.type,
          id: attachment.uploadedAttachmentId!,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        })),
      );
    }
    userInputResponsesInFlight.current.add(responseKey);
    setRespondingUserInputId(activePendingUserInput.requestId);
    const result = await respondToUserInput({
      environmentId: selectedThreadShell.environmentId,
      input: {
        threadId: selectedThreadShell.id,
        requestId: activePendingUserInput.requestId,
        answers: activePendingUserInputAnswers,
        ...(attachmentsByQuestionId.size > 0
          ? { attachmentsByQuestionId: Object.fromEntries(attachmentsByQuestionId) }
          : {}),
      },
    });
    userInputResponsesInFlight.current.delete(responseKey);
    setRespondingUserInputId((current) =>
      current === activePendingUserInput.requestId ? null : current,
    );
    return result;
  }, [
    activePendingUserInput,
    activePendingUserInputAnswers,
    respondToUserInput,
    selectedThreadShell,
  ]);

  useEffect(() => {
    setInteractionSubmission((current) => {
      if (current === null) {
        return null;
      }
      const next = reconcileInteractionSubmission(
        current,
        activePendingInteraction?.requestId ?? null,
        activeInteractionFailure,
      );
      if (next === null || (current.phase === "submitting" && next.phase === "error")) {
        interactionSubmissionAttemptRef.current += 1;
        releaseInteractionSubmissionLock(interactionSubmissionLockRef, current.requestId);
      }
      return next;
    });
  }, [activeInteractionFailure, activePendingInteraction?.requestId]);

  const onRespondToInteraction = useCallback(
    async (requestId: SessionInteractionRequestId, response: SessionInteractionResponse) => {
      if (
        !selectedThreadShell ||
        !acquireInteractionSubmissionLock(interactionSubmissionLockRef, requestId)
      ) {
        return;
      }

      const attempt = interactionSubmissionAttemptRef.current + 1;
      interactionSubmissionAttemptRef.current = attempt;
      setInteractionSubmission(
        beginInteractionSubmission(
          requestId,
          response,
          activeInteractionFailure?.requestId === requestId ? activeInteractionFailure.id : null,
        ),
      );
      try {
        const result = await respondToInteraction({
          environmentId: selectedThreadShell.environmentId,
          input: buildSessionInteractionCommandInput(selectedThreadShell.id, requestId, response),
        });
        if (interactionSubmissionAttemptRef.current !== attempt) {
          return result;
        }
        if (result._tag === "Failure") {
          releaseInteractionSubmissionLock(interactionSubmissionLockRef, requestId);
        }
        setInteractionSubmission((current) => {
          if (current?.requestId !== requestId) {
            return current;
          }
          return result._tag === "Failure"
            ? interactionCommandFailed(current, interactionResponseError(result.cause))
            : interactionCommandAccepted(current);
        });
        // Success only means the event-sourced command was accepted. Keep the
        // controls disabled until interaction.resolved or a matching provider
        // failure arrives, otherwise a fast second tap can race the reactor.
        return result;
      } catch (error) {
        if (interactionSubmissionAttemptRef.current !== attempt) {
          return undefined;
        }
        releaseInteractionSubmissionLock(interactionSubmissionLockRef, requestId);
        setInteractionSubmission((current) =>
          current?.requestId === requestId
            ? interactionCommandFailed(
                current,
                error instanceof Error && error.message.trim().length > 0
                  ? compactSessionPresentationText(error.message)
                  : "The response could not be sent. Try again.",
              )
            : current,
        );
        return undefined;
      }
    },
    [activeInteractionFailure, respondToInteraction, selectedThreadShell],
  );

  const onRetryInteraction = useCallback(async () => {
    if (interactionSubmission?.phase !== "error") {
      return;
    }
    return onRespondToInteraction(interactionSubmission.requestId, interactionSubmission.response);
  }, [interactionSubmission, onRespondToInteraction]);

  const interactionSubmissionMatches = interactionSubmissionMatchesActive(
    interactionSubmission,
    activePendingInteraction?.requestId ?? null,
  );
  // Closes an async question without messaging the agent.
  const onDismissUserInput = useCallback(async () => {
    if (!selectedThreadShell || !activePendingUserInput) {
      return;
    }

    setRespondingUserInputId(activePendingUserInput.requestId);
    const result = await dismissUserInput({
      environmentId: selectedThreadShell.environmentId,
      input: {
        threadId: selectedThreadShell.id,
        requestId: activePendingUserInput.requestId,
      },
    });
    setRespondingUserInputId((current) =>
      current === activePendingUserInput.requestId ? null : current,
    );
    return result;
  }, [activePendingUserInput, dismissUserInput, selectedThreadShell]);

  return {
    activePendingApproval,
    activePendingUserInput,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    activePendingInteraction,
    sessionInteractionPresentation: sessionInteractionState,
    interactionSubmitting:
      interactionSubmissionMatches && interactionSubmission.phase === "submitting",
    interactionError: interactionSubmissionMatches
      ? interactionSubmission.error
      : (activeInteractionFailure?.message ?? null),
    interactionCanRetry: interactionSubmissionMatches && interactionSubmission.phase === "error",
    respondingApprovalId,
    respondingUserInputId,
    onRespondToApproval,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onSubmitUserInput,
    onRespondToInteraction,
    onRetryInteraction,
    onDismissUserInput,
  };
}
