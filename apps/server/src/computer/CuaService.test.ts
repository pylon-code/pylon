import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/unstable/ai";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeCuaService, type CuaError, type CuaConnection } from "./CuaService.ts";

const expectFailure = Effect.match({
  onFailure: (error: CuaError) => error,
  onSuccess: () => {
    throw new Error("Expected CuaError");
  },
});

const owner = { threadId: "thread", providerSessionId: "session" };
const encodeResult = Schema.encodeEffect(McpSchema.CallToolResult);
const imageResult = {
  content: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
  isError: false,
};

const fixture = Effect.gen(function* () {
  let current = { ...DEFAULT_SERVER_SETTINGS, enableAgentComputerAccess: true };
  const changes = yield* PubSub.unbounded<typeof current>();
  const closed = yield* Queue.unbounded<number>();
  let starts = 0;
  let calls = 0;
  const connections: CuaConnection[] = [];
  const settings = Layer.mock(ServerSettingsService)({
    getSettings: Effect.sync(() => current),
    subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
  });
  const connect = async () => {
    const id = ++starts;
    const connection: CuaConnection = {
      listTools: async () => ({
        tools: [{ name: "get_window_state", inputSchema: { type: "object" } }],
      }),
      callTool: async () => {
        calls++;
        return imageResult;
      },
      close: async () => {
        Queue.offerUnsafe(closed, id);
      },
    };
    connections.push(connection);
    return connection;
  };
  const cua = yield* makeCuaService(connect).pipe(Effect.provide(settings));
  return {
    cua,
    closed,
    connections,
    starts: () => starts,
    calls: () => calls,
    settings,
    connect,
    setSilent: (patch: Partial<typeof current>) =>
      Effect.sync(() => {
        current = { ...current, ...patch };
      }),
    set: (patch: Partial<typeof current>) =>
      Effect.sync(() => {
        current = { ...current, ...patch };
      }).pipe(Effect.andThen(() => PubSub.publish(changes, current))),
  };
});

it.effect("reuses a session, isolates other agents, and forwards screenshots", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.cua.tools(owner);
      const result = yield* f.cua.call(owner, "get_window_state", {});
      expect((yield* encodeResult(result)).content).toEqual(imageResult.content);
      yield* f.cua.tools({ ...owner, providerSessionId: "claude-session" });
      expect(f.starts()).toBe(2);
      yield* f.cua.closeSession(owner.providerSessionId);
      expect(yield* Queue.take(f.closed).pipe(Effect.orDie)).toBe(1);
      expect((yield* f.cua.tools(owner).pipe(expectFailure)).message).toContain("no longer");
      yield* f.cua.call({ ...owner, providerSessionId: "claude-session" }, "get_window_state", {});
      expect(f.starts()).toBe(2);
    }),
  ),
);

it.effect("turning access off closes existing clients and prevents new calls", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.cua.tools(owner);
      yield* f.set({ enableAgentComputerAccess: false });
      yield* Queue.take(f.closed).pipe(Effect.orDie);
      expect(
        (yield* f.cua.call(owner, "get_window_state", {}).pipe(expectFailure)).message,
      ).toContain("off");
      expect(f.calls()).toBe(0);
    }),
  ),
);

it.effect("unrelated settings preserve sessions; changing the executable closes them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.cua.tools(owner);
      yield* f.set({ enableAgentDeviceAccess: true });
      yield* f.cua.tools(owner);
      expect(f.starts()).toBe(1);
      yield* f.set({ computerUseBinaryPath: "/new/cua-driver" });
      yield* Queue.take(f.closed).pipe(Effect.orDie);
      yield* f.cua.tools(owner);
      expect(f.starts()).toBe(2);
    }),
  ),
);

it.effect("revocation during connection setup cannot publish a new client", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = Promise.withResolvers<void>();
      const cua = yield* makeCuaService(async () => {
        Deferred.doneUnsafe(entered, Effect.void);
        await release.promise;
        return f.connect();
      }).pipe(Effect.provide(f.settings));
      const pending = yield* cua.tools(owner).pipe(expectFailure, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* cua.closeSession(owner.providerSessionId);
      release.resolve();
      expect((yield* Fiber.join(pending)).message).toContain("revoked");
      yield* Queue.take(f.closed).pipe(Effect.orDie);
    }),
  ),
);

