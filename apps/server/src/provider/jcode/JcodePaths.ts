// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

/**
 * Private on-disk layout for launched Jcode instances.
 *
 * Instance and thread IDs arrive from the wire, so they are never used as path
 * text. Each becomes one opaque base64url segment, which keeps a hostile ID
 * from escaping the namespace, colliding with a sibling, or creating nested
 * user-controlled directories. The encoding is the same rule Prime proved, kept
 * local so the two providers stay independent.
 */
function safePathSegment(value: string): string {
  return `b64-${Buffer.from(value, "utf8").toString("base64url")}`;
}

type Join = (...segments: ReadonlyArray<string>) => string;

const defaultJoin: Join = (...segments) => NodePath.join(...segments);

export interface JcodeInstancePathInput {
  readonly stateDir: string;
  readonly instanceId: string;
  /** Supplied by Effect `Path` consumers so platform separators stay correct. */
  readonly join?: Join;
}

export interface JcodeThreadPathInput extends JcodeInstancePathInput {
  readonly threadId: string;
}

/** `<stateDir>/provider-sessions/jcode/<encoded-instance-id>` */
export function jcodeProviderRoot(input: JcodeInstancePathInput): string {
  return (input.join ?? defaultJoin)(
    input.stateDir,
    "provider-sessions",
    "jcode",
    safePathSegment(input.instanceId),
  );
}

/** `<instance root>/home` — the instance's private `JCODE_HOME`. */
export function jcodeHomePath(input: JcodeInstancePathInput): string {
  return (input.join ?? defaultJoin)(jcodeProviderRoot(input), "home");
}

/** `<instance root>/threads/<encoded-thread-id>.json` — the identity sidecar. */
export function jcodeThreadIdentityPath(input: JcodeThreadPathInput): string {
  return (input.join ?? defaultJoin)(
    jcodeProviderRoot(input),
    "threads",
    `${safePathSegment(input.threadId)}.json`,
  );
}

/**
 * The longest path a Unix domain socket can be bound to.
 *
 * `sockaddr_un.sun_path` is 104 bytes on macOS (108 on Linux) and holds a
 * NUL-terminated string, so 103 is the longest usable path on the tighter of
 * the two. Measured against the real runtime rather than assumed: a home 82
 * characters long binds and one 83 characters long does not.
 */
export const JCODE_MAX_UNIX_SOCKET_PATH = 103;

/**
 * The longest file the SDK's daemon binds under `<home>/run`.
 *
 * The debug socket is longer than `jcode.sock` and `jcode-api.sock`, so it is
 * the one that decides whether a home is usable. When it cannot be bound the
 * daemon exits before signalling ready, the bridge carries on assuming an
 * already-running server, and every request fails with an opaque `EPIPE`.
 */
const LONGEST_RUNTIME_SOCKET = "jcode-debug.sock";

export interface JcodeLaunchHomeInput {
  readonly launchHome: string;
  readonly join?: Join;
}

/** `<launch home>/run/jcode-debug.sock` — the path that has to fit. */
export function jcodeLongestRuntimeSocketPath(input: JcodeLaunchHomeInput): string {
  return (input.join ?? defaultJoin)(input.launchHome, "run", LONGEST_RUNTIME_SOCKET);
}

/** Whether a daemon launched from this home can bind all of its sockets. */
export function jcodeLaunchHomeFitsUnixLimit(input: JcodeLaunchHomeInput): boolean {
  return (
    Buffer.byteLength(jcodeLongestRuntimeSocketPath(input), "utf8") <= JCODE_MAX_UNIX_SOCKET_PATH
  );
}

export interface JcodeLaunchAliasInput extends JcodeInstancePathInput {
  readonly aliasBase: string;
}

/**
 * `<alias base>/<16 hex>` — the short path the SDK is actually launched from.
 *
 * The durable home lives under the state directory, whose depth is chosen by
 * the user and routinely exceeds the socket limit on its own. Rather than
 * shortening durable state (which would move it out of the provider namespace
 * and strand existing instances), the daemon is launched from a bounded alias
 * that resolves to the durable home, so the bind path stops depending on how
 * deep the state directory is.
 *
 * The name is a digest of the state directory and instance ID together: stable
 * across restarts so a resumed instance finds its own home, distinct per
 * environment so two Pylon environments sharing an instance ID cannot collide,
 * and one opaque segment so a wire-supplied ID never becomes path text.
 */
export function jcodeLaunchAliasPath(input: JcodeLaunchAliasInput): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(input.stateDir, "utf8")
    .update("\0")
    .update(input.instanceId, "utf8")
    .digest("hex")
    .slice(0, 16);
  return (input.join ?? defaultJoin)(input.aliasBase, digest);
}

/**
 * `/tmp/pylon-jcode-<uid>` — where aliases live on Unix.
 *
 * Deliberately not the platform temp directory: on macOS that is a ~49
 * character per-user path, which spends half the budget this exists to
 * protect. `/tmp` is short and present on every supported Unix. It is also
 * world-writable, so the caller must verify ownership and mode before trusting
 * the directory; the per-uid suffix keeps two accounts on one machine from
 * contending for the same name.
 */
export function jcodeDefaultLaunchAliasBase(input: {
  readonly uid: number;
  readonly join?: Join;
}): string {
  return (input.join ?? defaultJoin)("/tmp", `pylon-jcode-${input.uid}`);
}
