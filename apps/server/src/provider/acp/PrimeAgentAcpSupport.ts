import { type PrimeAgentSettings } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import { resolveProviderHomePath } from "../../pathExpansion.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const PRIME_AGENT_HOME_ENV = "PRIME_AGENT_CODING_AGENT_DIR";

const RESERVED_PRIME_AGENT_LAUNCH_ARGS = [
  "--mode",
  "--offline",
  "--cwd",
  "--session-dir",
  "--continue",
  "-c",
  "--model",
  "--no-session",
] as const;

export function primeAgentLaunchArgsIssue(launchArgs: string | undefined): string | undefined {
  const reserved = tokenizeCliArgs(launchArgs).find(
    (token) =>
      token === "--" ||
      RESERVED_PRIME_AGENT_LAUNCH_ARGS.some(
        (flag) => token === flag || token.startsWith(`${flag}=`),
      ),
  );
  return reserved
    ? `Launch arguments cannot override Pylon-owned Prime Agent flag '${reserved}'.`
    : undefined;
}

export type PrimeAgentAcpSettings = Pick<
  PrimeAgentSettings,
  "binaryPath" | "agentHomePath" | "launchArgs"
>;

export interface PrimeAgentAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "resumeSessionId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly primeAgentSettings: PrimeAgentAcpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly sessionDir: string;
  readonly continueSession: boolean;
  readonly model?: string | undefined;
}

export function makePrimeAgentEnvironment(
  settings: Pick<PrimeAgentSettings, "agentHomePath"> | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const agentHomePath = settings?.agentHomePath.trim();
  return agentHomePath
    ? { ...environment, [PRIME_AGENT_HOME_ENV]: resolveProviderHomePath(agentHomePath) }
    : { ...environment };
}

export function buildPrimeAgentAcpSpawnInput(input: {
  readonly settings: PrimeAgentAcpSettings | null | undefined;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly continueSession: boolean;
  readonly model?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}): AcpSessionRuntime.AcpSpawnInput {
  const model = input.model?.trim();
  const selectedModel = model && model !== "default" ? model : undefined;
  return {
    command: input.settings?.binaryPath.trim() || "prime-agent",
    args: [
      ...tokenizeCliArgs(input.settings?.launchArgs),
      "--mode",
      "acp",
      "--offline",
      "--cwd",
      input.cwd,
      "--session-dir",
      input.sessionDir,
      ...(input.continueSession ? (["--continue"] as const) : []),
      ...(selectedModel ? (["--model", selectedModel] as const) : []),
    ],
    cwd: input.cwd,
    env: makePrimeAgentEnvironment(input.settings, input.environment),
  };
}

export const makePrimeAgentAcpRuntime = (
  input: PrimeAgentAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildPrimeAgentAcpSpawnInput({
          settings: input.primeAgentSettings,
          cwd: input.cwd,
          sessionDir: input.sessionDir,
          continueSession: input.continueSession,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.environment !== undefined ? { environment: input.environment } : {}),
        }),
        // Prime Agent owns persistence through --session-dir/--continue and
        // deliberately advertises loadSession:false. Never pass resumeSessionId.
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });
