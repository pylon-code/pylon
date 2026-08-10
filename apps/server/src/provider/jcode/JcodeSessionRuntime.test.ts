// @effect-diagnostics nodeBuiltinImport:off
import { inspect } from "node:util";

import { HarnessError } from "@1jehuang/jcode-sdk";
import type { ApiEvent, SendMessageOptions, SessionInfo } from "@1jehuang/jcode-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type ProviderSendTurnInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import * as ServerConfig from "../../config.ts";
import { jcodeThreadIdentityPath } from "./JcodePaths.ts";
import { JCODE_RESUME_CURSOR } from "./JcodeResumeCursor.ts";
import {
  makeJcodeSdkBridge,
  type JcodeSdkBridge,
  type JcodeSdkClient,
  type JcodeSdkClientLike,
  type JcodeSdkModule,
} from "./JcodeSdkBridge.ts";
import { writeJcodeSessionIdentity } from "./JcodeSessionIdentity.ts";
import {
  JcodeSessionRuntimeError,
  makeJcodeSessionRuntime,
  type JcodeSessionRuntime,
  type JcodeSessionRuntimeInput,
} from "./JcodeSessionRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

const SECRET = "sk-ant-secret-value-1234";
const NATIVE_SOCKET = "/private/var/folders/jcode-home-abc/api.sock";
const NATIVE_SESSION_ID = "native-session-abc";
const INSTANCE_ID = "jcode_local";
const THREAD_ID = ThreadId.make("thread-1");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("jcode_local");

/** Everything a logger, crash printer, or serializer can observe on an error. */
function observableSurface(error: unknown): string {
  const asError = error as Error;
  return [
    inspect(error, { depth: 10 }),
    JSON.stringify(error),
    JSON.stringify({ error }),
    String(error),
    asError.stack ?? "",
    Cause.pretty(Cause.fail(error)),
  ].join("\n");
}

function sessionInfo(sessionId: string, workingDir?: string): SessionInfo {
  return {
    session_id: sessionId,
    status: "idle",
    ...(workingDir === undefined ? {} : { working_dir: workingDir }),
  };
}

type SourceItem =
  | { readonly kind: "event"; readonly value: ApiEvent }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "end" };

/** A hand-driven SDK event source so tests decide exactly when frames land. */
class EventSource {
  private readonly items: SourceItem[] = [];
  private readonly waiters: Array<() => void> = [];
  /** Times the runtime asked for an iterator. Proves "no reconnect". */
  starts = 0;
  /** Times the iterator was torn down. Proves cleanup runs exactly once. */
  returns = 0;

  push(value: ApiEvent): void {
    this.items.push({ kind: "event", value });
    this.wake();
  }

  fail(error: unknown): void {
    this.items.push({ kind: "error", error });
    this.wake();
  }

  end(): void {
    this.items.push({ kind: "end" });
    this.wake();
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  iterator(): AsyncIterableIterator<ApiEvent> {
    this.starts += 1;
    const self = this;
    return (async function* () {
      try {
        for (;;) {
          while (self.items.length === 0) {
            await new Promise<void>((resolve) => {
              self.waiters.push(resolve);
            });
          }
          const next = self.items.shift() as SourceItem;
          if (next.kind === "end") return;
          if (next.kind === "error") throw next.error;
          yield next.value;
        }
      } finally {
        self.returns += 1;
      }
    })();
  }
}

interface Harness {
  readonly sdk: JcodeSdkModule;
  readonly source: EventSource;
  readonly created: string[];
  readonly attached: string[];
  readonly sent: Array<{
    readonly sessionId: string;
    readonly content: string;
    readonly options?: SendMessageOptions;
  }>;
  readonly setModels: Array<{ readonly sessionId: string; readonly model: string }>;
  readonly setEfforts: Array<{ readonly sessionId: string; readonly effort: string }>;
  readonly cancels: string[];
  readonly histories: string[];
  closes: number;
  /**
   * The directory the fake daemon reports for this session.
   *
   * Mutable so `scenario` can point it at the temp cwd it just created: the
   * real harness echoes the session's own working directory back on attach,
   * and a double that always omitted it would hide the attach-time check.
   */
  workingDir: string | undefined;
}

interface HarnessOptions {
  readonly createSession?: (workingDir?: string) => Promise<SessionInfo>;
  readonly attachSession?: (sessionId: string) => Promise<SessionInfo>;
  readonly sendMessage?: (sessionId: string, content: string) => Promise<void>;
  readonly setModel?: (sessionId: string, model: string) => Promise<void>;
  readonly setReasoningEffort?: (sessionId: string, effort: string) => Promise<void>;
  readonly cancel?: (sessionId: string) => Promise<void>;
  readonly workingDir?: string;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const source = new EventSource();
  const harness: Harness = {
    sdk: undefined as unknown as JcodeSdkModule,
    source,
    created: [],
    attached: [],
    sent: [],
    setModels: [],
    setEfforts: [],
    cancels: [],
    histories: [],
    closes: 0,
    workingDir: options.workingDir,
  };

