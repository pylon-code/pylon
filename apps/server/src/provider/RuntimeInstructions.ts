const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

/**
 * Included only when the session's MCP credential grants delegation, so it never
 * describes tools the agent does not have. It carries no default model name:
 * the server resolves the user's defaults when the tool runs, so the text cannot
 * go stale when settings change mid-session.
 */
const DELEGATION_INSTRUCTIONS = `<pylon_delegation>
Keep small or tightly coupled work local. Before choosing a delegation method for worthwhile independent work, call the t3-code MCP tool read_delegation_skill to read the current project preference and workflow. It does not start a child. The default is built-in subagents; a saved Pylon preference permits Pylon child threads without a separate request each time. Explicit user instructions override the preference. Availability alone is not a request to delegate, and missing built-in agents do not justify an automatic Pylon fallback. Follow the skill when using delegate_thread and managing results.
</pylon_delegation>`;

/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** Whether this session's MCP credential grants the delegation tools. */
  readonly delegationAvailable?: boolean | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in Pylon through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}${
    runtime.delegationAvailable === true ? `\n\n${DELEGATION_INSTRUCTIONS}` : ""
  }`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
