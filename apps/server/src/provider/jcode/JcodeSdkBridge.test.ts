import { inspect } from "node:util";

import { HarnessError } from "@1jehuang/jcode-sdk";
import type { ApiEvent, LaunchedInstance, SessionInfo } from "@1jehuang/jcode-sdk";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import {
  JcodeSdkOperationError,
  type JcodeSdkBridgeError,
  JcodeSessionNotFoundError,
  makeJcodeSdkBridge,
  type JcodeSdkClientLike,
  type JcodeSdkModule,
} from "./JcodeSdkBridge.ts";

function asOperationError(error: JcodeSdkBridgeError): JcodeSdkOperationError {
  if (!(error instanceof JcodeSdkOperationError)) {
    throw new Error(`expected JcodeSdkOperationError, got ${error._tag}`);
  }
  return error;
}

function asSessionNotFoundError(error: JcodeSdkBridgeError): JcodeSessionNotFoundError {
  if (!(error instanceof JcodeSessionNotFoundError)) {
    throw new Error(`expected JcodeSessionNotFoundError, got ${error._tag}`);
  }
  return error;
}

const SECRET = "sk-ant-secret-value-1234";
const NATIVE_PATH = "/private/var/folders/jcode-home-abc/api.sock";

/**
 * Everything a logger, crash printer, or serializer can realistically observe
 * on a bridge error. Redaction has to hold across all of it, not just `detail`.
 */
function observableSurface(error: JcodeSdkBridgeError): string {
  return [
    inspect(error, { depth: 10 }),
    JSON.stringify(error),
    JSON.stringify({ error }),
    String(error),
    error.stack ?? "",
    Cause.pretty(Cause.fail(error)),
  ].join("\n");
}

function sessionInfo(sessionId: string): SessionInfo {
  return { session_id: sessionId, status: "idle" };
}

function fakeClient(overrides: Partial<JcodeSdkClientLike> = {}): JcodeSdkClientLike {
  return {
    server: "jcode-harness-api-bridge/0.1.0",
    capabilities: ["sessions", "models"],
    supports: (capability) =>
      (overrides.capabilities ?? ["sessions", "models"]).includes(capability),
    createSession: async () => sessionInfo("created"),
    attachSession: async (sessionId) => sessionInfo(sessionId),
    detachSession: async () => {},
    listSessions: async () => [],
    listModels: async () => ({ models: [] }),
    getRuntimeInfo: async () => {
      throw new Error("not used");
    },
    setModel: async () => {},
    setReasoningEffort: async () => {},
    sendMessage: async () => {},
    cancel: async () => {},
    getHistory: async () => [],
    // eslint-disable-next-line require-yield
    events: async function* () {},
    close: async () => {},
    ...overrides,
  } as JcodeSdkClientLike;
}

function fakeSdk(overrides: Partial<JcodeSdkModule> = {}): JcodeSdkModule {
  return {
    launchInstance: async () =>
      ({
        socketPath: NATIVE_PATH,
        jcodeHome: "/private/var/folders/jcode-home-abc",
        shutdown: async () => {},
      }) as unknown as LaunchedInstance,
    connect: async () => fakeClient(),
    userJcodeHome: () => "/Users/someone/.jcode",
    inheritCredentials: () => ["auth.json"],
    ...overrides,
  };
}

describe("JcodeSdkBridge credential inheritance", () => {
  it("reports the inherited names through the same typed boundary", async () => {
    const calls: Array<{ from: string; to: string }> = [];
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        userJcodeHome: () => "/Users/someone/.jcode",
        inheritCredentials: (fromHome: string, toHome: string) => {
          calls.push({ from: fromHome, to: toHome });
          return ["auth.json", "config.toml"];
        },
      }),
    );

    const home = await Effect.runPromise(bridge.userJcodeHome);
    const inherited = await Effect.runPromise(
      bridge.inheritCredentials({ fromHome: home, toHome: "/state/home" }),
    );

    expect(home).toBe("/Users/someone/.jcode");
    expect(inherited).toEqual(["auth.json", "config.toml"]);
    expect(calls).toEqual([{ from: "/Users/someone/.jcode", to: "/state/home" }]);
  });

  it("maps a synchronous inheritance failure without leaking the native path or secret", async () => {
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        inheritCredentials: () => {
          throw new HarnessError(
            "invalid_instance_home",
            `instance home must be a real directory, not a link or file: ${NATIVE_PATH} for ${SECRET}`,
          );
        },
      }),
    );

    const error = asOperationError(
      await Effect.runPromise(
        Effect.flip(
          bridge.inheritCredentials(
            { fromHome: "/Users/someone/.jcode", toHome: NATIVE_PATH },
            { credentialValues: [SECRET] },
          ),
        ),
      ),
    );

    expect(error.operation).toBe("inheritCredentials");
    expect(error.code).toBe("invalid_instance_home");
    const surface = observableSurface(error);
    expect(surface).not.toContain(SECRET);
    expect(surface).not.toContain(NATIVE_PATH);
  });
});