  const client: JcodeSdkClientLike = {
    server: "jcode-harness-api-bridge/0.1.0",
    capabilities: ["sessions", "models"],
    supports: () => true,
    createSession: async (workingDir) => {
      harness.created.push(workingDir ?? "");
      if (options.createSession) return options.createSession(workingDir);
      return sessionInfo(NATIVE_SESSION_ID, workingDir ?? harness.workingDir);
    },
    attachSession: async (sessionId) => {
      harness.attached.push(sessionId);
      if (options.attachSession) return options.attachSession(sessionId);
      return sessionInfo(sessionId, harness.workingDir);
    },
    detachSession: async () => {},
    listSessions: async () => [],
    listModels: async () => ({ models: [] }),
    getRuntimeInfo: async () => {
      throw new Error("not used");
    },
    setModel: async (sessionId, model) => {
      harness.setModels.push({ sessionId, model });
      if (options.setModel) return options.setModel(sessionId, model);
    },
    setReasoningEffort: async (sessionId, effort) => {
      harness.setEfforts.push({ sessionId, effort });
      if (options.setReasoningEffort) return options.setReasoningEffort(sessionId, effort);
    },
    sendMessage: async (sessionId, content, sendOptions) => {
      harness.sent.push({
        sessionId,
        content,
        ...(sendOptions === undefined ? {} : { options: sendOptions }),
      });
      if (options.sendMessage) return options.sendMessage(sessionId, content);
    },
    cancel: async (sessionId) => {
      harness.cancels.push(sessionId);
      if (options.cancel) return options.cancel(sessionId);
    },
    getHistory: async (sessionId) => {
      harness.histories.push(sessionId);
      return [];
    },
    events: () => source.iterator(),
    // The real client's event iterator completes when the connection closes.
    // Modeling that here is what lets the runtime drain its pump rather than
    // abandoning a suspended async generator.
    close: async () => {
      harness.closes += 1;
      source.end();
    },
  };

  const mutable = harness as { sdk: JcodeSdkModule };
  mutable.sdk = {
    launchInstance: async () => ({
      socketPath: NATIVE_SOCKET,
      jcodeHome: "/private/var/folders/jcode-home-abc",
      shutdown: async () => {},
    }),
    connect: async () => client,
  };
  return harness;
}

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "jcode-session-runtime-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

interface Fixture {
  readonly runtime: JcodeSessionRuntime;
  readonly cwd: string;
  readonly stateDir: string;
  readonly identityPath: string;
  readonly attachmentsDir: string;
  readonly bridge: JcodeSdkBridge;
  readonly client: JcodeSdkClient;
}

interface ScenarioOptions {
  readonly resumeCursor?: unknown;
  readonly model?: string;
  readonly threadId?: ThreadId;
  /** Seeds the private sidecar before the runtime starts. */
  readonly seedIdentity?: { readonly sessionId: string; readonly workingDir?: string };
}

/**
 * Builds the bridge-wrapped client the way production does, so tests exercise
 * the real classification boundary rather than a hand-rolled double.
 */
const connectClient = (harness: Harness) =>
  Effect.gen(function* () {
    const bridge = makeJcodeSdkBridge(harness.sdk);
    const client = yield* bridge
      .connect({ socketPath: NATIVE_SOCKET, clientName: "pylon-jcode-session/1" })
      .pipe(Effect.orDie);
    return { bridge, client };
  });

/** Everything a scenario needs, created inside the caller's scope. */
const scenario = (harness: Harness, options: ScenarioOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "jcode-runtime-state-" });
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "jcode-runtime-cwd-" });
    // A daemon reports the session's real directory; only a test that overrode
    // `workingDir` deliberately wants to see something else.
    harness.workingDir ??= cwd;
    const threadId = options.threadId ?? THREAD_ID;
    const identityPath = jcodeThreadIdentityPath({
      stateDir,
      instanceId: INSTANCE_ID,
      threadId,
      join: (...segments) => path.join(...segments),
    });
    if (options.seedIdentity !== undefined) {
      yield* writeJcodeSessionIdentity({
        filePath: identityPath,
        sessionId: options.seedIdentity.sessionId,
        workingDir: options.seedIdentity.workingDir ?? cwd,
      }).pipe(Effect.orDie);
    }
    const { bridge, client } = yield* connectClient(harness);
    const input: JcodeSessionRuntimeInput = {
      bridge,
      client,
      providerInstanceId: PROVIDER_INSTANCE_ID,
      instanceId: INSTANCE_ID,
      threadId,
      stateDir,
      cwd,
      runtimeMode: "full-access",
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.resumeCursor === undefined ? {} : { resumeCursor: options.resumeCursor }),
    };
    return {
      input,
      cwd,
      stateDir,
      identityPath,
      attachmentsDir: serverConfig.attachmentsDir,
      bridge,
      client,
    };
  });

