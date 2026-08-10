import { HarnessError } from "@1jehuang/jcode-sdk";
import type { ApiEvent, LaunchedInstance, SessionInfo } from "@1jehuang/jcode-sdk";
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
    ...overrides,
  };
}

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
        bridge.launchInstance({
          jcodeHome: "/private/var/folders/jcode-home-abc",
          env: { ANTHROPIC_API_KEY: SECRET },
        }),
      ),
    );

    expect(error).toBeInstanceOf(JcodeSdkOperationError);
    expect(error._tag).toBe("JcodeSdkOperationError");
    expect(asOperationError(error).operation).toBe("launchInstance");
    expect(asOperationError(error).detail).not.toContain(SECRET);
    expect(asOperationError(error).detail).not.toContain(NATIVE_PATH);
    expect(asOperationError(error).detail).not.toContain("/private/var/folders");
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

    expect(asOperationError(error).detail).not.toContain(NATIVE_PATH);
    expect(asOperationError(error).detail).toContain("internal");
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
              yield { ev: "text_delta", session_id: "session-1", text: "hi" } as ApiEvent;
              yield {
                ev: "some_future_event_kind",
                session_id: "session-1",
              } as unknown as ApiEvent;
              yield { ev: "turn_done", session_id: "session-1" } as unknown as ApiEvent;
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

    expect(kinds).toEqual(["text_delta", "turn_done"]);
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
