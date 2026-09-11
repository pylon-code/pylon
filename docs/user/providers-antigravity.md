# Antigravity

Pylon runs Google's official Antigravity ACP agent on your selected environment. It has its own
sign-in, separate from the Antigravity IDE or CLI, and never falls back to a different sign-in method
than the one you select. The agent, files, conversation state, and Google credentials stay on that
environment. Google controls which models and account access are available through this agent.

## Set up Antigravity

On web or desktop, open **Settings → Providers**, choose the environment that runs your project, and
enable Antigravity; it is off by default. Choose **Install Antigravity** to download Google's runtime
to that environment, then choose **Sign in with Google** and complete the browser sign-in with the
account you use for Antigravity. Wait for Pylon to confirm account access and load models before
starting a thread. Provider setup is not available in the mobile app.

Installation continues if you leave settings or reconnect. Setup requires permission to operate the
environment; update an older server if it does not offer Antigravity setup.

When Antigravity is enabled but not installed, signed out, or without usable models, the model
picker and the provider status banner above a thread show that status with an
**Open provider setup** link, and the composer's button reads **Open provider settings** when no
provider is ready. Each opens **Settings → Providers** on that device with the Antigravity instance
selected.

### Sign in from a remote device

Google returns to a `127.0.0.1` address. It can finish directly when your browser is on the
environment's machine. From another device, the final page will usually fail to load because the
sign-in listener is on the environment.

Copy the full return address, including everything after `?`, into the return URL field in the web or
desktop client where you started setup, then choose **Continue**. Keep the original address; do not
replace it with the server's hostname. Only that Pylon sign-in session can finish the attempt, and the
setup screen shows when it expires. If it expires, retry sign-in and use the new link.

The return URL contains a temporary sign-in code. Paste it only into the setup field. A successful
callback page alone does not confirm account access; wait for Pylon's confirmation.

### Other sign-in methods

Choose **Sign-in method** in the Antigravity provider settings:

| Method                     | Credentials                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Google account             | Personal Google sign-in in the browser                                                       |
| Gemini Enterprise          | Browser sign-in, GCP project, and GCP location                                               |
| Gemini API key             | API key; choose **Connect** without a browser                                                |
| Agent Platform / Vertex AI | API key, or GCP project and location with Application Default Credentials on the environment |

The Antigravity API key field is stored in plain text in settings on the environment and passed only
to the agent. The agent uses the method and credentials selected for this instance; ambient
`GEMINI_API_KEY` and Google credential variables do not override them. Changing the method stops the
instance's sessions. Sign out before replacing an account.

## Runtime installation

Managed installation supports Apple Silicon macOS, Linux x64 or ARM64, and Windows x64 or ARM64.
Intel Macs can connect to a supported remote environment. The Linux x64 runtime downloads about
682 MB and uses about 2 GB after extraction; allow at least 3 GB free, because an update keeps the
previous runtime too.

When a newer managed release is available, **Update Antigravity** appears in provider settings.
Running sessions keep their current runtime; new sessions use the update.

### Use a manual installation

Download the archive for your environment from the [official ACP Registry][registry]. Extract the ACP
executable and its `localharness_external` helper into the same directory, at the same version. Make
both executable on macOS or Linux; Windows uses `.exe` files.

Set **Binary path** to the ACP executable on the environment and update it yourself. An invalid path
reports an error instead of selecting another installation. Leave the field blank to use the managed
runtime, or a compatible executable on `PATH` if no managed runtime is installed.

## Models and threads

The model list comes from your Antigravity account and can differ from other Antigravity apps. The
current agent exposes Gemini models only. New threads use Gemini 3.8 Flash (High) when your account
offers it, and older generations stay under **Legacy models**. A resumed thread keeps its selected
model. If access to that model ends, select another available model before continuing.

Use Antigravity's native `/plan` command for planning. Pylon's separate Plan mode is unavailable. Tool
approvals follow [Permission modes](./permission-modes.md): file writes appear as file change
approvals, and choosing **Allow for this thread** on a shell or web tool shows Google's prompt
injection warning. Questions with fixed choices still need one of the offered answers, even in
**Full access**.

Pylon keeps conversation history and file diffs, but Antigravity cannot rewind its conversation.
Reverting a thread or editing and resubmitting an earlier turn is unavailable. Continue with a
follow-up message or start a new thread.

### Skills and attachments

Put project skills in `.agents/skills`. Pylon also reads `.gemini/skills` and the legacy
`.agent/skills` directory. Among these project locations, the first copy wins in this order:
`.gemini/skills`, `.agents/skills`, `.agent/skills`. See
[commands and skills](./composer.md#commands-and-skills) for invoking them.

Antigravity accepts images, PDFs, text files, and supported audio formats directly. Its limits are
1 MiB per text file, 10 MiB per image, 20 MiB per audio clip, and 50 MiB total attachments per
message. Unsupported formats are rejected. These limits can be lower than the general upload limit;
uploading a file does not mean this provider can use it.

### Subagents

Antigravity groups subagent activity into batches, shown as **Antigravity subagent batch** in
**Agents** on web and desktop and in the work log on mobile. You cannot open or control individual
subagents, and an idle batch does not confirm that every child succeeded. See
[agent work](./thread-sidebar.md#inspect-agent-work) for where to inspect activity.

## Accounts and removal

Add an Antigravity provider instance for each Google account in **Settings → Providers** on web or
desktop. Each has its own sign-in; downloaded runtimes are shared on the environment.

| Action                    | Effect                                                            |
| ------------------------- | ----------------------------------------------------------------- |
| Disable                   | Stops the instance's sessions and keeps its Google sign-in.       |
| Sign out of Google        | Stops the instance's sessions and removes its saved Google login. |
| Remove downloaded runtime | Removes the shared installation and keeps Google credentials.     |

All three keep thread history and workspace files. Sending `/logout` by itself in a thread signs out
its instance, including stopping that instance's other sessions. Sign out, then sign in again to
replace an account.

Before removing a managed runtime, disable its instances and cancel any active installation. Clear any
explicit binary path pointing into that runtime. Removal is refused while the runtime is in use.

## Check access and troubleshoot

After a server restart, a thread with a chosen model keeps working without asking you to sign in
again; the saved sign-in is checked when a session starts. A new thread, or one using the account's
default model, needs the model list first and asks you to refresh it. To check access and reload
your account's model catalog, use **Refresh provider status** in web or desktop provider settings,
or **Refresh models** in mobile thread settings. Refresh uses the saved sign-in and does not open a
login page. If asked to sign in again, use setup on web or desktop. The packaged runtime can be slow
to start, especially on Windows; health checks, model refresh, and sign-out each allow up to 90
seconds.

When Pylon cannot send to Antigravity, the composer says why: it is not installed, it is signed out,
no model is chosen, its models have not loaded, or the thread's saved model is no longer offered.

If Google reports `SUBSCRIPTION_REQUIRED`, an account restriction, or a usage limit, follow the
provider's message and any retry time. A finished turn can contain an upstream error instead of
completed work. Pylon does not report your plan tier or remaining quota, and does not switch to an API
key to get past a limit. See [Google's account plans][plans] for eligibility.

[registry]: https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
[plans]: https://antigravity.google/docs/plans