/**
 * The only two failures a scenario can produce: the runtime's own typed error,
 * and a real platform failure from the temp directories and fixture files these
 * tests write. Anything wider would let a genuine defect pass as an expected
 * outcome.
 */
type ScenarioError = JcodeSessionRuntimeError | PlatformError.PlatformError;

/**
 * Asserts an operation fails, and yields its typed error.
 *
 * `flip` alone would move the success value into the error channel, which is
 * how an operation that was supposed to fail-closed could quietly satisfy a
 * scenario's error type. Dying on the flipped failure makes an unexpected
 * success a defect the runner reports rather than a passing test.
 */
const expectFailure = <A, R>(
  effect: Effect.Effect<A, JcodeSessionRuntimeError, R>,
): Effect.Effect<JcodeSessionRuntimeError, never, R> => Effect.orDie(Effect.flip(effect));

function runScoped<A>(
  body: (services: {
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) => Effect.Effect<
    A,
    ScenarioError,
    FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig | Scope.Scope
  >,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return yield* body({ fs, path });
      }),
    ).pipe(Effect.provide(testLayer)),
  );
}

/** Starts a runtime and hands it to `body` inside one scope. */
function withRuntime<A>(
  harness: Harness,
  options: ScenarioOptions,
  body: (fixture: Fixture) => Effect.Effect<A, ScenarioError, FileSystem.FileSystem | Path.Path>,
): Promise<A> {
  return runScoped(() =>
    Effect.gen(function* () {
      const built = yield* scenario(harness, options);
      const runtime = yield* makeJcodeSessionRuntime(built.input);
      return yield* body({
        runtime,
        cwd: built.cwd,
        stateDir: built.stateDir,
        identityPath: built.identityPath,
        attachmentsDir: built.attachmentsDir,
        bridge: built.bridge,
        client: built.client,
      });
    }),
  );
}

/** Starts a runtime expected to fail, returning the typed error. */
function startFailure(
  harness: Harness,
  options: ScenarioOptions,
): Promise<{ readonly error: JcodeSessionRuntimeError; readonly identityPath: string }> {
  return runScoped(() =>
    Effect.gen(function* () {
      const built = yield* scenario(harness, options);
      const error = yield* expectFailure(makeJcodeSessionRuntime(built.input));
      return { error, identityPath: built.identityPath };
    }),
  );
}

const collect = (runtime: JcodeSessionRuntime, count: number) =>
  Stream.runCollect(Stream.take(runtime.streamEvents, count));

const collectAll = (runtime: JcodeSessionRuntime) => Stream.runCollect(runtime.streamEvents);

function textDelta(text: string): ApiEvent {
  return { ev: "text_delta", session_id: NATIVE_SESSION_ID, text };
}

const imageAttachment: ChatAttachment = {
  type: "image",
  id: "thread-1-0000ffff-1111-2222-3333-444455556666",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 4,
};

const writeAttachment = (attachmentsDir: string, attachment: ChatAttachment, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(attachmentsDir, { recursive: true }).pipe(Effect.ignore);
    yield* fs.writeFile(path.join(attachmentsDir, `${attachment.id}.png`), bytes);
  });

function turnInput(overrides: Partial<ProviderSendTurnInput> = {}): ProviderSendTurnInput {
  return { threadId: THREAD_ID, input: "hello", ...overrides } as ProviderSendTurnInput;
}