describe("JcodeSdkBridge launchInstance", () => {
  it("maps launch failures to a typed operation error without leaking env values or native paths", async () => {
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        launchInstance: async () => {
          throw new Error(`spawn failed for ${NATIVE_PATH} with key ${SECRET}`);
        },
      }),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        bridge.launchInstance(
          {
            jcodeHome: "/private/var/folders/jcode-home-abc",
            env: { ANTHROPIC_API_KEY: SECRET },
          },
          { credentialValues: [SECRET] },
        ),
      ),
    );

    expect(error).toBeInstanceOf(JcodeSdkOperationError);
    expect(error._tag).toBe("JcodeSdkOperationError");
    expect(asOperationError(error).operation).toBe("launchInstance");
    expect(asOperationError(error).detail).not.toContain(SECRET);
    expect(asOperationError(error).detail).not.toContain(NATIVE_PATH);
    expect(asOperationError(error).detail).not.toContain("/private/var/folders");
  });

  it("keeps the secret and native path out of every observable surface, not just detail", async () => {
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        launchInstance: async () => {
          throw new Error(`spawn failed for ${NATIVE_PATH} with key ${SECRET}`);
        },
      }),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        bridge.launchInstance(
          {
            jcodeHome: "/private/var/folders/jcode-home-abc",
            env: { ANTHROPIC_API_KEY: SECRET },
          },
          { credentialValues: [SECRET] },
        ),
      ),
    );

    const surface = observableSurface(error);
    expect(surface).not.toContain(SECRET);
    expect(surface).not.toContain(NATIVE_PATH);
    expect(surface).not.toContain("/private/var/folders");
  });

  it("returns an instance whose shutdown is idempotent at the wrapper boundary", async () => {
    let shutdowns = 0;
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        launchInstance: async () =>
          ({
            socketPath: NATIVE_PATH,
            jcodeHome: "/private/var/folders/jcode-home-abc",
            shutdown: async () => {
              shutdowns += 1;
            },
          }) as unknown as LaunchedInstance,
      }),
    );

    const instance = await Effect.runPromise(bridge.launchInstance({}));
    expect(instance.socketPath).toBe(NATIVE_PATH);
    expect(instance.jcodeHome).toBe("/private/var/folders/jcode-home-abc");

    await instance.shutdown();
    await instance.shutdown();
    await Promise.all([instance.shutdown(), instance.shutdown()]);

    expect(shutdowns).toBe(1);
  });
});

