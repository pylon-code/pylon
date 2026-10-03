import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

export function resolveAddProjectEnvironment<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
  },
>(environmentOptions: ReadonlyArray<T>, requestedEnvironmentId: EnvironmentId | null): T | null {
  if (requestedEnvironmentId !== null) {
    return (
      environmentOptions.find(
        (environment) =>
          environment.environmentId === requestedEnvironmentId &&
          canCreateProjectInEnvironment(environment.connectionState),
      ) ?? null
    );
  }

  return (
    environmentOptions.find((environment) =>
      canCreateProjectInEnvironment(environment.connectionState),
    ) ?? null
  );
}

/**
 * How New project's "Add existing project" reaches the folder and clone
 * sources for the machine it has selected:
 *
 * - `back`: the Add project screen underneath already shows that machine;
 * - `replace-sources`: replace the screen with Add project for that machine,
 *   first popping an Add project screen underneath that shows another one
 *   (`popSourcesBelow`), so Back still returns to where New project opened
 *   from. A deep link has no Add project underneath.
 */
export type ExistingProjectSourcesNavigation =
  | { readonly kind: "back" }
  | { readonly kind: "replace-sources"; readonly popSourcesBelow: boolean };

export function resolveExistingProjectSourcesNavigation(input: {
  readonly previousRouteName: string | null;
  readonly openedFromEnvironmentId: EnvironmentId | null;
  readonly selectedEnvironmentId: EnvironmentId;
}): ExistingProjectSourcesNavigation {
  const sourcesBelow = input.previousRouteName === "AddProject";
  if (sourcesBelow && input.openedFromEnvironmentId === input.selectedEnvironmentId) {
    return { kind: "back" };
  }
  return { kind: "replace-sources", popSourcesBelow: sourcesBelow };
}