describe("JcodeSessionRuntime create and exact resume", () => {
  it("creates a native session at the exact cwd and returns only the constant cursor", async () => {
    const harness = makeHarness();
    const result = await withRuntime(harness, {}, (fixture) =>
      Effect.succeed({ session: fixture.runtime.session, cwd: fixture.cwd }),
    );

    expect(harness.created).toEqual([result.cwd]);
    expect(result.session.cwd).toBe(result.cwd);
    expect(result.session.threadId).toBe(THREAD_ID);
    expect(result.session.provider).toBe("jcode");
    expect(result.session.providerInstanceId).toBe(PROVIDER_INSTANCE_ID);
    expect(result.session.resumeCursor).toEqual(JCODE_RESUME_CURSOR);
    expect(result.session.restored).toBe(false);
    expect(JSON.stringify(result.session.resumeCursor)).not.toContain(NATIVE_SESSION_ID);
  });

  it("persists exactly the private identity fields for the new session", async () => {
    const harness = makeHarness();
    const source = await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return {
          contents: yield* fs.readFileString(fixture.identityPath),
          cwd: fixture.cwd,
        };
      }),
    );

    expect(JSON.parse(source.contents)).toEqual({
      schemaVersion: 1,
      sessionId: NATIVE_SESSION_ID,
      workingDir: source.cwd,
    });
  });

  it("attaches the recorded native session on an exact resume", async () => {
    const harness = makeHarness();
    const session = await withRuntime(
      harness,
      { resumeCursor: JCODE_RESUME_CURSOR, seedIdentity: { sessionId: "resumed-session" } },
      (fixture) => Effect.succeed(fixture.runtime.session),
    );

    expect(harness.attached).toEqual(["resumed-session"]);
    expect(harness.created).toEqual([]);
    expect(session.restored).toBe(true);
    expect(session.resumeCursor).toEqual(JCODE_RESUME_CURSOR);
  });

  it("fails closed when a resume cursor is malformed and never creates a replacement", async () => {
    for (const cursor of [
      { schemaVersion: 2, kind: "jcode-private-session", continue: true },
      { schemaVersion: 1, kind: "jcode-private-session", continue: true, sessionId: "x" },
      { kind: "jcode-private-session" },
      "jcode",
    ]) {
      const harness = makeHarness();
      const { error } = await startFailure(harness, {
        resumeCursor: cursor,
        seedIdentity: { sessionId: "resumed-session" },
      });
      expect(error).toBeInstanceOf(JcodeSessionRuntimeError);
      expect(error.operation).toBe("resume");
      expect(harness.created).toEqual([]);
      expect(harness.attached).toEqual([]);
    }
  });

  it("fails closed when the private identity is missing", async () => {
    const harness = makeHarness();
    const { error } = await startFailure(harness, { resumeCursor: JCODE_RESUME_CURSOR });

    expect(error.operation).toBe("resume");
    expect(harness.created).toEqual([]);
    expect(harness.attached).toEqual([]);
  });

  it("fails closed when the private identity is malformed", async () => {
    const harness = makeHarness();
    const error = await runScoped(() =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const built = yield* scenario(harness, { resumeCursor: JCODE_RESUME_CURSOR });
        yield* fs.makeDirectory(path.dirname(built.identityPath), { recursive: true });
        yield* fs.writeFileString(built.identityPath, "{ not json");
        return yield* expectFailure(makeJcodeSessionRuntime(built.input));
      }),
    );

    expect(error.operation).toBe("resume");
    expect(harness.created).toEqual([]);
    expect(harness.attached).toEqual([]);
  });

  it("fails closed when the recorded working directory is foreign", async () => {
    const harness = makeHarness();
    const { error } = await startFailure(harness, {
      resumeCursor: JCODE_RESUME_CURSOR,
      seedIdentity: { sessionId: "resumed-session", workingDir: "/somewhere/else/entirely" },
    });

    expect(error.operation).toBe("resume");
    expect(harness.attached).toEqual([]);
    expect(harness.created).toEqual([]);
  });

  it("fails closed when the attached session omits its working directory", async () => {
    const harness = makeHarness({
      attachSession: async (sessionId) => sessionInfo(sessionId),
    });
    const { error } = await startFailure(harness, {
      resumeCursor: JCODE_RESUME_CURSOR,
      seedIdentity: { sessionId: "resumed-session" },
    });

    expect(error.operation).toBe("resume");
    expect(harness.created).toEqual([]);
  });

  it("closes the child client on every fail-closed startup path", async () => {
    const missingSidecar = makeHarness();
    await startFailure(missingSidecar, { resumeCursor: JCODE_RESUME_CURSOR });
    expect(missingSidecar.closes).toBe(1);

    const unknownSession = makeHarness({
      attachSession: async () => {
        throw new HarnessError("unknown_session", "session gone");
      },
    });
    await startFailure(unknownSession, {
      resumeCursor: JCODE_RESUME_CURSOR,
      seedIdentity: { sessionId: "resumed-session" },
    });
    expect(unknownSession.closes).toBe(1);

    const createFailure = makeHarness({
      createSession: async () => {
        throw new Error("create failed");
      },
    });
    await startFailure(createFailure, {});
    expect(createFailure.closes).toBe(1);
  });

  it("fails closed when the attached session reports a different working directory", async () => {
    const harness = makeHarness({
      attachSession: async (sessionId) => sessionInfo(sessionId, "/somewhere/else/entirely"),
    });
    const { error } = await startFailure(harness, {
      resumeCursor: JCODE_RESUME_CURSOR,
      seedIdentity: { sessionId: "resumed-session" },
    });

    expect(error.operation).toBe("resume");
    expect(harness.created).toEqual([]);
  });

  it("fails closed on an authoritative unknown session without silent replacement", async () => {
    const harness = makeHarness({
      attachSession: async () => {
        throw new HarnessError("unknown_session", "session gone");
      },
    });
    const { error } = await startFailure(harness, {
      resumeCursor: JCODE_RESUME_CURSOR,
      seedIdentity: { sessionId: "resumed-session" },
    });

    expect(error.operation).toBe("resume");
    expect(harness.created).toEqual([]);
    expect(observableSurface(error)).not.toContain("resumed-session");
  });

  it("opens the event iterator before the first message is sent", async () => {
    const harness = makeHarness();
    const startsAtReady = await withRuntime(harness, {}, () =>
      Effect.succeed({ starts: harness.source.starts, sent: harness.sent.length }),
    );

    expect(startsAtReady.starts).toBe(1);
    expect(startsAtReady.sent).toBe(0);
  });
});

