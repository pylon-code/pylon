import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  getNewProjectGitHubRepository,
  resolveNewProjectAttempt,
  type NewProjectAttempt,
} from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useRef } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { newProjectId } from "~/lib/utils";
import { waitForProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

const PUBLISH_RETRY_HINT = "Use Publish repository in the Git menu to try again.";

/**
 * Starts a project from just a name on the chosen environment. The server
 * makes a folder under its `newProjectsRoot` with a README, an icon, and a
 * first commit; this then opens a new thread draft in it. With `github`, it
 * also publishes the repository as private, without holding up the draft.
 *
 * Submitting the same name on the same environment again, after a failure or
 * a lost response, reuses the earlier attempt's project id, so the server
 * returns the project it already made instead of a `-2` copy.
 *
 * Resolves to whether the project was created.
 */
export function useNewProject() {
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const pendingAttemptRef = useRef<NewProjectAttempt | null>(null);

  const publishToGitHub = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly workspaceRoot: string;
      readonly account: string | null;
    }) => {
      // The folder the server actually made, which may carry a `-2` suffix.
      const result = await publishRepository({
        environmentId: input.environmentId,
        input: {
          cwd: input.workspaceRoot,
          provider: "github",
          repository: getNewProjectGitHubRepository(input, input.workspaceRoot),
          visibility: "private",
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create the GitHub repository",
              description: `${errorMessage(squashAtomCommandFailure(result))} The project is still in ${input.workspaceRoot}. ${PUBLISH_RETRY_HINT}`,
            }),
          );
        }
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Published to GitHub",
          description: result.value.repository.nameWithOwner,
        }),
      );
    },
    [publishRepository],
  );

  return useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly github: { readonly account: string | null } | null;
    }): Promise<boolean> => {
      const attempt = resolveNewProjectAttempt(
        pendingAttemptRef.current,
        { environmentId: input.environmentId, name: input.name },
        newProjectId,
      );
      pendingAttemptRef.current = attempt;
      const result = await createNew({
        environmentId: attempt.environmentId,
        input: { name: attempt.name, projectId: attempt.projectId },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create the project",
              description: errorMessage(squashAtomCommandFailure(result)),
            }),
          );
        }
        return false;
      }
      pendingAttemptRef.current = null;

      const { projectId, workspaceRoot, commitError } = result.value;
      // The folder sits in the environment's Pylon data directory, so always
      // say where.
      toastManager.add(
        stackedThreadToast(
          commitError === undefined
            ? { type: "success", title: `Created ${attempt.name}`, description: workspaceRoot }
            : {
                type: "warning",
                title: `Created ${attempt.name} without a first commit`,
                description: `${commitError} The project is in ${workspaceRoot}.${
                  input.github
                    ? ` The GitHub repository was not created; commit first. ${PUBLISH_RETRY_HINT}`
                    : ""
                }`,
              },
        ),
      );
      // An unborn repository has nothing to push, so publishing waits for
      // the first commit.
      if (input.github && commitError === undefined) {
        void publishToGitHub({
          environmentId: attempt.environmentId,
          workspaceRoot,
          account: input.github.account,
        });
      }

      const projectRef = scopeProjectRef(attempt.environmentId, projectId);
      // Drafts key off the project's stored path, so wait for the create event
      // to reach the store before opening one.
      const project = await waitForProject(projectRef).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to open project",
            description: `${errorMessage(error)} It will appear in the sidebar once this client catches up.`,
          }),
        );
        return null;
      });
      if (project === null) return true;
      await handleNewThread(projectRef).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to open project",
            description: errorMessage(error),
          }),
        );
      });
      return true;
    },
    [createNew, handleNewThread, publishToGitHub],
  );
}
