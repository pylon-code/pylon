# Updating Pylon

The app you use and the server running your agents can be on different machines. When a server is
behind your web or desktop app, an update notice appears in the conversation and
**Settings → Connections**. Update the machine named in that notice. Dismissing the conversation
notice only hides it for those two versions; the difference stays visible in Connections.

## Choose a desktop track

On the [Pylon download page](https://pylon-code.com/download), choose **Stable** or **Nightly**.
You can also share a direct [Nightly download link](https://pylon-code.com/download?channel=nightly).

Stable and Nightly are separate applications. Installing one leaves the other in place, each keeps
its own projects, threads, and settings, and neither updates into the other. Each app keeps itself
current on the track it was built for. **Settings → About → Update track** shows which build you are
running and opens the download page for the other one. Both can run at the same time; delete an app
to leave its track, and its data stays on disk until you remove it.

When a nightly update is available, the desktop app previews its release notes, newest changes
first, with links to each release.

## Before you update

Server updates restart the connection and can interrupt active agents and terminal commands. Saved
threads, settings, and project files remain.

**Settings → General → Continue threads after restarts** is off by default. Enable it to resume
supported active threads after an update, crash, or machine restart. Changes are saved to connected
environments that support this setting; update older servers first, and use **Apply to all** after
an offline environment reconnects with a different value. Pylon must start again on that machine;
the setting does not enable automatic startup.

Codex continues without adding a user message, and other supported providers receive a short
instruction to continue where they left off. Threads without saved provider resume state need a new
message. Prime Agent keeps its own recovery of the original session and does not receive a duplicate
continuation turn. Terminal commands may still be interrupted.

## Update a connected server

The offered action depends on how the server runs. Pylon does not update connected servers silently.

| Action                     | What to do                                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it downloads, restarts, and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                                         |
| **Copy update command**    | Stop the command-line server on its host and relaunch with the copied command, keeping your usual startup options.                                                                                          |

For a background service, run the matching version's CLI on the host:

```sh
npx t3@<client-version> service update
```

Replace `<client-version>` with the version shown in the notice. Using `@latest` only resolves the
mismatch if your client is on that release. An older service launcher may require this local update
before it supports remote updates and rollback.

For a foreground server, the copied command is `npx t3@<client-version>`. Add `serve` if you
normally run without a browser, and preserve options such as `--host` or `--tailscale-serve`. See
[background services](./background-service.md) for service management.

## If an update fails

Keep the client open until it reconnects or reports a failure. The notice follows the update in both
the conversation and Connections, and a failure stays visible with its error. A failed service
update rolls back to the previous version and reports the rollback right away. If the update still
fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

## Mobile updates

Mobile updates are separate from the desktop tracks. The mobile app downloads updates in the
background and applies them when you next leave the app. It saves drafts and queued messages before
restarting. If you keep the app open for a long time, it may ask to install immediately; choosing
**Later** leaves the update queued for the next suitable moment.
