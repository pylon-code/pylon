import type { ApiEvent, LaunchOptions, SessionInfo } from "@1jehuang/jcode-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import {
  makeJcodeInstanceManager,
  type JcodeInstanceManager,
  type JcodeInstanceProbe,
} from "../jcode/JcodeInstanceManager.ts";
import { jcodeThreadIdentityPath } from "../jcode/JcodePaths.ts";
import {
  makeJcodeSdkBridge,
  type JcodeSdkClientLike,
  type JcodeSdkModule,
} from "../jcode/JcodeSdkBridge.ts";
import { makeJcodeAdapter, type JcodeAdapterShape } from "./JcodeAdapter.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

const NATIVE_SOCKET = "/private/var/folders/jcode-home-abc/api.sock";
const NATIVE_SESSION_ID = "native-session-abc";
const INSTANCE_KEY = "jcode_local";
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("jcode_local");
const THREAD_ID = ThreadId.make("thread-1");
const OTHER_THREAD_ID = ThreadId.make("thread-2");

interface SourceItem {
  readonly kind: "event" | "end";
  readonly value?: ApiEvent;
  /** Resolved once the consumer has processed this frame and asked for the next. */
  readonly delivered?: () => void;
}

/** A hand-driven SDK event source so tests decide exactly when frames land. */
class EventSource {
  private readonly items: SourceItem[] = [];
  private readonly waiters: Array<() => void> = [];

  push(value: ApiEvent): void {
    this.items.push({ kind: "event", value });
    this.wake();
  }

  /**
   * Pushes a frame and resolves only after the runtime's event pump has mapped
   * it. That is what makes an ordering test deterministic instead of dependent
   * on scheduler luck: awaiting this inside `sendMessage` guarantees the mapped
   * events are already queued ahead of the adapter's `turn.started`.
   */
  pushAwaited(value: ApiEvent): Promise<void> {
    return new Promise<void>((resolve) => {
      this.items.push({ kind: "event", value, delivered: resolve });
      this.wake();
    });
  }

