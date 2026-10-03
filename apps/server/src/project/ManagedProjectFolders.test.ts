import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, GitCommandError, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { ProjectServiceLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";

// Real repository detection: the service only asks the Git workflow whether
// the data dir is inside a checkout.
const gitWorkflowLayer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
    return Layer.mock(GitWorkflow.GitWorkflowService)({
      isRepository: (cwd) =>
        registry.detect({ cwd }).pipe(
          Effect.map((handle) => handle?.kind === "git"),
          Effect.orDie,
        ),
    });
  }),
).pipe(Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))));

const enrichmentLayer = ProjectEnrichmentService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
);

const realGitLayer = GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer));

interface HarnessOptions {
  /** A git driver for failures real git cannot produce on demand. */
  readonly git?: Layer.Layer<GitVcsDriver.GitVcsDriver>;
  /** Wraps the real ProjectService, for failures it cannot produce on demand. */
  readonly projects?: (
    real: ProjectService.ProjectService["Service"],
  ) => ProjectService.ProjectService["Service"];
}

/**
 * The service over a real ProjectService and real git, with its data dir at
 * `baseDir`.
 */
const makeLayer = (baseDir: string, options?: HarnessOptions) =>
  ManagedProjectFolders.layer.pipe(
    Layer.provide(
      options?.projects === undefined
        ? Layer.empty
        : Layer.effect(
            ProjectService.ProjectService,
            ProjectService.ProjectService.pipe(Effect.map(options.projects)),
          ),
    ),
    Layer.provideMerge(ProjectServiceLayerLive),
    Layer.provideMerge(enrichmentLayer),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(gitWorkflowLayer),
    Layer.provideMerge(options?.git ?? realGitLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

/** Runs `body` with a data dir in a fresh temp folder, outside any checkout. */
const withScratch = <A, E>(
  body: (input: {
    readonly baseDir: string;
  }) => Effect.Effect<
    A,
    E,
    | ManagedProjectFolders.ManagedProjectFolders
    | ProjectService.ProjectService
    | NodeServices.NodeServices
    | Scope.Scope
  >,
  options?: HarnessOptions,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-managed-folders-" });
    return yield* body({ baseDir }).pipe(Effect.provide(makeLayer(baseDir, options)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const git = (cwd: string, args: ReadonlyArray<string>) =>
  ProcessRunner.ProcessRunner.pipe(
    Effect.flatMap((runner) => runner.run({ command: "git", args: ["-C", cwd, ...args] })),
    Effect.provide(ProcessRunner.layer),
  );

const requireRoot = Effect.gen(function* () {
  const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
  return Option.getOrThrow(yield* scratch.scratchRoot);
});

it.effect("offers a Scratch folder under the data dir when it is outside a checkout", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.equal(yield* requireRoot, path.resolve(baseDir, "scratch"));
    }),
  ),
);

it.effect("offers nothing when the data dir sits inside a Git checkout", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-scratch-repo-" });
    yield* git(checkout, ["init", "--quiet"]);
    const baseDir = path.join(checkout, ".t3");
    yield* fileSystem.makeDirectory(baseDir);
    yield* Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      assert.isTrue(Option.isNone(yield* scratch.scratchRoot));
      const failure = yield* Effect.flip(scratch.ensureScratchProject);
      assert.equal(failure._tag, "ScratchUnavailableError");
    }).pipe(Effect.provide(makeLayer(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("creates one Scratch project, even for concurrent first requests", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      // Without handling the losing creates' conflicts, eight racers fail.
      const racers = yield* Effect.all(
        Array.from({ length: 8 }, () => scratch.ensureScratchProject),
        { concurrency: "unbounded" },
      );
      const again = yield* scratch.ensureScratchProject;
      assert.deepEqual(
        new Set(racers.map((result) => result.projectId)),
        new Set([again.projectId]),
      );

      const snapshot = yield* projects.snapshot;
      const root = yield* requireRoot;
      const scratchProjects = snapshot.projects.filter((project) => project.workspaceRoot === root);
      assert.lengthOf(scratchProjects, 1);
      assert.equal(scratchProjects[0]?.title, "No project");
      assert.deepEqual(scratchProjects[0]?.projectIcon, {
        kind: "lucide",
        name: "message-square-dashed",
        color: "gray",
      });
    }),
  ),
);

it.effect("recreates the Scratch folder after it is deleted", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const fileSystem = yield* FileSystem.FileSystem;
      const { projectId } = yield* scratch.ensureScratchProject;
      const root = yield* requireRoot;
      yield* fileSystem.remove(root, { recursive: true });

      assert.equal((yield* scratch.ensureScratchProject).projectId, projectId);
      assert.isTrue(yield* fileSystem.exists(root));

      yield* fileSystem.remove(root, { recursive: true });
      const folder = yield* scratch.folderForThread({
        projectId,
        threadId: ThreadId.make("thread-after-delete"),
        text: "Still works",
      });
      assert.isTrue(yield* fileSystem.exists(Option.getOrThrow(folder)));
    }),
  ),
);

