import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  UsageLimitSourceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { BackgroundPolicy } from "../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { make } from "./UsageLimitSources.ts";

const sourceId = UsageLimitSourceId.make("hub");
const initial: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerHealthRefreshInterval: Duration.zero,
  backgroundActivity: {
    schemaVersion: 1,
    profile: "custom",
    overrides: { providerHealthRefreshInterval: Duration.zero },
  },
  usageLimitSources: {
    [sourceId]: {
      kind: "cliproxy",
      url: "http://hub.test",
      managementKey: "test-key",
      enabled: true,
    },
  },
};
const fixture = Effect.gen(function* () {
  const settings = yield* Ref.make(initial);
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<ServerSettings>(), PubSub.shutdown);
  let requests = 0;
  let failReads = false;
  let redeemed = false;
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests++;
      const path = new URL(request.url).pathname;
      if (path.endsWith("/auth-files"))
        return HttpClientResponse.fromWeb(
          request,
          redeemed || failReads
            ? Response.json({}, { status: 503 })
            : Response.json({
                files: [{ id: "account", auth_index: "account", provider: "codex" }],
              }),
        );
      if (path.endsWith("/reset-quota"))
        return HttpClientResponse.fromWeb(request, Response.json({}));
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const consuming = body.includes("/consume");
      if (consuming) redeemed = true;
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          status_code: 200,
          body: consuming
            ? '{"code":"reset"}'
            : body.includes("reset-credits")
              ? '{"credits":[]}'
              : '{"rate_limit":{"primary_window":{"used_percent":12}}}',
        }),
      );
    }),
  );
  const service = yield* make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettingsService)({
          getSettings: Ref.get(settings),
          subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
        }),
        Layer.mock(BackgroundPolicy)({ shouldRunScopeWork: () => Effect.succeed(true) }),
        Layer.succeed(HttpClient.HttpClient, http),
      ),
    ),
  );
  yield* service.streamChanges.pipe(
    Stream.filter((sources) => sources.length > 0),
    Stream.take(1),
    Stream.runDrain,
  );
  return {
    service,
    settings,
    changes,
    requests: () => requests,
    failReads: () => {
      failReads = true;
    },
  };
});

it.effect(
  "disables automatic hub probes at a zero interval while preserving manual refresh and removal",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      const before = test.requests();
      yield* TestClock.adjust("10 minutes");
      expect(test.requests()).toBe(before);
      yield* test.service.refresh;
      expect(test.requests()).toBeGreaterThan(before);
      const removed = { ...initial, usageLimitSources: {} };
      yield* Ref.set(test.settings, removed);
      yield* PubSub.publish(test.changes, removed);
      yield* test.service.streamChanges.pipe(
        Stream.filter((sources) => sources.length === 0),
        Stream.take(1),
        Stream.runDrain,
      );
      expect(yield* test.service.current).toEqual([]);
      expect(
        (yield* test.service
          .consumeResetCredit({ sourceId, accountId: "account", creditId: "credit" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.scoped),
);

it.effect("preserves a confirmed hub reset with an explicit refresh warning", () =>
  Effect.gen(function* () {
    const test = yield* fixture;
    const result = yield* test.service.consumeResetCredit({
      sourceId,
      accountId: "account",
      creditId: "credit",
    });
    expect(result.outcome).toBe("reset");
    expect(result.warning).toContain("updated limits could not be read");
    expect((yield* test.service.current)[0]?.error).toBeDefined();
  }).pipe(Effect.scoped),
);
