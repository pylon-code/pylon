import {
  ServerProviderLoginError,
  type ClaudeSettings,
  type ProviderLoginSessionId,
  type ServerProviderLoginMethod,
  type ServerProviderLoginResult,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";
import {
  claudeLoginArgs,
  parseProviderLoginUrl,
  providerLoginFailureMessage,
} from "./providerLogin.ts";

/**
 * A sign-in is interactive, so the CLI has to stay alive between two client
 * calls: one to get the authorization URL, one to hand back the pasted code.
 * These bounds keep an abandoned browser tab from leaving a process resident
 * forever.
 */
const URL_TIMEOUT = Duration.seconds(30);
const CODE_TIMEOUT = Duration.seconds(90);
const SESSION_TTL = Duration.minutes(15);
/** Enough to hold the URL and any error; the CLI is not verbose. */
const OUTPUT_MAX_CHARS = 16_000;

interface LoginSession {
  readonly startedAtMs: number;
  readonly submitCode: (code: string) => Effect.Effect<ServerProviderLoginResult>;
  readonly close: Effect.Effect<void>;
}

export interface ProviderLoginSessionsShape {
  /**
   * Spawn the CLI and read back the URL to open. The process stays running,
   * waiting for the code.
   */
  readonly start: (input: {
    readonly sessionId: ProviderLoginSessionId;
    readonly settings: ClaudeSettings;
    readonly method: ServerProviderLoginMethod;
    readonly email?: string | undefined;
    readonly environment?: NodeJS.ProcessEnv | undefined;
  }) => Effect.Effect<{ readonly url: string }, ServerProviderLoginError>;

  readonly submitCode: (input: {
    readonly sessionId: ProviderLoginSessionId;
    readonly code: string;
  }) => Effect.Effect<ServerProviderLoginResult, ServerProviderLoginError>;

  /** Idempotent: cancelling an already-finished session is not an error. */
  readonly cancel: (input: { readonly sessionId: ProviderLoginSessionId }) => Effect.Effect<void>;
}

export class ProviderLoginSessions extends Context.Service<
  ProviderLoginSessions,
  ProviderLoginSessionsShape
>()("t3/provider/ProviderLoginSessions") {}

const loginError = (reason: string, cause?: unknown) =>
  new ServerProviderLoginError({ reason, ...(cause === undefined ? {} : { cause }) });

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const sessions = yield* Ref.make(new Map<string, LoginSession>());

  const forget = (sessionId: string) =>
    Ref.update(sessions, (current) => {
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });

  /** Reap sessions whose browser tab was abandoned, so processes do not pile up. */
  const sweepExpired = Effect.gen(function* () {
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const current = yield* Ref.get(sessions);
    const ttlMs = Duration.toMillis(SESSION_TTL);
    for (const [id, session] of current) {
      if (now - session.startedAtMs > ttlMs) {
        yield* session.close;
        yield* forget(id);
      }
    }
  });

  const start: ProviderLoginSessionsShape["start"] = (input) =>
    Effect.gen(function* () {
      yield* sweepExpired;

      const environment = yield* makeClaudeEnvironment(input.settings, input.environment);
      const args = claudeLoginArgs({
        method: input.method,
        ...(input.email === undefined ? {} : { email: input.email }),
      });
      const spawnCommand = yield* resolveSpawnCommand(input.settings.binaryPath, [...args]);

      // The scope outlives this call on purpose: the process must survive until
      // the user pastes a code, so it is closed by submitCode/cancel/sweep.
      const scope = yield* Scope.make("sequential");
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            env: environment,
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((cause) => loginError("Could not start the sign-in command.", cause)),
        );

      const output = yield* Ref.make("");
      const urlFound = yield* Deferred.make<string>();
      const reader = yield* Stream.merge(child.stdout, child.stderr).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            const next = yield* Ref.updateAndGet(output, (previous) =>
              `${previous}${Buffer.from(chunk).toString("utf8")}`.slice(-OUTPUT_MAX_CHARS),
            );
            const url = parseProviderLoginUrl(next);
            if (url) yield* Deferred.succeed(urlFound, url);
          }),
        ),
        Effect.forkIn(scope),
      );

      const close = Effect.gen(function* () {
        yield* Fiber.interrupt(reader).pipe(Effect.ignore);
        yield* child.kill().pipe(Effect.ignore);
        yield* Scope.close(scope, Exit.void);
      });

      const urlOption = yield* Deferred.await(urlFound).pipe(Effect.timeoutOption(URL_TIMEOUT));
      if (urlOption._tag === "None") {
        yield* close;
        return yield* Effect.fail(loginError("The sign-in command did not return a link in time."));
      }
      const url = urlOption.value;

      const submitCode = (code: string): Effect.Effect<ServerProviderLoginResult> =>
        Effect.gen(function* () {
          yield* Stream.run(Stream.encodeText(Stream.make(`${code}\n`)), child.stdin).pipe(
            Effect.ignore,
          );
          // A process that cannot be waited on is indistinguishable from one
          // that never finished, and both mean the same thing to the user.
          const exitCode = yield* child.exitCode.pipe(
            Effect.map(Number),
            Effect.timeoutOption(CODE_TIMEOUT),
            Effect.orElseSucceed(() => Option.none<number>()),
          );
          const collected = yield* Ref.get(output);
          yield* close;

          if (exitCode._tag === "None") {
            return {
              signedIn: false,
              message: "The sign-in command did not finish in time.",
            } satisfies ServerProviderLoginResult;
          }
          const failure = providerLoginFailureMessage({
            exitCode: exitCode.value,
            output: collected,
          });
          return {
            signedIn: failure === undefined,
            ...(failure === undefined ? {} : { message: failure }),
          } satisfies ServerProviderLoginResult;
        });

      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      yield* Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.set(input.sessionId, { startedAtMs: now, submitCode, close });
        return next;
      });

      return { url };
    }).pipe(Effect.provideService(Path.Path, path));

  const submitCode: ProviderLoginSessionsShape["submitCode"] = (input) =>
    Effect.gen(function* () {
      const session = (yield* Ref.get(sessions)).get(input.sessionId);
      if (!session) {
        return yield* Effect.fail(loginError("That sign-in is no longer running. Start it again."));
      }
      yield* forget(input.sessionId);
      return yield* session.submitCode(input.code);
    });

  const cancel: ProviderLoginSessionsShape["cancel"] = (input) =>
    Effect.gen(function* () {
      const session = (yield* Ref.get(sessions)).get(input.sessionId);
      if (!session) return;
      yield* forget(input.sessionId);
      yield* session.close;
    });

  return ProviderLoginSessions.of({ start, submitCode, cancel });
});

export const ProviderLoginSessionsLive = Layer.effect(ProviderLoginSessions, make);
