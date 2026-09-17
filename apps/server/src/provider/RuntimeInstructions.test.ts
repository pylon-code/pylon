import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it.each(["Codex", "Claude Code", "Cursor", "Grok", "OpenCode"])(
    "identifies the %s harness and describes media embedding",
    (harness) => {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain(`running in Pylon through the ${harness} harness.`);
      expect(instructions).toContain("embed images and videos");
      expect(instructions).toContain("Markdown with absolute file paths");
      expect(instructions).not.toContain("undefined");
    },
  );
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });

  it("describes delegation only when the session has the delegation tools", () => {
    expect(buildRuntimeInstructions({ harness: "Claude Code" })).not.toContain("delegate_thread");
    expect(
      buildRuntimeInstructions({ harness: "Claude Code", delegationAvailable: false }),
    ).not.toContain("<pylon_delegation>");
    const instructions = buildRuntimeInstructions({
      harness: "Claude Code",
      delegationAvailable: true,
    });
    expect(instructions).toContain("<pylon_delegation>");
    // When to choose delegation over built-in subagents.
    expect(instructions).toContain("prefer your own built-in subagents");
    expect(instructions).toContain("only when the user explicitly asks");
    expect(instructions).toContain("Never fall back to Pylon delegation");
    expect(instructions).toContain("waitSeconds 45");
    expect(instructions).not.toContain("waitSeconds 20");
    expect(instructions).toContain("if truncated, request a larger maxChars");
    // Defaults apply only when the user names nothing, and are never guessed.
    expect(instructions).toContain("omit providerInstanceId and model");
    expect(instructions).toContain("never pick a provider yourself");
    // Permissions: never broaden, follow the user's child setting.
    expect(instructions).toContain("Do not pass runtimeMode unless the user asks");
    expect(instructions).toContain("never gets broader permissions than you");
    // Review before relying on a child's work.
    expect(instructions).toContain("delegated_thread_result");
  });
});
