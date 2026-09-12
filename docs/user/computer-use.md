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

1. Open **Settings → Integrations → Computer** for the environment you want to
   control. Pylon checks its installed driver and desktop permissions.
2. Leave **Cua Driver executable** set to `cua-driver` to use managed setup.
   Choose **Check for updates**, then **Install**. Pylon selects the newest plain
   SemVer Driver release from Cua's official GitHub repository, verifies its size
   and SHA-256, and stages it before activation. On macOS, Pylon also verifies the
   app signature and Cua's publisher identity. Cua's monorepo marks its product
   releases as GitHub prereleases; a plain SemVer tag is its stable channel.
3. On macOS, choose **Open permission setup**. Complete the prompts on the
   environment's computer and enable **CuaDriver** in System Settings → Privacy
   & Security → Accessibility and Screen & System Audio Recording. Then choose
   **Check permissions again**. Pylon cannot grant or reset macOS permissions for
   you. A terminal's permissions alone are insufficient.
4. Turn on **Agent computer access** and start a new agent session. No separate
   Codex, Claude, or other provider MCP configuration is needed.
5. Open the target app yourself when using background mode. Ask the agent: “Use
   Pylon's computer tools to check permissions, inspect this app's window, test the
   requested flow, and verify the result.”

The macOS app stays at `/Applications/CuaDriver.app` to preserve its identity and
permission grants. Linux and Windows installations live in the environment's
managed tools directory and require an interactive desktop. Pylon does not install
an operating system or configure a headless display server. A custom executable
remains under your control; Pylon does not update or replace it. Guided management
is available in the web and desktop settings UI; mobile agents receive the same
tools but mobile does not yet have a setup screen.

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

Use **Check for updates**, **Update**, or **Repair installation** in Computer
settings. Review the selected version and environment before continuing. Setup
restarts that computer's Cua service, including connections from other applications
or Pylon environments; finish those desktop tasks first. Pylon drains its current
action and blocks new actions during activation. It never downgrades a newer
installed version.

Progress belongs to the environment server and survives a browser disconnect.
You can cancel downloads and permission setup; the short activation transaction
cannot be cancelled. A failed activation restores the previous app when its backup
can be verified. If another process changed the app or backup, Pylon preserves the
files and asks you to inspect them. After a server restart, **Repair** can recover
an interrupted transaction.

An installer lock prevents two Pylon processes from replacing the same driver.
After a process crash, Pylon deliberately does not reclaim a lock automatically:
its error gives the lock path. Verify no installer is running before removing only
that lock and retrying Repair. Insufficient write access to `/Applications` must
be resolved on that Mac; Pylon does not silently elevate privileges.

The background tool policy and live Mac desktop control were verified against
Cua Driver **0.28.1**. New upstream tools or argument names require a Pylon policy
update or explicit foreground access; installing a future release does not expand
the default background permissions.

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
