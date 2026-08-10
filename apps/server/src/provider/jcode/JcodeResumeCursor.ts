import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The only resume marker Jcode ever puts on the wire.
 *
 * Native session identity lives in a private sidecar on disk, never in a
 * client-visible cursor. The marker is therefore constant and carries no
 * payload: a cursor that grew a session ID, socket, home path, credential, or
 * event data would leak native state into projections, so decoding is exact and
 * fail-closed rather than tolerant.
 */
export const JCODE_RESUME_CURSOR = {
  schemaVersion: 1,
  kind: "jcode-private-session",
  continue: true,
} as const;

export type JcodeResumeCursor = typeof JCODE_RESUME_CURSOR;

const JcodeResumeCursorSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("jcode-private-session"),
  continue: Schema.Literal(true),
});

const decodeCursor = Schema.decodeUnknownOption(JcodeResumeCursorSchema);

const EXPECTED_KEYS = ["continue", "kind", "schemaVersion"] as const;

/** Produces the marker to hand back to callers; there is only ever one value. */
export function encodeJcodeResumeCursor(): JcodeResumeCursor {
  return JCODE_RESUME_CURSOR;
}

export function isJcodeResumeCursor(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const keys = Object.keys(raw).toSorted();
  if (
    keys.length !== EXPECTED_KEYS.length ||
    keys.some((key, index) => key !== EXPECTED_KEYS[index])
  ) {
    return false;
  }
  return Option.isSome(decodeCursor(raw));
}

export function decodeJcodeResumeCursor(raw: unknown): JcodeResumeCursor | undefined {
  return isJcodeResumeCursor(raw) ? JCODE_RESUME_CURSOR : undefined;
}
