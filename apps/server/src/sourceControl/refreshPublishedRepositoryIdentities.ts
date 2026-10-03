import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import type { ProjectId } from "@t3tools/contracts";

import type * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";

interface PublishedRepositorySnapshot {
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
  readonly threads: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  }>;
}

/** Refresh the published checkout and any project root that owns it. */
const refreshPublishedRepositoryIdentities = Effect.fnUntraced(function* <E>(
  cwd: string,
  snapshots: {
    readonly getShellSnapshot: () => Effect.Effect<PublishedRepositorySnapshot, E>;
  },
  identities: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
) {
  const path = yield* Path.Path;
  const contains = (root: string) => {
    const relative = path.relative(path.resolve(root), path.resolve(cwd));
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  yield* identities.resolve(cwd, { refresh: true });
  const snapshot = yield* snapshots
    .getShellSnapshot()
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("project identity refresh after publish skipped", { cwd, error }).pipe(
          Effect.as(null),
        ),
      ),
    );
  if (snapshot === null) return;

  const projects = new Map(snapshot.projects.map((project) => [project.id, project.workspaceRoot]));
  const roots = new Set(
    snapshot.projects
      .filter((project) => contains(project.workspaceRoot))
      .map((project) => project.workspaceRoot),
  );
  for (const thread of snapshot.threads) {
    if (thread.worktreePath !== null && contains(thread.worktreePath)) {
      const root = projects.get(thread.projectId);
      if (root !== undefined) roots.add(root);
    }
  }
  roots.delete(cwd);
  yield* Effect.forEach(roots, (root) => identities.resolve(root, { refresh: true }), {
    discard: true,
  });
});

export const withPublishedRepositoryIdentityRefresh = <A, E, R>(
  publish: Effect.Effect<A, E, R>,
  cwd: string,
  snapshots: Parameters<typeof refreshPublishedRepositoryIdentities>[1],
  identities: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
) =>
  publish.pipe(Effect.tap(() => refreshPublishedRepositoryIdentities(cwd, snapshots, identities)));