  end(): void {
    this.items.push({ kind: "end" });
    this.wake();
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  iterator(): AsyncIterableIterator<ApiEvent> {
    const self = this;
    return (async function* () {
      for (;;) {
        while (self.items.length === 0) {
          await new Promise<void>((resolve) => {
            self.waiters.push(resolve);
          });
        }
        const next = self.items.shift()!;
        if (next.kind === "end") return;
        yield next.value as ApiEvent;
        // Reached only once the consumer requests the following frame.
        next.delivered?.();
      }
    })();
  }
}

interface FakeClient {
  readonly sessionId: string;
  readonly source: EventSource;
  readonly sent: Array<{ readonly sessionId: string; readonly content: string }>;
  readonly setModels: Array<{ readonly sessionId: string; readonly model: string }>;
  readonly setEfforts: Array<{ readonly sessionId: string; readonly effort: string }>;
  readonly cancels: string[];
  readonly detached: string[];
  closes: number;
}

interface FakeSdk {
  readonly sdk: JcodeSdkModule;
  /** One entry per `connect`, so per-session lifetimes are countable. */
  readonly clients: FakeClient[];
  /** One entry per launched daemon, so "exactly one instance" is measurable. */
  readonly launches: LaunchOptions[];
}

function sessionInfo(sessionId: string, workingDir?: string): SessionInfo {
  return {
    session_id: sessionId,
    status: "idle",
    ...(workingDir === undefined ? {} : { working_dir: workingDir }),
  };
}

interface FakeSdkOptions {
  /**
   * Runs inside `sendMessage`, before its promise resolves. This is the only way
   * to model a daemon that streams its first frame while `sendTurn` is still in
   * flight, which is what makes the `turn.started` ordering guarantee testable.
   */
  readonly onSendMessage?: (client: FakeClient) => Promise<void> | void;
}

function makeFakeSdk(options: FakeSdkOptions = {}): FakeSdk {
  const clients: FakeClient[] = [];
  const launches: LaunchOptions[] = [];
  const sdk: JcodeSdkModule = {
    launchInstance: async (launchOptions) => {
      launches.push(launchOptions);
      return {
        socketPath: NATIVE_SOCKET,
        jcodeHome: launchOptions.jcodeHome ?? "/private/var/folders/jcode-home-abc",
        shutdown: async () => {},
      };
    },
    userJcodeHome: () => "/Users/someone/.jcode",
    inheritCredentials: () => ["auth.json"],
    connect: async () => {
      const state: FakeClient = {
        sessionId: `${NATIVE_SESSION_ID}-${clients.length + 1}`,
        source: new EventSource(),
        sent: [],
        setModels: [],
        setEfforts: [],
        cancels: [],
        detached: [],
        closes: 0,
      };
      clients.push(state);
      const client: JcodeSdkClientLike = {
        server: "jcode-harness-api-bridge/0.1.0",
        capabilities: ["sessions", "models"],
        supports: () => true,
        createSession: async (workingDir) => sessionInfo(state.sessionId, workingDir),
        attachSession: async (sessionId) => sessionInfo(sessionId),
        detachSession: async (sessionId) => {
          state.detached.push(sessionId);
        },
        listSessions: async () => [],
        listModels: async () => ({ models: [] }),
        getRuntimeInfo: async () => {
          throw new Error("not used");
        },
        setModel: async (sessionId, model) => {
          state.setModels.push({ sessionId, model });
        },
        setReasoningEffort: async (sessionId, effort) => {
          state.setEfforts.push({ sessionId, effort });
        },
        sendMessage: async (sessionId, content) => {
          state.sent.push({ sessionId, content });
          await options.onSendMessage?.(state);
        },
        cancel: async (sessionId) => {
          state.cancels.push(sessionId);
        },
        getHistory: async () => [],
        events: () => state.source.iterator(),
        close: async () => {
          state.closes += 1;
          state.source.end();
        },
      };
      return client;
    },
  };
  return { sdk, clients, launches };
}

const PROBE: JcodeInstanceProbe = {
  server: "jcode 0.73.0",
  protocolVersion: 1,
  capabilities: ["sessions", "models"],
  currentModel: "claude-opus-5",
  models: [{ model: "claude-opus-5", provider: "anthropic", available: true }],
};

interface ManagerDouble {
  readonly manager: JcodeInstanceManager;
  /** Times the adapter asked for a fresh child connection. */
  connects: () => number;
  /** Times the adapter released a child connection back to the manager. */
  releases: () => number;
  shutdowns: () => number;
}

function makeManagerDouble(fake: FakeSdk): {
  readonly double: ManagerDouble;
  readonly bridge: ReturnType<typeof makeJcodeSdkBridge>;
} {
  const bridge = makeJcodeSdkBridge(fake.sdk);
  let connects = 0;
  let releases = 0;
  let shutdowns = 0;
  const manager: JcodeInstanceManager = {
    probe: Effect.succeed(PROBE),
    connectSessionClient: Effect.suspend(() => {
      connects += 1;
      return bridge
        .connect({ socketPath: NATIVE_SOCKET, clientName: "pylon-jcode-session/1" })
        .pipe(Effect.orDie);
    }),
    releaseSessionClient: () =>
      Effect.sync(() => {
        releases += 1;
      }),
    shutdown: Effect.sync(() => {
      shutdowns += 1;
    }),
  };
  return {
    double: {
      manager,
      connects: () => connects,
      releases: () => releases,
      shutdowns: () => shutdowns,
    },
    bridge,
  };
}

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "jcode-adapter-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

interface Fixture {
  readonly adapter: JcodeAdapterShape;
  readonly fake: FakeSdk;
  readonly manager: ManagerDouble;
  readonly cwd: string;
}

/** Builds an adapter plus its fakes inside the caller's scope. */
const fixture = (
  options: {
    readonly manager?: JcodeInstanceManager | undefined;
    readonly sdk?: FakeSdkOptions;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "jcode-adapter-cwd-" });
    const fake = makeFakeSdk(options.sdk ?? {});
    const { double, bridge } = makeManagerDouble(fake);
    const adapter = yield* makeJcodeAdapter({
      providerInstanceId: PROVIDER_INSTANCE_ID,
      instanceKey: INSTANCE_KEY,
      bridge,
      manager: "manager" in options ? options.manager : double.manager,
    });
    return { adapter, fake, manager: double, cwd } satisfies Fixture;
  });

