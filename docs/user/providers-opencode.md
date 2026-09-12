# OpenCode

Install and authenticate OpenCode on the machine running your environment, then enable it in
**Settings → Providers**. See [provider setup](./install.md#providers). Pylon requires OpenCode
1.14.19 or newer, including when you connect an existing OpenCode server, and uses the login and
configuration on the connected environment.

## Local or external server

Leave **Server URL** empty to let Pylon start OpenCode locally. A password in provider settings
applies to both that server and Pylon's connection. With no password setting, the local server uses
`OPENCODE_SERVER_PASSWORD` from its environment.

To use an existing OpenCode server, set **Server URL** and its password in provider settings. Pylon
uses only that configured password for an external server; it does not forward a local
`OPENCODE_SERVER_PASSWORD`. If connection or version checks fail, check the URL, credentials, and
OpenCode version, then refresh provider status.

After a lost connection, send another prompt to reconnect to the same OpenCode session.

## Approvals

OpenCode follows the shared [permission modes](./permission-modes.md). **Auto** has the same rules as
**Supervised** because OpenCode has no AI approval reviewer. In those modes OpenCode can read project
files, search, load skills, and update its task list without approval, but asks before commands,
edits, web access, and directories outside the workspace. Environment files such as `.env` and
`.env.local` need approval even though normal file reads do not; `.env.example` is allowed.

**Allow for workspace** applies to matching requests in other OpenCode sessions using the same
workspace. It is broader than the current thread, especially on a shared external server. Use
**Allow once** for a single request. Denying an action does not stop the whole turn; use **Stop**
for that. An approval that fails to send because of a connection error stays available to retry.

## Progress and stopping

Web and desktop show OpenCode's task list in the **Tasks** tab, the turn summary, and the sidebar's
working line. **Stop** ends the main OpenCode session and its nested child sessions, without
touching unrelated sessions, and waits for that cleanup before the next prompt. Pending approvals and
questions clear after Stop succeeds.

## Models, commands, and skills

On mobile, the model picker shows each OpenCode model's upstream provider, such as Anthropic or
OpenCode Zen. Search by that provider name to narrow the list.

After changing an OpenCode login or configuration, use **Refresh provider status** in
**Settings → Providers** for that environment. On mobile, use **Refresh models** in the thread
settings. Reconnecting also refreshes the catalog; periodic provider health checks do not.

Credential changes are read on refresh. Native OpenCode configuration can remain cached while the
local helper is running. Let it sit for 30 seconds without model refreshes or text-generation work,
then refresh again to reload the files. Repeated refreshes keep the helper alive. An external server
may need its own reload or restart before Pylon can see configuration changes. If a refresh fails,
Pylon keeps the last known models, commands, and skills.

Existing threads keep their selected model and options even when it disappears from the catalog. If
OpenCode rejects that model, select an available one and retry.
