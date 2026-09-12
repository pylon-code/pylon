import {
  PREVIEW_RECORDING_STOP_TIMEOUT_MS,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import type { ProviderRuntimeFence } from "../provider/ProviderDriver.ts";

/**
 * Per-call timeout to configure for Pylon's MCP server where a provider accepts one.
 * It outlasts `preview_recording_stop`, the slowest tool, so a provider does not
 * abandon a recording transfer the server is still allowed to finish. Older Codex
 * releases default to 60 or 120 seconds and OpenCode to 60.
 */
export const MCP_PROVIDER_TOOL_TIMEOUT_MS = PREVIEW_RECORDING_STOP_TIMEOUT_MS + 60_000;

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
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
