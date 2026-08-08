// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  buildPrimeAgentAcpSpawnInput,
  makePrimeAgentEnvironment,
  primeAgentLaunchArgsIssue,
  PRIME_AGENT_HOME_ENV,
} from "./PrimeAgentAcpSupport.ts";

const settings = {
  binaryPath: "prime-agent-custom",
  agentHomePath: "",
  launchArgs: "--verbose --theme 'Pylon Dark'",
};

describe("PrimeAgentAcpSupport", () => {
  it("builds the enforced offline ACP launch after custom arguments", () => {
    const spawn = buildPrimeAgentAcpSpawnInput({
      settings,
      cwd: "/workspace",
      sessionDir: "/state/prime/thread",
      continueSession: false,
      model: "openai/gpt-5.4",
      environment: { PATH: "/bin" },
    });

    expect(spawn.command).toBe("prime-agent-custom");
    expect(spawn.cwd).toBe("/workspace");
    expect(spawn.args).toEqual([
      "--verbose",
      "--theme",
      "Pylon Dark",
      "--mode",
      "acp",
      "--offline",
      "--cwd",
      "/workspace",
      "--session-dir",
      "/state/prime/thread",
      "--model",
      "openai/gpt-5.4",
    ]);
  });

  it("omits the synthetic default model and adds continue only for a resume marker", () => {
    const spawn = buildPrimeAgentAcpSpawnInput({
      settings: { ...settings, launchArgs: "" },
      cwd: "/workspace",
      sessionDir: "/state/prime/thread",
      continueSession: true,
      model: "default",
    });

    expect(spawn.args).toContain("--continue");
    expect(spawn.args).not.toContain("--model");
    expect(spawn.args).not.toContain("session/load");
  });

  it("rejects launch arguments that can override Pylon-owned ACP state", () => {
    for (const launchArgs of [
      "--mode rpc",
      "--cwd=/tmp",
      "--session-dir elsewhere",
      "--continue",
      "-c",
      "--model anthropic/other",
      "--no-session",
      "--offline",
      "-- --mode text",
    ]) {
      expect(primeAgentLaunchArgsIssue(launchArgs)).toContain("Pylon-owned");
    }
    expect(primeAgentLaunchArgsIssue("--thinking high --theme 'Pylon Dark'")).toBeUndefined();
  });

  it("maps agentHomePath to Prime Agent's documented home environment", () => {
    const environment = makePrimeAgentEnvironment(
      { agentHomePath: "~/.prime/pylon-work" },
      { PATH: "/bin" },
    );
    expect(environment).toEqual({
      PATH: "/bin",
      [PRIME_AGENT_HOME_ENV]: NodePath.join(NodeOS.homedir(), ".prime/pylon-work"),
    });
  });
});
