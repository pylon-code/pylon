import {
  type PairLead,
  pairLockedReason,
  pairToggleStep,
  resolveExecutorSelection,
  shouldRestartLeadSession,
} from "@t3tools/client-runtime/state/pair-control";
import { type PairState, resolvePairState } from "@t3tools/client-runtime/state/pair";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { pairExecutorThreadId } from "@t3tools/shared/delegatedThreads";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useCallback, useMemo } from "react";
import { Alert } from "react-native";

import { useEnvironmentServerConfig, useProjects, useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export interface UsePairToggleInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly lead: PairLead | null;
  readonly leadDriverKind: string | null | undefined;
}

export interface UsePairToggleResult {
  readonly state: PairState;
  readonly executorSelection: ModelSelection | null;
  readonly lockedReason: string | null;
  readonly onToggle: (on: boolean) => Promise<void>;
}

export function usePairToggle(input: UsePairToggleInput): UsePairToggleResult {
  const threads = useThreadShells();
  const projects = useProjects();
  const selectedProject = useMemo(
    () =>
      input.projectId === null
        ? null
        : (projects.find(
            (project) =>
              project.environmentId === input.environmentId && project.id === input.projectId,
          ) ?? null),
    [input.environmentId, input.projectId, projects],
  );
  const selectedEnvironmentServerConfig = useEnvironmentServerConfig(input.environmentId);
  const projectSettings = useMemo(
    () =>
      resolveProjectSettings(
        selectedEnvironmentServerConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
        input.projectId,
        selectedProject,
      ).settings,
    [input.projectId, selectedEnvironmentServerConfig?.settings, selectedProject],
  );
  const defaultSelection = projectSettings.delegationDefaultModelSelection;
  const childRuntimeMode = projectSettings.delegationChildRuntimeMode;

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

  const executorSelection = useMemo(
    () => resolveExecutorSelection({ state, picked: null, defaultSelection }),
    [defaultSelection, state],
  );
  const lockedReason = useMemo(() => pairLockedReason(input.lead), [input.lead]);

  const onToggle = useCallback(
    async (on: boolean) => {
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
              const message =
                error instanceof Error
                  ? error.message
                  : "An error occurred while creating the new thread.";
              Alert.alert("Could not change the pair", message);
            }
            return;
          }
        }
      } else if (step.kind === "delete") {
        const deleteResult = await deleteThread({
          environmentId: input.environmentId,
          input: {
            threadId: step.threadId,
          },
        });
        if (deleteResult._tag === "Failure" && !isAtomCommandInterrupted(deleteResult)) {
          const error = squashAtomCommandFailure(deleteResult);
          const message =
            error instanceof Error ? error.message : "An error occurred while deleting the thread.";
          Alert.alert("Could not change the pair", message);
          return;
        }
      } else if (step.kind === "archive") {
        const archiveResult = await archiveThread({
          environmentId: input.environmentId,
          input: {
            threadId: step.threadId,
          },
        });
        if (archiveResult._tag === "Failure" && !isAtomCommandInterrupted(archiveResult)) {
          const error = squashAtomCommandFailure(archiveResult);
          const message =
            error instanceof Error
              ? error.message
              : "An error occurred while archiving the thread.";
          Alert.alert("Could not change the pair", message);
          return;
        }
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
      deleteThread,
      executorSelection,
      input.environmentId,
      input.lead,
      state,
      stopSession,
      unarchiveThread,
    ],
  );

  return useMemo(
    () => ({
      state,
      executorSelection,
      lockedReason,
      onToggle,
    }),
    [executorSelection, lockedReason, onToggle, state],
  );
}
