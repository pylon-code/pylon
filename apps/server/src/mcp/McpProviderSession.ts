import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ProviderRuntimeFence } from "../provider/ProviderDriver.ts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();
const generationsByThread = new Map<ThreadId, object>();

export function setMcpProviderSession(
  config: McpProviderSessionConfig,
  runtimeFence?: ProviderRuntimeFence,
): void {
  sessionsByThread.set(config.threadId, config);
  if (runtimeFence === undefined) generationsByThread.delete(config.threadId);
  else generationsByThread.set(config.threadId, runtimeFence.generation);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function isMcpProviderSessionOwnedByGeneration(
  threadId: ThreadId,
  runtimeFence: ProviderRuntimeFence,
): boolean {
  return generationsByThread.get(threadId) === runtimeFence.generation;
}

export function clearMcpProviderSession(
  threadId: ThreadId,
  runtimeFence?: ProviderRuntimeFence,
): boolean {
  if (runtimeFence !== undefined && generationsByThread.get(threadId) !== runtimeFence.generation) {
    return false;
  }
  generationsByThread.delete(threadId);
  return sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
  generationsByThread.clear();
}
