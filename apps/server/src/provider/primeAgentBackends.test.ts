import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";

import { primeAgentSignInsFromAuthFile, readPrimeAgentBackends } from "./primeAgentBackends.ts";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");

// Shaped like a real `~/.prime/agent/auth.json`: one entry per backend, with
// the token fields Pylon never reads alongside the ones it does.
const AUTH_FILE = {
  anthropic: {
    type: "oauth",
    refresh: "refresh-secret",
    access: "access-secret",
    expires: NOW + 30 * 60_000,
  },
  "openai-codex": {
    type: "oauth",
    access: "access-secret",
    refresh: "refresh-secret",
    expires: NOW + 30 * 60_000,
    accountId: "acct_123",
  },
};

describe("primeAgentSignInsFromAuthFile", () => {
  it("keeps each backend's identity and its token while fresh", () => {
    assert.deepStrictEqual(primeAgentSignInsFromAuthFile(JSON.stringify(AUTH_FILE), NOW), [
      { backend: "anthropic", accessToken: "access-secret" },
      { backend: "openai-codex", accountId: "acct_123", accessToken: "access-secret" },
    ]);
  });

  // The identity outlives the token: matching a configured Codex account
  // needs no credential, only reading Prime's own capacity does.
  it("keeps the Codex identity after its token has expired", () => {
    const expired = {
      ...AUTH_FILE,
      "openai-codex": { ...AUTH_FILE["openai-codex"], expires: NOW - 1 },
    };

    assert.deepStrictEqual(primeAgentSignInsFromAuthFile(JSON.stringify(expired), NOW)[1], {
      backend: "openai-codex",
      accountId: "acct_123",
    });
  });

  // Prime only refreshes the token while it is running on Anthropic; sending
  // an expired one buys a 401 and nothing else.
  it("drops an Anthropic token that has expired or is about to", () => {
    const expired = {
      ...AUTH_FILE,
      anthropic: { ...AUTH_FILE.anthropic, expires: NOW - 1 },
    };
    const expiring = {
      ...AUTH_FILE,
      anthropic: { ...AUTH_FILE.anthropic, expires: NOW + 30_000 },
    };

    assert.deepStrictEqual(primeAgentSignInsFromAuthFile(JSON.stringify(expired), NOW)[0], {
      backend: "anthropic",
    });
    assert.deepStrictEqual(primeAgentSignInsFromAuthFile(JSON.stringify(expiring), NOW)[0], {
      backend: "anthropic",
    });
  });

  it("ignores backends Pylon has no provider for", () => {
    const withExtra = { ...AUTH_FILE, "prime-inference": { type: "api", access: "k" } };

    assert.deepStrictEqual(
      primeAgentSignInsFromAuthFile(JSON.stringify(withExtra), NOW).map((entry) => entry.backend),
      ["anthropic", "openai-codex"],
    );
  });

  it.each([
    ["not JSON", "{oops"],
    ["an empty file", "{}"],
    ["a Codex entry with no account id", JSON.stringify({ "openai-codex": { type: "oauth" } })],
  ])("yields nothing for %s", (_label, raw) => {
    assert.deepStrictEqual(primeAgentSignInsFromAuthFile(raw, NOW), []);
  });
});

// The usage endpoint must never be reached here: Anthropic's token is expired
// in this fixture, so a request would mean the freshness rule is broken.
const UnreachableHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("the usage endpoint must not be called")),
);

it.layer(Layer.mergeAll(NodeServices.layer, UnreachableHttpClient))(
  "readPrimeAgentBackends",
  (it) => {
    it.effect("reads Prime's own ChatGPT capacity and skips an expired Anthropic token", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-home-" });
        const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-cache-" });
        const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        yield* fs.writeFileString(
          path.join(home, "auth.json"),
          `{"anthropic":{"type":"oauth","access":"stale","expires":${nowMs - 1}},` +
            `"openai-codex":{"type":"oauth","access":"fresh-secret","expires":${nowMs + 60 * 60_000},"accountId":"acct_123"}}`,
        );
        const reads: string[] = [];

        const backends = yield* readPrimeAgentBackends(
          { agentHomePath: home },
          {
            sharedCacheDir: cacheDir,
            readCodexWindows: (signIn) =>
              Effect.sync(() => {
                reads.push(`${signIn.accountId}:${signIn.accessToken}`);
                return {
                  rateLimits: { primary: { usedPercent: 40, windowDurationMins: 10_080 } },
                };
              }),
          },
        );

        assert.deepStrictEqual(reads, ["acct_123:fresh-secret"]);
        assert.deepStrictEqual(backends, [
          { backend: "anthropic" },
          {
            backend: "openai-codex",
            accountId: "acct_123",
            usageLimits: {
              source: "primeAgentCodex",
              checkedAt: backends[1]?.usageLimits?.checkedAt ?? "",
              windows: [{ label: "Weekly", usedPercent: 40, windowDurationMins: 10_080 }],
            },
          },
        ]);

        // A second read inside the shared window is served from the cache:
        // one process and one request per window, however many servers ask.
        const again = yield* readPrimeAgentBackends(
          { agentHomePath: home },
          {
            sharedCacheDir: cacheDir,
            readCodexWindows: () => Effect.die("must be served from the shared reading"),
          },
        );
        assert.strictEqual(again[1]?.usageLimits?.windows[0]?.usedPercent, 40);
      }).pipe(Effect.scoped),
    );
  },
);
