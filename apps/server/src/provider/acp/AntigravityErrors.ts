/**
 * Utilities for formatting Google Antigravity and Cloud Code upstream errors into
 * clean, actionable user-facing messages.
 */

export function extractAntigravityModelName(text: string): string | undefined {
  const match =
    /model\s+([a-zA-Z0-9._-]+)\s+on the server/i.exec(text) ??
    /\bmodel[:=]\s*["']?([a-zA-Z0-9._-]+)["']?/i.exec(text) ??
    /for model\s+["']?([a-zA-Z0-9._-]+)["']?/i.exec(text);
  return match?.[1];
}

export function isAntigravityCorruptedSessionError(text?: string | null): boolean {
  if (!text || typeof text !== "string") return false;
  return (
    /could not find doneCh for checkpoint/i.test(text) ||
    /reached terminal step type\. Exiting/i.test(text) ||
    /agent executor error:\s*could not find doneCh/i.test(text) ||
    /Antigravity agent executor encountered an internal checkpoint error/i.test(text)
  );
}

export function isAntigravityInternalErrorEnvelope(text?: string | null): boolean {
  if (!text || typeof text !== "string") return false;
  return (
    /^Encountered retryable error from model provider:/i.test(text) ||
    /^Agent execution (?:terminated due to error|error):/i.test(text) ||
    /could not find doneCh for checkpoint/i.test(text) ||
    /reached terminal step type\. Exiting/i.test(text) ||
    /MODEL_CAPACITY_EXHAUSTED/i.test(text) ||
    /No capacity available for model/i.test(text)
  );
}

export function formatAntigravityErrorMessage(raw: string): string {
  if (!raw || typeof raw !== "string") return raw;

  const is503Capacity =
    raw.includes("MODEL_CAPACITY_EXHAUSTED") ||
    /No capacity available for model/i.test(raw) ||
    (raw.includes("503") &&
      (raw.includes("UNAVAILABLE") || /capacity/i.test(raw) || /overloaded/i.test(raw)));

  if (is503Capacity) {
    const model = extractAntigravityModelName(raw);
    const modelTarget = model ? ` for ${model}` : "";
    return `Google Antigravity model capacity exhausted${modelTarget} (503 UNAVAILABLE). The Gemini server is temporarily overloaded; please try again in a moment or switch models.`;
  }

  const is429Quota =
    raw.includes("RESOURCE_EXHAUSTED") ||
    /code\s*429/i.test(raw) ||
    /quota exceeded/i.test(raw) ||
    /rate limit/i.test(raw);

  if (is429Quota) {
    const model = extractAntigravityModelName(raw);
    const modelTarget = model ? ` for ${model}` : "";
    return `Google Antigravity rate limit exceeded${modelTarget} (429 RESOURCE_EXHAUSTED). Please wait a moment before retrying.`;
  }

  if (isAntigravityCorruptedSessionError(raw)) {
    return "Antigravity agent executor encountered an internal checkpoint error. Please retry your message.";
  }

  if (/model unreachable/i.test(raw)) {
    return "Google Antigravity model unreachable. The server is currently unreachable; please check your network connection or try again shortly.";
  }

  // Strip raw nested wrapper prefixes if present so the message is cleaner
  let cleaned = raw;
  const retryablePrefix =
    /^Encountered retryable error from model provider:\s*Agent execution terminated due to error\.\s*\("?([\s\S]*?)"?\)$/;
  const retryableMatch = retryablePrefix.exec(cleaned);
  if (retryableMatch?.[1]) {
    cleaned = retryableMatch[1];
  }
  const agentExecPrefix = /^Agent execution error:\s*/;
  if (agentExecPrefix.test(cleaned)) {
    cleaned = cleaned.replace(agentExecPrefix, "");
  }

  return cleaned;
}
