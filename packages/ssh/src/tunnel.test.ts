import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SshPasswordPrompt } from "./auth.ts";
import {
  buildRemoteLaunchScript,
  buildRemoteLogTailScript,
  buildRemotePairingScript,
  buildRemoteStopScript,
  buildRemoteT3RunnerScript,
  describeReadinessCause,
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  REMOTE_PICK_PORT_SCRIPT,
  SshEnvironmentManager,
  waitForHttpReady,
} from "./tunnel.ts";

const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeDelayedSuccessfulProcess = (stdout: string, delayMs: number) => {
  const process = makeSuccessfulProcess(stdout);
  return {
    ...process,
    exitCode: Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.as(ChildProcessSpawner.ExitCode(0)),
    ),
  };
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

describe("ssh tunnel scripts", () => {
  it("builds the remote t3 runner with npx and npm fallbacks", () => {
    const script = buildRemoteT3RunnerScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE });

    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(script, 'exec t3 "$@"');
    assert.include(script, "exec npx --yes 't3@latest' \"$@\"");
    assert.include(script, "exec npm exec --yes 't3@latest' -- \"$@\"");
    assert.include(script, "could not install 't3@latest'");
    assert.include(script, "require_installed_t3_cli npx --yes --package 't3@latest'");
    assert.include(script, "require_installed_t3_cli npm exec --yes --package 't3@latest'");
    assert.include(script, "npm produced no t3 executable");
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/bin"');
    assert.include(script, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(script, "remote_node_satisfies_engine()");
    assert.include(script, "function satisfiesSemverRange");
    assert.include(script, "satisfiesSemverRange(rawVersion, range)");
    assert.include(script, 'prepend_path_if_dir "$VOLTA_HOME/bin"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.asdf/shims"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/share/mise/shims"');
    assert.include(script, 'eval "$(fnm env --shell bash)"');
    assert.include(script, "fnm use --silent-if-unchanged");
    assert.include(script, "fnm use default");
    assert.include(script, 'prepend_path_if_dir "$HOME/.nodenv/shims"');
    assert.include(script, 'NVM_DIR="$HOME/.nvm"');
    assert.include(script, "nvm use --silent default");
    assert.include(script, 'for T3_NODE_BIN in "$NVM_DIR"/versions/node/*/bin');
    assert.notInclude(script, "ensure $NVM_DIR/nvm.sh is available");
  });

  it("does not hard-code a remote node engine range", () => {
    const script = buildRemoteT3RunnerScript();

    assert.include(script, "T3_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("shell-quotes package specs in the remote t3 runner", () => {
    const script = buildRemoteT3RunnerScript({
      packageSpec: "t3@nightly; touch /tmp/t3-owned",
    });

    assert.include(script, "exec npx --yes 't3@nightly; touch /tmp/t3-owned' \"$@\"");
    assert.include(script, "exec npm exec --yes 't3@nightly; touch /tmp/t3-owned' -- \"$@\"");
    assert.include(
      script,
      "require_installed_t3_cli npx --yes --package 't3@nightly; touch /tmp/t3-owned'",
    );
    assert.notInclude(script, "exec npx --yes t3@nightly; touch /tmp/t3-owned");
  });

  it("builds the remote t3 runner with a node script override", () => {
    const script = buildRemoteT3RunnerScript({
      nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
    });

    assert.include(
      script,
      "T3_NODE_SCRIPT_PATH='/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs'",
    );
    assert.include(script, 'exec node "$T3_NODE_SCRIPT_PATH" "$@"');
  });

  it("uses the remote t3 runner for launch and pairing scripts", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      '[ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null',
    );
    assert.include(buildRemoteLaunchScript(), "RUNNER_CHANGED=1");
    assert.include(buildRemoteLaunchScript(), "ensure_remote_node_path()");
    assert.include(buildRemoteLaunchScript(), "if ! ensure_remote_node_path; then");
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`,
    );
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      "does not satisfy required range ",
    );
    assert.include(buildRemoteLaunchScript(), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(buildRemoteLaunchScript(), "wait_ready");
    assert.include(buildRemoteLaunchScript(), '"$RUNNER_FILE" serve --host 127.0.0.1');
    assert.include(buildRemoteLaunchScript(), '--base-dir "$DEFAULT_SERVER_HOME"');
    assert.notInclude(buildRemoteLaunchScript(), "server-home");
    assert.include(buildRemoteLaunchScript(), "Remote T3 server did not become ready");
    assert.include(buildRemoteLaunchScript(), 'wait_ready "60000"');
    assert.include(buildRemoteLaunchScript(), 'if [ -s "$LOG_FILE" ]; then');
    assert.include(buildRemoteLaunchScript(), "It wrote nothing to %s");
    assert.include(buildRemoteLaunchScript({ packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      buildRemotePairingScript(target),
      '"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json',
    );
    assert.include(buildRemotePairingScript(target), 'PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"');
    assert.notInclude(buildRemotePairingScript(target), "server-home");
    assert.include(buildRemotePairingScript(target, { packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      buildRemoteStopScript(target),
      'if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ]',
    );
    assert.include(buildRemoteStopScript(target), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(buildRemoteStopScript(target), 'rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"');
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"',
    );
    assert.include(buildRemoteLaunchScript(), "resolve_default_runtime_port()");
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port',
    );
    assert.include(
      buildRemoteLaunchScript(),
      "if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port))",
    );
    assert.include(buildRemoteLaunchScript(), 'PID_TO_STOP="${REMOTE_PID:-$DEFAULT_RUNTIME_PID}"');
    assert.include(buildRemoteLaunchScript(), 'REMOTE_PORT="$DEFAULT_REMOTE_PORT"');
    assert.include(buildRemoteLaunchScript(), 'rm -f "$PID_FILE"');
    assert.include(buildRemoteLaunchScript(), "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(buildRemoteLaunchScript(), 'if [ -z "$REMOTE_PORT" ]; then');
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('if [ "$REMOTE_MANAGED" = "managed" ]'),
      buildRemoteLaunchScript().indexOf("printf 'external\\n' >\"$MANAGED_FILE\""),
    );
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port'),
      buildRemoteLaunchScript().indexOf('elif [ -n "$REMOTE_PID" ]'),
    );
  });

  const SSH_TARGET = {
    alias: "devbox",
    hostname: "devbox.example.com",
    username: "julius",
    port: 2222,
  } as const;

  const generatedRemoteScripts = () => ({
    launch: buildRemoteLaunchScript(),
    pairing: buildRemotePairingScript(SSH_TARGET),
    stop: buildRemoteStopScript(SSH_TARGET),
    logTail: buildRemoteLogTailScript(SSH_TARGET),
    runner: buildRemoteT3RunnerScript(),
  });

  /**
   * Every line that decides where a remote server keeps its state: the state
   * dir the launcher owns, the home it hands `serve` and `auth pairing
   * create`, and any literal `--base-dir` argument. The legacy cleanup block
   * still names `.t3`, so the check is about what a script points a server at
   * rather than whether the string appears at all.
   */
  const serverHomeDeclarations = (script: string) =>
    script
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          /^(STATE_DIR|DEFAULT_SERVER_HOME|DEFAULT_RUNTIME_FILE|PAIRING_BASE_DIR)=/.test(line) ||
          line.includes("--base-dir"),
      );

  // `~/.t3` is T3 Code's runtime home, and its database carries upstream's
  // migration numbering. A remote server pointed at it would adopt another
  // product's install.
  it("keeps every generated remote script under the Pylon runtime home", () => {
    const scripts = generatedRemoteScripts();

    assert.include(scripts.launch, 'STATE_DIR="$HOME/.pylon-code/ssh-launch/$STATE_KEY"');
    assert.include(scripts.launch, 'DEFAULT_SERVER_HOME="$HOME/.pylon-code"');
    assert.include(scripts.pairing, '"$HOME/.pylon-code/ssh-launch/');
    assert.include(scripts.pairing, 'DEFAULT_SERVER_HOME="$HOME/.pylon-code"');
    assert.include(scripts.stop, '"$HOME/.pylon-code/ssh-launch/');
    assert.include(scripts.logTail, '"$HOME/.pylon-code/ssh-launch/');

    for (const [name, script] of Object.entries(scripts)) {
      const declarations = serverHomeDeclarations(script);
      for (const declaration of declarations) {
        assert.notMatch(declaration, /\.t3\b/, `${name}: ${declaration}`);
      }
    }

    // Guards the guard: the check is worthless if it matches nothing.
    assert.isAbove(serverHomeDeclarations(scripts.launch).length, 0);
    assert.isAbove(serverHomeDeclarations(scripts.pairing).length, 0);
  });

  // A host set up by the previous launcher is still running a server from
  // `~/.t3` that the new state dir cannot see and the new stop script no
  // longer reaches. The launch script retires it once, best effort.
  it("retires a previous launcher's state directory on the remote host", () => {
    const launch = buildRemoteLaunchScript();

    assert.include(launch, 'LEGACY_SERVER_HOME="$HOME/.t3"');
    assert.include(launch, 'LEGACY_STATE_DIR="$LEGACY_SERVER_HOME/ssh-launch/$STATE_KEY"');
    assert.include(launch, 'if [ -d "$LEGACY_STATE_DIR" ]; then');
    // Same mechanism as REMOTE_STOP_SCRIPT: never touch a server the user owns.
    assert.include(
      launch,
      '[ "$LEGACY_MANAGED" != "external" ] && [ -n "$LEGACY_PID" ] && kill -0 "$LEGACY_PID" 2>/dev/null && legacy_pid_is_stale_launcher_server "$LEGACY_PID"',
    );
    assert.include(launch, 'kill "$LEGACY_PID" 2>/dev/null || true');
    assert.include(launch, 'wait_for_pid_exit "$LEGACY_PID"');
    assert.include(
      launch,
      'rm -f "$LEGACY_STATE_DIR/pid" "$LEGACY_STATE_DIR/port" "$LEGACY_STATE_DIR/managed" || true',
    );
    assert.include(
      launch,
      'mv "$LEGACY_STATE_DIR" "$LEGACY_STATE_DIR.migrated" 2>/dev/null || rm -rf "$LEGACY_STATE_DIR" || true',
    );
    assert.include(launch, "Earlier remote state may still exist under ~/.t3");
    // The hint is diagnostic output; stdout carries the launch JSON the
    // desktop parses. `|| true` because under `set -e` a closed stderr would
    // otherwise take the whole launch down.
    assert.include(launch, "to keep using it.\\n' >&2 || true");

    // Every step in the block is best effort; none may abort the launch.
    const legacyBlock = launch.slice(
      launch.indexOf('if [ -d "$LEGACY_STATE_DIR" ]; then'),
      launch.indexOf('REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"'),
    );
    for (const line of legacyBlock.split("\n").map((entry) => entry.trim())) {
      if (line.startsWith("rm ") || line.startsWith("mv ") || line.startsWith("printf ")) {
        assert.match(line, /\|\| true$/, line);
      }
    }
  });

  // A pid file outlives the process it names. After a remote reboot the number
  // in it may belong to something else this user owns, so the block confirms
  // identity before it signals anything.
  it("checks the stale pid still looks like the old launcher's server", () => {
    const launch = buildRemoteLaunchScript();

    assert.include(launch, "legacy_pid_is_stale_launcher_server() {");
    assert.include(launch, 'LEGACY_ARGS="$(ps -p "$1" -o args= 2>/dev/null || true)"');
    // The two markers the old launcher's own `serve` invocation always carried.
    assert.include(
      launch,
      '*"serve --host 127.0.0.1"*"--base-dir $LEGACY_SERVER_HOME"*) return 0 ;;',
    );
    assert.include(launch, "*) return 1 ;;");
    // Defined before the block that calls it.
    assert.isBelow(
      launch.indexOf("legacy_pid_is_stale_launcher_server() {"),
      launch.indexOf('if [ -d "$LEGACY_STATE_DIR" ]; then'),
    );

    // wait_for_pid_exit has to be defined before the block calls it.
    assert.isBelow(
      launch.indexOf("wait_for_pid_exit() {"),
      launch.indexOf('if [ -d "$LEGACY_STATE_DIR" ]; then'),
    );
    // And the retirement has to happen before the current state is read, or
    // the launch decides what to reuse from a host we have not cleaned up.
    assert.isBelow(
      launch.indexOf('if [ -d "$LEGACY_STATE_DIR" ]; then'),
      launch.indexOf('REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"'),
    );
  });

  // Only the launch script retires the old directory. A stop or log-tail run
  // that also cleaned up would delete state the launch script may still need
  // to report on, and the stop script must never resurrect the old path.
  it("keeps the legacy cleanup out of the stop and log-tail scripts", () => {
    for (const script of [
      buildRemoteStopScript(SSH_TARGET),
      buildRemoteLogTailScript(SSH_TARGET),
      buildRemotePairingScript(SSH_TARGET),
    ]) {
      assert.notInclude(script, "LEGACY_STATE_DIR");
      assert.notInclude(script, ".t3/ssh-launch");
    }
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);

    return Effect.gen(function* () {
      const result = yield* launchOrReuseRemoteServer(target);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("allows cold remote launches to exceed the default SSH command timeout", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 75_000)),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(launchOrReuseRemoteServer(target));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(75));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(processLayer));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          waitForHttpReady({
            baseUrl: "http://127.0.0.1:41773/",
            timeoutMs: 1_000,
            intervalMs: 100,
            probeTimeoutMs: 250,
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Timed out waiting 1000ms");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, hangingHttpClient)),
      ),
    ),
  );

  it("preserves primitive readiness reason values in diagnostic output", () => {
    assert.deepEqual(
      describeReadinessCause({
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      }),
      {
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      },
    );
  });

  it.effect("accepts pretty-printed pairing JSON from the remote CLI", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("closes the tunnel scope and starts fresh after disconnect", () => {
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    let tunnelKillCount = 0;
    let stopCommandCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        spawnedCommands.push(args);
        if (args.includes("-N")) {
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        if (args.includes("sh") && args.includes("--")) {
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
          stopCommandCount += 1;
          return makeSuccessfulProcess('{"stopped":true}\n');
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer(),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;

      const first = yield* manager.ensureEnvironment(target);
      assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");
      const firstTunnelArgs = spawnedCommands.find((args) => args.includes("-N"));
      assert.isDefined(firstTunnelArgs);
      assert.include(firstTunnelArgs, "ControlMaster=no");
      assert.include(firstTunnelArgs, "ControlPath=none");
      assert.include(firstTunnelArgs, "ControlPersist=no");

      yield* manager.disconnectEnvironment(target);
      assert.equal(tunnelKillCount, 1);
      assert.equal(stopCommandCount, 1);

      yield* manager.ensureEnvironment(target);

      assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});