describe("JcodeSessionRuntime turns and attachments", () => {
  it("sends text-only turns with no image payload", async () => {
    const harness = makeHarness();
    const started = await withRuntime(harness, {}, (fixture) =>
      fixture.runtime.sendTurn(turnInput()),
    );

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.content).toBe("hello");
    expect(harness.sent[0]?.options?.images).toBeUndefined();
    expect(started.threadId).toBe(THREAD_ID);
    expect(started.resumeCursor).toEqual(JCODE_RESUME_CURSOR);
    expect(started.turnId).toBeTruthy();
  });

  it("sends image-only turns as base64 SDK tuples", async () => {
    const harness = makeHarness();
    await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        yield* writeAttachment(
          fixture.attachmentsDir,
          imageAttachment,
          new Uint8Array([1, 2, 3, 4]),
        );
        return yield* fixture.runtime.sendTurn(
          turnInput({ input: undefined, attachments: [imageAttachment] }),
        );
      }),
    );

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.content).toBe("");
    expect(harness.sent[0]?.options?.images).toEqual([
      ["image/png", Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64")],
    ]);
  });

  it("sends text plus image in one turn", async () => {
    const harness = makeHarness();
    await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        yield* writeAttachment(
          fixture.attachmentsDir,
          imageAttachment,
          new Uint8Array([9, 9, 9, 9]),
        );
        return yield* fixture.runtime.sendTurn(turnInput({ attachments: [imageAttachment] }));
      }),
    );

    expect(harness.sent[0]?.content).toBe("hello");
    expect(harness.sent[0]?.options?.images).toHaveLength(1);
  });

  it("fails typed on an unresolvable attachment id without sending", async () => {
    const harness = makeHarness();
    const error = await withRuntime(harness, {}, (fixture) =>
      expectFailure(
        fixture.runtime.sendTurn(
          turnInput({
            attachments: [{ ...imageAttachment, id: "../../escape" } as ChatAttachment],
          }),
        ),
      ),
    );

    expect(error).toBeInstanceOf(JcodeSessionRuntimeError);
    expect((error as JcodeSessionRuntimeError).operation).toBe("attachments");
    expect(harness.sent).toEqual([]);
  });

  it("fails typed when the attachment file is missing without sending", async () => {
    const harness = makeHarness();
    const error = await withRuntime(harness, {}, (fixture) =>
      expectFailure(fixture.runtime.sendTurn(turnInput({ attachments: [imageAttachment] }))),
    );

    expect((error as JcodeSessionRuntimeError).operation).toBe("attachments");
    expect(harness.sent).toEqual([]);
  });

  it("accepts exactly the canonical maximum number of attachments", async () => {
    const harness = makeHarness();
    const attachments = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) => ({
      ...imageAttachment,
      id: `thread-1-0000ffff-1111-2222-3333-44445555${String(index).padStart(4, "0")}`,
    })) as ReadonlyArray<ChatAttachment>;

    await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        for (const attachment of attachments) {
          yield* writeAttachment(fixture.attachmentsDir, attachment, new Uint8Array([7]));
        }
        return yield* fixture.runtime.sendTurn(turnInput({ attachments }));
      }),
    );

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.options?.images).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
  });

  it("rejects more attachments than the canonical bound without sending", async () => {
    const harness = makeHarness();
    const attachments = Array.from({ length: 9 }, (_, index) => ({
      ...imageAttachment,
      id: `thread-1-0000ffff-1111-2222-3333-44445555${String(index).padStart(4, "0")}`,
    })) as ReadonlyArray<ChatAttachment>;

    const error = await withRuntime(harness, {}, (fixture) =>
      expectFailure(fixture.runtime.sendTurn(turnInput({ attachments }))),
    );

    expect((error as JcodeSessionRuntimeError).operation).toBe("attachments");
    expect(harness.sent).toEqual([]);
  });
});