const startInput = (
  overrides: Partial<ProviderSessionStartInput> & { readonly cwd: string },
): ProviderSessionStartInput => ({
  threadId: THREAD_ID,
  runtimeMode: "full-access",
  ...overrides,
});

/**
 * Subscribes before the producer runs and collects exactly `count` events.
 * `startImmediately` is what guarantees the subscription exists before the
 * caller triggers the work that emits.
 */
const collectEvents = (adapter: JcodeAdapterShape, count: number) =>
  Stream.runCollect(Stream.take(adapter.streamEvents, count)).pipe(
    Effect.map((chunk) => Array.from(chunk).map((event) => decodeRuntimeEvent(event))),
    Effect.forkChild({ startImmediately: true }),
  );

/**
 * The same adapter, but over the *real* instance manager.
 *
 * The manager double cannot answer "how many daemons did two threads launch",
 * because it never launches one. Here the launch, the control client, the hidden
 * probe session, and every child connection are production code paths, with only
 * the SDK module faked.
 */
const concurrentFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fake = makeFakeSdk();
    const bridge = makeJcodeSdkBridge(fake.sdk);
    const manager = yield* makeJcodeInstanceManager({
      bridge,
      instanceId: INSTANCE_KEY,
      stateDir: serverConfig.stateDir,
      settings: { binaryPath: "/usr/local/bin/jcode", inheritLogins: true },
      environment: { PATH: "/usr/bin" },
      credentialValues: [],
      // A private alias base, short like the production default and removed
      // with the scope. Rooting it under the deep test state directory would
      // trip the very socket-length guard this fix adds.
      launchAliasBase: yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "pj-" }),
    }).pipe(Effect.orDie);
    const adapter = yield* makeJcodeAdapter({
      providerInstanceId: PROVIDER_INSTANCE_ID,
      instanceKey: INSTANCE_KEY,
      bridge,
      manager,
    });
    // Two threads with their own working directories, as two Pylon threads have.
    const firstCwd = yield* fs.makeTempDirectoryScoped({ prefix: "jcode-adapter-cwd-a-" });
    const secondCwd = yield* fs.makeTempDirectoryScoped({ prefix: "jcode-adapter-cwd-b-" });
    const identityPath = (threadId: ThreadId) =>
      jcodeThreadIdentityPath({
        stateDir: serverConfig.stateDir,
        instanceId: INSTANCE_KEY,
        threadId,
        join: (...segments) => path.join(...segments),
      });
    yield* adapter.startSession(startInput({ cwd: firstCwd }));
    yield* adapter.startSession(startInput({ cwd: secondCwd, threadId: OTHER_THREAD_ID }));
    return {
      adapter,
      fake,
      firstCwd,
      secondCwd,
      identityPath,
      // Index 0 is the manager's control client; each thread owns the next one.
      firstClient: fake.clients[1]!,
      secondClient: fake.clients[2]!,
    };
  });

const textDelta = (client: FakeClient, text: string): ApiEvent =>
  ({ ev: "text_delta", session_id: client.sessionId, text }) as ApiEvent;

const turnDone = (client: FakeClient): ApiEvent =>
  ({ ev: "turn_done", session_id: client.sessionId }) as ApiEvent;

