import { describe, expect, it } from "vite-plus/test";
import { buildCodexThreadInstructions } from "./CodexDeveloperInstructions.ts";
import { PAIR_LEAD_PROTOCOL, buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it.each(["Codex", "Claude Code", "Cursor", "Grok", "OpenCode", "Antigravity"])(
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
    expect(instructions).toContain("read_delegation_skill");
    expect(instructions).toContain("current project preference");
    expect(instructions).toContain("default is built-in subagents");
    expect(instructions).toContain("Explicit user instructions override");
    expect(instructions).not.toContain("waitSeconds 45");
  });

  it("gives a paired lead the pair protocol instead of the delegation block", () => {
    const paired = buildRuntimeInstructions({
      harness: "Claude Code",
      delegationAvailable: true,
      pairActive: true,
    });
    expect(paired).toContain("<pylon_pair>");
    expect(paired).toContain(PAIR_LEAD_PROTOCOL);
    expect(paired).not.toContain("<pylon_delegation>");

    const unpaired = buildRuntimeInstructions({
      harness: "Claude Code",
      delegationAvailable: true,
      pairActive: false,
    });
    expect(unpaired).not.toContain("<pylon_pair>");
    expect(unpaired).toContain("<pylon_delegation>");
    // Nothing of the pair exists for a thread that is not paired.
    expect(buildRuntimeInstructions({ harness: "Codex" })).not.toContain("pair_");
  });

  it("states the rules a lead must not get wrong", () => {
    for (const rule of [
      "Work test-first",
      "fail for the right reason",
      "protectedPaths",
      "without editing them",
      "code only",
      "pair_handoff",
      "pair_await",
      "Never poll in a loop",
      "confirm your tests are unchanged",
      "re-run the checks yourself",
      "not verification",
      "Only you push and open pull requests",
      "never approve on their behalf",
    ]) {
      expect(PAIR_LEAD_PROTOCOL).toContain(rule);
    }
  });

  it("tells a paired lead how to give the executor a fresh start", () => {
    for (const rule of ["pair_reset", "remembers nothing"]) {
      expect(PAIR_LEAD_PROTOCOL).toContain(rule);
    }
  });

  it("tells a paired lead that delegating means briefing its executor", () => {
    // A user who says "use delegation" on a paired thread means the executor.
    for (const rule of ["delegate_thread", "delegate", "means brief your executor"]) {
      expect(PAIR_LEAD_PROTOCOL).toContain(rule);
    }
  });

  it("points the lead at Pylon's pair tools and away from its harness's own agents", () => {
    // Codex keeps its collaboration tools whatever feature flags say, and a lead
    // told to "brief the executor" reaches for them unless the protocol is explicit.
    for (const rule of [
      "t3-code MCP server",
      "search your tools for pair_handoff",
      "spawn_agent",
      "collaboration",
      "is not your executor",
    ]) {
      expect(PAIR_LEAD_PROTOCOL).toContain(rule);
    }
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
    expect(buildCodexThreadInstructions({ browser: true, device: false, pair: true })).toBe(
      buildRuntimeInstructions({
        harness: "Codex",
        browserAvailable: true,
        deviceAvailable: false,
        delegationAvailable: false,
        pairActive: true,
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
