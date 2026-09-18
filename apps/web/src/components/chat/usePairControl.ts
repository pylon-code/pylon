import { useCallback, useMemo, useState } from "react";
import { resolvePairState, type PairState } from "@t3tools/client-runtime/state/pair";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ThreadId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { pairExecutorThreadId } from "@t3tools/shared/delegatedThreads";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useThreadShells } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadTurnInterruptInput } from "../ChatView.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { PairControlProps } from "./PairControl";
import {
  pairLockedReason,
  pairToggleStep,
  resolveExecutorSelection,
  shouldRestartLeadSession,
  type PairLead,
} from "./pairControl.logic";

export function usePairControl(input: {
  readonly environmentId: EnvironmentId;
  readonly lead: PairLead | null;
  readonly leadDriverKind: string | null | undefined;
  readonly projectId: ProjectId | null;
}): Pick<
  PairControlProps,
  | "state"
  | "executorSelection"
  | "lockedReason"
  | "onToggle"
  | "onExecutorChange"
  | "onStopExecutor"
> {
  const threads = useThreadShells();
  const settings = useEnvironmentSettings(input.environmentId);
  const projectSettings = useMemo(
    () => resolveProjectSettings(settings, input.projectId).settings,
    [input.projectId, settings],
  );
  const defaultSelection = projectSettings.delegationDefaultModelSelection;
  const childRuntimeMode = projectSettings.delegationChildRuntimeMode;

  // Keyed by the lead so a model picked for one thread never follows the user
  // to another, without an effect to reset it.
  const [pick, setPick] = useState<{
    readonly leadId: ThreadId | undefined;
    readonly selection: ModelSelection;
  } | null>(null);
  const leadId = input.lead?.id;
  const picked = pick !== null && pick.leadId === leadId ? pick.selection : null;

  const state = useMemo<PairState>(() => {
    if (input.lead === null) {
      return {
        kind: "off",
        executorId: pairExecutorThreadId(ThreadId.make("no-thread")),
      };
    }
    return resolvePairState({
      threads,
      lead: {
        environmentId: input.environmentId,
        threadId: input.lead.id,
        driverKind: input.leadDriverKind,
      },
    });
  }, [input.environmentId, input.lead, input.leadDriverKind, threads]);

  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const unarchiveThread = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const archiveThread = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });

  const onToggle = useCallback(
    async (on: boolean) => {
      const executorSelection = resolveExecutorSelection({
        state,
        picked,
        defaultSelection,
      });
      const step = pairToggleStep({
        on,
        state,
        lead: input.lead,
        executorSelection,
        childRuntimeMode,
      });
      if (step === null) {
        return;
      }

      if (step.kind === "create") {
        const createResult = await createThread({
          environmentId: input.environmentId,
          input: {
            ...step.input,
            createdAt: new Date().toISOString(),
          },
        });
        if (createResult._tag === "Failure") {
          const unarchiveResult = await unarchiveThread({
            environmentId: input.environmentId,
            input: {
              threadId: step.input.threadId,
            },
          });
          if (unarchiveResult._tag === "Failure") {
            if (!isAtomCommandInterrupted(unarchiveResult)) {
              const error = squashAtomCommandFailure(unarchiveResult);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not pair thread",
                  description:
                    error instanceof Error
                      ? error.message
                      : "An error occurred while creating the new thread.",
                }),
              );
            }
            return;
          }
        }
      } else if (step.kind === "delete") {
        await deleteThread({
          environmentId: input.environmentId,
          input: {
            threadId: step.threadId,
          },
        });
      } else if (step.kind === "archive") {
        await archiveThread({
          environmentId: input.environmentId,
          input: {
            threadId: step.threadId,
          },
        });
      }

      if (input.lead !== null && shouldRestartLeadSession(input.lead)) {
        void stopSession({
          environmentId: input.environmentId,
          input: {
            threadId: input.lead.id,
          },
        });
      }
    },
    [
      archiveThread,
      childRuntimeMode,
      createThread,
      defaultSelection,
      deleteThread,
      input.environmentId,
      input.lead,
      picked,
      state,
      stopSession,
      unarchiveThread,
    ],
  );

  const onExecutorChange = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      setPick({ leadId, selection: { instanceId, model } });
    },
    [leadId],
  );

  const onStopExecutor = useCallback(async () => {
    if (state.kind !== "on") {
      return;
    }
    const executorShell = threads.find(
      (thread) => thread.environmentId === input.environmentId && thread.id === state.executorId,
    );
    if (!executorShell) {
      return;
    }
    const result = await interruptTurn({
      environmentId: input.environmentId,
      input: buildThreadTurnInterruptInput(executorShell),
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not stop the executor",
          description:
            error instanceof Error
              ? error.message
              : "An error occurred while stopping the executor.",
        }),
      );
    }
  }, [input.environmentId, interruptTurn, state, threads]);

  const executorSelection = useMemo(
    () => resolveExecutorSelection({ state, picked, defaultSelection }),
    [defaultSelection, picked, state],
  );
  const lockedReason = useMemo(() => pairLockedReason(input.lead), [input.lead]);

  return useMemo(
    () => ({
      state,
      executorSelection,
      lockedReason,
      onToggle,
      onExecutorChange,
      onStopExecutor,
    }),
    [executorSelection, lockedReason, onExecutorChange, onStopExecutor, onToggle, state],
  );
}
