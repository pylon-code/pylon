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
The t3-code MCP server exposes delegation tools: delegate_thread, delegated_thread_status, delegated_thread_result, send_to_delegated_thread, and interrupt_delegated_thread. Delegation starts a separate Pylon thread, visible to the user, on another provider in its own git worktree.
Keep small or tightly coupled work local. For worthwhile bounded parallel work, prefer your own built-in subagents when available. Use Pylon delegation only when the user explicitly asks for a separate Pylon thread or work on another provider, model, or account. Enabling delegation is not a request to use it. Never fall back to Pylon delegation merely because built-in subagents are unavailable.
If the user names no provider or model, omit providerInstanceId and model: Pylon applies the user's default delegation model, and a new child's result shows what was used in defaultApplied. If the user names one, pass exactly that. If the tool reports that no default is set, ask the user which provider to use; never pick a provider yourself.
Do not pass runtimeMode unless the user asks for a permission mode. Pylon applies the user's child permission setting, and a child never gets broader permissions than you. Children cannot delegate further, and each child uses its own provider's quota.
Give each child one bounded task with relevant file references, acceptance criteria, and a concise final report of changes, checks, and unresolved issues. Avoid copying the full conversation or duplicating the child's work. delegate_thread returns immediately. Do independent work before checking status; when waiting is necessary, use delegated_thread_status with waitSeconds 45. Pylon does not automatically wake you when a child finishes. Avoid short polling, unchanged progress updates, and repeatedly inspecting unfinished files. Read delegated_thread_result at completion; if truncated, request a larger maxChars before accepting the work. At the 60000-character limit, inspect the child thread or ask for a concise handoff. Review the completed diff and checks, then send consolidated corrections. Never report delegated work as done without reading its result.
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
