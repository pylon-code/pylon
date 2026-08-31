import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  primeAgentCredentialFingerprint,
  primeAgentSignInsFromAuthFile,
  readPrimeAgentBackends,
  readPrimeAgentCapacity,
  readPrimeAgentCodexWindows,
  resolvePrimeAgentHomePath,
} from "./primeAgentBackends.ts";

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
  it("builds stable secret-safe credential fingerprints", () => {
    const fingerprint = primeAgentCredentialFingerprint("access-secret");
    assert.strictEqual(fingerprint, primeAgentCredentialFingerprint("access-secret"));
    assert.notStrictEqual(fingerprint, primeAgentCredentialFingerprint("different-secret"));
    assert.notInclude(fingerprint, "access-secret");
  });

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

it.effect("bounds and finalizes the throwaway Codex process when cancelled", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const started = yield* Deferred.make<void>();
    const finalized = yield* Deferred.make<void>();
    const captured = yield* Ref.make<ChildProcess.Command | undefined>(undefined);
    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.never,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.never,
      stderr: Stream.empty,
      all: Stream.never,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.acquireRelease(
        Ref.set(captured, command).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.as(handle),
        ),
        () => Deferred.succeed(finalized, undefined).pipe(Effect.asVoid),
      ),
    );
    const fiber = yield* readPrimeAgentCodexWindows({
      accessToken: "must-not-appear-in-diagnostics",
      accountId: "acct_123",
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.forkScoped,
    );

    yield* Deferred.await(started);
    const command = yield* Ref.get(captured);
    assert.isTrue(command !== undefined && ChildProcess.isStandardCommand(command));
    if (!command || !ChildProcess.isStandardCommand(command)) return;
    assert.strictEqual(command.command, "codex");
    assert.strictEqual(command.options.forceKillAfter, "2 seconds");
    const tempHome = command.options.env?.["CODEX_HOME"];
    assert.isString(tempHome);
    assert.isTrue(yield* fs.exists(tempHome ?? ""));

    yield* Fiber.interrupt(fiber);
    yield* Deferred.await(finalized);
    assert.isFalse(yield* fs.exists(tempHome ?? ""));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("logs only a sanitized prerequisite when the Codex process cannot start", () => {
  const messages: string[] = [];
  const logger = Logger.make(({ message }) => {
    messages.push(String(message));
  });
  const accessToken = "diagnostic-access-secret";
  const accountId = "diagnostic-account-secret";
  const spawner = ChildProcessSpawner.make(() =>
    Effect.die(new Error(`native failure ${accessToken} ${accountId}`)),
  );

  return Effect.gen(function* () {
    assert.strictEqual(yield* readPrimeAgentCodexWindows({ accessToken, accountId }), undefined);
    assert.isTrue(
      messages.some((message) =>
        message.includes(
          "Prime Agent ChatGPT capacity requires the Codex CLI (`codex`) on the Pylon server PATH.",
        ),
      ),
    );
    assert.notInclude(messages.join("\n"), accessToken);
    assert.notInclude(messages.join("\n"), accountId);
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provide(
      Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
    ),
  );
});

it.effect("resolves Prime capacity homes from the merged instance environment", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    assert.equal(
      resolvePrimeAgentHomePath({ agentHomePath: "" }, path, {
        processEnv: { HOME: "/instance/home" },
        platform: "linux",
      }),
      "/instance/home/.prime/agent",
    );
    assert.equal(
      resolvePrimeAgentHomePath({ agentHomePath: "" }, path, {
        processEnv: {
          HOME: "/instance/home",
          PRIME_AGENT_CODING_AGENT_DIR: "/instance/prime-home",
        },
        platform: "linux",
      }),
      "/instance/prime-home",
    );
    assert.equal(
      resolvePrimeAgentHomePath({ agentHomePath: "" }, path, {
        processEnv: {
          HOME: "/instance/home",
          PRIME_AGENT_CODING_AGENT_DIR: "~/.prime-alt",
        },
        platform: "linux",
      }),
      "/instance/home/.prime-alt",
    );
    assert.equal(
      resolvePrimeAgentHomePath({ agentHomePath: "" }, path, {
        processEnv: {
          UserProfile: "C:\\Users\\Instance",
          HomeDrive: "D:",
          HomePath: "\\Ignored",
        },
        platform: "win32",
      }),
      "C:\\Users\\Instance\\.prime\\agent",
    );
    assert.equal(
      resolvePrimeAgentHomePath({ agentHomePath: "" }, path, {
        processEnv: { HOMEDRIVE: "D:", HOMEPATH: "\\Profiles\\DriveUser" },
        platform: "win32",
      }),
      "D:\\Profiles\\DriveUser\\.prime\\agent",
    );
    assert.equal(
      resolvePrimeAgentHomePath({ agentHomePath: "" }, path, {
        processEnv: {
          USERPROFILE: "C:\\Users\\Base",
          PRIME_AGENT_CODING_AGENT_DIR: "C:\\prime-base",
          UserProfile: "D:\\Users\\Instance",
          prime_agent_coding_agent_dir: "~\\prime-instance",
        },
        platform: "win32",
      }),
      "D:\\Users\\Instance\\prime-instance",
    );
    assert.equal(
      resolvePrimeAgentHomePath({ agentHomePath: "/explicit/prime-home" }, path, {
        processEnv: {
          HOME: "/instance/home",
          PRIME_AGENT_CODING_AGENT_DIR: "relative-home",
        },
        platform: "linux",
      }),
      "/explicit/prime-home",
    );
    assert.equal(
      resolvePrimeAgentHomePath({ agentHomePath: "" }, path, {
        processEnv: {
          HOME: "/instance/home",
          PRIME_AGENT_CODING_AGENT_DIR: "relative-home",
        },
        platform: "linux",
      }),
      undefined,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.layer(Layer.mergeAll(NodeServices.layer, UnreachableHttpClient))(
  "readPrimeAgentBackends",
  (it) => {
    it.effect("reads auth from the HOME-derived instance account", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-env-home-" });
        const agentDir = path.join(home, ".prime", "agent");
        yield* fs.makeDirectory(agentDir, { recursive: true });
        yield* fs.writeFileString(path.join(agentDir, "auth.json"), "{}");

        const result = yield* readPrimeAgentCapacity(
          { agentHomePath: "" },
          { processEnv: { HOME: home }, platform: "linux" },
        );
        assert.deepStrictEqual(result, { backends: [] });
      }).pipe(Effect.scoped),
    );

    it.effect("fails closed for a relative environment agent dir without a provider cwd", () =>
      Effect.gen(function* () {
        const result = yield* readPrimeAgentCapacity(
          { agentHomePath: "" },
          {
            processEnv: {
              HOME: "/server/account",
              PRIME_AGENT_CODING_AGENT_DIR: "relative-prime-home",
            },
            platform: "linux",
          },
        );
        assert.equal(result, undefined);
      }),
    );

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

    it.effect("shares failed Codex reads and preserves their last good result", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-home-" });
        const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-cache-" });
        const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        yield* fs.writeFileString(
          path.join(home, "auth.json"),
          `{"openai-codex":{"type":"oauth","access":"fresh-secret",` +
            `"expires":${nowMs + 60 * 60_000},"accountId":"acct_123"}}`,
        );
        let reads = 0;
        const read = () =>
          Effect.sync(() => {
            reads += 1;
            return reads === 1
              ? { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 10_080 } } }
              : undefined;
          });
        const options = {
          sharedCacheDir: cacheDir,
          freshForMs: 0,
          readCodexWindows: read,
        };

        const first = yield* readPrimeAgentCapacity({ agentHomePath: home }, options);
        const failed = yield* readPrimeAgentCapacity({ agentHomePath: home }, options);
        const sharedFailure = yield* readPrimeAgentCapacity(
          { agentHomePath: home },
          {
            ...options,
            readCodexWindows: () => Effect.die("shared failure must suppress another process"),
          },
        );

        assert.strictEqual(reads, 2);
        assert.isTrue(first?.backends[0]?.didReadCapacity);
        assert.isFalse(failed?.backends[0]?.didReadCapacity);
        assert.isFalse(sharedFailure?.backends[0]?.didReadCapacity);
        assert.strictEqual(
          sharedFailure?.backends[0]?.backend.usageLimits?.windows[0]?.usedPercent,
          40,
        );
      }).pipe(Effect.scoped),
    );

    it.effect("drops a failed shared value past the periodic retention cap", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-home-" });
        const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-cache-" });
        yield* fs.writeFileString(
          path.join(home, "auth.json"),
          `{"openai-codex":{"type":"oauth","access":"fresh-secret",` +
            `"expires":${NOW + 3 * 60 * 60_000},"accountId":"acct_123"}}`,
        );
        let reads = 0;
        const options = {
          sharedCacheDir: cacheDir,
          freshForMs: 0,
          readCodexWindows: () =>
            Effect.sync(() => {
              reads += 1;
              return reads === 1
                ? { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 10_080 } } }
                : undefined;
            }),
        };

        const first = yield* readPrimeAgentBackends({ agentHomePath: home }, options);
        assert.strictEqual(first[0]?.usageLimits?.windows[0]?.usedPercent, 40);
        yield* TestClock.adjust("31 minutes");
        const failed = yield* readPrimeAgentBackends({ agentHomePath: home }, options);

        assert.strictEqual(reads, 2);
        assert.deepStrictEqual(failed, [{ backend: "openai-codex", accountId: "acct_123" }]);
      }).pipe(Effect.scoped),
    );

    it.effect("does not reuse Anthropic capacity after a token re-login", () => {
      let calls = 0;
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          calls += 1;
          return HttpClientResponse.fromWeb(
            request,
            calls === 1
              ? Response.json({ five_hour: { utilization: 10 } })
              : Response.json({ error: "temporarily unavailable" }, { status: 503 }),
          );
        }),
      );

      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-home-" });
        const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-cache-" });
        const authPath = path.join(home, "auth.json");
        const writeAuth = (token: string) =>
          fs.writeFileString(
            authPath,
            `{"anthropic":{"type":"oauth","access":"${token}",` +
              `"expires":${NOW + 60 * 60_000}}}`,
          );

        yield* writeAuth("token-a");
        const first = yield* readPrimeAgentCapacity(
          { agentHomePath: home },
          { sharedCacheDir: cacheDir, freshForMs: 0 },
        );
        yield* writeAuth("token-b");
        const relogged = yield* readPrimeAgentCapacity(
          { agentHomePath: home },
          { sharedCacheDir: cacheDir, freshForMs: 0 },
        );
        const snapshot = yield* readPrimeAgentBackends(
          { agentHomePath: home },
          { sharedCacheDir: cacheDir, freshForMs: 0 },
        );

        assert.strictEqual(calls, 2);
        assert.strictEqual(first?.backends[0]?.backend.usageLimits?.windows[0]?.usedPercent, 10);
        assert.isTrue(first?.backends[0]?.didReadCapacity);
        assert.isFalse(relogged?.backends[0]?.didReadCapacity);
        assert.notStrictEqual(
          first?.backends[0]?.retentionIdentity,
          relogged?.backends[0]?.retentionIdentity,
        );
        assert.deepStrictEqual(relogged?.backends[0]?.backend, { backend: "anthropic" });
        assert.deepStrictEqual(snapshot, [{ backend: "anthropic" }]);
      }).pipe(Effect.scoped, Effect.provideService(HttpClient.HttpClient, httpClient));
    });

    it.effect("distinguishes an unreadable auth file from an authoritative empty one", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-home-" });
        const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-prime-cache-" });
        const authPath = path.join(home, "auth.json");

        assert.strictEqual(
          yield* readPrimeAgentCapacity({ agentHomePath: home }, { sharedCacheDir: cacheDir }),
          undefined,
        );
        yield* fs.writeFileString(authPath, "not json");
        assert.strictEqual(
          yield* readPrimeAgentCapacity({ agentHomePath: home }, { sharedCacheDir: cacheDir }),
          undefined,
        );
        yield* fs.writeFileString(authPath, "{}");
        assert.deepStrictEqual(
          yield* readPrimeAgentCapacity({ agentHomePath: home }, { sharedCacheDir: cacheDir }),
          { backends: [] },
        );
      }).pipe(Effect.scoped),
    );
  },
);