describe("JcodeSdkBridge secret scope", () => {
  it("redacts launch secrets from later client operations without caller discipline", async () => {
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        connect: async () =>
          fakeClient({
            getHistory: async () => {
              throw new HarnessError("internal", `provider rejected key ${SECRET}`);
            },
          }),
      }),
    );

    await Effect.runPromise(
      bridge.launchInstance({ env: { ANTHROPIC_API_KEY: SECRET } }, { credentialValues: [SECRET] }),
    );
    const client = await Effect.runPromise(
      bridge.connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        bridge.trySdk({
          operation: "getHistory",
          sessionId: "session-1",
          run: () => client.getHistory("session-1"),
        }),
      ),
    );

    expect(observableSurface(error)).not.toContain(SECRET);
  });

  it("redacts declared credentials without shredding ordinary process environment values", async () => {
    const bridge = makeJcodeSdkBridge(fakeSdk());

    await Effect.runPromise(
      bridge.launchInstance(
        {
          env: {
            NODE_ENV: "production",
            TERM: "a",
            JCODE_DEBUG: "1",
            LANG: "en_US.UTF-8",
            ANTHROPIC_API_KEY: SECRET,
          },
        },
        { credentialValues: [SECRET] },
      ),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        bridge.trySdk({
          operation: "getHistory",
          sessionId: "session-1",
          run: async () => {
            throw new HarnessError(
              "internal",
              `request 1 failed in production mode after 12 attempts using key ${SECRET}`,
            );
          },
        }),
      ),
    );

    expect(asOperationError(error).detail).toBe(
      "internal: request 1 failed in production mode after 12 attempts using key <redacted>",
    );
    expect(observableSurface(error)).not.toContain(SECRET);
  });

  it("redacts the longest credential first so overlapping literals are not pre-shredded", async () => {
    const bridge = makeJcodeSdkBridge(fakeSdk());
    const prefix = "sk-ant-secret";

    await Effect.runPromise(
      bridge.launchInstance({}, { credentialValues: [prefix, SECRET, SECRET] }),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        bridge.trySdk({
          operation: "getHistory",
          run: async () => {
            throw new HarnessError("internal", `rejected ${SECRET}`);
          },
        }),
      ),
    );

    expect(asOperationError(error).detail).toBe("internal: rejected <redacted>");
  });
});

describe("JcodeSdkBridge event stream", () => {
  it("classifies and redacts a mid-stream operation failure", async () => {
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        connect: async () =>
          fakeClient({
            events: async function* () {
              yield { ev: "text_delta", session_id: "session-1", text: "hi" } satisfies ApiEvent;
              throw new HarnessError("internal", `stream died at ${NATIVE_PATH} key ${SECRET}`);
            },
          }),
      }),
    );

    await Effect.runPromise(bridge.launchInstance({}, { credentialValues: [SECRET] }));
    const client = await Effect.runPromise(
      bridge.connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );

    const seen: Array<string> = [];
    const failure = await (async () => {
      try {
        for await (const event of client.events("session-1")) seen.push(event.ev);
        return undefined;
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(seen).toEqual(["text_delta"]);
    expect(failure).toBeInstanceOf(JcodeSdkOperationError);
    const operationFailure = asOperationError(failure as JcodeSdkBridgeError);
    expect(operationFailure.operation).toBe("events");
    expect(operationFailure.code).toBe("internal");
    expect(operationFailure.detail).toBe("internal: stream died at <path> key <redacted>");
    expect(observableSurface(operationFailure)).not.toContain(SECRET);
    expect(observableSurface(operationFailure)).not.toContain(NATIVE_PATH);
  });

  it("classifies a mid-stream unknown_session failure with the bound session id", async () => {
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        connect: async () =>
          fakeClient({
            events: async function* () {
              throw new HarnessError("unknown_session", "no such session");
              // eslint-disable-next-line no-unreachable
              yield { ev: "turn_done", session_id: "session-1" } satisfies ApiEvent;
            },
          }),
      }),
    );

    const client = await Effect.runPromise(
      bridge.connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );

    const failure = await (async () => {
      try {
        for await (const _event of client.events("session-1")) void _event;
        return undefined;
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(JcodeSessionNotFoundError);
    const notFound = asSessionNotFoundError(failure as JcodeSdkBridgeError);
    expect(notFound.operation).toBe("events");
    expect(notFound.sessionId).toBe("session-1");
  });
});

/**
 * A source stream that reports whether it was closed, mirroring the real SDK's
 * iterator whose `return` is the teardown that unsubscribes its listeners.
 */
function countingSource(
  events: ReadonlyArray<ApiEvent>,
  options: { readonly failAfter?: unknown; readonly failCleanup?: unknown } = {},
) {
  let closes = 0;
  let cleanedUp = false;
  async function* generate(): AsyncGenerator<ApiEvent, void, unknown> {
    try {
      for (const event of events) yield event;
      if (options.failAfter !== undefined) throw options.failAfter;
    } finally {
      cleanedUp = true;
    }
  }
  const inner = generate();
  const source: AsyncIterableIterator<ApiEvent> = {
    [Symbol.asyncIterator]() {
      return source;
    },
    next: () => inner.next(),
    return: async (): Promise<IteratorResult<ApiEvent, void>> => {
      closes += 1;
      if (options.failCleanup !== undefined) throw options.failCleanup;
      return inner.return(undefined);
    },
  };
  return {
    source,
    closes: () => closes,
    cleanedUp: () => cleanedUp,
  };
}

