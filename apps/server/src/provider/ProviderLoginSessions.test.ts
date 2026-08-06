import { ProviderLoginSessionId, type ClaudeSettings } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ProviderLoginSessions, ProviderLoginSessionsLive } from "./ProviderLoginSessions.ts";

const LOGIN_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz&code_challenge_method=S256";

const CLAUDE_SETTINGS = {
  enabled: true,
  binaryPath: "claude",
  homePath: "",
  launchArgs: "",
  customModels: [],
} as unknown as ClaudeSettings;

const sessionId = ProviderLoginSessionId.make("login-1");

/**
 * Stand-in for `claude auth login`: prints the URL, then exits with the given
 * code once anything is written to stdin.
 */
function loginProcessLayer(input: {
  readonly output: string;
  readonly exitCode?: number;
  readonly onStdin?: (written: string) => void;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach((chunk: Uint8Array) =>
            Effect.sync(() => input.onStdin?.(Buffer.from(chunk).toString("utf8"))),
          ),
          stdout: Stream.make(new TextEncoder().encode(input.output)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );
}

const testLayer = (spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
  ProviderLoginSessionsLive.pipe(
    Layer.provideMerge(spawner),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("hands back the authorization URL the CLI printed", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderLoginSessions;

    const started = yield* sessions.start({
      sessionId,
      settings: CLAUDE_SETTINGS,
      method: "subscription",
    });

    assert.strictEqual(started.url, LOGIN_URL);
  }).pipe(
    Effect.provide(
      testLayer(
        loginProcessLayer({
          output: `Opening browser to sign in…\nIf the browser didn't open, visit: ${LOGIN_URL}\nPaste code here if prompted > `,
        }),
      ),
    ),
  ),
);

// The code the user pastes is worthless unless it reaches the process stdin,
// and a silent drop would look exactly like a rejected code.
it.effect("writes the pasted code to the waiting process", () => {
  const written: string[] = [];
  const layer = testLayer(
    loginProcessLayer({
      output: `visit: ${LOGIN_URL}\nPaste code here if prompted > `,
      onStdin: (chunk) => written.push(chunk),
    }),
  );

  return Effect.gen(function* () {
    const sessions = yield* ProviderLoginSessions;

    yield* sessions.start({ sessionId, settings: CLAUDE_SETTINGS, method: "subscription" });
    const result = yield* sessions.submitCode({ sessionId, code: "pasted-code" });

    assert.strictEqual(result.signedIn, true);
    assert.include(written.join(""), "pasted-code");
  }).pipe(Effect.provide(layer));
});

it.effect("reports the CLI's own message when sign-in fails", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderLoginSessions;

    yield* sessions.start({ sessionId, settings: CLAUDE_SETTINGS, method: "subscription" });
    const result = yield* sessions.submitCode({ sessionId, code: "wrong" });

    assert.strictEqual(result.signedIn, false);
    assert.strictEqual(result.message, "Invalid authorization code");
  }).pipe(
    Effect.provide(
      testLayer(
        loginProcessLayer({
          output: `visit: ${LOGIN_URL}\nPaste code here if prompted > \nInvalid authorization code\n`,
          exitCode: 1,
        }),
      ),
    ),
  ),
);

// A stale session id is the normal result of leaving a dialog open too long, so
// it must read as "start again", not as a crash.
it.effect("refuses a code for a session that is no longer running", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderLoginSessions;

    const result = yield* sessions
      .submitCode({ sessionId: ProviderLoginSessionId.make("gone"), code: "x" })
      .pipe(Effect.flip);

    assert.match(result.reason, /no longer running/iu);
  }).pipe(Effect.provide(testLayer(loginProcessLayer({ output: `visit: ${LOGIN_URL}\n` })))),
);

it.effect("cancelling an unknown session is not an error", () =>
  Effect.gen(function* () {
    const sessions = yield* ProviderLoginSessions;

    yield* sessions.cancel({ sessionId: ProviderLoginSessionId.make("never-started") });
  }).pipe(Effect.provide(testLayer(loginProcessLayer({ output: `visit: ${LOGIN_URL}\n` })))),
);
