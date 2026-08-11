// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import type { JcodeSettings } from "@t3tools/contracts";
import { isHostWindows } from "@t3tools/shared/hostProcess";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { sanitizeJcodeLaunchEnvironment } from "./JcodeEnvironment.ts";
import {
  jcodeDefaultLaunchAliasBase,
  jcodeHomePath,
  jcodeLaunchAliasPath,
  jcodeLaunchHomeFitsUnixLimit,
  jcodeProviderRoot,
} from "./JcodePaths.ts";
import {
  JcodeSdkOperationError,
  JcodeSessionNotFoundError,
  type JcodeLaunchedInstance,
  type JcodeSdkBridge,
  type JcodeSdkClient,
} from "./JcodeSdkBridge.ts";

/**
 * Fixed deadlines for every native interaction this manager owns.
 *
 * A launched daemon that never answers must not hold a provider instance open
 * forever, and each milestone gets its own bound so a slow shutdown cannot be
 * mistaken for a slow launch. Tests drive these with `TestClock`, so they stay
 * constants rather than tuning knobs.
 */
export const JCODE_LAUNCH_TIMEOUT = Duration.seconds(45);
export const JCODE_CONNECT_TIMEOUT = Duration.seconds(15);
export const JCODE_ATTACH_PROBE_TIMEOUT = Duration.seconds(15);
export const JCODE_PROBE_TIMEOUT = Duration.seconds(15);
export const JCODE_CLIENT_CLOSE_TIMEOUT = Duration.seconds(10);
export const JCODE_DETACH_TIMEOUT = Duration.seconds(10);
export const JCODE_INSTANCE_SHUTDOWN_TIMEOUT = Duration.seconds(30);

const CONTROL_CLIENT_NAME = "pylon-jcode-control/1";
const SESSION_CLIENT_NAME = "pylon-jcode-session/1";

const MAX_SESSION_ID_LENGTH = 256;

/** The bridge's authoritative code for a session the daemon has forgotten. */
const UNKNOWN_SESSION_CODE = "unknown_session";

/**
 * The private identity of this instance's hidden probe session.
 *
 * It is not a cache. A socket path, `JCODE_HOME`, credential, model list,
 * capability, protocol version, or event written here would turn a resume
 * record into a durable leak of native state, so encoding emits exactly these
 * two fields and decoding rejects a sidecar carrying anything else.
 */
interface JcodeProbeIdentity {
  readonly schemaVersion: 1;
  readonly sessionId: string;
}

const JcodeProbeIdentitySchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.String,
});

const decodeProbeIdentity = Schema.decodeUnknownOption(JcodeProbeIdentitySchema);

const EXPECTED_KEYS = ["schemaVersion", "sessionId"] as const;

export interface JcodeInstanceProbe {
  readonly server: string;
  readonly protocolVersion: number;
  readonly capabilities: ReadonlyArray<string>;
  readonly currentModel?: string;
  readonly models: ReadonlyArray<{
    readonly model: string;
    readonly provider?: string;
    readonly available: boolean;
  }>;
}

export class JcodeInstanceManagerError extends Data.TaggedError("JcodeInstanceManagerError")<{
  readonly operation:
    | "launch"
    | "connect-control"
    | "attach-probe"
    | "probe"
    | "connect-session"
    | "shutdown";
  readonly detail: string;
  /**
   * Only an already-redacted bridge error, never a raw throwable. A tagged
   * error is a real `Error`, so anything attached here is printed by
   * `util.inspect`, Node's crash printer, and any logger that walks error
   * properties.
   */
  readonly cause?: unknown;
}> {}

export interface JcodeInstanceManager {
  readonly probe: Effect.Effect<JcodeInstanceProbe, JcodeInstanceManagerError>;
  readonly connectSessionClient: Effect.Effect<JcodeSdkClient, JcodeInstanceManagerError>;
  readonly releaseSessionClient: (client: JcodeSdkClient) => Effect.Effect<void>;
  readonly shutdown: Effect.Effect<void, JcodeInstanceManagerError>;
}

