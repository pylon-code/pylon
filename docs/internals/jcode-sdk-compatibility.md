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

| Check                                       | Required  | Result  |
| ------------------------------------------- | --------- | ------- |
| `launch_instance`                           | yes       | Not run |
| `connect_control_client`                    | yes       | Not run |
| `ping`                                      | yes       | Not run |
| `create_sessions` (two working directories) | yes       | Not run |
| `attach_children_concurrently`              | yes       | Not run |
| `list_models`                               | yes       | Not run |
| `runtime_info`                              | yes       | Not run |
| `detach_reattach_exact_session`             | yes       | Not run |
| `clean_shutdown`                            | yes       | Not run |
| `live_text_turn`                            | live only | Not run |
| `live_reasoning_turn`                       | live only | Not run |
| `live_tool_turn`                            | live only | Not run |
| `live_image_turn`                           | live only | Not run |
| `live_cancel_turn`                          | live only | Not run |
| Observed Jcode runtime version              | —         | Not run |

Live-turn checks spend real model quota and only execute when
`JCODE_COMPAT_LIVE_TURNS=1` is set.
