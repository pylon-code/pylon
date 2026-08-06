import {
  ClaudeSettings,
  ProviderDriverKind,
  ServerProviderLoginError,
  type ProviderInstanceId,
  type ServerProviderLoginCancelInput,
  type ServerProviderLoginResult,
  type ServerProviderLoginStartInput,
  type ServerProviderLoginStarted,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProviderLoginSessions } from "./ProviderLoginSessions.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

export interface ProviderLoginCoordinatorShape {
  readonly start: (
    input: ServerProviderLoginStartInput,
  ) => Effect.Effect<ServerProviderLoginStarted, ServerProviderLoginError>;
  readonly submitCode: (input: {
    readonly sessionId: ServerProviderLoginStarted["sessionId"];
    readonly code: string;
  }) => Effect.Effect<ServerProviderLoginResult, ServerProviderLoginError>;
  readonly cancel: (input: ServerProviderLoginCancelInput) => Effect.Effect<void>;
}

export class ProviderLoginCoordinator extends Context.Service<
  ProviderLoginCoordinator,
  ProviderLoginCoordinatorShape
>()("t3/provider/providerLoginCoordinator") {}

const loginError = (reason: string, cause?: unknown) =>
  new ServerProviderLoginError({ reason, ...(cause === undefined ? {} : { cause }) });

/**
 * Which instance a sign-in belongs to, and how to run its CLI.
 *
 * Sign-in has to target one configured instance rather than the driver: the
 * whole point is authenticating a *second* account, and the only thing that
 * separates the two is that instance's config directory.
 */
const resolveInstance = (instanceId: ProviderInstanceId) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService.pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.mapError((cause) => loginError("Could not read provider settings.", cause)),
    );
    const instance = settings.providerInstances[instanceId];
    if (!instance) {
      return yield* Effect.fail(loginError(`Unknown provider instance "${instanceId}".`));
    }
    if (instance.driver !== CLAUDE_DRIVER) {
      // Codex has its own login protocol and the rest have none; offering a
      // flow that cannot work is worse than saying so.
      return yield* Effect.fail(
        loginError(`Signing in from Pylon is not supported for ${instance.driver} yet.`),
      );
    }
    const config = decodeClaudeSettings(instance.config ?? {});
    return {
      claudeSettings: { ...config, enabled: true } satisfies ClaudeSettings,
      environment: mergeProviderInstanceEnvironment(instance.environment),
    };
  });

const make = Effect.gen(function* () {
  const sessions = yield* ProviderLoginSessions;
  const registry = yield* ProviderRegistry;
  const context = yield* Effect.context<ServerSettingsService>();

  let counter = 0;

  const start: ProviderLoginCoordinatorShape["start"] = (input) =>
    Effect.gen(function* () {
      const resolved = yield* resolveInstance(input.instanceId);
      counter += 1;
      const sessionId = `${input.instanceId}:${counter}` as ServerProviderLoginStarted["sessionId"];
      const started = yield* sessions.start({
        sessionId,
        settings: resolved.claudeSettings,
        method: input.method,
        ...(input.email === undefined ? {} : { email: input.email }),
        environment: resolved.environment,
      });
      return { sessionId, url: started.url } satisfies ServerProviderLoginStarted;
    }).pipe(Effect.provide(context));

  const submitCode: ProviderLoginCoordinatorShape["submitCode"] = (input) =>
    Effect.gen(function* () {
      const result = yield* sessions.submitCode(input);
      if (!result.signedIn) return result;

      // Re-probe rather than trusting the exit code: the card has to show the
      // account that actually landed, and the user's next click depends on it.
      const instanceId = input.sessionId.split(":")[0] as ProviderInstanceId;
      const providers = yield* registry
        .refreshInstance(instanceId)
        .pipe(Effect.orElseSucceed(() => undefined));
      const refreshed = providers?.find((provider) => provider.instanceId === instanceId);
      const email = refreshed?.auth.email?.trim();
      return {
        ...result,
        signedIn: refreshed ? refreshed.auth.status === "authenticated" : result.signedIn,
        ...(email ? { email } : {}),
        ...(refreshed && refreshed.auth.status !== "authenticated"
          ? { message: "Sign-in finished but the account still reads as signed out." }
          : {}),
      } satisfies ServerProviderLoginResult;
    });

  const cancel: ProviderLoginCoordinatorShape["cancel"] = (input) => sessions.cancel(input);

  return ProviderLoginCoordinator.of({ start, submitCode, cancel });
});

export const ProviderLoginCoordinatorLive = Layer.effect(ProviderLoginCoordinator, make);
