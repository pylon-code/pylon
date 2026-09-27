import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { withPublishedRepositoryIdentityRefresh } from "./refreshPublishedRepositoryIdentities.ts";

it.layer(NodeServices.layer)("published repository identities", (it) => {
  it.effect("refreshes a primed project root after publishing from its linked worktree", () => {
    const projectRoot = "/workspace/project";
    const worktree = "/workspace/linked-worktree";
    let remote = "git@github.com:acme/old.git";
    const calls: Array<ReadonlyArray<string>> = [];
    const processRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          return {
            stdout: input.args.includes("rev-parse")
              ? `${input.args[1]}\n`
              : `origin\t${remote} (fetch)\n`,
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const resolverLayer = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make(),
    ).pipe(Layer.provide(processRunner));

    return Effect.gen(function* () {
      const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const snapshots = {
        getShellSnapshot: () =>
          Effect.succeed({
            projects: [{ id: ProjectId.make("project"), workspaceRoot: projectRoot }],
            threads: [{ projectId: ProjectId.make("project"), worktreePath: worktree }],
          }),
      };
      expect((yield* identities.resolve(projectRoot))?.canonicalKey).toBe("github.com/acme/old");
      yield* withPublishedRepositoryIdentityRefresh(
        Effect.sync(() => {
          remote = "git@github.com:acme/new.git";
        }),
        worktree,
        snapshots,
        identities,
      );

      expect((yield* identities.resolve(projectRoot))?.canonicalKey).toBe("github.com/acme/new");
      expect(
        calls.filter((args) => args[1] === projectRoot && args.includes("remote")),
      ).toHaveLength(2);
      expect(calls.filter((args) => args[1] === worktree && args.includes("remote"))).toHaveLength(
        1,
      );
    }).pipe(Effect.provide(resolverLayer));
  });
});
