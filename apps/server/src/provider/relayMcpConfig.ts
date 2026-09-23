// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

/** The environment server opts in to its own local Relay CLI installation. */
export function relayCliFromEnvironment(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.PYLON_RELAY_CLI;
  return value && NodePath.isAbsolute(value) ? value : undefined;
}

export function relayCodexAppServerArgs(cliPath: string): ReadonlyArray<string> {
  return [
    "-c",
    `mcp_servers.relay.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.relay.args=${JSON.stringify([cliPath, "mcp"])}`,
    "-c",
    "mcp_servers.relay.tool_timeout_sec=180.0",
  ];
}
