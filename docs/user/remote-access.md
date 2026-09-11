# Remote access

Connect a phone, browser, or another desktop app to Pylon running on a different machine. That
machine must stay running and reachable while you work. Projects, files, provider credentials, and
agent work stay on that machine.

Prefer a trusted private network that meshes your devices together, such as a tailnet. It gives you a
stable address and transport security with less exposure than opening the server to the internet.

## Pylon Connect

Pylon Connect makes an environment available to your other devices without setting up router
forwarding. In the desktop app on the host, open **Settings → Connections**, sign in, and enable
**Pylon Connect** for that environment.

For a command-line host, run:

```bash
npx t3@latest connect
```

Follow the sign-in instructions. Setup offers a [background service](./background-service.md); if you
decline it, start the server with `npx t3 serve`. Saving your sign-in alone does not make the machine
reachable: the server must start and establish its relay link.

On your other device, sign in to the same Pylon Connect account and choose the environment. Over SSH,
the CLI prints a browser link and accepts the returned authorization code, so you do not need to
forward an OAuth callback port.

Pylon Connect renews access credentials without disconnecting a healthy conversation. Pull request
diffs and provider settings keep working after the previous credential expires; a failed renewal
affects only that request.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Connections** and enable **Network access**, which restarts the
app. The panel shows the default reachable endpoint; expand it to see alternatives such as LAN,
private-network, or HTTPS endpoints and to choose another default. The default is saved by endpoint
type, so a LAN default survives IP address changes. Use **Create Link**, then **Share**
for a QR code and the full pairing URL. The share panel's endpoint picker changes only that share, and
loopback endpoints are never offered as QR codes because a phone scanning `127.0.0.1` reaches itself.
Turn network access off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet address:

```bash
npx t3 serve --host <private-ip>
```

It prints a pairing URL and QR code. If a server is already running, generate a fresh link without
restarting it:

```bash
npx t3 pair
```

`t3 pair` finds the running server, including the current worktree's development server when run
inside one. Use `--ttl` to change the link lifetime and `--base-dir` to target a specific data
directory; see `npx t3 pair --help` for other options.

Scan the QR code on your phone or paste the pairing URL into **Add environment** in the receiving app.
Connection settings are under **Settings → Connections** on web and desktop and
**Settings → Environments** on mobile. On mobile, an IP address entered without a scheme uses HTTP, so
include `https://` when your server uses HTTPS. Once paired, choose **Add Project** in the command
palette and pick the environment the project lives on.

Pairing authorizes that device for future connections. Use a fresh one-time link for each new
device; you do not need the original token to reconnect. Links created in Settings can only be
copied from the client that created them while its Connections page stays open. If you leave or
reload that page, create another link to share. Other clients can see an active link's name, scopes,
and expiry, and can revoke it with access management permission. After a restart, the desktop app
replaces its own local credential; paired phones, browsers, and remote desktops keep their access.

### Balance new threads across machines

When a project is grouped across several connected environments, Pylon can choose a machine for each
new thread. Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing**.

Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and memory available,
**Less often** to reduce its share, or **Manual only** to exclude it. These are preferences, not fixed
traffic percentages, and each client saves its own. A machine is chosen only when it is connected, has
the project, and can run the selected provider.

The composer checks eligible machines when choosing a draft's environment, then keeps that choice.
Choose **Auto balance** again to check current resources, or choose a specific machine to override it.
Choosing a branch or worktree also keeps the draft on that machine, and existing threads stay where
they started. If resource checks fail or every eligible machine is busy, choose a machine yourself.
Mobile keeps its manual environment selection.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale HTTPS** in
**Settings → Connections**; when Tailscale is detected, its addresses also appear in the endpoint list.
Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
npx t3 serve --tailscale-serve
```

For an already-running server:

```bash
npx t3 pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`. The mapping created by
`pair --tailscale` persists across restarts. Remove its default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with `--tailscale-serve-port`.

### Hosted web app

[app.pylon-code.com](https://app.pylon-code.com) needs an HTTPS endpoint. It saves the environment in
the browser and connects directly to your server; a hosted pairing link does not make an unreachable
backend reachable or convert HTTP to HTTPS. The pairing token stays in the link's fragment, so it is
not sent to the hosted app.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can open it, or pair from
the desktop app.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose **SSH**, and enter a host
or SSH alias such as `user@example.com`. Pylon starts or reuses a server under `~/.pylon-code` there and
opens the port forward for you.

The remote host needs a compatible [Node.js installation](./install.md#requirements) and
[provider setup](./install.md#providers). Launch looks for `node` on `PATH`, common install
directories, and version managers such as Volta, asdf, mise, fnm, nodenv, and nvm, but a version
manager that initializes only in an interactive shell is not found. If launch cannot find Node or
reports an incompatible version, check it through a non-interactive SSH session:

```bash
ssh user@example.com 'sh -lc "command -v node && node --version"'
```

Configure your version manager for non-interactive shells if this differs from your normal terminal.
With nvm, setting a compatible default, such as `nvm alias default 24`, can resolve the problem.

If SSH reconnecting fails after an app update, retry the launch once; you should not need to delete
launcher state or stop remote processes yourself. Removing the connection stops a server that Pylon
launched; a server that was already running is left alone.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Remote file actions

On the same machine as an environment, file references can open in your editor or reveal the file in
Finder, File Explorer, or Files. Pylon hides those actions when the environment is remote, so a remote
browser cannot open a file manager on an unattended server. Previews and copy-path actions remain
available.

## Environment icons

Machine icons help distinguish environments in thread lists, connection lists, and environment
pickers. Pylon detects the machine when it can. **Settings → Connections → Environment icon** overrides
the detected icon for every client connected to that environment; choose **Automatic** to restore
detection. Older servers keep a generic icon until updated.

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create pairing links and revoke
client sessions. Revoking an unused link prevents new pairings; revoke a device's session to remove its
existing access. A session with an open connection stays listed after its access credential expires.
Command-line management is available through `npx t3 auth --help`.

To remove an environment from Pylon Connect, open your account menu's **Pylon Connect** page, or
**Settings → Pylon Connect** on mobile, and choose **Deregister**. This revokes its cloud access, removes
any managed tunnel, and frees its host space even when the environment is offline or has been wiped.

On a command-line host, `t3 connect unlink` disables exposure while retaining your login;
`t3 connect logout` also clears that login. Background-service
[removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in screenshots, logs, or
bug reports. Bind `--host` to a trusted private address rather than exposing the server broadly.

When the app and a remote server run different versions, follow [Updating Pylon](./updating.md).

## Pylon Connect troubleshooting

Run `t3 connect status` on the host to inspect saved authorization and link configuration. It is not a
live reachability check. If the environment appears offline, run `t3 service status` and read the
displayed log. If it disappears when SSH closes, see
[background-service troubleshooting](./background-service.md#troubleshooting).

| Error                                                     | Recovery                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Deregister an unused environment, then restart Pylon on the host.                                                                           |
| `auth_invalid` or `invalid_bearer`                        | Run `t3 connect login`. If credentials were revoked, run `t3 connect logout`, then `t3 connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update Pylon, then restart it.                                                                              |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                               |
| HTTP 408, 429, or 5xx                                     | Check network and relay availability. Startup retries temporary failures for up to ten minutes.                                             |

After fixing a permanent rejection, restart the host's server. On Linux, use
`systemctl --user restart t3code.service` for the background service. For a foreground server, stop it
and run `t3 serve` again with your usual options. Include the diagnostic message and trace ID when
reporting a persistent failure, but never authorization codes, pairing URLs, or secrets.

For a connection that still fails after linking, check the date and time on both devices.