describe("JcodeSessionRuntime model and reasoning effort", () => {
  it("sets the model only when the selection differs from the attached model", async () => {
    const harness = makeHarness();
    await withRuntime(harness, { model: "sonnet" }, (fixture) =>
      fixture.runtime.sendTurn(
        turnInput({ modelSelection: { instanceId: PROVIDER_INSTANCE_ID, model: "opus" } }),
      ),
    );

    expect(harness.setModels).toEqual([{ sessionId: NATIVE_SESSION_ID, model: "opus" }]);
  });

  it("does not set the model when the selection matches the attached model", async () => {
    const harness = makeHarness();
    await withRuntime(harness, { model: "sonnet" }, (fixture) =>
      fixture.runtime.sendTurn(
        turnInput({ modelSelection: { instanceId: PROVIDER_INSTANCE_ID, model: "sonnet" } }),
      ),
    );

    expect(harness.setModels).toEqual([]);
    expect(harness.sent).toHaveLength(1);
  });

  it("sets reasoning effort only when it is not the Jcode default", async () => {
    const harness = makeHarness();
    await withRuntime(harness, { model: "sonnet" }, (fixture) =>
      fixture.runtime.sendTurn(
        turnInput({
          modelSelection: {
            instanceId: PROVIDER_INSTANCE_ID,
            model: "sonnet",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        }),
      ),
    );

    expect(harness.setEfforts).toEqual([{ sessionId: NATIVE_SESSION_ID, effort: "high" }]);
  });

  it("omits reasoning effort for the Jcode default selection", async () => {
    const harness = makeHarness();
    await withRuntime(harness, { model: "sonnet" }, (fixture) =>
      fixture.runtime.sendTurn(
        turnInput({
          modelSelection: {
            instanceId: PROVIDER_INSTANCE_ID,
            model: "sonnet",
            options: [{ id: "reasoningEffort", value: "jcode-default" }],
          },
        }),
      ),
    );

    expect(harness.setEfforts).toEqual([]);
    expect(harness.sent).toHaveLength(1);
  });

  it("surfaces invalid_request as a typed failure before sending and leaves other runtimes alone", async () => {
    const rejecting = makeHarness({
      setModel: async () => {
        throw new HarnessError("invalid_request", "unknown model");
      },
    });
    const untouched = makeHarness();

    const error = await runScoped(() =>
      Effect.gen(function* () {
        const builtA = yield* scenario(rejecting, { model: "sonnet" });
        const builtB = yield* scenario(untouched, {
          model: "sonnet",
          threadId: ThreadId.make("thread-2"),
        });
        const runtimeA = yield* makeJcodeSessionRuntime(builtA.input);
        yield* makeJcodeSessionRuntime(builtB.input);
        return yield* expectFailure(
          runtimeA.sendTurn(
            turnInput({ modelSelection: { instanceId: PROVIDER_INSTANCE_ID, model: "opus" } }),
          ),
        );
      }),
    );

    expect(error).toBeInstanceOf(JcodeSessionRuntimeError);
    expect((error as JcodeSessionRuntimeError).operation).toBe("model");
    expect(rejecting.sent).toEqual([]);
    expect(untouched.sent).toEqual([]);
    expect(untouched.setModels).toEqual([]);
    expect(untouched.cancels).toEqual([]);
  });
});

describe("JcodeSessionRuntime interruption and disconnect", () => {
  it("cancels the native session exactly once per interrupt", async () => {
    const harness = makeHarness();
    await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        yield* fixture.runtime.sendTurn(turnInput());
        yield* fixture.runtime.interruptTurn();
      }),
    );

    expect(harness.cancels).toEqual([NATIVE_SESSION_ID]);
  });

  it("cancels exactly once when the interrupt names the active turn", async () => {
    const harness = makeHarness();
    await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        const started = yield* fixture.runtime.sendTurn(turnInput());
        yield* fixture.runtime.interruptTurn(started.turnId);
      }),
    );

    expect(harness.cancels).toEqual([NATIVE_SESSION_ID]);
  });

  it("ignores an interrupt that names a turn other than the active one", async () => {
    const harness = makeHarness();
    await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        yield* fixture.runtime.sendTurn(turnInput());
        yield* fixture.runtime.interruptTurn(TurnId.make("some-other-turn"));
      }),
    );

    expect(harness.cancels).toEqual([]);
  });

  it("does not cancel when no turn is active", async () => {
    const harness = makeHarness();
    await withRuntime(harness, {}, (fixture) => fixture.runtime.interruptTurn());

    expect(harness.cancels).toEqual([]);
  });

  it("does not abort a completed turn when the transport later fails", async () => {
    const harness = makeHarness();
    const events = await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        const collector = yield* collectAll(fixture.runtime).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* fixture.runtime.sendTurn(turnInput());
        harness.source.push(textDelta("answer"));
        harness.source.push({ ev: "turn_done", session_id: NATIVE_SESSION_ID });
        harness.source.fail(new Error("socket closed"));
        return yield* Fiber.join(collector);
      }),
    );

    const types = events.map((event) => event.type);
    expect(types).toContain("turn.completed");
    expect(types).not.toContain("turn.aborted");
    expect(types.at(-1)).toBe("session.exited");
    for (const event of events) expect(() => decodeRuntimeEvent(event)).not.toThrow();
  });

  it("does not abort a turn that was never accepted when the transport later fails", async () => {
    const harness = makeHarness({
      sendMessage: async () => {
        throw new Error("write failed");
      },
    });
    const events = await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        const collector = yield* collectAll(fixture.runtime).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* expectFailure(fixture.runtime.sendTurn(turnInput()));
        harness.source.fail(new Error("socket closed"));
        return yield* Fiber.join(collector);
      }),
    );

    expect(events.map((event) => event.type)).not.toContain("turn.aborted");
    expect(harness.cancels).toEqual([]);
  });

  it("aborts the active turn, reports the error, and exits on transport failure", async () => {
    const harness = makeHarness();
    const events = await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        const collector = yield* collectAll(fixture.runtime).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* fixture.runtime.sendTurn(turnInput());
        harness.source.push(textDelta("partial"));
        harness.source.fail(new Error(`socket closed at ${NATIVE_SOCKET} for ${SECRET}`));
        return yield* Fiber.join(collector);
      }),
    );

    const types = events.map((event) => event.type);
    expect(types).toContain("turn.aborted");
    expect(types.indexOf("turn.aborted")).toBeLessThan(types.indexOf("runtime.error"));
    expect(types.indexOf("runtime.error")).toBeLessThan(types.indexOf("session.exited"));
    expect(types.at(-1)).toBe("session.exited");
    for (const event of events) expect(() => decodeRuntimeEvent(event)).not.toThrow();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(NATIVE_SOCKET);
    expect(serialized).not.toContain(NATIVE_SESSION_ID);
    expect(harness.closes).toBe(1);
    expect(harness.source.starts).toBe(1);
  });

  it("closes without synthesizing history when the transport fails while idle", async () => {
    const harness = makeHarness();
    const events = await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        const collector = yield* collectAll(fixture.runtime).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        harness.source.fail(new Error("socket closed"));
        return yield* Fiber.join(collector);
      }),
    );

    const types = events.map((event) => event.type);
    expect(types).not.toContain("turn.aborted");
    expect(types.at(-1)).toBe("session.exited");
    expect(harness.histories).toEqual([]);
    expect(harness.source.starts).toBe(1);
    expect(harness.sent).toEqual([]);
  });

  it("never reconnects or retries a mutation after a send failure", async () => {
    const harness = makeHarness({
      sendMessage: async () => {
        throw new Error("write failed");
      },
    });
    const error = await withRuntime(harness, {}, (fixture) =>
      expectFailure(fixture.runtime.sendTurn(turnInput())),
    );

    expect((error as JcodeSessionRuntimeError).operation).toBe("send");
    expect(harness.sent).toHaveLength(1);
    expect(harness.source.starts).toBe(1);
  });
});

