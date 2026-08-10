// @effect-diagnostics nodeBuiltinImport:off
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
