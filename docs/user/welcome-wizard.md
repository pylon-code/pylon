# Welcome wizard

Pylon shows a setup flow when you open a new installation or connect to the
hosted app for the first time. Existing workspaces skip this flow. An existing
installation with no projects and no threads shows it once.

To run setup again, for example to import more projects, open the command
palette and choose **Set up computers and import projects**.

## Connect your computers

Select one or more computers to set up. If you opened Pylon directly from a
server or the desktop app, that computer is already connected and selected.
It is identified by its name, which may differ from the device running your
browser.

You can add more computers before continuing:

- **Pylon Connect** connects computers that are signed in to your account. Run
  `npx t3 connect` on each computer you want to add, then start Pylon or run
  `npx t3 serve` so the computer stays available.
- **Add a computer** connects directly to a server on your network or tailnet.
  Start the server with `npx t3 serve`, then run `npx t3 pair --tailscale` and
  paste the pairing link. You can also run `npx t3 serve --host <address>` and
  use `npx t3 pair` when the server is already reachable on your network.

Saved computers and computers discovered through Pylon Connect are selected by
default. Uncheck any you do not want to set up; this does not disconnect them.
Continue when your selected computers are connected. Setup checks agents across
the selected computers, then offers project import grouped by computer.

If Pylon cannot confirm the workspace during startup, the setup flow shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If Pylon cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Check your agents

Pylon checks each selected computer for Claude Code and Codex. If an agent is
not installed, **Install** opens a terminal with the vendor's standalone
installer ready to run; it does not need Node or npm and keeps **Update now**
working in Settings. If Claude Code is signed out, **Sign in** opens the same
sign-in dialog as **Settings → Providers**. If Codex is signed out, **Sign in**
opens a terminal with its login command ready to run. Other providers, including
Prime Agent, Antigravity, Cursor, Grok, and OpenCode, can be added in
**Settings → Providers**.

The setup terminal uses the home directory and environment configured for the
selected provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

## Import your projects

Pylon finds directories that Claude Code or Codex has used. Git repositories
are listed first, newest activity on top. When the remote is on GitHub, the
group shows the repository as `owner/name`. Clones with the same remote share
one group. Directories that are not git repositories sit under "Other folders".

The default selection includes git repositories active within the last 30 days
with at least three conversations. Use the checkboxes, or "Select all" and
"Select none", to change the selection. Linked git worktrees, worktrees that
Pylon creates for its own threads, Codex scratch directories under
`Documents/Codex`, and anything under `Downloads` are not offered.

A large or malformed history can reach the scan limit. Pylon keeps the
projects it found and warns when projects or conversations may be missing.

Imported projects include Codex and Claude conversations active within the last
30 days. You can continue those conversations in Pylon.

Conversation import is best effort. Pylon keeps the first user prompt and the
newest remaining visible user and assistant messages, with 200 messages total.
It omits tool activity and attachments. For Codex, it omits generated setup
context only when a canonical user event and a valid shared turn ID identify the
same user turn. Ambiguous legacy or response-only context stays in the imported
conversation so Pylon does not remove user text. It reads one conversation at
a time and streams past large tool output, such as screenshots, instead of
loading it. It skips a conversation file larger than 4 GiB, or one whose kept
messages would exceed 32 MiB. It ignores malformed records and skips unreadable
or unparseable conversations.

Each import attempt reads up to 100 conversation files and 4 GiB per project,
with up to 100,000 input records. Run import again to continue a large batch.
Completed conversations are not imported again. You can continue without the
remaining history.

You can continue without configuring agents or importing projects, or return to
an earlier step using the setup progress bar. Navigation pauses while an import
is running.