export interface JcodeInstanceManagerInput {
  /**
   * Manager-scoped, never a process singleton: the bridge retains launch
   * credential literals for its whole life, so sharing one across provider
   * instances would cross-contaminate secrets between them.
   */
  readonly bridge: JcodeSdkBridge;
  readonly instanceId: string;
  readonly stateDir: string;
  readonly settings: Pick<JcodeSettings, "binaryPath" | "inheritLogins">;
  readonly environment: NodeJS.ProcessEnv;
  /**
   * Values later provider wiring knows are credentials, taken from the known
   * sensitive provider-environment entries. Redaction is literal, so passing
   * every environment value would shred ordinary words out of later messages
   * and guessing from name or entropy would silently miss a short credential.
   */
  readonly credentialValues: ReadonlyArray<string>;
  /**
   * Where bounded launch aliases live. Defaults to `/tmp/pylon-jcode-<uid>`;
   * tests point it at a private directory.
   */
  readonly launchAliasBase?: string;
}

function tagOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const tag = (error as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : undefined;
}

/**
 * What a manager error is allowed to say about the failure it replaced.
 *
 * Bridge errors are already redacted at their own boundary, so their `detail`
 * is safe to repeat. Everything else collapses to a non-identifying
 * discriminator rather than a path-bearing platform message.
 */
function failureDetail(error: unknown): string {
  if (error instanceof JcodeSessionNotFoundError) {
    return `${error.operation}: the session is no longer known to the instance`;
  }
  if (error instanceof JcodeSdkOperationError) return `${error.operation}: ${error.detail}`;
  if (tagOf(error) === "TimeoutError") return "timed out";
  return "unknown failure";
}

/**
 * The only platform failure that means "this file is not there".
 *
 * Matched on the reason discriminator rather than a message, mirroring the
 * shape Task 4 proved against the real Node filesystem layer.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const reason = (error as { readonly reason?: { readonly _tag?: unknown } }).reason;
  return typeof reason === "object" && reason !== null && reason._tag === "NotFound";
}

/**
 * What may be retained as a manager error's `cause`.
 *
 * A `Data.TaggedError` prop is an own enumerable property of a real `Error`, so
 * anything stored here is printed by `util.inspect`, `JSON.stringify`, Node's
 * crash printer, and any logger that walks error properties. The bridge redacts
 * the credential literals it was handed at launch, but it cannot redact a
 * native session ID it minted itself: `JcodeSessionNotFoundError.sessionId` is
 * the private probe or thread session, and retaining it would publish exactly
 * the identifier the sidecar exists to keep private. It is replaced by an
 * equivalent operation error carrying the same authoritative code and no ID.
 */
function safeCause(cause: unknown): unknown {
  return cause instanceof JcodeSessionNotFoundError
    ? new JcodeSdkOperationError({
        operation: cause.operation,
        code: UNKNOWN_SESSION_CODE,
        detail: "the session is no longer known to the instance",
      })
    : cause;
}

function isSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SESSION_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function decodeJcodeProbeIdentity(source: string): JcodeProbeIdentity | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const keys = Object.keys(raw).toSorted();
  if (
    keys.length !== EXPECTED_KEYS.length ||
    keys.some((key, index) => key !== EXPECTED_KEYS[index])
  ) {
    return undefined;
  }
  const identity = decodeProbeIdentity(raw);
  if (Option.isNone(identity) || !isSessionId(identity.value.sessionId)) return undefined;
  return { schemaVersion: 1, sessionId: identity.value.sessionId };
}

/**
 * Point one bounded alias at this instance's durable home.
 *
 * The alias is the only thing standing between a deep state directory and an
 * unbindable socket, so every outcome is handled explicitly:
 *
 * - already the right link: left alone, which is what makes a restart reuse
 *   one alias per instance rather than accumulating one per launch;
 * - a link somewhere else: replaced, because a leftover from an earlier layout
 *   would silently redirect this instance at a home that is not its own;
 * - anything that is not a link: refused. Replacing it means deleting whatever
 *   is there, and no path length problem justifies destroying a directory this
 *   manager did not create.
 *
 * The base directory is created owner-only and then re-read and required to be
 * a real owner-only directory, since on Unix it lives under a world-writable
 * `/tmp`. Nothing here rewrites a path this manager did not just create, so a
 * base another account raced into place can only make the launch fail.
 */