it.effect("gives each Scratch thread its own folder, named from its message", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { projectId } = yield* scratch.ensureScratchProject;
      const root = yield* requireRoot;
      const text = "Convert these PNGs to WebP, please!";
      // Two ids with the same tail would collide on the short name.
      const first = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread:a:0123456789abcdef"),
          text,
        }),
      );
      const second = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread:b:0123456789abcdef"),
          text,
        }),
      );

      // Ids that normalize to the same characters take both of its names.
      const third = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread:b0123456789abcdef"),
          text,
        }),
      );

      assert.equal(new Set([first, second, third]).size, 3);
      for (const folder of [first, second, third]) {
        assert.equal(path.dirname(folder), root);
        assert.match(path.basename(folder), /^\d{4}-\d{2}-\d{2}-convert-these-pngs-to-webp-/);
        assert.isTrue(yield* fileSystem.exists(folder));
      }

      const pasted = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread-pasted"),
          text: `${"word ".repeat(10_000)}../../etc`,
        }),
      );
      assert.equal(path.dirname(pasted), root);
      assert.isAtMost(path.basename(pasted).length, 80);
    }),
  ),
);

it.effect("leaves threads in other projects alone", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* scratch.ensureScratchProject;
      const other = yield* projects.create({
        commandId: CommandId.make("command:other"),
        projectId: ProjectId.make("project:other"),
        title: "Other",
        workspaceRoot: path.join(baseDir, "other"),
        createWorkspaceRootIfMissing: true,
      });

      const folder = yield* scratch.folderForThread({
        projectId: other.id,
        threadId: ThreadId.make("thread-other"),
        text: "Hello",
      });
      assert.isTrue(Option.isNone(folder));
      assert.deepEqual(yield* fileSystem.readDirectory(yield* requireRoot), []);
    }),
  ),
);

const GIT_IDENTITY_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
] as const;

/**
 * Runs `effect` with git reading only an empty global config plus `env`, so
 * the developer's own identity and signing settings stay out of the test. The
 * suite's pinned settings (gitConfig.setup.ts) still apply.
 */
const withGitEnv = <A, E, R>(
  env: Partial<Record<(typeof GIT_IDENTITY_KEYS)[number], string>>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const emptyConfig = yield* fileSystem.makeTempFileScoped({ prefix: "t3-gitconfig-" });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const saved = GIT_IDENTITY_KEYS.map((key) => [key, process.env[key]] as const);
        for (const key of GIT_IDENTITY_KEYS) delete process.env[key];
        Object.assign(process.env, {
          GIT_CONFIG_GLOBAL: emptyConfig,
          GIT_CONFIG_NOSYSTEM: "1",
          ...env,
        });
        return saved;
      }),
      () => effect,
      (saved) =>
        Effect.sync(() => {
          for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );
  });

const TEST_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

const gitOutput = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).pipe(Effect.map((result) => result.stdout.trim()));