describe("JcodeSessionRuntime event mapping", () => {
  it("threads mapper state across events from the seeded initial state", async () => {
    const harness = makeHarness();
    const events = await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        const collector = yield* collect(fixture.runtime, 3).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        harness.source.push(textDelta("a"));
        harness.source.push(textDelta("b"));
        return yield* Fiber.join(collector);
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "item.started",
      "content.delta",
      "content.delta",
    ]);
  });

  it("stamps every SDK event with a unique canonical event id", async () => {
    const harness = makeHarness();
    const events = await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        const collector = yield* collect(fixture.runtime, 4).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        harness.source.push(textDelta("a"));
        harness.source.push(textDelta("b"));
        harness.source.push(textDelta("c"));
        return yield* Fiber.join(collector);
      }),
    );

    const ids = events.map((event) => event.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const event of events) expect(() => decodeRuntimeEvent(event)).not.toThrow();
  });

  it("aborts and closes when the mapper reports a fatal permission request", async () => {
    const harness = makeHarness();
    const events = await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        const collector = yield* collectAll(fixture.runtime).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* fixture.runtime.sendTurn(turnInput());
        harness.source.push({
          ev: "permission_request",
          session_id: NATIVE_SESSION_ID,
          request_id: "native-request-abc",
          tool_name: "bash",
          description: "run a command",
        });
        return yield* Fiber.join(collector);
      }),
    );

    const types = events.map((event) => event.type);
    expect(types).toContain("runtime.error");
    expect(types).toContain("turn.aborted");
    expect(types.at(-1)).toBe("session.exited");
    expect(JSON.stringify(events)).not.toContain("native-request-abc");
    expect(harness.closes).toBe(1);
  });

  it("keeps ignoring compaction acknowledgements", async () => {
    const harness = makeHarness();
    const events = await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        const collector = yield* collect(fixture.runtime, 1).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        harness.source.push({ ev: "compacted", session_id: NATIVE_SESSION_ID } as ApiEvent);
        harness.source.push(textDelta("a"));
        return yield* Fiber.join(collector);
      }),
    );

    expect(events.map((event) => event.type)).toEqual(["item.started"]);
  });
});

