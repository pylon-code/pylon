export const PRIME_AGENT_FINISHED_WITHOUT_FINAL_RESPONSE =
  "Prime Agent finished without sending a final response.";
export const PRIME_AGENT_STOPPED_WITHOUT_FINAL_RESPONSE =
  "Prime Agent stopped before sending a final response.";
export const PRIME_AGENT_TURN_FAILED = "Prime Agent turn failed.";

export const primeAgentMissingFinalResponseDetail = (outcome: "completed" | "failed") => ({
  kind: "missing-final-response" as const,
  outcome,
});
