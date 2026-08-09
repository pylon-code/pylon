// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const PRIME_AGENT_SESSION_IDENTITY_FILENAME = ".pylon-prime-session.json";
export const PRIME_AGENT_SESSION_IDENTITY_TEMP_FILENAME = ".pylon-prime-session.json.tmp";

const PrimeAgentSessionIdentity = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.String,
  sessionFileName: Schema.String,
});
const decodeIdentity = Schema.decodeUnknownOption(PrimeAgentSessionIdentity);

export interface PrimeAgentPrivateSessionIdentity {
  readonly sessionId: string;
  readonly sessionPath: string;
}

function isSessionId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isDirectSessionFileName(value: string): boolean {
  return (
    value.length > ".jsonl".length && value.endsWith(".jsonl") && NodePath.basename(value) === value
  );
}

export function primeAgentSessionFileName(
  sessionDir: string,
  sessionFile: string,
): string | undefined {
  const resolvedDir = NodePath.resolve(sessionDir);
  const resolvedFile = NodePath.resolve(sessionFile);
  const relative = NodePath.relative(resolvedDir, resolvedFile);
  return isDirectSessionFileName(relative) ? relative : undefined;
}

export function encodePrimeAgentSessionIdentity(
  sessionDir: string,
  sessionId: string,
  sessionFile: string,
): string | undefined {
  const normalizedSessionId = sessionId.trim();
  const sessionFileName = primeAgentSessionFileName(sessionDir, sessionFile);
  return !isSessionId(normalizedSessionId) || sessionFileName === undefined
    ? undefined
    : `${JSON.stringify({ schemaVersion: 1, sessionId: normalizedSessionId, sessionFileName })}
`;
}

export function decodePrimeAgentSessionIdentity(
  sessionDir: string,
  source: string,
): PrimeAgentPrivateSessionIdentity | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return undefined;
  }
  const identity = decodeIdentity(raw);
  if (
    Option.isNone(identity) ||
    !isSessionId(identity.value.sessionId) ||
    !isDirectSessionFileName(identity.value.sessionFileName)
  ) {
    return undefined;
  }
  return {
    sessionId: identity.value.sessionId,
    sessionPath: NodePath.join(NodePath.resolve(sessionDir), identity.value.sessionFileName),
  };
}

export function primeAgentLegacySessionFileNames(
  entries: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return entries.filter(isDirectSessionFileName).toSorted();
}