describe("JcodeSessionRuntime finalization and privacy", () => {
  it("closes the child client and the event fiber exactly once", async () => {
    const harness = makeHarness();
    await runScoped(() =>
      Effect.gen(function* () {
        const built = yield* scenario(harness, {});
        const runtime = yield* makeJcodeSessionRuntime(built.input);
        yield* runtime.close;
        yield* runtime.close;
      }),
    );

    expect(harness.closes).toBe(1);
    expect(harness.source.returns).toBe(1);
  });

  it("closes the child client when the owning scope closes", async () => {
    const harness = makeHarness();
    await runScoped(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const built = yield* scenario(harness, {});
          yield* makeJcodeSessionRuntime(built.input);
        }),
      ),
    );

    expect(harness.closes).toBe(1);
  });

  it("keeps native identity, credentials, sockets, and private paths out of every error surface", async () => {
    const harness = makeHarness({
      createSession: async () => {
        throw new Error(`create failed on ${NATIVE_SOCKET} with ${SECRET}`);
      },
    });
    const { error, identityPath } = await startFailure(harness, {});

    const surface = observableSurface(error);
    expect(error.operation).toBe("create");
    expect(surface).not.toContain(SECRET);
    expect(surface).not.toContain(NATIVE_SOCKET);
    expect(surface).not.toContain(identityPath);
    expect(surface).not.toContain(NATIVE_SESSION_ID);
  });

  it("keeps the attachment path out of an attachment failure surface", async () => {
    const harness = makeHarness();
    const observed = await withRuntime(harness, {}, (fixture) =>
      Effect.gen(function* () {
        const error = yield* expectFailure(
          fixture.runtime.sendTurn(turnInput({ attachments: [imageAttachment] })),
        );
        return { surface: observableSurface(error), dir: fixture.attachmentsDir };
      }),
    );

    expect(observed.surface).not.toContain(observed.dir);
    expect(observed.surface).not.toContain(NATIVE_SESSION_ID);
  });
});