export const ensureLaunchAlias = Effect.fn("ensureLaunchAlias")(function* (input: {
  readonly aliasPath: string;
  readonly target: string;
  /**
   * Optional so a caller outside the manager (the compatibility script) can
   * reuse this exact preparation without inventing its own error vocabulary.
   */
  readonly managerError?: (
    operation: JcodeInstanceManagerError["operation"],
    detail: string,
    cause?: unknown,
  ) => JcodeInstanceManagerError;
}): Effect.fn.Return<void, JcodeInstanceManagerError, FileSystem.FileSystem | Path.Path> {
  const { aliasPath, target } = input;
  const managerError =
    input.managerError ??
    ((operation, detail) => new JcodeInstanceManagerError({ operation, detail }));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const aliasBase = path.dirname(aliasPath);

  // A launch from here could not bind its sockets, and the resulting failure is
  // an opaque EPIPE several steps later. Refuse now, while the reason is known.
  if (!jcodeLaunchHomeFitsUnixLimit({ launchHome: aliasPath, join: (...s) => path.join(...s) })) {
    return yield* managerError(
      "launch",
      "The Jcode runtime directory is too long for this platform's socket limit.",
    );
  }

  // On Unix the base lives under a world-writable directory, so another
  // account can plant this name first. Nothing here changes a path Pylon did
  // not just create: `makeDirectory` applies the owner-only mode at creation,
  // and the state is then re-read and required to be a real, owner-only
  // directory. Deliberately no `chmod`. A `chmod` would be a second syscall on
  // a path another account can swap between the check and the act, and it
  // would tighten a directory Pylon does not own; refusing is both safer and
  // simpler. The residual race can therefore only make this launch fail, never
  // modify a third party's directory.
  yield* fs
    .makeDirectory(aliasBase, { recursive: true, mode: 0o700 })
    .pipe(
      Effect.mapError(() =>
        managerError("launch", "Failed to prepare the private Jcode runtime directory."),
      ),
    );

  if (Option.isSome(yield* fs.readLink(aliasBase).pipe(Effect.option))) {
    return yield* managerError(
      "launch",
      "The private Jcode runtime directory is a link rather than a directory.",
    );
  }

  const baseInfo = yield* fs
    .stat(aliasBase)
    .pipe(
      Effect.mapError(() =>
        managerError("launch", "Failed to inspect the private Jcode runtime directory."),
      ),
    );
  if (baseInfo.type !== "Directory") {
    return yield* managerError("launch", "The private Jcode runtime directory is not a directory.");
  }
  // A pre-existing base with a looser mode is one this manager did not create.
  if ((baseInfo.mode & 0o777) !== 0o700) {
    return yield* managerError("launch", "The private Jcode runtime directory is not owner-only.");
  }

  const existing = yield* fs.readLink(aliasPath).pipe(Effect.option);
  if (Option.isSome(existing)) {
    if (existing.value === target) return;
    yield* fs
      .remove(aliasPath, { force: true })
      .pipe(
        Effect.mapError(() =>
          managerError("launch", "Failed to replace a stale private Jcode runtime link."),
        ),
      );
  } else if (yield* fs.exists(aliasPath).pipe(Effect.orElseSucceed(() => false))) {
    return yield* managerError(
      "launch",
      "The private Jcode runtime path is occupied by something this instance did not create.",
    );
  }

  yield* fs
    .symlink(target, aliasPath)
    .pipe(
      Effect.mapError(() =>
        managerError("launch", "Failed to prepare the private Jcode runtime directory."),
      ),
    );
});

