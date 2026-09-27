import { afterEach, describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  LOCAL_DEVICE_HOST_ID,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import {
  EnvironmentAuth,
  ServerAuthMissingCredentialError,
  ServerAuthSessionCredentialValidationError,
  type ServerAuthCredentialError,
  type ServerAuthInternalError,
} from "../auth/EnvironmentAuth.ts";
import { DeviceService } from "./DeviceService.ts";
import { deviceHubProxyRouteLayer, relayWebSocketFrames } from "./DeviceHubProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  fail = false,
  authError?: ServerAuthCredentialError | ServerAuthInternalError,
) => {
  let finalized = 0;
  const requests: string[] = [];
  const client = HttpClient.make((request, _url, signal) =>
    Effect.gen(function* () {
      requests.push(request.url);
      signal.addEventListener("abort", () => {
        finalized++;
      });
      if (fail) return yield* Effect.die(new Error("upstream failed"));
      return HttpClientResponse.fromWeb(request, new Response("frame"));
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    deviceHubProxyRouteLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            authError
              ? Effect.fail(authError)
              : Effect.succeed({
                  sessionId: AuthSessionId.make("test"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes,
                }),
        } as unknown as EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(DeviceService, {
          currentReadiness: () =>
            Effect.succeed({ hostId: LOCAL_DEVICE_HOST_ID, hub: { origin: "http://hub.test" } }),
        } as DeviceService["Service"]),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, requests, finalized: () => finalized };
};

describe("device hub proxy", () => {
  effectIt.effect("forwards both socket directions and releases both sides when one closes", () =>
    Effect.gen(function* () {
      const clientFrames = yield* Queue.unbounded<readonly [string]>();
      const upstreamFrames = yield* Queue.unbounded<readonly [string]>();
      const clientClosed = yield* Deferred.make<never, Socket.SocketError>();
      const upstreamClosed = yield* Deferred.make<never, Socket.SocketError>();
      const clientReceived = yield* Deferred.make<void>();
      const upstreamReceived = yield* Deferred.make<void>();
      const released: string[] = [];
      const toClient: string[] = [];
      const toUpstream: string[] = [];
      const makeSocket = (
        name: string,
        frames: Queue.Queue<readonly [string]>,
        closed: Deferred.Deferred<never, Socket.SocketError>,
        output: string[],
        received: Deferred.Deferred<void>,
      ) =>
        Socket.make({
          reader: Effect.acquireRelease(
            Effect.succeed({
              pull: Effect.raceFirst(Queue.take(frames), Deferred.await(closed)),
              upgrade: Socket.SocketUpgradeError.unsupported,
            }),
            () =>
              Effect.sync(() => {
                released.push(`${name}:reader`);
              }),
          ),
          writer: Effect.acquireRelease(
            Effect.succeed({
              write: (frame: Uint8Array | string | Socket.CloseEvent) =>
                Effect.sync(() => {
                  output.push(String(frame));
                }),
              writeAll: (batch: readonly [Uint8Array | string, ...(Uint8Array | string)[]]) =>
                Effect.gen(function* () {
                  output.push(...batch.map(String));
                  yield* Deferred.succeed(received, undefined);
                }),
            }),
            () =>
              Effect.sync(() => {
                released.push(`${name}:writer`);
              }),
          ),
        });
      const client = makeSocket("client", clientFrames, clientClosed, toClient, clientReceived);
      const upstream = makeSocket(
        "upstream",
        upstreamFrames,
        upstreamClosed,
        toUpstream,
        upstreamReceived,
      );
      const relay = yield* Effect.forkChild(Effect.exit(relayWebSocketFrames(client, upstream)));
      yield* Queue.offer(clientFrames, ["client frame"]);
      yield* Queue.offer(upstreamFrames, ["upstream frame"]);
      yield* Deferred.await(clientReceived);
      yield* Deferred.await(upstreamReceived);
      yield* Deferred.fail(
        clientClosed,
        new Socket.SocketError({
          reason: new Socket.SocketCloseError({ code: 1000 }),
        }),
      );
      const exit = yield* Fiber.join(relay);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(toClient).toEqual(["upstream frame"]);
      expect(toUpstream).toEqual(["client frame"]);
      expect(released.sort()).toEqual([
        "client:reader",
        "client:writer",
        "upstream:reader",
        "upstream:writer",
      ]);
    }),
  );

  it("releases the upstream response after forwarding its body and strips tickets", async () => {
    const { handler, requests, finalized } = fixture([AuthOrchestrationReadScope]);
    const response = await handler(
      new Request("http://t3.test/api/device-hub/api/devices?wsTicket=secret"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("frame");
    expect(requests).toEqual(["http://hub.test/api/devices"]);
    expect(finalized()).toBe(1);
  });

  it("releases resources when upstream acquisition fails", async () => {
    const { handler, finalized } = fixture([AuthOrchestrationReadScope], true);
    const response = await handler(new Request("http://t3.test/api/device-hub/api/devices"));
    expect(response.status).toBe(500);
    expect(finalized()).toBe(1);
  });

  it.each(["/vendor/serve-sim/helper/ws", "/vendor/serve-emu/ws"])(
    "rejects input socket %s for a read-only session",
    async (path) => {
      const { handler, requests } = fixture([AuthOrchestrationReadScope]);
      const response = await handler(
        new Request(`http://t3.test/api/device-hub${path}`, { headers: { upgrade: "websocket" } }),
      );
      expect(response.status).toBe(403);
      expect(requests).toEqual([]);
    },
  );

  it("requires operate scope for stream tuning", async () => {
    const readOnly = fixture([AuthOrchestrationReadScope]);
    const path = "http://t3.test/api/device-hub/vendor/serve-emu/api/stream-settings";
    expect((await readOnly.handler(new Request(path, { method: "POST" }))).status).toBe(403);
    const operator = fixture([AuthOrchestrationOperateScope]);
    const response = await operator.handler(new Request(path, { method: "POST" }));
    expect(response.status).toBe(200);
    await response.text();
  });

  it("never forwards the vendor shell endpoint", async () => {
    const { handler, requests } = fixture([AuthOrchestrationOperateScope]);
    expect(
      (
        await handler(
          new Request("http://t3.test/api/device-hub/vendor/serve-sim/exec", { method: "POST" }),
        )
      ).status,
    ).toBe(404);
    expect(requests).toEqual([]);
  });
});

it.each([
  [new ServerAuthMissingCredentialError({}), 401],
  [
    new ServerAuthSessionCredentialValidationError({
      cause: new Error("private credential diagnostic"),
    }),
    500,
  ],
] as const)("translates authentication failure to HTTP %s", async (error, status) => {
  const { handler, requests } = fixture([], false, error);
  const response = await handler(new Request("http://t3.test/api/device-hub/api/devices"));
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain("private credential diagnostic");
  expect(requests).toEqual([]);
});