describe("makeJcodeAdapter", () => {
  it.effect("declares the Jcode adapter contract", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter } = yield* fixture();

        expect(adapter.provider).toBe("jcode");
        expect(adapter.capabilities).toEqual({
          sessionModelSwitch: "in-session",
          conversationRollback: "unsupported",
        });
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("starts a full-access session and reports it ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, fake, manager, cwd } = yield* fixture();
        const session = yield* adapter.startSession(startInput({ cwd }));

        expect(session).toMatchObject({
          provider: "jcode",
          providerInstanceId: PROVIDER_INSTANCE_ID,
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          status: "ready",
          cwd,
        });
        expect(manager.connects()).toBe(1);
        expect(fake.clients).toHaveLength(1);
        expect(yield* adapter.hasSession(THREAD_ID)).toBe(true);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("never leaks native session ids or socket paths through the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, cwd } = yield* fixture();
        const session = yield* adapter.startSession(startInput({ cwd }));

        // Serialize the whole value so a native identifier cannot hide at depth.
        // @effect-diagnostics-next-line preferSchemaOverJson:off - leak assertion, not decoding.
        const serialized = JSON.stringify(session);
        expect(serialized).not.toContain(NATIVE_SESSION_ID);
        expect(serialized).not.toContain(NATIVE_SOCKET);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects every runtime mode other than full-access without connecting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, manager, cwd } = yield* fixture();

        for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
          const result = yield* adapter
            .startSession(startInput({ cwd, runtimeMode }))
            .pipe(Effect.result);

          expect(Result.isFailure(result), `${runtimeMode} must be rejected`).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("ProviderAdapterValidationError");
          }
        }
        // Defensive rejection must happen before any child connection is opened.
        expect(manager.connects()).toBe(0);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("requires a working directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, manager } = yield* fixture();
        const result = yield* adapter
          .startSession({ threadId: THREAD_ID, runtimeMode: "full-access" })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("ProviderAdapterValidationError");
        }
        expect(manager.connects()).toBe(0);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a second session for a thread it already owns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, manager, cwd } = yield* fixture();
        yield* adapter.startSession(startInput({ cwd }));
        const result = yield* adapter.startSession(startInput({ cwd })).pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("ProviderAdapterValidationError");
        }
        expect(manager.connects()).toBe(1);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails startSession with a typed error when the private instance is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, cwd } = yield* fixture({ manager: undefined });
        const result = yield* adapter.startSession(startInput({ cwd })).pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("ProviderAdapterProcessError");
        }
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("emits turn.started itself, because the runtime never does", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, fake, cwd } = yield* fixture();
        yield* adapter.startSession(startInput({ cwd }));
        const collector = yield* collectEvents(adapter, 1);

        const started = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });
        const events = yield* Fiber.join(collector);

        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe("turn.started");
        expect(events[0]?.threadId).toBe(THREAD_ID);
        expect(events[0]?.turnId).toBe(started.turnId);
        expect(fake.clients[0]?.sent.map((entry) => entry.content)).toEqual(["hello"]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("owns the session status transition into running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, cwd } = yield* fixture();
        yield* adapter.startSession(startInput({ cwd }));
        const started = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });

        const sessions = yield* adapter.listSessions();
        expect(sessions[0]?.status).toBe("running");
        expect(sessions[0]?.activeTurnId).toBe(started.turnId);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("forwards mapped runtime events from the session runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, fake, cwd } = yield* fixture();
        yield* adapter.startSession(startInput({ cwd }));
        // The adapter's own turn.started, then the pair the mapper makes of one
        // assistant text delta.
        const collector = yield* collectEvents(adapter, 3);

        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });
        const client = fake.clients[0]!;
        client.source.push({
          ev: "text_delta",
          session_id: client.sessionId,
          text: "hi",
        } as ApiEvent);

        const events = yield* Fiber.join(collector);
        expect(events.map((event) => event.type)).toEqual([
          "turn.started",
          "item.started",
          "content.delta",
        ]);
        // Mapped events must be correlated with the turn the adapter announced.
        expect(events[2]?.turnId).toBe(events[0]?.turnId);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a turn for an unknown thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter } = yield* fixture();
        const result = yield* adapter
          .sendTurn({ threadId: THREAD_ID, input: "hello" })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("ProviderAdapterSessionNotFoundError");
        }
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a concurrent turn while the first is still running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, cwd } = yield* fixture();
        yield* adapter.startSession(startInput({ cwd }));
        // Deliberately never completed: this case must fail because a turn is
        // genuinely in flight, which is only meaningful alongside the
        // "accepts a second turn after the first completes" case below.
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first" });
        const result = yield* adapter
          .sendTurn({ threadId: THREAD_ID, input: "second" })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("ProviderAdapterValidationError");
        }
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("releases the turn when the runtime reports it completed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, fake, cwd } = yield* fixture();
        yield* adapter.startSession(startInput({ cwd }));
        // turn.started, then turn.completed forwarded from the runtime.
        const collector = yield* collectEvents(adapter, 2);
        const started = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });

        const client = fake.clients[0]!;
        client.source.push({ ev: "turn_done", session_id: client.sessionId } as ApiEvent);
        const events = yield* Fiber.join(collector);

        expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
        expect(events[1]?.turnId).toBe(started.turnId);

        const sessions = yield* adapter.listSessions();
        expect(sessions[0]?.status).toBe("ready");
        expect(sessions[0]?.activeTurnId).toBeUndefined();
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("accepts a second turn after the first one completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, fake, cwd } = yield* fixture();
        yield* adapter.startSession(startInput({ cwd }));
        const first = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });

        const client = fake.clients[0]!;
        const completed = yield* collectEvents(adapter, 1);
        client.source.push({ ev: "turn_done", session_id: client.sessionId } as ApiEvent);
        yield* Fiber.join(completed);

        const second = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "thanks" });

        expect(second.turnId).not.toBe(first.turnId);
        expect(client.sent.map((entry) => entry.content)).toEqual(["hello", "thanks"]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("retires a session whose runtime exited and frees the thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, fake, manager, cwd } = yield* fixture();
        yield* adapter.startSession(startInput({ cwd }));
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });

        const client = fake.clients[0]!;
        // The runtime answers a dead transport with turn.aborted + session.exited.
        const exited = yield* Stream.runCollect(
          Stream.takeUntil(adapter.streamEvents, (event) => event.type === "session.exited"),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        client.source.end();
        const events = Array.from(yield* Fiber.join(exited));

        expect(events.map((event) => event.type)).toContain("session.exited");
        expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
        expect(yield* adapter.listSessions()).toEqual([]);
        // Retirement hands the scope close to the adapter scope rather than
        // closing from the scope-owned forwarding fiber, and teardown stays
        // idempotent: exactly one child close.
        expect(client.closes).toBe(1);

        // The thread must be startable again rather than wedged behind a corpse.
        const restarted = yield* adapter.startSession(startInput({ cwd }));
        expect(restarted.threadId).toBe(THREAD_ID);
        expect(restarted.status).toBe("ready");
        expect(manager.connects()).toBe(2);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes turn.started before any event the daemon emits during send", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The frame is pushed from inside `sendMessage`, before it resolves, so
        // only a structural ordering guarantee can keep turn.started first.
        const { adapter, cwd } = yield* fixture({
          sdk: {
            onSendMessage: (client) =>
              client.source.pushAwaited({
                ev: "text_delta",
                session_id: client.sessionId,
                text: "eager",
              } as ApiEvent),
          },
        });
        yield* adapter.startSession(startInput({ cwd }));
        const collector = yield* collectEvents(adapter, 3);

        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });
        const events = yield* Fiber.join(collector);

        expect(events[0]?.type).toBe("turn.started");
        expect(events.map((event) => event.type)).toEqual([
          "turn.started",
          "item.started",
          "content.delta",
        ]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("records an in-session model switch on the session and the turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, fake, cwd } = yield* fixture();
        yield* adapter.startSession(
          startInput({
            cwd,
            modelSelection: { instanceId: PROVIDER_INSTANCE_ID, model: "claude-opus-5" },
          }),
        );
        const collector = yield* collectEvents(adapter, 1);
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          modelSelection: { instanceId: PROVIDER_INSTANCE_ID, model: "claude-fable-5" },
        });
        const events = yield* Fiber.join(collector);

        expect(fake.clients[0]?.setModels.map((entry) => entry.model)).toEqual(["claude-fable-5"]);
        expect(events[0]?.payload).toMatchObject({ model: "claude-fable-5" });
        const sessions = yield* adapter.listSessions();
        expect(sessions[0]?.model).toBe("claude-fable-5");
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("never fabricates a model for a session started without a selection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, cwd } = yield* fixture();
        yield* adapter.startSession(startInput({ cwd }));
        const collector = yield* collectEvents(adapter, 1);
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });
        const events = yield* Fiber.join(collector);

        // `"default"` is not a Jcode model; publishing it would persist a lie
        // against the turn.
        expect(events[0]?.payload).toEqual({});
        const sessions = yield* adapter.listSessions();
        expect(sessions[0]?.model).toBeUndefined();
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues restart-unique adapter event ids", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* fixture();
        const second = yield* fixture();
        yield* first.adapter.startSession(startInput({ cwd: first.cwd }));
        yield* second.adapter.startSession(startInput({ cwd: second.cwd }));

        const firstEvent = yield* collectEvents(first.adapter, 1);
        const secondEvent = yield* collectEvents(second.adapter, 1);
        yield* first.adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });
        yield* second.adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });

        const firstId = (yield* Fiber.join(firstEvent))[0]?.eventId;
        const secondId = (yield* Fiber.join(secondEvent))[0]?.eventId;
        expect(firstId).toBeDefined();
        expect(firstId).not.toBe(secondId);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("passes the attached model on resume so the first turn issues no setModel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, fake, cwd } = yield* fixture();
        yield* adapter.startSession(
          startInput({
            cwd,
            modelSelection: { instanceId: PROVIDER_INSTANCE_ID, model: "claude-opus-5" },
          }),
        );
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          modelSelection: { instanceId: PROVIDER_INSTANCE_ID, model: "claude-opus-5" },
        });

        expect(fake.clients[0]?.setModels).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("interrupts the active turn through the session runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, fake, cwd } = yield* fixture();
        yield* adapter.startSession(startInput({ cwd }));
        const started = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });
        yield* adapter.interruptTurn(THREAD_ID, started.turnId);

        expect(fake.clients[0]?.cancels).toHaveLength(1);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails interruptTurn for an unknown thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter } = yield* fixture();
        const result = yield* adapter.interruptTurn(THREAD_ID).pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("ProviderAdapterSessionNotFoundError");
        }
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("stops one session exactly once and forgets it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, fake, manager, cwd } = yield* fixture();
        yield* adapter.startSession(startInput({ cwd }));
        yield* adapter.stopSession(THREAD_ID);

        // The runtime's close is idempotent and also runs as a scope finalizer;
        // the adapter must not close the child client or release manager ownership twice.
        expect(fake.clients[0]?.closes).toBe(1);
        expect(manager.releases()).toBe(1);
        expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
        expect(yield* adapter.listSessions()).toEqual([]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails stopSession for an unknown thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter } = yield* fixture();
        const result = yield* adapter.stopSession(THREAD_ID).pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("ProviderAdapterSessionNotFoundError");
        }
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("tracks independent sessions per thread and stops all of them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, fake, manager, cwd } = yield* fixture();
        yield* adapter.startSession(startInput({ cwd }));
        yield* adapter.startSession(startInput({ cwd, threadId: OTHER_THREAD_ID }));

        expect(manager.connects()).toBe(2);
        expect((yield* adapter.listSessions()).map((session) => session.threadId).sort()).toEqual(
          [THREAD_ID, OTHER_THREAD_ID].sort(),
        );

        yield* adapter.stopAll();

        expect(fake.clients.map((client) => client.closes)).toEqual([1, 1]);
        expect(manager.releases()).toBe(2);
        expect(yield* adapter.listSessions()).toEqual([]);
        expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
        expect(yield* adapter.hasSession(OTHER_THREAD_ID)).toBe(false);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("closes live sessions when the adapter scope closes", () =>
    Effect.gen(function* () {
      const captured: FakeSdk[] = [];
      const managers: ManagerDouble[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { adapter, fake, manager, cwd } = yield* fixture();
          captured.push(fake);
          managers.push(manager);
          yield* adapter.startSession(startInput({ cwd }));
          expect(manager.releases()).toBe(0);
        }),
      );

      expect(captured[0]?.clients[0]?.closes).toBe(1);
      expect(managers[0]?.releases()).toBe(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reads an empty thread snapshot and refuses durable rollback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, cwd } = yield* fixture();
        yield* adapter.startSession(startInput({ cwd }));

        expect(yield* adapter.readThread(THREAD_ID)).toEqual({
          threadId: THREAD_ID,
          turns: [],
        });

        const rollback = yield* adapter.rollbackThread(THREAD_ID, 1).pipe(Effect.result);
        expect(Result.isFailure(rollback)).toBe(true);
        if (
          Result.isFailure(rollback) &&
          rollback.failure._tag === "ProviderAdapterUnsupportedOperationError"
        ) {
          expect(rollback.failure.operation).toBe("rollbackThread");
        } else {
          expect.unreachable("rollbackThread must report a typed unsupported operation");
        }
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns typed unsupported errors for approvals and user input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, cwd } = yield* fixture();
        yield* adapter.startSession(startInput({ cwd }));

        const approval = yield* adapter
          .respondToRequest(THREAD_ID, "request-1" as never, "approve" as never)
          .pipe(Effect.result);
        if (
          Result.isFailure(approval) &&
          approval.failure._tag === "ProviderAdapterUnsupportedOperationError"
        ) {
          expect(approval.failure.operation).toBe("respondToRequest");
        } else {
          expect.unreachable("respondToRequest must report a typed unsupported operation");
        }

        const userInput = yield* adapter
          .respondToUserInput(THREAD_ID, "request-1" as never, {} as never)
          .pipe(Effect.result);
        if (
          Result.isFailure(userInput) &&
          userInput.failure._tag === "ProviderAdapterUnsupportedOperationError"
        ) {
          expect(userInput.failure.operation).toBe("respondToUserInput");
        } else {
          expect.unreachable("respondToUserInput must report a typed unsupported operation");
        }
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("serves two threads from one launched instance with private identities", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { fake, firstCwd, secondCwd, identityPath, firstClient, secondClient } =
          yield* concurrentFixture();

        // One daemon for the provider instance, one control client, and exactly
        // one child connection per thread.
        expect(fake.launches).toHaveLength(1);
        expect(fake.clients).toHaveLength(3);
        expect(firstClient).not.toBe(secondClient);

        const files = [identityPath(THREAD_ID), identityPath(OTHER_THREAD_ID)];
        expect(files[0]).not.toBe(files[1]);
        const identities = yield* Effect.forEach(files, (file) => fs.readFileString(file));
        const parsed = identities.map(
          (source) =>
            JSON.parse(source) as { readonly sessionId: string; readonly workingDir: string },
        );
        // Each thread has its own private identity file naming its own native
        // session and its own working directory.
        expect(parsed[0]!.sessionId).not.toBe(parsed[1]!.sessionId);
        expect(parsed.map((identity) => identity.sessionId)).toEqual([
          firstClient.sessionId,
          secondClient.sessionId,
        ]);
        expect(parsed.map((identity) => identity.workingDir)).toEqual([firstCwd, secondCwd]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps interleaved events attached to the thread and turn that produced them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, firstClient, secondClient } = yield* concurrentFixture();
        // Two turn.started, then item.started + content.delta for each thread's
        // first delta, plus one more content.delta on the first thread.
        const collector = yield* collectEvents(adapter, 7);
        const firstTurn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "one" });
        const secondTurn = yield* adapter.sendTurn({ threadId: OTHER_THREAD_ID, input: "two" });

        firstClient.source.push(textDelta(firstClient, "a"));
        secondClient.source.push(textDelta(secondClient, "b"));
        firstClient.source.push(textDelta(firstClient, "c"));
        const events = yield* Fiber.join(collector);

        const forThread = (threadId: ThreadId) =>
          events.filter((event) => event.threadId === threadId);
        expect(forThread(THREAD_ID).map((event) => event.type)).toEqual([
          "turn.started",
          "item.started",
          "content.delta",
          "content.delta",
        ]);
        expect(forThread(OTHER_THREAD_ID).map((event) => event.type)).toEqual([
          "turn.started",
          "item.started",
          "content.delta",
        ]);
        // Nothing crosses over: every event carries its own thread's turn id.
        expect(firstTurn.turnId).not.toBe(secondTurn.turnId);
        expect(new Set(forThread(THREAD_ID).map((event) => event.turnId))).toEqual(
          new Set([firstTurn.turnId]),
        );
        expect(new Set(forThread(OTHER_THREAD_ID).map((event) => event.turnId))).toEqual(
          new Set([secondTurn.turnId]),
        );
        expect(firstClient.sent.map((entry) => entry.content)).toEqual(["one"]);
        expect(secondClient.sent.map((entry) => entry.content)).toEqual(["two"]);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("stopping one thread neither detaches nor cancels the other", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, firstClient, secondClient } = yield* concurrentFixture();
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "one" });
        const survivor = yield* adapter.sendTurn({ threadId: OTHER_THREAD_ID, input: "two" });

        // Subscribed before the stop, so nothing published in between is missed.
        const collector = yield* Stream.runCollect(
          Stream.takeUntil(adapter.streamEvents, (event) => event.type === "turn.completed"),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* adapter.stopSession(THREAD_ID);

        expect(firstClient.closes).toBe(1);
        expect(secondClient.closes).toBe(0);
        expect(secondClient.detached).toEqual([]);
        expect(secondClient.cancels).toEqual([]);
        expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
        expect(yield* adapter.hasSession(OTHER_THREAD_ID)).toBe(true);

        // The surviving thread's turn still completes on its own child client.
        secondClient.source.push(turnDone(secondClient));
        const events = Array.from(yield* Fiber.join(collector)).map((event) =>
          decodeRuntimeEvent(event),
        );
        expect(
          events.filter((event) => event.threadId === OTHER_THREAD_ID).map((event) => event.type),
        ).toEqual(["turn.completed"]);
        expect(events.at(-1)?.turnId).toBe(survivor.turnId);
        // Stopping a thread never fabricates a completion for it.
        expect(
          events.filter((event) => event.threadId === THREAD_ID && event.type === "turn.completed"),
        ).toEqual([]);

        const sessions = yield* adapter.listSessions();
        expect(sessions.map((session) => session.threadId)).toEqual([OTHER_THREAD_ID]);
        expect(sessions[0]?.status).toBe("ready");
        expect(sessions[0]?.activeTurnId).toBeUndefined();
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("omits every optional operation Jcode cannot honor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter } = yield* fixture();

        // `ProviderService` treats an absent optional member as unsupported and
        // returns `ProviderUnsupportedError`. Defining an always-failing member
        // would instead read as "supported" to any presence check.
        for (const operation of [
          "respondToInteraction",
          "reloadSessionResources",
          "askSessionSideQuestion",
          "cancelSessionSideQuestion",
          "cancelSessionAgent",
          "messageSessionAgent",
          "watchSessionAgentActivity",
          "getSessionAgentDepth",
          "setSessionAgentDepth",
          "followUp",
          "getSessionInputQueue",
          "clearSessionInputQueue",
          "setSessionInputQueueMode",
          "getSessionCompaction",
          "compactSession",
          "abortSessionCompaction",
          "setSessionAutoCompaction",
          "refineSessionHarness",
        ] as const) {
          expect(adapter[operation], `${operation} must stay unsupported`).toBeUndefined();
        }
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
