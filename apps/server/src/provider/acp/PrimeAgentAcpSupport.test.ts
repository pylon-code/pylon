// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  buildPrimeAgentAcpSpawnInput,
  isPrimeAgentAcpPrivateThoughtUpdate,
  makePrimeAgentEnvironment,
  parsePrimeAgentAcpTerminalUpdate,
  primeAgentLaunchArgsIssue,
  PRIME_AGENT_ACP_META_NAMESPACE,
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
    expect(spawn.extendEnv).toBe(false);
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

  it("identifies only Prime ACP private thought updates for boundary discard", () => {
    const thought = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk" as const,
        content: { type: "text" as const, text: "private chain of thought" },
      },
    };
    const answer = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk" as const,
        content: { type: "text" as const, text: "public answer" },
      },
    };

    expect(isPrimeAgentAcpPrivateThoughtUpdate(thought)).toBe(true);
    expect(isPrimeAgentAcpPrivateThoughtUpdate(answer)).toBe(false);
  });

  it("accepts only correlated terminal-quiescence metadata with a settled child roster", () => {
    const notification = (metadata: Readonly<Record<string, unknown>>) => ({
      sessionId: "session-1",
      update: {
        sessionUpdate: "session_info_update",
        _meta: { [PRIME_AGENT_ACP_META_NAMESPACE]: metadata },
      },
    });

    expect(
      parsePrimeAgentAcpTerminalUpdate(
        notification({
          promptTurnId: 3,
          eventSequence: 8,
          phase: "responseBoundary",
          outcome: "result",
          terminalQuiescenceExpected: true,
        }),
      ),
    ).toEqual({
      promptTurnId: 3,
      eventSequence: 8,
      phase: "responseBoundary",
      outcome: "result",
      terminalQuiescenceExpected: true,
    });
    expect(
      parsePrimeAgentAcpTerminalUpdate(
        notification({
          promptTurnId: 3,
          eventSequence: 9,
          phase: "terminalQuiescence",
          outcome: "error",
          quiescence: { outstandingSubagents: 0, remainingAutonomousContinuations: 1 },
        }),
      ),
    ).toEqual({
      promptTurnId: 3,
      eventSequence: 9,
      phase: "terminalQuiescence",
      outcome: "error",
      outstandingSubagents: 0,
      remainingAutonomousContinuations: 1,
    });
    expect(
      parsePrimeAgentAcpTerminalUpdate(
        notification({
          promptTurnId: 3,
          eventSequence: 9,
          phase: "terminalQuiescence",
          outcome: "result",
          quiescence: { outstandingSubagents: 1, remainingAutonomousContinuations: 0 },
        }),
      ),
    ).toEqual({ phase: "invalid" });
    expect(
      parsePrimeAgentAcpTerminalUpdate(
        notification({
          promptTurnId: 3,
          eventSequence: 8,
          phase: "responseBoundary",
          outcome: "result",
        }),
      ),
    ).toEqual({ phase: "invalid" });
    expect(parsePrimeAgentAcpTerminalUpdate({ private: "payload" })).toBeUndefined();
  });

  it("maps agentHomePath to Prime Agent's documented home environment", () => {
    const environment = makePrimeAgentEnvironment(
      { agentHomePath: "~/.prime/pylon-work" },
      {
        PATH: "/bin",
        PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
        PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "secret",
        RLM_DEPTH: "2",
        RLM_MAX_DEPTH: "4",
      },
    );
    expect(environment).toEqual({
      PATH: "/bin",
      RLM_MAX_DEPTH: "4",
      [PRIME_AGENT_HOME_ENV]: NodePath.join(NodeOS.homedir(), ".prime/pylon-work"),
    });
  });
});