function eventsBridge(source: AsyncIterableIterator<ApiEvent>) {
  return makeJcodeSdkBridge(fakeSdk({ connect: async () => fakeClient({ events: () => source }) }));
}

describe("JcodeSdkBridge event stream cleanup", () => {
  it("closes the underlying stream exactly once when the consumer breaks early", async () => {
    const probe = countingSource([
      { ev: "text_delta", session_id: "session-1", text: "one" },
      { ev: "text_delta", session_id: "session-1", text: "two" },
    ]);

    const client = await Effect.runPromise(
      eventsBridge(probe.source).connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );

    const seen: Array<string> = [];
    for await (const event of client.events("session-1")) {
      seen.push(event.ev);
      break;
    }

    expect(seen).toEqual(["text_delta"]);
    expect(probe.cleanedUp()).toBe(true);
    expect(probe.closes()).toBe(1);
  });

  it("closes the underlying stream when the consumer throws", async () => {
    const probe = countingSource([{ ev: "text_delta", session_id: "session-1", text: "one" }]);

    const client = await Effect.runPromise(
      eventsBridge(probe.source).connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );

    const consumerError = new Error("consumer exploded");
    const thrown = await (async () => {
      try {
        for await (const _event of client.events("session-1")) {
          void _event;
          throw consumerError;
        }
        return undefined;
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(thrown).toBe(consumerError);
    expect(probe.cleanedUp()).toBe(true);
    expect(probe.closes()).toBe(1);
  });

  it("closes the underlying stream once on normal completion", async () => {
    const probe = countingSource([{ ev: "turn_done", session_id: "session-1" }]);

    const client = await Effect.runPromise(
      eventsBridge(probe.source).connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );

    const seen: Array<string> = [];
    for await (const event of client.events("session-1")) seen.push(event.ev);

    expect(seen).toEqual(["turn_done"]);
    expect(probe.cleanedUp()).toBe(true);
    expect(probe.closes()).toBe(1);
  });

  it("preserves the classified stream error when cleanup also fails", async () => {
    const probe = countingSource([{ ev: "text_delta", session_id: "session-1", text: "one" }], {
      failAfter: new HarnessError("internal", `stream died at ${NATIVE_PATH}`),
      failCleanup: new Error(`cleanup failed for ${NATIVE_PATH}`),
    });

    const client = await Effect.runPromise(
      eventsBridge(probe.source).connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );

    const failure = await (async () => {
      try {
        for await (const _event of client.events("session-1")) void _event;
        return undefined;
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(JcodeSdkOperationError);
    const operationFailure = asOperationError(failure as JcodeSdkBridgeError);
    expect(operationFailure.operation).toBe("events");
    expect(operationFailure.detail).toBe("internal: stream died at <path>");
    expect(probe.closes()).toBe(1);
  });
});

describe("JcodeSdkBridge client boundary", () => {
  it("rejects client calls with already-classified bridge errors", async () => {
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        connect: async () =>
          fakeClient({
            attachSession: async () => {
              throw new HarnessError("unknown_session", "no such session");
            },
            getHistory: async () => {
              throw new HarnessError("internal", `failed reading ${NATIVE_PATH}`);
            },
          }),
      }),
    );

    const client = await Effect.runPromise(
      bridge.connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );

    const attachFailure = await client.attachSession("session-1").catch((error: unknown) => error);
    expect(attachFailure).toBeInstanceOf(JcodeSessionNotFoundError);

    const historyFailure = await client.getHistory("session-1").catch((error: unknown) => error);
    expect(historyFailure).toBeInstanceOf(JcodeSdkOperationError);
    expect(observableSurface(historyFailure as JcodeSdkBridgeError)).not.toContain(NATIVE_PATH);
  });

  it("does not re-wrap an already-classified bridge error", async () => {
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        connect: async () =>
          fakeClient({
            attachSession: async () => {
              throw new HarnessError("unknown_session", "no such session");
            },
          }),
      }),
    );

    const client = await Effect.runPromise(
      bridge.connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );
    const error = await Effect.runPromise(
      Effect.flip(
        bridge.trySdk({
          operation: "attachSession",
          sessionId: "session-1",
          run: () => client.attachSession("session-1"),
        }),
      ),
    );

    expect(error).toBeInstanceOf(JcodeSessionNotFoundError);
    expect(asSessionNotFoundError(error).operation).toBe("attachSession");
    expect(asSessionNotFoundError(error).sessionId).toBe("session-1");
  });
});