it.effect("starts a named project as a committed repository, and suffixes a taken name", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.resolve(baseDir, "projects");
        assert.equal(folders.namedProjectsRoot, root);

        const first = yield* folders.createNamedProject({ name: "Pinball Stats" });
        const second = yield* folders.createNamedProject({ name: "pinball stats" });

        assert.equal(first.workspaceRoot, path.join(root, "pinball-stats"));
        assert.equal(second.workspaceRoot, path.join(root, "pinball-stats-2"));
        assert.isUndefined(first.commitError);
        const project = Option.getOrThrow(yield* projects.getById(first.projectId));
        assert.equal(project.title, "Pinball Stats");
        assert.equal(project.workspaceRoot, first.workspaceRoot);

        const readme = yield* fileSystem.readFileString(
          path.join(first.workspaceRoot, "README.md"),
        );
        assert.include(readme, "# Pinball Stats");
        assert.include(readme, `src="assets/icon.svg"`);
        const icon = yield* fileSystem.readFileString(
          path.join(first.workspaceRoot, "assets", "icon.svg"),
        );
        assert.include(icon, ">PS</text>");
        assert.equal(
          yield* gitOutput(first.workspaceRoot, ["log", "--format=%s"]),
          "Initial commit",
        );
        assert.equal(
          yield* gitOutput(first.workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
          "main",
        );
        assert.equal(yield* gitOutput(first.workspaceRoot, ["status", "--porcelain"]), "");
      }),
    ),
  ),
);

it.effect("gives concurrent named projects with the same name distinct folders", () =>
  withScratch(() =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const created = yield* Effect.all(
          Array.from({ length: 4 }, () => folders.createNamedProject({ name: "Race" })),
          { concurrency: "unbounded" },
        );

        assert.equal(new Set(created.map((result) => result.workspaceRoot)).size, 4);
        assert.equal(new Set(created.map((result) => result.projectId)).size, 4);
        const snapshot = yield* projects.snapshot;
        for (const result of created) {
          assert.isTrue(
            snapshot.projects.some((project) => project.workspaceRoot === result.workspaceRoot),
          );
        }
      }),
    ),
  ),
);

it.effect("keeps a named project and reports why when Git cannot commit", () =>
  withScratch(({ baseDir }) =>
    // No identity anywhere, and Git may not guess one from the host name.
    withGitEnv(
      {},
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(baseDir, "no-identity.gitconfig"),
          "[user]\n\tuseConfigOnly = true\n",
        );
        process.env.GIT_CONFIG_GLOBAL = path.join(baseDir, "no-identity.gitconfig");

        const result = yield* folders.createNamedProject({ name: "No Identity" });

        assert.include(result.commitError ?? "", "no name or email");
        assert.isTrue(Option.isSome(yield* projects.getById(result.projectId)));
        assert.isTrue(yield* fileSystem.exists(path.join(result.workspaceRoot, "README.md")));
        assert.isTrue(yield* fileSystem.exists(path.join(result.workspaceRoot, ".git")));
      }),
    ),
  ),
);

it.effect("keeps a folder that another project owns when the create conflicts", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const taken = path.join(folders.namedProjectsRoot, "taken");
        // A project registered at this path some other way (by hand, or a
        // client that predates the claim) owns the folder the create claims.
        yield* projects.create({
          commandId: CommandId.make("command:owner"),
          projectId: ProjectId.make("project:owner"),
          title: "Owner",
          workspaceRoot: taken,
          createWorkspaceRootIfMissing: true,
        });
        yield* fileSystem.remove(taken, { recursive: true });

        const failure = yield* Effect.flip(folders.createNamedProject({ name: "Taken" }));

        assert.equal(failure._tag, "NamedProjectCreateError");
        assert.equal(failure.message, "Failed to create the project.");
        assert.isTrue(yield* fileSystem.exists(path.join(taken, "README.md")));
        const owner = yield* projects.getByWorkspaceRoot(taken);
        assert.equal(Option.getOrThrow(owner).id, ProjectId.make("project:owner"));
        assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), [
          "taken",
        ]);
      }),
    ),
  ),
);

