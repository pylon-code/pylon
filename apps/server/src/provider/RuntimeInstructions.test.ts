import { describe, expect, it } from "vite-plus/test";
import { buildCodexThreadInstructions } from "./CodexDeveloperInstructions.ts";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it.each(["Codex", "Claude Code", "Cursor", "Grok", "OpenCode", "Antigravity"])(
    "identifies the %s harness and describes media embedding",
    (harness) => {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain(`running in Pylon through the ${harness} harness.`);
      expect(instructions).toContain("embed images and videos");
      expect(instructions).toContain("Markdown with absolute file paths");
      expect(instructions).not.toContain("undefined");
      expect(instructions).not.toMatch(
        /pylon_pair|pylon_delegation|pair_handoff|read_delegation_skill/,
      );
      expect(instructions).not.toContain("instead of using your own subagents");
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

  it("describes the collaborative browser only when preview tools are available", () => {
    expect(buildRuntimeInstructions({ harness: "Antigravity" })).not.toContain("<pylon_browser>");
    expect(
      buildRuntimeInstructions({ harness: "Claude Code", browserAvailable: false }),
    ).not.toContain("preview_status");

    const instructions = buildRuntimeInstructions({
      harness: "Antigravity",
      browserAvailable: true,
    });
    expect(instructions).toContain("<pylon_browser>");
    expect(instructions).toContain("Pylon collaborative browser");
    expect(instructions).toContain("preview_status");
    expect(instructions).toContain("preview_open");
    expect(instructions).toContain("Do not switch to global browser skills");
  });

  it("describes device tools only when device tools are available", () => {
    expect(buildRuntimeInstructions({ harness: "Cursor" })).not.toContain("<pylon_devices>");
    expect(buildRuntimeInstructions({ harness: "Cursor", deviceAvailable: false })).not.toContain(
      "device_list",
    );

    const instructions = buildRuntimeInstructions({
      harness: "Cursor",
      deviceAvailable: true,
    });
    expect(instructions).toContain("<pylon_devices>");
    expect(instructions).toContain("device_list");
    expect(instructions).toContain("device_open");
    expect(instructions).toContain("agent-device");
  });
});

describe("the instructions a Codex thread starts with", () => {
  it("are Pylon's own, for the tools this session has, without Codex's mode template", () => {
    expect(buildCodexThreadInstructions({ browser: true, device: false })).toBe(
      buildRuntimeInstructions({
        harness: "Codex",
        browserAvailable: true,
        deviceAvailable: false,
      }),
    );
    const none = buildCodexThreadInstructions(false);
    expect(none).toContain("running in Pylon through the Codex harness");
    expect(none).not.toContain("<pylon_browser>");
    expect(none).not.toContain("<pylon_pair>");
  });
});

it("asks Antigravity for progress narration and concise task summaries", () => {
  const instructions = buildRuntimeInstructions({ harness: "Antigravity" });
  expect(instructions).toContain("<pylon_progress>");
  expect(instructions).toMatch(/before.*tool/i);
  expect(instructions).toMatch(/progress/i);
  expect(instructions).toMatch(/raw.*(?:output|logs)/i);
  expect(buildRuntimeInstructions({ harness: "Codex" })).not.toContain("<pylon_progress>");
});
