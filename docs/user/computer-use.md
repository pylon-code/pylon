# Computer access

Pylon can give agents desktop control through Cua Driver. The same
`computer_tools` and `computer_call` tools are available through Codex, Claude,
OpenCode, Cursor, Grok, Antigravity, and Prime Agent. This is independent of the
selected model; its ability to interpret screenshots and use tools still matters.

Computer access controls **the computer running the selected environment server**.
Connecting from a phone, a browser, or over a tunnel does not change that target.
For a remote environment, Cua must run on that remote computer in a usable desktop
session. This integration does not forward control to your local Mac or provision
a virtual desktop.

## Set up

1. Install [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver)
   on the environment server computer. Pylon's MCP connection and tool catalog were verified
   against version **0.28.1**, the latest published release on September 12, 2026
   (marked prerelease by upstream). Pylon does not install or update it silently.
2. On macOS, use the CuaDriver app installation and run
   `cua-driver permissions grant`. Grant Accessibility and Screen Recording to
   **CuaDriver** in System Settings. A terminal's permissions alone are insufficient.
3. Open **Settings → Integrations → Computer** for that environment. Set
   **Cua Driver executable** if it is not on the server's PATH. The standard macOS
   app executable is `/Applications/CuaDriver.app/Contents/MacOS/cua-driver`.
4. Turn on **Agent computer access** and start a new agent session. No separate
   Codex, Claude, or other provider MCP configuration is needed.
5. Open the target app yourself when using background mode. Ask the agent: “Use Pylon's computer tools to check Cua permissions, then test
   the requested desktop app flow. Inspect the current window before acting and
   verify the result.”

The agent lists tools with `computer_tools`, reads a particular tool's schema by
passing its name, and invokes it with `computer_call`. Screenshots return as images
in the tool result. The available actions come from your installed Cua version.
Use Pylon's Browser for web testing and Device hub for simulators.

Each provider session has a separate Cua connection. Ending that session closes its
connection. Turning computer access off closes Pylon's connections and blocks
further calls, including calls from existing sessions. An action already delivered
to an application cannot be undone by turning the setting off. Re-enabling access
requires a new session for agents that started while it was disabled.

Background mode is the default. Pylon permits a reviewed subset of window tools,
requires explicit window targeting for input, forces background delivery, and blocks
foreground, desktop-input, replay, configuration, and unknown tool routes. To allow
interrupting actions, enable **Allow foreground control** in the same settings.
Background actions can still cause an app to open a dialog or another window.

Cua can perform many actions in the background, but support depends on the app,
platform, and action. A successful connection is not proof that every action is
supported. Some actions require foreground access or may be refused; ask the agent
to report those limits rather than repeatedly retrying.

## Updates and troubleshooting

Run `cua-driver --version` to inspect the installed version and
`cua-driver check-update --no-cache` to check upstream. Follow Cua's update process,
then restart the Pylon agent session. Background mode admits only tools and argument names reviewed by Pylon; new
upstream actions require a Pylon update or explicit foreground control. Pylon does not guarantee compatibility with every future Cua release.

If connecting fails, check the executable path on the environment server and run
`cua-driver permissions status --json` on that machine. If a call times out, inspect
what actually happened before retrying an action.

Cua's own telemetry preference is separate from Pylon's. Inspect it with
`cua-driver telemetry status` and disable it with `cua-driver telemetry disable`.

Separate connections do not create separate desktops. Pylon serializes individual
calls, but two agents' workflows can interleave. Avoid simultaneous automation of
the same app; use separate environment desktops for independent work.

Pylon forwards standard desktop display/session environment variables to Cua, but
not arbitrary server secrets or `CUA_DRIVER_*` policy overrides. Configure the
installed driver directly. Linux and Windows require their own working Cua desktop
backend; macOS background behavior does not imply equivalent platform support.