it.effect("removes the folder when the project create is rejected for another reason", () =>
  withScratch(
    ({ baseDir }) =>
      withGitEnv(
        TEST_IDENTITY,
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const failure = yield* Effect.flip(folders.createNamedProject({ name: "Rejected" }));

          assert.equal(failure._tag, "NamedProjectCreateError");
          assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), []);
        }),
      ),
    {
      // The project store failing the create is not something a real
      // ProjectService can be made to do on demand.
      projects: (real) =>
        ProjectService.ProjectService.of({
          ...real,
          create: (input) =>
            Effect.fail(
              new ProjectService.ProjectOperationError({
                operation: "dispatch-project-command",
                projectId: input.projectId,
                cause: "store unavailable",
              }),
            ),
        }),
    },
  ),
);

it.effect("removes the folder when the create is cancelled before the project exists", () =>
  Effect.gen(function* () {
    const scaffolding = yield* Deferred.make<void>();
    yield* withScratch(
      ({ baseDir }) =>
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const projects = yield* ProjectService.ProjectService;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const fiber = yield* folders
            .createNamedProject({ name: "Cancelled" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(scaffolding);
          assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), [
            "cancelled",
          ]);
          yield* Fiber.interrupt(fiber);

          assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), []);
          assert.deepEqual((yield* projects.snapshot).projects, []);
        }),
      {
        // Holds `git init` open so the create can be interrupted mid-scaffold.
        git: Layer.mock(GitVcsDriver.GitVcsDriver)({
          readConfigValue: () => Effect.succeed(null),
          execute: () =>
            Deferred.succeed(scaffolding, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      },
    );
  }),
);

it.effect("removes the folder when the repository cannot be made", () =>
  withScratch(
    ({ baseDir }) =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const failure = yield* Effect.flip(folders.createNamedProject({ name: "Broken" }));

        assert.equal(failure._tag, "NamedProjectFolderError");
        assert.equal(failure.message, "Failed to create the project folder.");
        assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), []);
        assert.deepEqual((yield* projects.snapshot).projects, []);
      }),
    {
      // git init itself failing (a missing or broken git) is not something a
      // real git can be made to do on demand.
      git: Layer.mock(GitVcsDriver.GitVcsDriver)({
        readConfigValue: () => Effect.succeed(null),
        execute: (input) =>
          Effect.fail(
            new GitCommandError({
              operation: input.operation,
              command: "git",
              cwd: input.cwd,
              detail: "git is broken",
            }),
          ),
      }),
    },
  ),
);

/**
 * Runs `effect` with extra git config entries layered after the suite's
 * pinned ones (gitConfig.setup.ts), so they win for single-valued keys.
 */
const withExtraGitConfig = <A, E, R>(
  entries: ReadonlyArray<readonly [key: string, value: string]>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const count = Number(process.env.GIT_CONFIG_COUNT ?? "0");
      entries.forEach(([key, value], index) => {
        process.env[`GIT_CONFIG_KEY_${count + index}`] = key;
        process.env[`GIT_CONFIG_VALUE_${count + index}`] = value;
      });
      process.env.GIT_CONFIG_COUNT = String(count + entries.length);
      return count;
    }),
    () => effect,
    (count) =>
      Effect.sync(() => {
        entries.forEach((_, index) => {
          delete process.env[`GIT_CONFIG_KEY_${count + index}`];
          delete process.env[`GIT_CONFIG_VALUE_${count + index}`];
        });
        process.env.GIT_CONFIG_COUNT = String(count);
      }),
  );

const projectsFolder = (baseDir: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return (yield* fileSystem.readDirectory(path.resolve(baseDir, "projects"))).toSorted();
  });

it.effect("starts a named project on the configured default branch", () =>
  withScratch(() =>
    withGitEnv(
      TEST_IDENTITY,
      withExtraGitConfig(
        [["init.defaultBranch", "trunk"]],
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const result = yield* folders.createNamedProject({ name: "Trunk Based" });

          assert.isUndefined(result.commitError);
          assert.equal(
            yield* gitOutput(result.workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
            "trunk",
          );
        }),
      ),
    ),
  ),
);

