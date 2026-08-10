/**
 * Narrow bridge over the public `@1jehuang/jcode-sdk`.
 *
 * Everything SDK-native stops here. Consumers (`JcodeInstanceManager`,
 * `JcodeSessionRuntime`) see Effects with a closed error union instead of
 * promise rejections, so nobody downstream has to guess how a harness failure
 * should be classified. The SDK's own `HarnessError.code` is the only signal
 * used for classification: message text is not stable and must never be matched.
 */
import { HarnessError, isKnownEvent, JcodeClient, launchInstance } from "@1jehuang/jcode-sdk";
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
}

export interface JcodeSdkBridge {
  readonly launchInstance: (
    options: LaunchOptions,
  ) => Effect.Effect<JcodeLaunchedInstance, JcodeSdkBridgeError>;
  readonly connect: (options: {
    readonly socketPath: string;
    readonly clientName: string;
  }) => Effect.Effect<JcodeSdkClient, JcodeSdkBridgeError>;
  readonly trySdk: <A>(input: {
    readonly operation: string;
    readonly sessionId?: string;
    readonly run: () => Promise<A>;
  }) => Effect.Effect<A, JcodeSdkBridgeError>;
}

/** Absolute POSIX and Windows paths, which name the user's machine and instance home. */
const ABSOLUTE_PATH = /(?:[A-Za-z]:)?[\\/][^\s'"`,;)\]]+/g;

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
 * The single mapping boundary. Every promise the SDK hands us goes through here
 * so no consumer invents its own classification.
 */
function toBridgeError(input: {
  readonly error: unknown;
  readonly operation: string;
  readonly sessionId?: string;
  readonly secrets?: ReadonlyArray<string>;
}): JcodeSdkBridgeError {
  const code = harnessCode(input.error);
  if (code === UNKNOWN_SESSION_CODE && input.sessionId !== undefined) {
    return new JcodeSessionNotFoundError({
      operation: input.operation,
      sessionId: input.sessionId,
    });
  }
  const detail = redactDetail(errorMessage(input.error), input.secrets ?? []);
  return new JcodeSdkOperationError({
    operation: input.operation,
    ...(code === undefined ? {} : { code }),
    detail: code === undefined ? detail : `${code}: ${detail}`,
    cause: input.error,
  });
}

function tryPromise<A>(input: {
  readonly operation: string;
  readonly sessionId?: string;
  readonly secrets?: ReadonlyArray<string>;
  readonly run: () => Promise<A>;
}): Effect.Effect<A, JcodeSdkBridgeError> {
  return Effect.tryPromise({
    try: () => input.run(),
    catch: (error) =>
      toBridgeError({
        error,
        operation: input.operation,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
      }),
  });
}

/** Run `task` at most once, no matter how many callers race on it. */
function once(task: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | undefined;
  return () => {
    started ??= task();
    return started;
  };
}

/**
 * Drop event kinds this SDK version does not know about.
 *
 * The harness may add events within protocol v1, and a consumer switching on
 * `event.ev` must not fault on one it has never seen.
 */
async function* knownEvents(
  source: AsyncIterableIterator<ApiEvent>,
): AsyncIterableIterator<ApiEvent> {
  for await (const event of source) {
    if (isKnownEvent(event as AnyApiEvent)) yield event;
  }
}

function wrapClient(client: JcodeSdkClientLike): JcodeSdkClient {
  const close = once(() => client.close());
  return {
    get server() {
      return client.server;
    },
    get capabilities() {
      return client.capabilities;
    },
    supports: (capability) => client.supports(capability),
    createSession: (workingDir) => client.createSession(workingDir),
    attachSession: (sessionId) => client.attachSession(sessionId),
    detachSession: (sessionId) => client.detachSession(sessionId),
    listSessions: (options) => client.listSessions(options),
    listModels: (sessionId) => client.listModels(sessionId),
    getRuntimeInfo: (sessionId) => client.getRuntimeInfo(sessionId),
    setModel: (sessionId, model) => client.setModel(sessionId, model),
    setReasoningEffort: (sessionId, effort) => client.setReasoningEffort(sessionId, effort),
    sendMessage: (sessionId, content, options) => client.sendMessage(sessionId, content, options),
    cancel: (sessionId) => client.cancel(sessionId),
    getHistory: (sessionId) => client.getHistory(sessionId),
    events: (sessionId) => knownEvents(client.events(sessionId)),
    close,
  };
}

export function makeJcodeSdkBridge(sdk: JcodeSdkModule): JcodeSdkBridge {
  return {
    launchInstance: (options) =>
      Effect.map(
        tryPromise({
          operation: "launchInstance",
          secrets: Object.values(options.env ?? {}),
          run: () => sdk.launchInstance(options),
        }),
        (instance) => ({
          socketPath: instance.socketPath,
          jcodeHome: instance.jcodeHome,
          shutdown: once(() => instance.shutdown()),
        }),
      ),
    connect: (options) =>
      Effect.map(tryPromise({ operation: "connect", run: () => sdk.connect(options) }), wrapClient),
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
};

export const jcodeSdkBridge: JcodeSdkBridge = makeJcodeSdkBridge(defaultJcodeSdkModule);
