// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type * as Path from "effect/Path";

/**
 * Expand a leading `~` (or `~/…`, `~\…`) in a user-supplied path to the
 * current user's home directory. Spawned processes don't get shell
 * expansion, so env vars like `CODEX_HOME=~/.codex-work` would be passed
 * verbatim and treated as relative paths by the receiver.
 *
 * Matches the behavior of the other `expandHomePath` helpers in the
 * workspace layers and CLI bootstrap: `~` alone and both `~/` and `~\`
 * separators are handled. Returns the input unchanged if it doesn't
 * start with `~` or is empty. Does not handle `~user` (other-user)
 * expansion.
 */
export function expandHomePath(value: string): string {
  if (!value) return value;
  if (value === "~") return NodeOS.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(NodeOS.homedir(), value.slice(2));
  }
  return value;
}

/**
 * Resolve a user-supplied provider home directory to an absolute path.
 *
 * Expands a leading `~`, then anchors anything still relative to the user's
 * home rather than the server's working directory. Someone typing
 * `.claude-alt` in settings means the directory beside their other dotfiles;
 * resolving that against the cwd points the same account at a different place
 * depending on how Pylon was started — the dev server, the packaged app, a
 * relaunch from elsewhere — and the provider CLI then creates an empty config
 * directory there rather than failing, so the account simply looks signed out.
 */
export function resolveProviderHomePath(value: string): string {
  const expanded = expandHomePath(value.trim());
  return NodePath.isAbsolute(expanded)
    ? NodePath.resolve(expanded)
    : NodePath.resolve(NodeOS.homedir(), expanded);
}

/**
 * Same expansion as `expandHomePath`, but joins with a caller-supplied
 * `Path.Path` service instead of `node:path`. Use this inside Effect code that
 * already has `Path.Path` in context so the platform layer stays in control of
 * separator handling.
 */
export function expandHomePathWith(value: string, path: Path.Path): string {
  if (value === "~") {
    return NodeOS.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), value.slice(2));
  }
  return value;
}