it.effect("keeps a named project and reports why when commit signing fails", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      withExtraGitConfig(
        [
          ["commit.gpgsign", "true"],
          ["gpg.program", "pylon-test-missing-gpg"],
        ],
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const projects = yield* ProjectService.ProjectService;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const result = yield* folders.createNamedProject({ name: "Signed" });

          assert.isString(result.commitError);
          assert.isTrue(Option.isSome(yield* projects.getById(result.projectId)));
          assert.isTrue(yield* fileSystem.exists(path.join(result.workspaceRoot, "README.md")));
          assert.deepEqual(yield* projectsFolder(baseDir), ["signed"]);
        }),
      ),
    ),
  ),
);

it.effect("names folders for Unicode and Windows device names portably", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;

        const unicode = yield* folders.createNamedProject({ name: "Café Crème" });
        const cjk = yield* folders.createNamedProject({ name: "日本語" });
        const device = yield* folders.createNamedProject({ name: "CON" });

        assert.deepEqual(yield* projectsFolder(baseDir), ["cafe-creme", "con-project", "project"]);
        // The title keeps the name as typed; only the folder is folded.
        const title = (id: ProjectId) =>
          projects.getById(id).pipe(Effect.map((project) => Option.getOrThrow(project).title));
        assert.equal(yield* title(unicode.projectId), "Café Crème");
        assert.equal(yield* title(cjk.projectId), "日本語");
        assert.equal(yield* title(device.projectId), "CON");
      }),
    ),
  ),
);

it.effect("replays a retried create with the same project id instead of duplicating it", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const projectId = ProjectId.make("project:client-chosen");

        const first = yield* folders.createNamedProject({ name: "Retry Me", projectId });
        // The response was lost; the client sends the same create again.
        const retry = yield* folders.createNamedProject({ name: "Retry Me", projectId });

        assert.equal(first.projectId, projectId);
        assert.deepEqual(retry, first);
        assert.deepEqual(yield* projectsFolder(baseDir), ["retry-me"]);
        assert.equal((yield* projects.snapshot).projects.length, 1);
      }),
    ),
  ),
);

it.effect("joins concurrent duplicates of one create into a single project", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const projectId = ProjectId.make("project:double-submit");

        const results = yield* Effect.all(
          Array.from({ length: 3 }, () =>
            folders.createNamedProject({ name: "Double", projectId }),
          ),
          { concurrency: "unbounded" },
        );

        assert.equal(new Set(results.map((result) => result.workspaceRoot)).size, 1);
        assert.deepEqual(yield* projectsFolder(baseDir), ["double"]);
        assert.equal((yield* projects.snapshot).projects.length, 1);
      }),
    ),
  ),
);

it.effect("replays a missing first commit as a warning on retry", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      {},
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(baseDir, "no-identity.gitconfig"),
          "[user]\n\tuseConfigOnly = true\n",
        );
        process.env.GIT_CONFIG_GLOBAL = path.join(baseDir, "no-identity.gitconfig");
        const projectId = ProjectId.make("project:no-identity-retry");

        const first = yield* folders.createNamedProject({ name: "Unborn", projectId });
        const retry = yield* folders.createNamedProject({ name: "Unborn", projectId });

        assert.include(first.commitError ?? "", "no name or email");
        assert.equal(retry.workspaceRoot, first.workspaceRoot);
        assert.include(retry.commitError ?? "", "no commits yet");
      }),
    ),
  ),
);

it.effect("refuses a project id that another project already uses", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const elsewhere = path.join(baseDir, "elsewhere");
        yield* projects.create({
          commandId: CommandId.make("command:elsewhere"),
          projectId: ProjectId.make("project:elsewhere"),
          title: "Elsewhere",
          workspaceRoot: elsewhere,
          createWorkspaceRootIfMissing: true,
        });
        yield* fileSystem.makeDirectory(path.resolve(baseDir, "projects"), { recursive: true });

        const failure = yield* Effect.flip(
          folders.createNamedProject({
            name: "Hijack",
            projectId: ProjectId.make("project:elsewhere"),
          }),
        );

        assert.equal(failure._tag, "NamedProjectIdInUseError");
        assert.deepEqual(yield* projectsFolder(baseDir), []);
      }),
    ),
  ),
);

