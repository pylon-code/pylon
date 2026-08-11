/**
 * Narrow bridge over the public `@1jehuang/jcode-sdk`.
 *
 * Everything SDK-native stops here. Consumers (`JcodeInstanceManager`,
 * `JcodeSessionRuntime`) see Effects with a closed error union instead of
 * promise rejections, so nobody downstream has to guess how a harness failure
 * should be classified. The SDK's own `HarnessError.code` is the only signal
 * used for classification: message text is not stable and must never be matched.
 */
import {
  HarnessError,
  inheritCredentials,
  isKnownEvent,
  JcodeClient,
  launchInstance,
  userJcodeHome,
} from "@1jehuang/jcode-sdk";
import type {
  AnyApiEvent,
  ApiEvent,
  HistoryMessage,
  LaunchOptions,
  RuntimeInfo,
  SendMessageOptions,
  SessionInfo,
} from "@1jehuang/jcode-sdk";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

/** The only SDK error code that authoritatively means "this session is gone". */
const UNKNOWN_SESSION_CODE = "unknown_session";

export class JcodeSessionNotFoundError extends Data.TaggedError("JcodeSessionNotFoundError")<{
  readonly operation: string;
  readonly sessionId: string;
}> {}

export class JcodeSdkOperationError extends Data.TaggedError("JcodeSdkOperationError")<{
  readonly operation: string;
  readonly code?: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export type JcodeSdkBridgeError = JcodeSessionNotFoundError | JcodeSdkOperationError;

/**
 * The subset of `JcodeClient` this provider depends on.
 *
 * Declared structurally so tests can supply a double without constructing a
 * real client (its constructor is private and requires a live socket).
 */
export interface JcodeSdkClientLike {
  readonly server: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly supports: (capability: string) => boolean;
  readonly createSession: (workingDir?: string) => Promise<SessionInfo>;
  readonly attachSession: (sessionId: string) => Promise<SessionInfo>;
  readonly detachSession: (sessionId: string) => Promise<void>;
  readonly listSessions: (options?: { includeArchived?: boolean }) => Promise<SessionInfo[]>;
  readonly listModels: (sessionId: string) => Promise<{ models: string[]; current?: string }>;
  readonly getRuntimeInfo: (sessionId: string) => Promise<RuntimeInfo>;
  readonly setModel: (sessionId: string, model: string) => Promise<void>;
  readonly setReasoningEffort: (sessionId: string, effort: string) => Promise<void>;
  readonly sendMessage: (
    sessionId: string,
    content: string,
    options?: SendMessageOptions,
  ) => Promise<void>;
  readonly cancel: (sessionId: string) => Promise<void>;
  readonly getHistory: (sessionId: string) => Promise<HistoryMessage[]>;
  readonly events: (sessionId?: string) => AsyncIterableIterator<ApiEvent>;
  readonly close: () => Promise<void>;
}

export type JcodeSdkClient = JcodeSdkClientLike;

export interface JcodeLaunchedInstance {
  readonly socketPath: string;
  readonly jcodeHome: string;
  readonly shutdown: () => Promise<void>;
}

/** The SDK surface the bridge consumes, so tests can substitute it wholesale. */
export interface JcodeSdkModule {
  readonly launchInstance: (options: LaunchOptions) => Promise<{
    readonly socketPath: string;
    readonly jcodeHome: string;
    readonly shutdown: () => Promise<void>;
  }>;
  readonly connect: (options: {
    readonly socketPath: string;
    readonly clientName: string;
  }) => Promise<JcodeSdkClientLike>;
  /** The user's real Jcode home, which is the only source of inherited logins. */
  readonly userJcodeHome: () => string;
  /**
   * Copy or link the user's provider logins into an instance home.
   *
   * Synchronous and throwing in the SDK, and it refuses a home that is a
   * symlink, so Pylon calls it against the durable directory itself rather
   * than letting a launch do it through an alias.
   */
  readonly inheritCredentials: (fromHome: string, toHome: string) => ReadonlyArray<string>;
}

/**
 * Values the caller knows are credentials.
 *
 * Redaction is literal, so the bridge must be told what to redact rather than
 * guessing. `LaunchOptions.env` is a full-process-environment passthrough on
 * the real wiring path, and treating every value in it as a secret shreds
 * `"1"`, `"a"`, and `"production"` out of every later message. A heuristic
 * (minimum length, entropy) would instead silently miss a short credential.
 * Naming them explicitly is the only option that is both readable and safe.
 */
export interface JcodeLaunchSecrets {
  readonly credentialValues: ReadonlyArray<string>;
}

export interface JcodeSdkBridge {
  readonly launchInstance: (
    options: LaunchOptions,
    secrets?: JcodeLaunchSecrets,
  ) => Effect.Effect<JcodeLaunchedInstance, JcodeSdkBridgeError>;
  readonly connect: (options: {
    readonly socketPath: string;
    readonly clientName: string;
  }) => Effect.Effect<JcodeSdkClient, JcodeSdkBridgeError>;
  readonly userJcodeHome: Effect.Effect<string, JcodeSdkBridgeError>;
  readonly inheritCredentials: (
    input: { readonly fromHome: string; readonly toHome: string },
    secrets?: JcodeLaunchSecrets,
  ) => Effect.Effect<ReadonlyArray<string>, JcodeSdkBridgeError>;
  readonly trySdk: <A>(input: {
    readonly operation: string;
    readonly sessionId?: string;
    readonly run: () => Promise<A>;
  }) => Effect.Effect<A, JcodeSdkBridgeError>;
}

/**
 * Absolute POSIX and Windows paths, which name the user's machine and instance
 * home. Two segments are required so ordinary API routes (`/health`) and bare
 * dividers survive: those carry no host detail and are the only debugging
 * context left once the raw throwable is dropped.
 */
const ABSOLUTE_PATH = /(?:[A-Za-z]:)?(?:[\\/][^\s'"`,;)\]/\\]+){2,}/g;

function redactDetail(message: string, secrets: ReadonlyArray<string>): string {
  const withoutSecrets = secrets.reduce(
    (text, secret) => (secret.length === 0 ? text : text.split(secret).join("<redacted>")),
    message,
  );
  return withoutSecrets.replace(ABSOLUTE_PATH, "<path>");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return Predicate.isString(error) ? error : String(error);
}

function harnessCode(error: unknown): string | undefined {
  return error instanceof HarnessError ? error.code : undefined;
}

/**
 * What a bridge error is allowed to remember about the throwable it replaced.
 *
 * Never the throwable itself: a tagged error is a real `Error`, so an attached
 * `cause` is printed by `util.inspect`, Node's crash printer, `Cause.pretty`,
 * and any logger that walks error properties. A raw SDK rejection carries the
 * launch environment and the instance's absolute paths in its message and
 * stack, so retaining it would put provider credentials in server logs.
 */
interface JcodeRedactedCause {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

function redactedCause(
  error: unknown,
  detail: string,
  secrets: ReadonlyArray<string>,
): JcodeRedactedCause {
  const stack = error instanceof Error ? error.stack : undefined;
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: detail,
    ...(stack === undefined ? {} : { stack: redactDetail(stack, secrets) }),
  };
}

/**
 * The single mapping boundary. Every promise the SDK hands us goes through here
 * so no consumer invents its own classification.
 */
function toBridgeError(input: {
  readonly error: unknown;
  readonly operation: string;
  readonly sessionId?: string;
  readonly secrets?: ReadonlyArray<string>;
}): JcodeSdkBridgeError {
  // Already classified upstream (a wrapped client method): keep the original
  // tag rather than re-wrapping a session-not-found into an operation error.
  if (
    input.error instanceof JcodeSessionNotFoundError ||
    input.error instanceof JcodeSdkOperationError
  ) {
    return input.error;
  }
  const code = harnessCode(input.error);
  if (code === UNKNOWN_SESSION_CODE) {
    return new JcodeSessionNotFoundError({
      operation: input.operation,
      sessionId: input.sessionId ?? "",
    });
  }
  const secrets = input.secrets ?? [];
  const detail = redactDetail(errorMessage(input.error), secrets);
  return new JcodeSdkOperationError({
    operation: input.operation,
    ...(code === undefined ? {} : { code }),
    detail,
    cause: redactedCause(input.error, detail, secrets),
  });
}

/**
 * Run `task` at most once *successfully*, no matter how many callers race on it.
 *
 * Only success latches. A transient cleanup failure must stay retryable, or an
 * instance manager that hits one timeout can never stop its daemon again.
 */
function once(task: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | undefined;
  return () => {
    started ??= task().catch((error: unknown) => {
      started = undefined;
      throw error;
    });
    return started;
  };
}

export function makeJcodeSdkBridge(sdk: JcodeSdkModule): JcodeSdkBridge {
  /**
   * Credentials handed to a launched instance, remembered for the bridge's
   * whole life. The daemon can echo one back in any later failure, so
   * redaction has to be bridge-scoped rather than something each caller
   * remembers to pass. Kept longest-first so a credential that contains a
   * shorter one is not pre-shredded by it, and deduplicated so repeat launches
   * of the same instance cannot grow the set without bound.
   */
  const launchSecrets = new Set<string>();
  let redactionLiterals: ReadonlyArray<string> = [];

  function rememberSecrets(secrets: JcodeLaunchSecrets | undefined): void {
    let added = false;
    for (const value of secrets?.credentialValues ?? []) {
      if (value.length === 0 || launchSecrets.has(value)) continue;
      launchSecrets.add(value);
      added = true;
    }
    if (added) redactionLiterals = [...launchSecrets].sort((a, b) => b.length - a.length);
  }

  function tryPromise<A>(input: {
    readonly operation: string;
    readonly sessionId?: string;
    readonly run: () => Promise<A>;
  }): Effect.Effect<A, JcodeSdkBridgeError> {
    return Effect.tryPromise({
      try: () => input.run(),
      catch: (error) =>
        toBridgeError({
          error,
          operation: input.operation,
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          secrets: redactionLiterals,
        }),
    });
  }

  /**
   * The synchronous half of the same boundary.
   *
   * `userJcodeHome` and `inheritCredentials` throw rather than reject, and
   * their messages carry the instance home and, on an inheritance failure, the
   * path of a credential file. They go through the identical redaction as the
   * promise methods so no consumer has to classify a raw throw.
   */
  function trySync<A>(input: {
    readonly operation: string;
    readonly run: () => A;
  }): Effect.Effect<A, JcodeSdkBridgeError> {
    return Effect.try({
      try: () => input.run(),
      catch: (error) =>
        toBridgeError({
          error,
          operation: input.operation,
          secrets: redactionLiterals,
        }),
    });
  }

  /**
   * Bind an operation name (and session) to a client promise so its rejection
   * is already a `JcodeSdkBridgeError`. Consumers cannot get a raw SDK
   * rejection out of a wrapped client, whichever Effect combinator they reach
   * for, and `trySdk` passes an already-classified error through untouched.
   */
  function guard<A>(
    operation: string,
    sessionId: string | undefined,
    run: () => Promise<A>,
  ): Promise<A> {
    return run().catch((error: unknown) => {
      throw toBridgeError({
        error,
        operation,
        ...(sessionId === undefined ? {} : { sessionId }),
        secrets: redactionLiterals,
      });
    });
  }

  /**
   * Drop event kinds this SDK version does not know about, and classify a
   * stream failure like any other SDK failure.
   *
   * The harness may add events within protocol v1, and a consumer switching on
   * `event.ev` must not fault on one it has never seen. A mid-stream
   * disconnect is the expected failure mode for a long-lived session, so it
   * goes through the same boundary as the promise methods rather than escaping
   * raw.
   *
   * The pull loop is manual so a rejected `next()` can be classified, which
   * means this generator owes the source the cleanup `for await` would have
   * performed for it: the `finally` runs whenever the consumer breaks,
   * returns, or throws, and closes the source exactly once. The SDK's iterator
   * teardown is its `return`, and skipping it leaks an event listener and an
   * unbounded queue for the life of the process. A cleanup failure is
   * deliberately swallowed: it must never replace the classified stream error
   * the consumer is already being told about.
   */
  async function* knownEvents(
    source: AsyncIterableIterator<ApiEvent>,
    sessionId: string | undefined,
  ): AsyncIterableIterator<ApiEvent> {
    const iterator = source[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await iterator.next().catch((error: unknown) => {
          throw toBridgeError({
            error,
            operation: "events",
            ...(sessionId === undefined ? {} : { sessionId }),
            secrets: redactionLiterals,
          });
        });
        if (next.done === true) return;
        if (isKnownEvent(next.value as AnyApiEvent)) yield next.value;
      }
    } finally {
      await iterator.return?.().catch(() => undefined);
    }
  }

  function wrapClient(client: JcodeSdkClientLike): JcodeSdkClient {
    const close = once(() => guard("close", undefined, () => client.close()));
    return {
      get server() {
        return client.server;
      },
      get capabilities() {
        return client.capabilities;
      },
      supports: (capability) => client.supports(capability),
      createSession: (workingDir) =>
        guard("createSession", undefined, () => client.createSession(workingDir)),
      attachSession: (sessionId) =>
        guard("attachSession", sessionId, () => client.attachSession(sessionId)),
      detachSession: (sessionId) =>
        guard("detachSession", sessionId, () => client.detachSession(sessionId)),
      listSessions: (options) =>
        guard("listSessions", undefined, () => client.listSessions(options)),
      listModels: (sessionId) => guard("listModels", sessionId, () => client.listModels(sessionId)),
      getRuntimeInfo: (sessionId) =>
        guard("getRuntimeInfo", sessionId, () => client.getRuntimeInfo(sessionId)),
      setModel: (sessionId, model) =>
        guard("setModel", sessionId, () => client.setModel(sessionId, model)),
      setReasoningEffort: (sessionId, effort) =>
        guard("setReasoningEffort", sessionId, () => client.setReasoningEffort(sessionId, effort)),
      sendMessage: (sessionId, content, options) =>
        guard("sendMessage", sessionId, () => client.sendMessage(sessionId, content, options)),
      cancel: (sessionId) => guard("cancel", sessionId, () => client.cancel(sessionId)),
      getHistory: (sessionId) => guard("getHistory", sessionId, () => client.getHistory(sessionId)),
      events: (sessionId) => knownEvents(client.events(sessionId), sessionId),
      close,
    };
  }

  return {
    launchInstance: (options, secrets) => {
      rememberSecrets(secrets);
      return Effect.map(
        tryPromise({
          operation: "launchInstance",
          run: () => sdk.launchInstance(options),
        }),
        (instance) => ({
          socketPath: instance.socketPath,
          jcodeHome: instance.jcodeHome,
          shutdown: once(() => guard("shutdown", undefined, () => instance.shutdown())),
        }),
      );
    },
    connect: (options) =>
      Effect.map(tryPromise({ operation: "connect", run: () => sdk.connect(options) }), wrapClient),
    userJcodeHome: trySync({ operation: "userJcodeHome", run: () => sdk.userJcodeHome() }),
    inheritCredentials: (input, secrets) => {
      rememberSecrets(secrets);
      return trySync({
        operation: "inheritCredentials",
        run: () => sdk.inheritCredentials(input.fromHome, input.toHome),
      });
    },
    trySdk: (input) =>
      tryPromise({
        operation: input.operation,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        run: input.run,
      }),
  };
}

/** The real SDK, used in production wiring. */
export const defaultJcodeSdkModule: JcodeSdkModule = {
  launchInstance: (options) => launchInstance(options),
  connect: (options) =>
    JcodeClient.connect({ socketPath: options.socketPath, clientName: options.clientName }),
  userJcodeHome: () => userJcodeHome(),
  inheritCredentials: (fromHome, toHome) => inheritCredentials(fromHome, toHome),
};

export const jcodeSdkBridge: JcodeSdkBridge = makeJcodeSdkBridge(defaultJcodeSdkModule);
