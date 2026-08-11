# Jcode SDK compatibility

Pylon talks to Jcode through the published TypeScript SDK and always launches the
Jcode runtime the user already installed. Nothing about the Jcode binary is
vendored into Pylon's artifacts.

This page is the evidence template for that boundary. Anything marked `Not run`
has not been observed yet: Task 11 owns the real compatibility matrix and is the
only task allowed to replace those markers with pass/fail results. Do not record
a tested Jcode runtime version here before
`apps/server/scripts/jcode-sdk-compatibility.ts` has actually observed it.

## Pinned SDK

| Field              | Value                         |
| ------------------ | ----------------------------- |
| Package            | `@1jehuang/jcode-sdk`         |
| Version            | `1.1.0` (exact pin, no range) |
| Declared engines   | `node >=20`                   |
| Runtime dependency | `ajv@^8.20.0`                 |
| Consumer           | `apps/server`                 |

## Local stream-correction boundary

The isolated Jcode integration branch is verified at commit
`6d878f8fb32c5f23fadb222f2ddd2b89484aedcd`. That local source exposes harness
API major `1`, minor `1`, advertises capability `stream_corrections`, and types
both additive correction events: `text_replace` and `retry_rollback`.

This is local implementation evidence, not a published-runtime matrix result.
Pylon remains pinned to the published `@1jehuang/jcode-sdk@1.1.0`, whose
`ApiEvent` union does not yet contain those two events. Its transport does
preserve unknown frames, so `JcodeSdkBridge` temporarily widens the internal
iterator to `AnyApiEvent` and applies a strict, capability-gated decoder for
exactly those two shapes. Malformed frames and correction frames received
without `stream_corrections` are dropped at the adapter boundary.

Remove that compatibility decoder and the `AnyApiEvent` iterator widening once
a published `@1jehuang/jcode-sdk` release contains both typed events. The same
cleanup commit should pin that release and consume the SDK's typed `ApiEvent`
union directly.

## Environment observed while pinning

These describe the machine that produced the packaging evidence below, not a
runtime compatibility result.

| Field                   | Value                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| Node                    | `v22.22.3`                                                                     |
| pnpm                    | `1.3.14` (via Vite Plus `vp`)                                                  |
| Platform / architecture | `Darwin arm64`                                                                 |
| Jcode binary path form  | absolute path on `PATH` (`JCODE_BINARY` overrides; default `jcode`)            |
| Credential mode         | `inheritLogins: true` by default; `JCODE_COMPAT_INHERIT_LOGINS=0` starts empty |
| Instance home           | `JCODE_COMPAT_HOME`, else `<tmpdir>/pylon-jcode-compat`                        |

## External-runtime packaging

The SDK ships six optional platform packages, each carrying a bundled Jcode
executable. All six are excluded by workspace overrides so no install, staged
desktop dependency set, or copied artifact file can pull one back in.

| Package                        | Status                  |
| ------------------------------ | ----------------------- |
| `@1jehuang/jcode-darwin-arm64` | excluded (`-` override) |
| `@1jehuang/jcode-darwin-x64`   | excluded (`-` override) |
| `@1jehuang/jcode-linux-arm64`  | excluded (`-` override) |
| `@1jehuang/jcode-linux-x64`    | excluded (`-` override) |
| `@1jehuang/jcode-win32-arm64`  | excluded (`-` override) |
| `@1jehuang/jcode-win32-x64`    | excluded (`-` override) |

Observed sizes on the environment above:

| Measurement                                             | Value                              |
| ------------------------------------------------------- | ---------------------------------- |
| Installed SDK store entry (`@1jehuang/jcode-sdk@1.1.0`) | 260 KB                             |
| Installed platform runtime packages                     | 0 (none present in `node_modules`) |
| Server bundle `apps/server/dist/bin.mjs` after the pin  | 4.7 MB                             |
| SDK symbols embedded in the server bundle               | 0 matches (`@1jehuang` absent)     |
| Bundled Jcode executable in any artifact                | none                               |

The SDK stays external to the server bundle, so pinning it changed neither the
bundle contents nor its size class.

## Runtime compatibility matrix

Reproduce with:

```bash
JCODE_COMPAT_HOME=/tmp/jcode-compat node apps/server/scripts/jcode-sdk-compatibility.ts
JCODE_COMPAT_LIVE_TURNS=1 node apps/server/scripts/jcode-sdk-compatibility.ts
```

`/tmp/jcode-compat` is short enough to bind its own sockets, so that command
takes the direct path and never exercises the alias described below. Use a home
under a deep checkout to exercise it, and read `durableHomeFitsSocketLimit` in
the `environment` record to see which path a run actually took: `false` is what
proves the alias was used.

| Check                                       | Required  | Result on macOS ARM64 |
| ------------------------------------------- | --------- | --------------------- |
| `launch_instance`                           | yes       | Pass                  |
| `connect_control_client`                    | yes       | Pass                  |
| `ping`                                      | yes       | Pass                  |
| `create_sessions` (two working directories) | yes       | Pass                  |
| `attach_children_concurrently`              | yes       | Pass                  |
| `list_models`                               | yes       | Pass                  |
| `runtime_info`                              | yes       | Pass                  |
| `detach_reattach_exact_session`             | yes       | Pass                  |
| `clean_shutdown`                            | yes       | Pass                  |
| `live_text_turn`                            | live only | Not run               |
| `live_reasoning_turn`                       | live only | Not run               |
| `live_tool_turn`                            | live only | Not run               |
| `live_image_turn`                           | live only | Not run               |
| `live_cancel_turn`                          | live only | Not run               |
| Observed Jcode runtime version              | —         | `0.75.2-dev`          |

The nine non-live checks were observed passing (`{"pass":10,"fail":0,"skipped":5}`
including the `environment` record, exit code 0) on `Darwin arm64`, Node
`v22.22.3`, against binary `0.75.2-dev (d218d84fe)`. Linux and Windows rows are
absent rather than assumed: neither has been run.

Live-turn checks spend real model quota and only execute when
`JCODE_COMPAT_LIVE_TURNS=1` is set. They remain unrun.

### Unix socket path length

The daemon binds `<launch home>/run/jcode-debug.sock`, and `sun_path` holds 104
bytes including its NUL terminator, so 103 is the longest bindable path. This is
not theoretical: a home 82 characters long binds and one 83 characters long does
not, and for a realistic state directory and instance ID Pylon's own durable home
(`<stateDir>/provider-sessions/jcode/<instance>/home`) yields a socket path of
137-145 bytes, which is 34-42 bytes past the limit.

When the durable home does not fit, the daemon is launched from a short alias
under `/tmp/pylon-jcode-<uid>` that resolves to it, so sessions, credentials and
`servers.json` still live in the durable home while the bind path stays bounded.
Verified on macOS ARM64 by driving `JcodeInstanceManager` against the real
runtime with a durable home whose socket path is 207 bytes: launch, runtime
status, model list, two session clients, exact-session detach/reattach and clean
shutdown all pass, binding from a 58-byte socket path instead.

The failure this prevents is silent. The daemon exits with `path must be shorter
than SUN_LEN`, `api-bridge` carries on assuming an already-running server, and
every request then fails with an opaque `EPIPE` that names neither the path nor
the limit.