it.effect("retries a rejected create with the same project id as a fresh attempt", () =>
  Effect.gen(function* () {
    let calls = 0;
    yield* withScratch(
      ({ baseDir }) =>
        withGitEnv(
          TEST_IDENTITY,
          Effect.gen(function* () {
            const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
            const projectId = ProjectId.make("project:rejected-once");

            const failure = yield* Effect.flip(
              folders.createNamedProject({ name: "Second Try", projectId }),
            );
            assert.equal(failure._tag, "NamedProjectCreateError");
            assert.deepEqual(yield* projectsFolder(baseDir), []);

            const retry = yield* folders.createNamedProject({ name: "Second Try", projectId });
            assert.equal(retry.projectId, projectId);
            assert.deepEqual(yield* projectsFolder(baseDir), ["second-try"]);
          }),
        ),
      {
        // The store refuses the first create only.
        projects: (real) =>
          ProjectService.ProjectService.of({
            ...real,
            create: (input) => {
              calls += 1;
              return calls === 1
                ? Effect.fail(
                    new ProjectService.ProjectOperationError({
                      operation: "dispatch-project-command",
                      projectId: input.projectId,
                      cause: "store unavailable",
                    }),
                  )
                : real.create(input);
            },
          }),
      },
    );
  }),
);

it.effect("removes the folder when the create is interrupted before it commits", () =>
  Effect.gen(function* () {
    const dispatching = yield* Deferred.make<void>();
    yield* withScratch(
      ({ baseDir }) =>
        withGitEnv(
          TEST_IDENTITY,
          Effect.gen(function* () {
            const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
            const projects = yield* ProjectService.ProjectService;

            const fiber = yield* folders
              .createNamedProject({ name: "Never Committed" })
              .pipe(Effect.forkChild);
            yield* Deferred.await(dispatching);
            assert.deepEqual(yield* projectsFolder(baseDir), ["never-committed"]);
            yield* Fiber.interrupt(fiber);

            assert.deepEqual(yield* projectsFolder(baseDir), []);
            assert.deepEqual((yield* projects.snapshot).projects, []);
          }),
        ),
      {
        // Holds the dispatch open before anything is committed.
        projects: (real) =>
          ProjectService.ProjectService.of({
            ...real,
            create: () =>
              Deferred.succeed(dispatching, undefined).pipe(Effect.andThen(Effect.never)),
          }),
      },
    );
  }),
);

it.effect("keeps the folder when the create is interrupted after it commits", () =>
  Effect.gen(function* () {
    const committed = yield* Deferred.make<void>();
    yield* withScratch(
      ({ baseDir }) =>
        withGitEnv(
          TEST_IDENTITY,
          Effect.gen(function* () {
            const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
            const projects = yield* ProjectService.ProjectService;
            const projectId = ProjectId.make("project:committed-then-interrupted");

            const fiber = yield* folders
              .createNamedProject({ name: "Committed", projectId })
              .pipe(Effect.forkChild);
            yield* Deferred.await(committed);
            yield* Fiber.interrupt(fiber);

            assert.deepEqual(yield* projectsFolder(baseDir), ["committed"]);
            assert.isTrue(Option.isSome(yield* projects.getById(projectId)));
            // The client never saw a response; its retry returns the project.
            const retry = yield* folders.createNamedProject({ name: "Committed", projectId });
            assert.equal(retry.projectId, projectId);
            assert.deepEqual(yield* projectsFolder(baseDir), ["committed"]);
          }),
        ),
      {
        // Commits the create, then never answers, as a dropped response would.
        projects: (real) =>
          ProjectService.ProjectService.of({
            ...real,
            create: (input) =>
              real
                .create(input)
                .pipe(
                  Effect.andThen(Deferred.succeed(committed, undefined)),
                  Effect.andThen(Effect.never),
                ),
          }),
      },
    );
  }),
);