export const makeJcodeInstanceManager = Effect.fn("makeJcodeInstanceManager")(function* (
  input: JcodeInstanceManagerInput,
): Effect.fn.Return<
  JcodeInstanceManager,
  JcodeInstanceManagerError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const join = (...segments: ReadonlyArray<string>) => path.join(...segments);
  const pathInput = { stateDir: input.stateDir, instanceId: input.instanceId, join } as const;
  const instanceRoot = jcodeProviderRoot(pathInput);
  const instanceHome = jcodeHomePath(pathInput);
  const identityPath = join(instanceRoot, "probe.json");
  const { bridge } = input;

  const managerError = (
    operation: JcodeInstanceManagerError["operation"],
    detail: string,
    cause?: unknown,
  ) =>
    new JcodeInstanceManagerError({
      operation,
      detail,
      // Sanitized at the single construction site, so every call path inherits
      // the guarantee rather than remembering it.
      ...(cause === undefined ? {} : { cause: safeCause(cause) }),
    });

  // The instance home is created here, at owner-only, before the daemon can
  // materialize it with default modes. A later sidecar write must never be the
  // thing that hardens a home somebody else created first.
  yield* fs.makeDirectory(instanceHome, { recursive: true, mode: 0o700 }).pipe(
    Effect.andThen(fs.chmod(instanceRoot, 0o700)),
    Effect.andThen(fs.chmod(instanceHome, 0o700)),
    Effect.mapError(() =>
      managerError("launch", "Failed to prepare the private Jcode instance directory."),
    ),
  );

  /**
   * The home the SDK is launched from, which is not always the durable one.
   *
   * The daemon binds `<home>/run/jcode-debug.sock`, and the durable home sits
   * under a user-chosen state directory that routinely exceeds the platform's
   * Unix socket path limit. On Unix the daemon is therefore launched from a
   * short alias that resolves to the durable home. Windows has no such limit
   * and creating a symlink there needs a privilege Pylon must not require, so
   * it launches from the durable home directly.
   */
  const onWindows = yield* isHostWindows;
  const launchHome = onWindows
    ? instanceHome
    : jcodeLaunchAliasPath({
        aliasBase:
          input.launchAliasBase ??
          jcodeDefaultLaunchAliasBase({ uid: process.getuid?.() ?? 0, join }),
        stateDir: input.stateDir,
        instanceId: input.instanceId,
        join,
      });

  if (!onWindows) {
    // Inheritance runs against the durable directory before the alias exists:
    // the SDK refuses a symlink as an inheritance target, and credentials have
    // to be in place before the daemon starts or the first turn has none.
    if (input.settings.inheritLogins) {
      const userHome = yield* bridge.userJcodeHome.pipe(
        Effect.mapError(() =>
          managerError("launch", "Could not locate the Jcode home to inherit logins from."),
        ),
      );
      yield* bridge
        .inheritCredentials(
          { fromHome: userHome, toHome: instanceHome },
          { credentialValues: input.credentialValues },
        )
        .pipe(
          Effect.mapError((error) =>
            managerError(
              "launch",
              `Could not share the existing Jcode logins with this instance (${failureDetail(error)}).`,
              error,
            ),
          ),
        );
    }
    yield* ensureLaunchAlias({ aliasPath: launchHome, target: instanceHome, managerError });
  }

  const binaryPath = input.settings.binaryPath.trim();
  const instance: JcodeLaunchedInstance = yield* bridge
    .launchInstance(
      {
        ...(binaryPath === "" ? {} : { binary: binaryPath }),
        jcodeHome: launchHome,
        // Already done above on Unix, against the durable home rather than the
        // alias. Asking the SDK to repeat it would fail on the symlink.
        inheritLogins: onWindows ? input.settings.inheritLogins : false,
        // Sanitized here even though callers claim to sanitize: a reserved
        // variable reaching the daemon would silently redirect this private
        // instance at the user's live interactive Jcode.
        env: sanitizeJcodeLaunchEnvironment(input.environment),
        inheritStderr: false,
      },
      { credentialValues: input.credentialValues },
    )
    .pipe(
      Effect.timeout(JCODE_LAUNCH_TIMEOUT),
      Effect.mapError((error) =>
        managerError(
          "launch",
          `Could not launch the private Jcode instance (${failureDetail(error)}).`,
          error,
        ),
      ),
    );

  const children = new Set<JcodeSdkClient>();
  let control: JcodeSdkClient | undefined;
  let probeSessionId: string | undefined;
  let stopped = false;

  const closeClient = (client: JcodeSdkClient) =>
    bridge
      .trySdk({ operation: "close", run: () => client.close() })
      .pipe(Effect.timeout(JCODE_CLIENT_CLOSE_TIMEOUT), Effect.flip, Effect.option);

  /**
   * Idempotent teardown: tracked children first, then the hidden probe session,
   * then the control client, then the instance exactly once. Every step is
   * best-effort so one failure cannot strand the daemon, and the collected
   * failures surface as a single typed, redacted error.
   */
  const shutdown: Effect.Effect<void, JcodeInstanceManagerError> = Effect.suspend(() => {
    if (stopped) return Effect.void;
    stopped = true;
    return Effect.gen(function* () {
      const failures: Array<string> = [];
      const record = (failure: Option.Option<unknown>) => {
        if (Option.isSome(failure)) failures.push(failureDetail(failure.value));
      };

      for (const child of children) record(yield* closeClient(child));
      children.clear();

      const attached = control;
      if (attached !== undefined && probeSessionId !== undefined) {
        const sessionId = probeSessionId;
        record(
          yield* bridge
            .trySdk({
              operation: "detachSession",
              sessionId,
              run: () => attached.detachSession(sessionId),
            })
            .pipe(Effect.timeout(JCODE_DETACH_TIMEOUT), Effect.flip, Effect.option),
        );
      }
      if (attached !== undefined) record(yield* closeClient(attached));
      control = undefined;

      record(
        yield* bridge
          .trySdk({ operation: "shutdown", run: () => instance.shutdown() })
          .pipe(Effect.timeout(JCODE_INSTANCE_SHUTDOWN_TIMEOUT), Effect.flip, Effect.option),
      );

      if (failures.length > 0) {
        return yield* managerError(
          "shutdown",
          `Could not fully stop the private Jcode instance (${failures.join("; ")}).`,
        );
      }
    });
  });

  // Registered as soon as an instance exists, so a failure anywhere below still
  // stops the daemon this manager launched.
  yield* Effect.addFinalizer(() => Effect.ignore(shutdown));

  control = yield* bridge
    .connect({ socketPath: instance.socketPath, clientName: CONTROL_CLIENT_NAME })
    .pipe(
      Effect.timeout(JCODE_CONNECT_TIMEOUT),
      Effect.mapError((error) =>
        managerError(
          "connect-control",
          `Could not connect the control client to the private Jcode instance (${failureDetail(error)}).`,
          error,
        ),
      ),
    );
  const controlClient = control;

  /**
   * Absence means "no probe session to continue"; corruption means the same and
   * is handled downstream by the decoder. An I/O failure means neither: it means
   * *unknown*, and treating it as absence would mint a second native probe
   * session and atomically rename its identity over a sidecar that is still
   * there, orphaning the first session and destroying the record of its ID. So
   * only genuine absence is recovered and everything else fails closed, with no
   * raw platform error retained as a cause.
   */
  const readIdentity = fs.readFileString(identityPath).pipe(
    Effect.catch((error) =>
      isNotFound(error)
        ? Effect.succeed(undefined)
        : Effect.fail(
            managerError("attach-probe", "Could not read the private Jcode probe identity."),
          ),
    ),
    Effect.map((source) => (source === undefined ? undefined : decodeJcodeProbeIdentity(source))),
  );

  const writeIdentity = (sessionId: string) => {
    const contents = `${JSON.stringify({ schemaVersion: 1, sessionId } satisfies JcodeProbeIdentity)}\n`;
    const tempPath = `${identityPath}.${NodeCrypto.randomUUID()}.tmp`;
    return fs.writeFileString(tempPath, contents).pipe(
      Effect.andThen(fs.chmod(tempPath, 0o600)),
      Effect.andThen(fs.rename(tempPath, identityPath)),
      Effect.catch(() =>
        fs
          .remove(tempPath)
          .pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.fail(
                managerError("attach-probe", "Failed to persist the private Jcode probe identity."),
              ),
            ),
          ),
      ),
    );
  };

  const createProbeSession = Effect.gen(function* () {
    const session = yield* bridge
      .trySdk({ operation: "createSession", run: () => controlClient.createSession() })
      .pipe(
        Effect.timeout(JCODE_ATTACH_PROBE_TIMEOUT),
        Effect.mapError((error) =>
          managerError(
            "attach-probe",
            `Could not create the hidden Jcode probe session (${failureDetail(error)}).`,
            error,
          ),
        ),
      );
    yield* writeIdentity(session.session_id);
    return session.session_id;
  });

  const recorded = yield* readIdentity;
  if (recorded === undefined) {
    probeSessionId = yield* createProbeSession;
  } else {
    const sessionId = recorded.sessionId;
    // Only the bridge's distinct authoritative tag means "this session is
    // gone"; message text is never matched, and any other failure keeps the
    // sidecar rather than creating a duplicate probe session.
    const reattached = yield* bridge
      .trySdk({
        operation: "attachSession",
        sessionId,
        run: () => controlClient.attachSession(sessionId),
      })
      .pipe(
        Effect.timeout(JCODE_ATTACH_PROBE_TIMEOUT),
        Effect.as(true),
        Effect.catch((error) =>
          error instanceof JcodeSessionNotFoundError
            ? Effect.succeed(false)
            : Effect.fail(
                managerError(
                  "attach-probe",
                  `Could not attach the hidden Jcode probe session (${failureDetail(error)}).`,
                  error,
                ),
              ),
        ),
      );
    if (reattached) {
      probeSessionId = sessionId;
    } else {
      yield* fs.remove(identityPath, { force: true }).pipe(Effect.ignore);
      probeSessionId = yield* createProbeSession;
    }
  }
  const probeSession = probeSessionId;

  /**
   * Always fresh: models and runtime data are read per call and never written
   * to the sidecar, so a stale catalog can never outlive the instance.
   */
  const probe: Effect.Effect<JcodeInstanceProbe, JcodeInstanceManagerError> = Effect.gen(
    function* () {
      const [models, runtime] = yield* Effect.all([
        bridge.trySdk({
          operation: "listModels",
          sessionId: probeSession,
          run: () => controlClient.listModels(probeSession),
        }),
        bridge.trySdk({
          operation: "getRuntimeInfo",
          sessionId: probeSession,
          run: () => controlClient.getRuntimeInfo(probeSession),
        }),
      ]).pipe(
        Effect.timeout(JCODE_PROBE_TIMEOUT),
        Effect.mapError((error) =>
          managerError(
            "probe",
            `Could not read the private Jcode instance runtime (${failureDetail(error)}).`,
            error,
          ),
        ),
      );

      const currentModel = runtime.model ?? models.current;
      return {
        server: runtime.server,
        protocolVersion: runtime.protocolVersion,
        // `permissions` is advertised here for diagnostics only. Early Access
        // never enters supervised mode, so nothing consumes it as a signal to
        // wait for or answer a permission prompt.
        capabilities: [...runtime.capabilities],
        ...(currentModel === undefined ? {} : { currentModel }),
        models: models.models.map((model) => {
          const route = runtime.routes.find((candidate) => candidate.model === model);
          return {
            model,
            ...(route === undefined ? {} : { provider: route.provider }),
            available: route?.available ?? true,
          };
        }),
      };
    },
  );

  const releaseSessionClient = (client: JcodeSdkClient): Effect.Effect<void> =>
    Effect.sync(() => {
      children.delete(client);
    });

  const connectSessionClient: Effect.Effect<JcodeSdkClient, JcodeInstanceManagerError> =
    Effect.suspend(() =>
      stopped
        ? Effect.fail(
            managerError("connect-session", "The private Jcode instance has already been stopped."),
          )
        : bridge.connect({ socketPath: instance.socketPath, clientName: SESSION_CLIENT_NAME }).pipe(
            Effect.timeout(JCODE_CONNECT_TIMEOUT),
            Effect.mapError((error) =>
              managerError(
                "connect-session",
                `Could not connect a session client to the private Jcode instance (${failureDetail(error)}).`,
                error,
              ),
            ),
            Effect.tap((client) =>
              Effect.sync(() => {
                children.add(client);
              }),
            ),
          ),
    );

  return { probe, connectSessionClient, releaseSessionClient, shutdown };
});
