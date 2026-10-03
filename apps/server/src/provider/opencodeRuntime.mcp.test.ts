import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { Config } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect, vi } from "vite-plus/test";

import * as OpenCodeRuntime from "./opencodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";

const testLayer = OpenCodeRuntime.OpenCodeRuntimeLive.pipe(
  Layer.provide(OpenCodeServerLedger.layerTest),
  Layer.provideMerge(NodeServices.layer),
);
const remoteConfig = {
  type: "remote" as const,
  url: "http://pylon.test/mcp",
  headers: { Authorization: "Bearer fixture-credential" },
  oauth: false as const,
};
const decodeBody = Schema.decodeSync(Schema.fromJsonString(Schema.JsonObject));

function makeHarness(
  options: {
    readonly config?: () => Config;
    readonly configStatus?: number;
    readonly addStatus?: number;
  } = {},
) {
  return Effect.gen(function* () {
    const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
    const requests: Array<{ readonly request: Request; readonly body: string }> = [];
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
          const request = input instanceof Request ? input : new Request(input.toString(), init);
          requests.push({ request, body: await request.clone().text() });
          if (new URL(request.url).pathname === "/config") {
            return Response.json(options.config?.() ?? {}, {
              status: options.configStatus ?? 200,
            });
          }
          return Response.json(
            { "t3-code": { status: "connected" } },
            {
              status: options.addStatus ?? 200,
            },
          );
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    return {
      client: runtime.createOpenCodeSdkClient({
        baseUrl: "http://opencode.test",
        directory: "/provider/workspace",
        serverPassword: "fixture-password",
      }),
      requests,
    };
  });
}

