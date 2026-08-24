/**
 * A Pylon-owned Prime Agent process is always a top-level runtime, even when
 * Pylon itself was launched from an existing Prime Agent session.
 */
export function sanitizePrimeAgentTopLevelEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !name.startsWith("PRIME_AGENT_INTERNAL_") && name !== "RLM_DEPTH",
    ),
  );
}
