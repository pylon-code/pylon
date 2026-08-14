import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const PrimeAgentAcpResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("prime-agent-cli-continue"),
  continue: Schema.Literal(true),
});
export type PrimeAgentAcpResumeCursor = typeof PrimeAgentAcpResumeCursor.Type;

const PrimeAgentLegacyDaemonResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  kind: Schema.Literal("prime-agent-daemon-continue"),
  continue: Schema.Literal(true),
});

export const PrimeAgentDaemonResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  kind: Schema.Literal("prime-agent-daemon-session"),
  continue: Schema.Literal(true),
});
export type PrimeAgentDaemonResumeCursor = typeof PrimeAgentDaemonResumeCursor.Type;

export const PRIME_AGENT_ACP_RESUME_CURSOR: PrimeAgentAcpResumeCursor = {
  schemaVersion: 1,
  kind: "prime-agent-cli-continue",
  continue: true,
};

export const PRIME_AGENT_DAEMON_RESUME_CURSOR: PrimeAgentDaemonResumeCursor = {
  schemaVersion: 3,
  kind: "prime-agent-daemon-session",
  continue: true,
};

const CompatibleResumeCursor = Schema.Union([
  PrimeAgentAcpResumeCursor,
  PrimeAgentLegacyDaemonResumeCursor,
  PrimeAgentDaemonResumeCursor,
]);
const decodeCompatibleResumeCursor = Schema.decodeUnknownOption(CompatibleResumeCursor);

/** Native identity remains in a private sidecar; client-visible cursors contain only a marker. */
export function isPrimeAgentCompatibleResumeCursor(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const keys = Object.keys(raw);
  if (
    keys.length !== 3 ||
    !keys.includes("schemaVersion") ||
    !keys.includes("kind") ||
    !keys.includes("continue")
  ) {
    return false;
  }
  return Option.isSome(decodeCompatibleResumeCursor(raw));
}
