#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
const args = process.argv.slice(2);
const mcpConfigIndex = args.indexOf("--mcp-config");
const rawMcpConfig = mcpConfigIndex >= 0 ? args[mcpConfigIndex + 1] : undefined;
let mcpConfig;
if (rawMcpConfig) {
  const contents = NodeFS.existsSync(rawMcpConfig)
    ? NodeFS.readFileSync(rawMcpConfig, "utf8")
    : rawMcpConfig;
  try {
    mcpConfig = JSON.parse(contents);
  } catch {
    mcpConfig = contents;
  }
}
NodeFS.writeFileSync(
  process.env.T3_PROBE_INVOCATION_PATH,
  JSON.stringify({
    args,
    cwd: process.cwd(),
    connectorEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,
    mcpConfig,
  }),
);
// Only stdin keeps this process alive, so it exits with its parent.
const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;
  process.stdout.write(
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],
          agents: [],
          output_style: "default",
          available_output_styles: ["default"],
          models: [],
          account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
        },
      },
    }) + "\n",
  );
});