it.layer(testLayer)("OpenCodeRuntime Pylon MCP timeout", (it) => {
  it.effect("extends only Pylon's remote registration and preserves scope and authentication", () =>
    Effect.gen(function* () {
      const { client, requests } = yield* makeHarness();
      const parameters = {
        name: "t3-code",
        config: remoteConfig,
        directory: "/specific/project",
        workspace: "workspace-fixture",
      };
      const controller = new AbortController();
      yield* Effect.promise(() =>
        client.mcp.add(parameters, {
          headers: { "x-fixture-option": "preserved" },
          signal: controller.signal,
        }),
      );

      expect(
        requests.map(({ request }) => [request.method, new URL(request.url).pathname]),
      ).toEqual([
        ["GET", "/config"],
        ["POST", "/mcp"],
      ]);
      expect(decodeBody(requests[1]!.body)).toEqual({
        name: "t3-code",
        config: { ...remoteConfig, timeout: 180_000 },
      });
      for (const { request } of requests) {
        const url = new URL(request.url);
        expect(url.searchParams.get("directory")).toBe(parameters.directory);
        expect(url.searchParams.get("workspace")).toBe(parameters.workspace);
        expect(request.headers.get("authorization")).toBe(
          `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}`,
        );
        expect(request.headers.get("x-fixture-option")).toBe("preserved");
        expect(request.signal.aborted).toBe(false);
      }
      controller.abort();
      expect(requests.every(({ request }) => request.signal.aborted)).toBe(true);
      expect(parameters.config).toEqual(remoteConfig);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps an explicit request timeout without fetching provider configuration", () =>
    Effect.gen(function* () {
      const { client, requests } = yield* makeHarness();
      const controller = new AbortController();
      yield* Effect.promise(() =>
        client.mcp.add(
          { name: "t3-code", config: { ...remoteConfig, timeout: 0 } },
          { headers: { "x-fixture-option": "preserved" }, signal: controller.signal },
        ),
      );
      expect(requests).toHaveLength(1);
      expect(decodeBody(requests[0]!.body)).toEqual({
        name: "t3-code",
        config: { ...remoteConfig, timeout: 0 },
      });
      expect(requests[0]!.request.headers.get("x-fixture-option")).toBe("preserved");
      expect(requests[0]!.request.signal.aborted).toBe(false);
      controller.abort();
      expect(requests[0]!.request.signal.aborted).toBe(true);
    }).pipe(Effect.scoped),
  );

  for (const timeout of [0, 90_000]) {
    it.effect(`preserves provider per-server timeout ${timeout} ahead of the global setting`, () =>
      Effect.gen(function* () {
        const providerConfig = {
          mcp: { "t3-code": { ...remoteConfig, timeout } },
          experimental: { mcp_timeout: 40_000 },
          provider: { fixture: { options: { baseURL: "http://provider.test" } } },
        } satisfies Config;
        const { client, requests } = yield* makeHarness({ config: () => providerConfig });
        yield* Effect.promise(() => client.mcp.add({ name: "t3-code", config: remoteConfig }));
        expect(decodeBody(requests[1]!.body)).toEqual({
          name: "t3-code",
          config: { ...remoteConfig, timeout },
        });
        expect(providerConfig.mcp["t3-code"].timeout).toBe(timeout);
        expect(providerConfig.provider.fixture.options.baseURL).toBe("http://provider.test");
        expect(requests.every(({ request }) => request.method !== "PATCH")).toBe(true);
        expect(new URL(requests[0]!.request.url).searchParams.get("directory")).toBe(
          "/provider/workspace",
        );
      }).pipe(Effect.scoped),
    );
  }

  for (const timeout of [0, 45_000]) {
    it.effect(`preserves provider global MCP timeout ${timeout}`, () =>
      Effect.gen(function* () {
        const { client, requests } = yield* makeHarness({
          config: () => ({ experimental: { mcp_timeout: timeout } }),
        });
        yield* Effect.promise(() => client.mcp.add({ name: "t3-code", config: remoteConfig }));
        expect(decodeBody(requests[1]!.body)).toEqual({
          name: "t3-code",
          config: { ...remoteConfig, timeout },
        });
      }).pipe(Effect.scoped),
    );
  }

  it.effect("leaves other names and local MCP servers unchanged", () =>
    Effect.gen(function* () {
      const { client, requests } = yield* makeHarness();
      yield* Effect.promise(() => client.mcp.add({ name: "other-server", config: remoteConfig }));
      const localConfig = { type: "local" as const, command: ["fixture-agent"] };
      yield* Effect.promise(() => client.mcp.add({ name: "t3-code", config: localConfig }));
      expect(requests).toHaveLength(2);
      expect(requests.map(({ request }) => new URL(request.url).pathname)).toEqual([
        "/mcp",
        "/mcp",
      ]);
      expect(decodeBody(requests[0]!.body)).toEqual({ name: "other-server", config: remoteConfig });
      expect(decodeBody(requests[1]!.body)).toEqual({ name: "t3-code", config: localConfig });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the original registration when resolved configuration cannot be read", () =>
    Effect.gen(function* () {
      const { client, requests } = yield* makeHarness({ configStatus: 400 });
      yield* Effect.promise(() => client.mcp.add({ name: "t3-code", config: remoteConfig }));
      expect(requests).toHaveLength(2);
      expect(decodeBody(requests[1]!.body)).toEqual({ name: "t3-code", config: remoteConfig });
    }).pipe(Effect.scoped),
  );

  it.effect("does not retry a failed MCP registration", () =>
    Effect.gen(function* () {
      const { client, requests } = yield* makeHarness({ addStatus: 400 });
      const result = yield* Effect.tryPromise(() =>
        client.mcp.add({
          name: "t3-code",
          config: remoteConfig,
        }),
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(requests).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves the SDK's explicit nonthrowing error response", () =>
    Effect.gen(function* () {
      const { client, requests } = yield* makeHarness({ addStatus: 400 });
      const result = yield* Effect.promise(() =>
        client.mcp.add({ name: "t3-code", config: remoteConfig }, { throwOnError: false }),
      );
      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(requests).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("uses current provider configuration for later registrations", () =>
    Effect.gen(function* () {
      let config: Config = {};
      const { client, requests } = yield* makeHarness({ config: () => config });
      yield* Effect.promise(() => client.mcp.add({ name: "t3-code", config: remoteConfig }));
      config = { experimental: { mcp_timeout: 30_000 } };
      yield* Effect.promise(() => client.mcp.add({ name: "t3-code", config: remoteConfig }));
      expect(decodeBody(requests[1]!.body)).toEqual({
        name: "t3-code",
        config: { ...remoteConfig, timeout: 180_000 },
      });
      expect(decodeBody(requests[3]!.body)).toEqual({
        name: "t3-code",
        config: { ...remoteConfig, timeout: 30_000 },
      });
    }).pipe(Effect.scoped),
  );
});