describe("JcodeSdkBridge cleanup retries", () => {
  it("retries close after a transient failure and latches only on success", async () => {
    let closes = 0;
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        connect: async () =>
          fakeClient({
            close: async () => {
              closes += 1;
              if (closes === 1) throw new Error("cleanup timed out");
            },
          }),
      }),
    );

    const client = await Effect.runPromise(
      bridge.connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );

    await expect(client.close()).rejects.toThrow();
    await client.close();
    await client.close();

    expect(closes).toBe(2);
  });

  it("retries shutdown after a transient failure and latches only on success", async () => {
    let shutdowns = 0;
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        launchInstance: async () =>
          ({
            socketPath: NATIVE_PATH,
            jcodeHome: "/private/var/folders/jcode-home-abc",
            shutdown: async () => {
              shutdowns += 1;
              if (shutdowns === 1) throw new Error("cleanup timed out");
            },
          }) as unknown as LaunchedInstance,
      }),
    );

    const instance = await Effect.runPromise(bridge.launchInstance({}));

    await expect(instance.shutdown()).rejects.toThrow();
    await instance.shutdown();
    await instance.shutdown();

    expect(shutdowns).toBe(2);
  });
});

describe("JcodeSdkBridge error classification", () => {
  it("maps an authoritative unknown_session harness error to the session-not-found tag", async () => {
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        connect: async () =>
          fakeClient({
            attachSession: async () => {
              throw new HarnessError("unknown_session", "no such session");
            },
          }),
      }),
    );

    const client = await Effect.runPromise(
      bridge.connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );
    const error = await Effect.runPromise(
      Effect.flip(
        bridge.trySdk({
          operation: "attachSession",
          sessionId: "session-1",
          run: () => client.attachSession("session-1"),
        }),
      ),
    );

    expect(error).toBeInstanceOf(JcodeSessionNotFoundError);
    expect(error._tag).toBe("JcodeSessionNotFoundError");
    expect(asSessionNotFoundError(error).sessionId).toBe("session-1");
    expect(asSessionNotFoundError(error).operation).toBe("attachSession");
  });

  it("keeps transport, timeout, and protocol failures distinguishable by stable code, not message text", async () => {
    const bridge = makeJcodeSdkBridge(fakeSdk());

    const failures = [
      { thrown: new HarnessError("internal", "boom"), code: "internal" },
      { thrown: new HarnessError("invalid_request", "bad"), code: "invalid_request" },
      { thrown: new HarnessError("unsupported_version", "old"), code: "unsupported_version" },
      { thrown: new HarnessError("unknown_request", "huh"), code: "unknown_request" },
      { thrown: new Error("socket hang up"), code: undefined },
    ];

    for (const failure of failures) {
      const error = await Effect.runPromise(
        Effect.flip(
          bridge.trySdk({
            operation: "attachSession",
            sessionId: "session-1",
            run: async () => {
              throw failure.thrown;
            },
          }),
        ),
      );

      expect(error._tag).toBe("JcodeSdkOperationError");
      expect(asOperationError(error).code).toBe(failure.code);
    }
  });

  it("redacts native paths from operation error detail", async () => {
    const bridge = makeJcodeSdkBridge(fakeSdk());

    const error = await Effect.runPromise(
      Effect.flip(
        bridge.trySdk({
          operation: "getHistory",
          run: async () => {
            throw new HarnessError("internal", `failed reading ${NATIVE_PATH}`);
          },
        }),
      ),
    );

    expect(asOperationError(error).detail).toBe("internal: failed reading <path>");
  });

  it("classifies unknown_session even when the caller omits the session id", async () => {
    const bridge = makeJcodeSdkBridge(fakeSdk());

    const error = await Effect.runPromise(
      Effect.flip(
        bridge.trySdk({
          operation: "getHistory",
          run: async () => {
            throw new HarnessError("unknown_session", "no such session");
          },
        }),
      ),
    );

    expect(error).toBeInstanceOf(JcodeSessionNotFoundError);
    expect(asSessionNotFoundError(error).operation).toBe("getHistory");
    expect(asSessionNotFoundError(error).sessionId).toBe("");
  });

  it("keeps single-segment paths and API routes readable while redacting native paths", async () => {
    const bridge = makeJcodeSdkBridge(fakeSdk());

    const error = await Effect.runPromise(
      Effect.flip(
        bridge.trySdk({
          operation: "getHistory",
          run: async () => {
            throw new HarnessError("internal", `GET /health failed for ${NATIVE_PATH}`);
          },
        }),
      ),
    );

    expect(asOperationError(error).detail).toBe("internal: GET /health failed for <path>");
  });

  it("maps connect failures to typed bridge errors", async () => {
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        connect: async () => {
          throw new HarnessError("internal", `cannot dial ${NATIVE_PATH}`);
        },
      }),
    );

    const error = await Effect.runPromise(
      Effect.flip(bridge.connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" })),
    );

    expect(error._tag).toBe("JcodeSdkOperationError");
    expect(asOperationError(error).operation).toBe("connect");
    expect(asOperationError(error).code).toBe("internal");
    expect(asOperationError(error).detail).not.toContain(NATIVE_PATH);
  });
});

