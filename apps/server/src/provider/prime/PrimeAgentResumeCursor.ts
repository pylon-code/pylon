import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const PrimeAgentAcpResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("prime-agent-cli-continue"),
  continue: Schema.Literal(true),
});
export type PrimeAgentAcpResumeCursor = typeof PrimeAgentAcpResumeCursor.Type;

export const PrimeAgentDaemonResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  kind: Schema.Literal("prime-agent-daemon-continue"),
  continue: Schema.Literal(true),
});
export type PrimeAgentDaemonResumeCursor = typeof PrimeAgentDaemonResumeCursor.Type;

export const PRIME_AGENT_ACP_RESUME_CURSOR: PrimeAgentAcpResumeCursor = {
  schemaVersion: 1,
  kind: "prime-agent-cli-continue",
  continue: true,
};

export const PRIME_AGENT_DAEMON_RESUME_CURSOR: PrimeAgentDaemonResumeCursor = {
  schemaVersion: 2,
  kind: "prime-agent-daemon-continue",
  continue: true,
};

const CompatibleResumeCursor = Schema.Union([
  PrimeAgentAcpResumeCursor,
  PrimeAgentDaemonResumeCursor,
]);
const decodeCompatibleResumeCursor = Schema.decodeUnknownOption(CompatibleResumeCursor);

/** Both backends share one deterministic session directory, so either opaque marker can continue. */
export function isPrimeAgentCompatibleResumeCursor(raw: unknown): boolean {
  return Option.isSome(decodeCompatibleResumeCursor(raw));
}
