import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type SessionInteractionRequestId,
  type SessionInteractionResponse,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom } from "effect/unstable/reactivity";

import { threadEnvironment } from "../state/threads";
import { scopedRequestKey } from "../lib/scopedEntities";
import {
  buildPendingUserInputAnswers,
  derivePendingApprovals,
  derivePendingUserInputs,
  setPendingUserInputCustomAnswer,
  sortThreadActivities,
  type PendingUserInputDraftAnswer,
} from "../lib/threadActivity";
import {
  acquireInteractionSubmissionLock,
  beginInteractionSubmission,
  deriveInteractionSubmissionView,
  interactionCommandAccepted,
  interactionCommandFailed,
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
import { useSelectedThreadDetail } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { useAtomCommand } from "./use-atom-command";

const userInputDraftsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:user-input-drafts"));

function setUserInputDraftOption(requestKey: string, questionId: string, label: string): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [questionId]: {
        selectedOptionLabel: label,
      },
    },
  });
}

function setUserInputDraftCustomAnswer(
  requestKey: string,
  questionId: string,
  customAnswer: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [questionId]: setPendingUserInputCustomAnswer(
        current[requestKey]?.[questionId],
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
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThread = useSelectedThreadDetail();
  const userInputDraftsByRequestKey = useAtomValue(userInputDraftsByRequestKeyAtom);
  const [respondingApprovalId, setRespondingApprovalId] = useState<ApprovalRequestId | null>(null);
  const [respondingUserInputId, setRespondingUserInputId] = useState<ApprovalRequestId | null>(
    null,
  );
  const [interactionSubmission, setInteractionSubmission] =
    useState<InteractionSubmissionState | null>(null);
  const interactionSubmissionLockRef = useRef<SessionInteractionRequestId | null>(null);
  const interactionSubmissionAttemptRef = useRef(0);

  // Sort once; both derivations expect the same lifecycle ordering.
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
  const activePendingApprovals = useMemo(
    () => derivePendingApprovals(sortedActivities),
    [sortedActivities],
  );
  const activePendingApproval = activePendingApprovals[0] ?? null;
  const activePendingUserInputs = useMemo(
    () => derivePendingUserInputs(sortedActivities),
    [sortedActivities],
  );
  const activePendingUserInput = activePendingUserInputs[0] ?? null;
  const activePendingUserInputDrafts =
    activePendingUserInput && selectedThreadShell
      ? (userInputDraftsByRequestKey[
          scopedRequestKey(selectedThreadShell.environmentId, activePendingUserInput.requestId)
        ] ?? {})
      : {};
  const activePendingUserInputAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingUserInputDrafts)
    : null;

  const onSelectUserInputOption = useCallback(
    (requestId: ApprovalRequestId, questionId: string, label: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftOption(requestKey, questionId, label);
    },
    [selectedThreadShell],
  );

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: ApprovalRequestId, questionId: string, customAnswer: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const requestKey = scopedRequestKey(selectedThreadShell.environmentId, requestId);
      setUserInputDraftCustomAnswer(requestKey, questionId, customAnswer);
    },
    [selectedThreadShell],
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

    setRespondingUserInputId(activePendingUserInput.requestId);
    const result = await respondToUserInput({
      environmentId: selectedThreadShell.environmentId,
      input: {
        threadId: selectedThreadShell.id,
        requestId: activePendingUserInput.requestId,
        answers: activePendingUserInputAnswers,
      },
    });
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

  const interactionSubmissionView = deriveInteractionSubmissionView(
    interactionSubmission,
    activePendingInteraction?.requestId ?? null,
    activeInteractionFailure,
  );

  return {
    activePendingApproval,
    activePendingUserInput,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    activePendingInteraction,
    sessionInteractionPresentation: sessionInteractionState,
    interactionSubmitting: interactionSubmissionView.submitting,
    interactionError: interactionSubmissionView.error,
    interactionCanRetry: interactionSubmissionView.canRetry,
    respondingApprovalId,
    respondingUserInputId,
    onRespondToApproval,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onSubmitUserInput,
    onRespondToInteraction,
    onRetryInteraction,
  };
}
