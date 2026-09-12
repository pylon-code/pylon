import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { reconcileClaudeUsage } from "./claudeUsageReconciliation.ts";
import { fetchClaudeOAuthUsage } from "./claudeOAuthUsage.ts";

it.layer(NodeServices.layer)("Claude authoritative quota reconciliation", (it) => {
  it.effect(
    "refreshes all named scopes while retaining shared reads, throttles and credential isolation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-claude-usage-home-" });
        const sharedCacheDir = yield* fs.makeTempDirectoryScoped({
          prefix: "pylon-claude-usage-cache-",
        });
        const credentialPath = path.join(homePath, ".credentials.json");
        const credential = (token: string) =>
          fs.writeFileString(
            credentialPath,
            JSON.stringify({ claudeAiOauth: { accessToken: token } }),
          );
        yield* credential("synthetic-account-a");
        let calls = 0;
        let status = 200;
        let percent = 20;
        let changeCredentialDuringRead = false;
        const client = HttpClient.make((request) =>
          Effect.gen(function* () {
            calls += 1;
            if (changeCredentialDuringRead)
              yield* credential("synthetic-account-c").pipe(Effect.orDie);
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                {
                  five_hour: { utilization: 12 },
                  seven_day: { utilization: 30 },
                  limits: [
                    {
                      kind: "weekly_scoped",
                      percent,
                      scope: { model: { id: "model-a", display_name: "Model A" } },
                    },
                    {
                      kind: "weekly_scoped",
                      percent: percent + 10,
                      scope: { model: { id: "model-b", display_name: "Model B" } },
                    },
                  ],
                },
                { status, headers: status === 429 ? { "retry-after": "120" } : {} },
              ),
            );
          }),
        );
        const read = (freshForMs?: number) =>
          Effect.gen(function* () {
            const checkedAt = DateTime.formatIso(yield* DateTime.now);
            return yield* fetchClaudeOAuthUsage({ homePath }, checkedAt, {
              sharedCacheDir,
              freshForMs,
              shareFailures: true,
              commitGuard: Effect.succeed(true),
            });
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.provideService(HostProcessPlatform, "linux"),
          );

        const initial = yield* read();
        assert.deepStrictEqual(
          initial.usageLimits?.windows.map((window) => window.label),
          ["Session", "Weekly (all models)", "Weekly (Model A)", "Weekly (Model B)"],
        );
        yield* TestClock.adjust("1 minute");
        percent = 44;
        // Ordinary reads still honor the five-minute cache; a scoped signal requests newer data.
        assert.strictEqual((yield* read()).usageLimits?.windows[2]?.usedPercent, 20);
        assert.strictEqual(calls, 1);
        assert.strictEqual((yield* read(60_000)).usageLimits?.windows[2]?.usedPercent, 44);
        assert.strictEqual(calls, 2);
        yield* read(60_000);
        assert.strictEqual(calls, 2);

        yield* TestClock.adjust("1 minute");
        status = 429;
        const throttled = yield* read(60_000);
        assert.strictEqual(throttled.didRead, false);
        assert.strictEqual(throttled.cacheForMs, 120_000);
        status = 200;
        yield* TestClock.adjust("1 minute");
        assert.strictEqual((yield* read(60_000)).didRead, false);
        assert.strictEqual(calls, 3);
        yield* TestClock.adjust("1 minute");
        status = 503;
        assert.strictEqual((yield* read(60_000)).didRead, false);
        yield* read(60_000);
        assert.strictEqual(calls, 4);

        // A new login cannot inherit account A's cache or its throttle/failure window.
        yield* credential("synthetic-account-b");
        status = 200;
        percent = 7;
        assert.strictEqual((yield* read(60_000)).usageLimits?.windows[2]?.usedPercent, 7);
        assert.strictEqual(calls, 5);
        // If the credential changes during the request, neither publish nor cache the old answer.
        yield* TestClock.adjust("1 minute");
        changeCredentialDuringRead = true;
        const retired = yield* read(60_000);
        assert.strictEqual(retired.usageLimits, undefined);
        assert.strictEqual(retired.didRead, false);
      }),
  );
});

it.effect("publishes only a positively matched account throughout the live read", () =>
  Effect.gen(function* () {
    const snapshot = {
      instanceId: ProviderInstanceId.make("claude-test"),
      driver: ProviderDriverKind.make("claudeAgent"),
      status: "ready",
      enabled: true,
      installed: true,
      auth: { status: "authenticated", email: "a@example.test" },
      checkedAt: "2026-09-12T00:00:00.000Z",
      version: "2.1.220",
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;
    const usageLimits = {
      checkedAt: snapshot.checkedAt,
      windows: [{ label: "Weekly (Model A)", usedPercent: 12 }],
    };
    let current = true;
    let after: ServerProvider = snapshot;
    let readIdentity: string | undefined = snapshot.auth.email;
    let reads = 0;
    let duringRead = () => {};
    const run = (before: ServerProvider = snapshot, enabled = true) => {
      let snapshots = 0;
      return reconcileClaudeUsage({
        enabled,
        getSnapshot: Effect.sync(() => (++snapshots === 1 ? before : after)),
        isCurrent: Effect.sync(() => current),
        read: Effect.sync(() => {
          reads += 1;
          duringRead();
          return { accountIdentity: readIdentity, usageLimits };
        }),
      });
    };
    assert.deepStrictEqual(yield* run(), { accountIdentity: snapshot.auth.email, usageLimits });
    readIdentity = "b@example.test";
    assert.strictEqual(yield* run(), undefined);
    readIdentity = undefined;
    assert.strictEqual(yield* run(), undefined);
    readIdentity = snapshot.auth.email;
    after = { ...snapshot, auth: { status: "authenticated", email: "b@example.test" } };
    assert.strictEqual(yield* run(), undefined);
    after = { ...snapshot, auth: { status: "unauthenticated" } };
    assert.strictEqual(yield* run(), undefined);
    after = snapshot;
    duringRead = () => {
      current = false;
    };
    assert.strictEqual(yield* run(), undefined);
    const admittedReads = reads;
    assert.strictEqual(yield* run(), undefined);
    current = true;
    assert.strictEqual(yield* run(snapshot, false), undefined);
    assert.strictEqual(yield* run({ ...snapshot, auth: { status: "authenticated" } }), undefined);
    assert.strictEqual(
      yield* run({
        ...snapshot,
        auth: { status: "authenticated", email: snapshot.auth.email, type: "apiKey" },
      }),
      undefined,
    );
    assert.strictEqual(
      yield* run({
        ...snapshot,
        auth: { status: "authenticated", email: snapshot.auth.email, type: "bedrock" },
      }),
      undefined,
    );
    assert.strictEqual(reads, admittedReads);
  }),
);
