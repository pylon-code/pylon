import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import {
  isScratchProject,
  resolveScratchEnvironmentId,
} from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" };

export function getProjectScopeSelectionTarget(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
): EnvironmentProject {
  return (
    scope.projects.find((project) => project.environmentId === preferredEnvironmentId) ??
    scope.representative
  );
}

export function getProjectScopeAccessibilityLabel(
  scope: HomeProjectScope,
  selectionTarget: EnvironmentProject,
): string {
  return scope.projects.length > 1
    ? `${scope.title}, ${scope.projects.length} workspaces`
    : `${scope.title}, ${selectionTarget.workspaceRoot}`;
}

export function filterProjectScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
  searchText: string,
): ReadonlyArray<HomeProjectScope> {
  const query = searchText.trim().toLowerCase();
  if (!query) return scopes;
  return scopes.filter(
    (scope) =>
      scope.title.toLowerCase().includes(query) ||
      scope.projects.some(
        (project) =>
          project.title.toLowerCase().includes(query) ||
          project.workspaceRoot.toLowerCase().includes(query),
      ),
  );
}

type ScratchRootLookup = ReadonlyMap<
  EnvironmentId,
  { readonly scratchWorkspaceRoot?: string | undefined }
>;

/**
 * Scratch projects are reached through the one "No project" row, never as
 * rows of their own; a scope keeps its row while it holds any real project.
 */
export function withoutScratchProjectScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
  serverConfigs: ScratchRootLookup,
): ReadonlyArray<HomeProjectScope> {
  return scopes.filter(
    (scope) =>
      !scope.projects.every((project) =>
        isScratchProject(project, serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot),
      ),
  );
}

/** Connected machines whose server offers threads without a project. */
export function scratchOfferingEnvironmentIds(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
  }>,
  serverConfigs: ScratchRootLookup,
): ReadonlyArray<EnvironmentId> {
  return environments
    .filter(
      (environment) =>
        canCreateProjectInEnvironment(environment.connectionState) &&
        serverConfigs.get(environment.environmentId)?.scratchWorkspaceRoot !== undefined,
    )
    .map((environment) => environment.environmentId);
}

/**
 * Where the "No project" row starts a thread: the flow's current machine when
 * it offers Scratch, never another one; with no current machine, only a sole
 * offering machine. Matches web (useScratchProject).
 */
export function resolveScratchStartEnvironmentId(input: {
  readonly currentEnvironmentId: EnvironmentId | null;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
  }>;
  readonly serverConfigs: ScratchRootLookup;
}): EnvironmentId | null {
  return resolveScratchEnvironmentId(
    input.currentEnvironmentId,
    scratchOfferingEnvironmentIds(input.environments, input.serverConfigs),
  );
}

function getOnlySelectableProject(
  projectScopes: ReadonlyArray<HomeProjectScope>,
): EnvironmentProject | null {
  const onlyScope = projectScopes.length === 1 ? projectScopes[0] : null;
  return onlyScope?.representative ?? null;
}

/**
 * Picks the project on a target environment that corresponds to the project
 * currently selected in the new-task flow, so switching computers follows the
 * same repo. Repository identity is preferred; projects without one (e.g. not
 * yet indexed) fall back to workspace basename, then title. When nothing
 * matches, the first project on the target stands in — the same fallback the
 * render path applies when no key is selected — so the draft always has a
 * concrete key to carry over to.
 */
export function resolveEnvironmentProjectMatch(
  projectsOnTarget: ReadonlyArray<EnvironmentProject>,
  selectedProject: EnvironmentProject | null,
): EnvironmentProject | null {
  const repositoryKey = selectedProject?.repositoryIdentity?.canonicalKey ?? null;
  // `|| null` (not `??`): a pending-task placeholder project can have an empty
  // workspaceRoot, and an "" basename would match nothing meaningful.
  const workspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
  // The weaker signals only apply where identity is unknown on at least one
  // side; two known, different repositories never match on a shared basename
  // or title (mirrors the environment list filter in the new-task flow).
  const isKnownMismatch = (project: EnvironmentProject) => {
    const projectKey = project.repositoryIdentity?.canonicalKey ?? null;
    return repositoryKey !== null && projectKey !== null && projectKey !== repositoryKey;
  };
  return (
    (repositoryKey !== null
      ? projectsOnTarget.find(
          (project) => (project.repositoryIdentity?.canonicalKey ?? null) === repositoryKey,
        )
      : undefined) ??
    (workspaceBasename !== null
      ? projectsOnTarget.find(
          (project) =>
            !isKnownMismatch(project) &&
            project.workspaceRoot.split("/").at(-1) === workspaceBasename,
        )
      : undefined) ??
    (selectedProject !== null
      ? projectsOnTarget.find(
          (project) => !isKnownMismatch(project) && project.title === selectedProject.title,
        )
      : undefined) ??
    projectsOnTarget[0] ??
    null
  );
}

export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
  projectScopes: ReadonlyArray<HomeProjectScope>,
): DraftProjectSelectionResolution {
  const hasExplicitProjectSelection =
    selectedProjectKey !== null &&
    projects.some(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    );
  if (hasExplicitProjectSelection) {
    return { kind: "preserve" };
  }

  const onlyProject = getOnlySelectableProject(projectScopes);
  return onlyProject ? { kind: "select", project: onlyProject } : { kind: "pick" };
}
