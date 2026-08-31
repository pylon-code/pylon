import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLoginShell,
  readPathFromLaunchctl,
  resolveWindowsEnvironment,
} from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

function hydratePosixPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  let shellPath: string | undefined;
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    try {
      shellPath = readPathFromLoginShell(shell);
    } catch (error) {
      logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
    }

    if (shellPath) break;
  }

  const launchctlPath = platform === "darwin" && !shellPath ? readPathFromLaunchctl() : undefined;
  const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }
}

export function hydratePosixHome(
  env: NodeJS.ProcessEnv,
  resolveHomeDir = () => NodeOS.userInfo().homedir,
): void {
  if ((env.HOME?.trim() ?? "").length > 0) return;

  const homeDir = resolveHomeDir();
  if (homeDir.length > 0) {
    env.HOME = homeDir;
  }
}

export const fixPath = Effect.fn("fixPath")(function* (): Effect.fn.Return<
  void,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;

  if (platform === "win32") {
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixHome(env)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate HOME from the user account.", defect);
      }),
    ),
  );
  yield* Effect.sync(() => hydratePosixPath(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
      }),
    ),
  );
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(NodeOS.homedir(), input.slice(2));
  }
  return input;
});

/**
 * Pylon's runtime home. `~/.t3` is T3 Code's: its database carries upstream's
 * migration numbering, so a Pylon server that opened it would record those ids
 * as applied and then fail on the first query. Nothing here ever falls back to
 * it — `--base-dir` or `T3CODE_HOME` is how a user points Pylon somewhere else.
 */
export const RUNTIME_HOME_DIR_NAME = ".pylon-code";

/** T3 Code's runtime home. Only ever named, never opened by default. */
export const LEGACY_RUNTIME_HOME_DIR_NAME = ".t3";

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(NodeOS.homedir(), RUNTIME_HOME_DIR_NAME);
  }
  return resolve(yield* expandHomePath(raw.trim()));
});

/**
 * Names the state directories rather than their parents. `userdata` is the
 * whole migration — settings and secrets live inside it — while the parent also
 * holds caches and worktrees that are either disposable or referenced by
 * absolute path, so telling someone to move the parent would be wrong.
 */
export const formatLegacyRuntimeHomeHint = (paths: {
  readonly stateDir: string;
  readonly legacyStateDir: string;
  readonly legacyBaseDir: string;
}) =>
  `Starting with a new state directory at ${paths.stateDir} — nothing was there yet. ` +
  `An older state directory exists at ${paths.legacyStateDir}, and Pylon does not adopt it automatically because it may belong to T3 Code. ` +
  `To keep using it, pass --base-dir ${paths.legacyBaseDir} or set T3CODE_HOME=${paths.legacyBaseDir}; ` +
  `otherwise move ${paths.legacyStateDir} to ${paths.stateDir}, which brings your settings and secrets with it.`;

/**
 * Points a user whose state predates the move to `~/.pylon-code` at the
 * directory they already have. It says its piece once: the launch that emits it
 * goes on to create `<default>/userdata`, so the next one no longer qualifies.
 *
 * Deliberately silent whenever the user already said where their state lives,
 * and for dev runs, whose state lives in `<base>/dev` rather than `userdata`.
 *
 * Written straight to stderr rather than through the logger, and never to
 * stdout. `auth`, `connect`, and `project` resolve their base dir through the
 * same helper, and they emit machine-readable payloads under `--json`; a
 * sentence prepended to that stream breaks every parser reading it. Their
 * `quietLogs` handling cannot help either, because it installs its log level
 * after the base dir has already been resolved.
 */
export const warnAboutLegacyRuntimeHome = Effect.fn("warnAboutLegacyRuntimeHome")(
  function* (options: {
    readonly baseDir: string;
    readonly stateDir: string;
    readonly baseDirIsExplicit: boolean;
    /** Injected by tests so they never read the developer's own home. */
    readonly homeDir?: string;
    /** Injected by tests. Defaults to stderr. */
    readonly write?: (message: string) => void;
  }) {
    if (options.baseDirIsExplicit) return;
    const { join } = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const homeDir = options.homeDir ?? NodeOS.homedir();
    const defaultBaseDir = join(homeDir, RUNTIME_HOME_DIR_NAME);
    if (options.baseDir !== defaultBaseDir) return;
    if (options.stateDir !== join(defaultBaseDir, "userdata")) return;

    const alreadyMigrated = yield* fs
      .exists(options.stateDir)
      .pipe(Effect.orElseSucceed(() => true));
    if (alreadyMigrated) return;

    const legacyBaseDir = join(homeDir, LEGACY_RUNTIME_HOME_DIR_NAME);
    const legacyStateDir = join(legacyBaseDir, "userdata");
    const legacyExists = yield* fs.exists(legacyStateDir).pipe(Effect.orElseSucceed(() => false));
    if (!legacyExists) return;

    const write =
      options.write ??
      ((message: string) => {
        process.stderr.write(message);
      });
    yield* Effect.sync(() =>
      write(
        `${formatLegacyRuntimeHomeHint({
          stateDir: options.stateDir,
          legacyStateDir,
          legacyBaseDir,
        })}\n`,
      ),
    );
  },
);
