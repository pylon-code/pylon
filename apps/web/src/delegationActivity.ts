import type { WorkLogEntry } from "./session-logic";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resultThreadId(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === "string") {
    try {
      return resultThreadId(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  const data = record(value);
  if (!data) return null;
  if (typeof data.threadId === "string") return data.threadId;
  const structured = resultThreadId(data.structuredContent, depth + 1);
  if (structured) return structured;
  if (typeof data.content === "string") return resultThreadId(data.content, depth + 1);
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      const item = record(block);
      if (item?.type !== "text") continue;
      const id = resultThreadId(item.text, depth + 1);
      if (id) return id;
    }
  }
  return null;
}

/** Only structured MCP identity counts; prose mentioning delegation is not a wait. */
export function delegationActivity(entry: WorkLogEntry) {
  const data = record(entry.toolData);
  const raw = data?.toolName ?? data?.tool ?? data?.name;
  if (typeof raw !== "string") return null;
  const qualified = /^(?:mcp__(?:t3_code|t3-code)__|t3-code[./])/.test(raw);
  if (!qualified && data?.server !== "t3-code" && data?.server !== "t3_code") return null;
  const name = raw.replace(/^(?:mcp__(?:t3_code|t3-code)__|t3-code[./])/, "");
  if (name !== "delegate_thread" && name !== "delegated_thread_status") return null;
  let input = data?.input ?? data?.arguments;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      input = null;
    }
  }
  const args = record(input);
  return {
    name,
    threadId: resultThreadId(data?.result ?? data?.output),
    title: typeof args?.title === "string" ? args.title : null,
    waiting:
      name === "delegated_thread_status" &&
      entry.toolLifecycleStatus === "inProgress" &&
      typeof args?.waitSeconds === "number" &&
      args.waitSeconds > 0,
  };
}
