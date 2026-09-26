import type { AuthSessionState, EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { SupervisorConnectionState } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export function initialConfigOption<T, E>(
  initialConfig: Effect.Effect<T, E>,
): Effect.Effect<Option.Option<T>> {
  return initialConfig.pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      Effect.logWarning("Could not load the initial environment configuration.").pipe(
        Effect.annotateLogs({ ...safeErrorLogAttributes(error) }),
        Effect.as(Option.none<T>()),
      ),
    ),
  );
}

export interface ConnectedInitialConfig<T = ServerConfig> {
  readonly state: SupervisorConnectionState;
  readonly config: T;
}

/** A capability is usable only with the exact connected lease that supplied it. */
export function connectedInitialConfigForState<T>(
  currentState: SupervisorConnectionState | null,
  observed: Option.Option<ConnectedInitialConfig<T>>,
): T | null {
  return currentState?.phase === "connected" &&
    Option.isSome(observed) &&
    observed.value.state === currentState
    ? observed.value.config
    : null;
}

/** Derive config and connection identity from one supervisor, fencing delayed reads. */
export function connectedInitialConfigChanges<T, E>(
  stateRef: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  readSession: Effect.Effect<Option.Option<{ readonly initialConfig: Effect.Effect<T, E> }>>,
): Stream.Stream<Option.Option<ConnectedInitialConfig<T>>> {
  return SubscriptionRef.changes(stateRef).pipe(
    Stream.mapEffect((state) =>
      Effect.gen(function* () {
        if (state.phase !== "connected") return Option.none<ConnectedInitialConfig<T>>();
        const session = yield* readSession;
        if (Option.isNone(session)) return Option.none<ConnectedInitialConfig<T>>();
        const config = yield* initialConfigOption(session.value.initialConfig);
        const currentState = yield* SubscriptionRef.get(stateRef);
        const currentSession = yield* readSession;
        return currentState === state &&
          Option.isSome(currentSession) &&
          currentSession.value === session.value &&
          Option.isSome(config)
          ? Option.some({ state, config: config.value })
          : Option.none<ConnectedInitialConfig<T>>();
      }),
    ),
  );
}

// Bounded like the snapshot fetches: a wedged environment must not pin the
// permissions check (and with it the settings UI) in a loading state for long.
const DEFAULT_SESSION_STATE_TIMEOUT_MS = 6_000;

/**
 * Read the granted scopes of this client's session on one environment via its
 * `/api/auth/session` endpoint, using the connection's authentication method
 * and refreshing relay credentials when needed.
 */
export const fetchEnvironmentSessionState = Effect.fn(
  "clientRuntime.state.fetchEnvironmentSessionState",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "auth",
    method: "GET",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/auth/session"),
    timeoutMs: input.timeoutMs ?? DEFAULT_SESSION_STATE_TIMEOUT_MS,
    request: ({ client, headers }) => client.session({ headers }),
    // This endpoint returns 200 with authenticated:false for expired credentials.
    isUnauthorizedResponse: (response) => !response.authenticated,
  });
});

export function createEnvironmentSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const initialConfigAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.session).pipe(
                Stream.mapEffect(
                  Option.match({
                    onNone: () => Effect.succeed(Option.none<ServerConfig>()),
                    onSome: (session) => initialConfigOption(session.initialConfig),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      { initialValue: Option.none() },
    ),
  );

  // Read the connection state and session from the same supervisor. A cached
  // config or a lagging independent session stream must never authorize a
  // semantic attachment marker after a same-ID server replacement. Consumers
  // compare the state object to their current connection projection as well.
  const connectedInitialConfigAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        followStreamInEnvironment(
          environmentId,
          Stream.unwrap(
            EnvironmentSupervisor.pipe(
              Effect.map((supervisor) =>
                connectedInitialConfigChanges(
                  supervisor.state,
                  SubscriptionRef.get(supervisor.session),
                ),
              ),
            ),
          ),
        ),
        { initialValue: Option.none<ConnectedInitialConfig>() },
      )
      .pipe(Atom.withLabel(`environment-current-config:${environmentId}`)),
  );

  // This is only the bootstrap config captured when a transport session is
  // established. Consumers that need current provider/settings state must use
  // createServerEnvironmentAtoms(...).configValueAtom instead.
  const initialConfigValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ServerConfig | null =>
      Option.getOrNull(
        Option.getOrElse(AsyncResult.value(get(initialConfigAtom(environmentId))), () =>
          Option.none(),
        ),
      ),
    ).pipe(Atom.withLabel(`environment-config-value:${environmentId}`)),
  );

  const preparedConnectionAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) => SubscriptionRef.changes(supervisor.prepared)),
          ),
        ),
      ),
      { initialValue: Option.none<PreparedConnection>() },
    ),
  );

  const preparedConnectionValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(preparedConnectionAtom(environmentId))), () =>
        Option.none<PreparedConnection>(),
      ),
    ).pipe(Atom.withLabel(`environment-prepared-connection:${environmentId}`)),
  );

  // Keyed on the prepared connection's identity: a reconnect (new credential,
  // new base URL) swaps the prepared value, which re-runs the fetch, so scope
  // changes from re-pairing are picked up without an explicit refresh.
  const sessionStateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom((get) => {
        const prepared = Option.getOrNull(get(preparedConnectionValueAtom(environmentId)));
        if (prepared === null) {
          return Effect.never;
        }
        return Effect.gen(function* () {
          const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
          const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
          return yield* fetchEnvironmentSessionState({ prepared, signer, remoteAuthorization });
        });
      })
      .pipe(
        Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-session-state:${environmentId}`),
      ),
  );

  const sessionStateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): AuthSessionState | null =>
        Option.getOrNull(AsyncResult.value(get(sessionStateAtom(environmentId)))) ?? null,
    ).pipe(Atom.withLabel(`environment-session-state-value:${environmentId}`)),
  );

  return {
    initialConfigAtom,
    connectedInitialConfigAtom,
    initialConfigValueAtom,
    preparedConnectionAtom,
    preparedConnectionValueAtom,
    sessionStateAtom,
    sessionStateValueAtom,
  };
}