describe("JcodeSdkBridge connect", () => {
  it("preserves server identity and capability strings", async () => {
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        connect: async () =>
          fakeClient({
            server: "jcode-harness-api-bridge/9.9.9",
            capabilities: ["sessions", "models", "files"],
          }),
      }),
    );

    const client = await Effect.runPromise(
      bridge.connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );

    expect(client.server).toBe("jcode-harness-api-bridge/9.9.9");
    expect(client.capabilities).toEqual(["sessions", "models", "files"]);
    expect(client.supports("files")).toBe(true);
  });

  it("reports supports('permissions') as false when the server omits it", async () => {
    const bridge = makeJcodeSdkBridge(fakeSdk());

    const client = await Effect.runPromise(
      bridge.connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );

    expect(client.capabilities).not.toContain("permissions");
    expect(client.supports("permissions")).toBe(false);
  });

  it("ignores unknown future event kinds rather than crashing the stream", async () => {
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        connect: async () =>
          fakeClient({
            events: async function* () {
              yield { ev: "text_delta", session_id: "session-1", text: "hi" } satisfies ApiEvent;
              yield {
                ev: "some_future_event_kind",
                session_id: "session-1",
                payload: { nested: true },
              } as unknown as ApiEvent;
              yield {
                ev: "tool_done",
                session_id: "session-1",
                call_id: "call-1",
                name: "read_file",
                output: "ok",
              } satisfies ApiEvent;
              yield { ev: "turn_done", session_id: "session-1" } satisfies ApiEvent;
            },
          }),
      }),
    );

    const client = await Effect.runPromise(
      bridge.connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );

    const kinds: Array<string> = [];
    for await (const event of client.events("session-1")) {
      kinds.push(event.ev);
    }

    expect(kinds).toEqual(["text_delta", "tool_done", "turn_done"]);
  });

  it("closes the underlying client at most once", async () => {
    let closes = 0;
    const bridge = makeJcodeSdkBridge(
      fakeSdk({
        connect: async () =>
          fakeClient({
            close: async () => {
              closes += 1;
            },
          }),
      }),
    );

    const client = await Effect.runPromise(
      bridge.connect({ socketPath: NATIVE_PATH, clientName: "pylon/test" }),
    );

    await client.close();
    await client.close();
    await Promise.all([client.close(), client.close()]);

    expect(closes).toBe(1);
  });
});
