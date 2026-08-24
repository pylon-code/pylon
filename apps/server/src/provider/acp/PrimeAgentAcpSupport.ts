import { type PrimeAgentSettings } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveProviderHomePath } from "../../pathExpansion.ts";
import { sanitizePrimeAgentTopLevelEnvironment } from "../prime/PrimeAgentEnvironment.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const PRIME_AGENT_HOME_ENV = "PRIME_AGENT_CODING_AGENT_DIR";
export const PRIME_AGENT_ACP_META_NAMESPACE = "ai.primeintellect.prime-agent";

const primeAgentAcpTerminalNotificationSchema = Schema.Struct({
  sessionId: Schema.String,
  update: Schema.Struct({
    sessionUpdate: Schema.Literal("session_info_update"),
    _meta: Schema.Struct({
      [PRIME_AGENT_ACP_META_NAMESPACE]: Schema.Struct({
        promptTurnId: Schema.Int.check(Schema.isGreaterThan(0)),
        eventSequence: Schema.Int.check(Schema.isGreaterThan(0)),
        phase: Schema.Literals(["responseBoundary", "terminalQuiescence"]),
        outcome: Schema.Literals(["result", "error"]),
        terminalQuiescenceExpected: Schema.optional(Schema.Boolean),
        quiescence: Schema.optional(
          Schema.Struct({
            outstandingSubagents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
            remainingAutonomousContinuations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          }),
        ),
      }),
    }),
  }),
});
const decodePrimeAgentAcpTerminalNotification = Schema.decodeUnknownOption(
  primeAgentAcpTerminalNotificationSchema,
);
const decodePrimeAgentAcpTerminalTarget = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionId: Schema.String,
    update: Schema.Struct({
      sessionUpdate: Schema.Literal("session_info_update"),
      _meta: Schema.Struct({
        [PRIME_AGENT_ACP_META_NAMESPACE]: Schema.Struct({
          phase: Schema.Literals(["responseBoundary", "terminalQuiescence"]),
        }),
      }),
    }),
  }),
);

type PrimeAgentAcpTerminalMeta =
  (typeof primeAgentAcpTerminalNotificationSchema.Type)["update"]["_meta"][typeof PRIME_AGENT_ACP_META_NAMESPACE];

export type PrimeAgentAcpTerminalUpdate =
  | { readonly phase: "invalid" }
  | {
      readonly phase: "responseBoundary";
      readonly promptTurnId: number;
      readonly eventSequence: number;
      readonly outcome: "result" | "error";
      readonly terminalQuiescenceExpected: boolean;
    }
  | {
      readonly phase: "terminalQuiescence";
      readonly promptTurnId: number;
      readonly eventSequence: number;
      readonly outcome: "result" | "error";
      readonly outstandingSubagents: 0;
      readonly remainingAutonomousContinuations: number;
    };

export function parsePrimeAgentAcpTerminalUpdate(
  notification: unknown,
): PrimeAgentAcpTerminalUpdate | undefined {
  const decoded = decodePrimeAgentAcpTerminalNotification(notification);
  if (Option.isNone(decoded)) {
    return Option.isSome(decodePrimeAgentAcpTerminalTarget(notification))
      ? { phase: "invalid" }
      : undefined;
  }
  const metadata: PrimeAgentAcpTerminalMeta =
    decoded.value.update._meta[PRIME_AGENT_ACP_META_NAMESPACE];
  if (metadata.phase === "responseBoundary") {
    if (metadata.terminalQuiescenceExpected === undefined) return { phase: "invalid" };
    return {
      phase: metadata.phase,
      promptTurnId: metadata.promptTurnId,
      eventSequence: metadata.eventSequence,
      outcome: metadata.outcome,
      terminalQuiescenceExpected: metadata.terminalQuiescenceExpected,
    };
  }
  if (metadata.quiescence === undefined || metadata.quiescence.outstandingSubagents !== 0) {
    return { phase: "invalid" };
  }
  return {
    phase: metadata.phase,
    promptTurnId: metadata.promptTurnId,
    eventSequence: metadata.eventSequence,
    outcome: metadata.outcome,
    outstandingSubagents: 0,
    remainingAutonomousContinuations: metadata.quiescence.remainingAutonomousContinuations,
  };
}

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
  "authMethodId" | "clientCapabilities" | "resumeSessionId" | "shouldDiscardSessionUpdate" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly primeAgentSettings: PrimeAgentAcpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly sessionDir: string;
  readonly continueSession: boolean;
  readonly model?: string | undefined;
}

export function isPrimeAgentAcpPrivateThoughtUpdate(
  notification: EffectAcpSchema.SessionNotification,
): boolean {
  return notification.update.sessionUpdate === "agent_thought_chunk";
}

export function makePrimeAgentEnvironment(
  settings: Pick<PrimeAgentSettings, "agentHomePath"> | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized = sanitizePrimeAgentTopLevelEnvironment(environment);
  const agentHomePath = settings?.agentHomePath.trim();
  return agentHomePath
    ? { ...sanitized, [PRIME_AGENT_HOME_ENV]: resolveProviderHomePath(agentHomePath) }
    : sanitized;
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
    extendEnv: false,
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
        // Phase 1 does not surface Prime ACP reasoning. Drop thought updates
        // before normalization, and disable incoming protocol logs so their raw
        // text cannot enter Pylon's native log before this provider boundary.
        shouldDiscardSessionUpdate: isPrimeAgentAcpPrivateThoughtUpdate,
        ...(input.protocolLogging
          ? {
              protocolLogging: {
                ...input.protocolLogging,
                logIncoming: false,
              },
            }
          : {}),
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
