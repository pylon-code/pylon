// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * The private per-thread record that lets a launched Jcode instance continue a
 * native session.
 *
 * Only the two fields below are ever persisted. A socket path, `JCODE_HOME`,
 * credential, model, capability list, or event payload written here would turn a
 * resume record into a durable leak of native state, so encoding drops unknown
 * input and decoding rejects any sidecar that carries extra keys. Reads treat a
 * missing or unreadable sidecar as absent: a corrupt file must degrade to "no
 * session to continue", never to a partially trusted identity.
 */
const JcodeSessionIdentitySchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.String,
  workingDir: Schema.String,
});

const decodeIdentity = Schema.decodeUnknownOption(JcodeSessionIdentitySchema);

const EXPECTED_KEYS = ["schemaVersion", "sessionId", "workingDir"] as const;

const MAX_SESSION_ID_LENGTH = 256;
const MAX_WORKING_DIR_LENGTH = 4096;

export class JcodeSessionIdentityError extends Data.TaggedError("JcodeSessionIdentityError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface JcodePrivateSessionIdentity {
  readonly sessionId: string;
  readonly workingDir: string;
}

function isSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SESSION_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isWorkingDir(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_WORKING_DIR_LENGTH &&
    !value.includes("\u0000") &&
    NodePath.isAbsolute(value)
  );
}

export function encodeJcodeSessionIdentity(input: JcodePrivateSessionIdentity): string | undefined {
  const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : undefined;
  if (!isSessionId(sessionId) || !isWorkingDir(input.workingDir)) return undefined;
  return `${JSON.stringify({ schemaVersion: 1, sessionId, workingDir: input.workingDir })}\n`;
}

export function decodeJcodeSessionIdentity(
  source: string,
): JcodePrivateSessionIdentity | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const keys = Object.keys(raw).toSorted();
  if (
    keys.length !== EXPECTED_KEYS.length ||
    keys.some((key, index) => key !== EXPECTED_KEYS[index])
  ) {
    return undefined;
  }
  const identity = decodeIdentity(raw);
  if (
    Option.isNone(identity) ||
    !isSessionId(identity.value.sessionId) ||
    !isWorkingDir(identity.value.workingDir)
  ) {
    return undefined;
  }
  return { sessionId: identity.value.sessionId, workingDir: identity.value.workingDir };
}

/**
 * Writes the sidecar through a uniquely named temp file in the destination
 * directory followed by `rename`, so a reader only ever observes a complete
 * record and concurrent writers converge on one of their own payloads instead of
 * interleaving. Temp residue is removed even when the write fails, and a
 * rejected identity never touches the existing file.
 */
export const writeJcodeSessionIdentity = (input: {
  readonly filePath: string;
  readonly sessionId: string;
  readonly workingDir: string;
}) =>
  Effect.gen(function* () {
    const contents = encodeJcodeSessionIdentity(input);
    if (contents === undefined) {
      return yield* new JcodeSessionIdentityError({
        detail: "Refused to persist an out-of-bounds Jcode session identity.",
      });
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.dirname(input.filePath);

    yield* fs.makeDirectory(directory, { recursive: true }).pipe(
      Effect.andThen(fs.chmod(directory, 0o700)),
      Effect.mapError(
        (cause) =>
          new JcodeSessionIdentityError({
            detail: "Failed to prepare the private Jcode identity directory.",
            cause,
          }),
      ),
    );

    // A per-write unique sibling keeps concurrent writers from sharing a temp
    // file, so each `rename` publishes one complete record and the last writer
    // wins instead of two payloads interleaving in the destination.
    const tempPath = `${input.filePath}.${NodeCrypto.randomUUID()}.tmp`;
    yield* fs.writeFileString(tempPath, contents).pipe(
      Effect.andThen(fs.chmod(tempPath, 0o600)),
      Effect.andThen(fs.rename(tempPath, input.filePath)),
      // The rename consumes the temp path on success; cleanup only matters on failure.
      Effect.catch((cause) =>
        fs.remove(tempPath).pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.fail(
              new JcodeSessionIdentityError({
                detail: "Failed to persist the private Jcode session identity.",
                cause,
              }),
            ),
          ),
        ),
      ),
    );
  });

export const readJcodeSessionIdentity = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(filePath).pipe(Effect.option);
    return Option.isNone(source) ? undefined : decodeJcodeSessionIdentity(source.value);
  });