it.effect("Cua tool errors remain errors and malformed results are rejected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.cua.tools(owner);
      Object.assign(f.connections[0]!, {
        callTool: async () => ({
          content: [{ type: "text", text: "background unavailable" }],
          isError: true,
        }),
      });
      expect((yield* f.cua.call(owner, "click", { pid: 10, window_id: 20 })).isError).toBe(true);
      Object.assign(f.connections[0]!, {
        callTool: async () => ({ content: [{ type: "image", data: 123 }] }),
      });
      expect(
        (yield* f.cua.call(owner, "get_window_state", {}).pipe(expectFailure)).message,
      ).toContain("invalid result");
    }),
  ),
);

for (const revoke of ["thread", "all"] as const) {
  it.effect(`queued calls cannot survive ${revoke} revocation`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.cua.tools(owner);
        const entered = yield* Deferred.make<void>();
        const release = Promise.withResolvers<void>();
        Object.assign(f.connections[0]!, {
          callTool: async () => {
            Deferred.doneUnsafe(entered, Effect.void);
            await release.promise;
            return imageResult;
          },
        });
        const active = yield* f.cua.call(owner, "get_window_state", {}).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const queued = yield* f.cua.tools(owner).pipe(expectFailure, Effect.forkChild);
        // Let the request enter the semaphore wait; no desktop or timer is involved.
        yield* Effect.yieldNow;
        yield* revoke === "thread" ? f.cua.closeThread(owner.threadId) : f.cua.closeAll;
        release.resolve();
        yield* Fiber.join(active);
        expect((yield* Fiber.join(queued)).message).toContain("no longer");
        expect(f.starts()).toBe(1);
      }),
    ),
  );
}

it.effect(
  "background policy blocks foreground calls before dispatch and supports explicit opt-in",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        expect(
          (yield* f.cua
            .call(owner, "bring_to_front", { pid: 10, window_id: 20 })
            .pipe(expectFailure)).message,
        ).toContain("background mode");
        expect(f.calls()).toBe(0);
        yield* f.set({ allowAgentComputerForeground: true });
        yield* f.cua.call(owner, "bring_to_front", { pid: 10, window_id: 20 });
        expect(f.calls()).toBe(1);
        yield* f.set({ allowAgentComputerForeground: false });
        expect(
          (yield* f.cua
            .call(owner, "bring_to_front", { pid: 10, window_id: 20 })
            .pipe(expectFailure)).message,
        ).toContain("background mode");
        expect(f.calls()).toBe(1);
      }),
    ),
);

it.effect("foreground revocation during connect is enforced before subscriber notification", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.setSilent({ allowAgentComputerForeground: true });
      const entered = yield* Deferred.make<void>();
      const release = Promise.withResolvers<void>();
      const cua = yield* makeCuaService(async () => {
        Deferred.doneUnsafe(entered, Effect.void);
        await release.promise;
        return f.connect();
      }).pipe(Effect.provide(f.settings));
      const pending = yield* cua
        .call(owner, "bring_to_front", { pid: 10, window_id: 20 })
        .pipe(expectFailure, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.setSilent({ allowAgentComputerForeground: false });
      release.resolve();
      expect((yield* Fiber.join(pending)).message).toContain("background mode");
      expect(f.calls()).toBe(0);
      yield* cua.tools(owner);
      expect(f.starts()).toBe(1); // A policy refusal preserves the valid connection and snapshot state.
    }),
  ),
);

for (const failure of ["transport", "catalog"] as const) {
  it.effect(`discovery recovers from ${failure} failure without closing on unknown names`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.cua.tools(owner);
        yield* f.cua.tools(owner, "not-a-tool").pipe(expectFailure);
        expect(f.starts()).toBe(1);
        Object.assign(f.connections[0]!, {
          listTools: async () => {
            if (failure === "transport") throw new Error("child exited");
            return { tools: "invalid" };
          },
        });
        yield* f.cua.tools(owner).pipe(expectFailure);
        expect(yield* Queue.take(f.closed).pipe(Effect.orDie)).toBe(1);
        yield* f.cua.tools(owner);
        expect(f.starts()).toBe(2);
      }),
    ),
  );
}
