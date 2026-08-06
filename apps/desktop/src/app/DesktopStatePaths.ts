import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

/**
 * Pylon's runtime home. `t3Home` remains a T3-compatible override input, but an
 * unset override resolves to Pylon's own directory, never T3's.
 */
export const DESKTOP_RUNTIME_HOME_DIR_NAME = ".pylon-code";

/**
 * Nightly's runtime home.
 *
 * A nightly build is a separate product from the stable one — it installs
 * alongside it under its own name — so it needs its own database. Sharing one
 * would mean trying a release candidate writes to the data the daily driver is
 * using, and its migrations would run there too. The default has to be the safe
 * one: nobody remembers to set an override before double-clicking an app.
 */
export const DESKTOP_NIGHTLY_RUNTIME_HOME_DIR_NAME = ".pylon-code-nightly";

export function resolveDesktopRuntimeHomeDirName(isNightly: boolean): string {
  return isNightly ? DESKTOP_NIGHTLY_RUNTIME_HOME_DIR_NAME : DESKTOP_RUNTIME_HOME_DIR_NAME;
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
  readonly isNightly: boolean;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () =>
    input.joinPath(input.homeDirectory, resolveDesktopRuntimeHomeDirName(input.isNightly)),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
