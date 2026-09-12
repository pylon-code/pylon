# Codex

For one account, use the default Codex provider with your normal Codex login.
[Provider setup](./install.md#providers) covers installation, **Settings → Providers**, and custom
binaries or environment variables.

## Use multiple accounts

A shared Codex home with a shadow home lets work and personal accounts continue the same threads.
The accounts share Codex sessions and configuration while keeping their own login and available
models.

Keep your first account in `~/.codex`. On the environment's machine, sign the second account into a
fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings → Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. Pylon prepares the shared state in the shadow
directory; do not populate it by copying your whole Codex home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential store, configure
file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Settings shows the email each instance is signed in with; click the blurred email to reveal it. Use
display names and accent colors to tell accounts apart in the model picker.

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want separate Codex
sessions and configuration. That instance cannot continue threads from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. Pylon offers compatible Codex instances that
share the thread's **CODEX_HOME path**. Changing accounts does not move the conversation into a
separate Codex home.

If the account is missing from the picker, compare the home paths in provider settings. If two
instances show the same unexpected account or models, check their reported emails, refresh provider
status, and confirm the second instance has its own shadow path and login. A shadow-home conflict
usually means the directory contains a copied Codex setup. Remove everything except `auth.json`, or
use a fresh shadow directory and sign in again:

```bash
find ~/.codex_personal -mindepth 1 ! -name auth.json -exec rm -rf {} +
```

## Usage limits

The Codex usage gauge shows the main account allowance. Spark has a separate model-specific
allowance that does not replace the main session or weekly reading.

When Codex stops on a usage limit, the thread names the window that ran out and when it resets, when
Codex reports them. Send the message again after the reset. On a workspace plan, the message also
says whether your workspace owner needs to add credits or raise the spend limit to continue sooner.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question panel, choosing a
suggested answer or entering your own. The answer becomes a new message: it reaches the active turn,
or starts another turn if Codex has finished. Unanswered questions survive reconnects. To close a
question without sending anything to Codex, dismiss it from its panel. This requires a Codex version
that supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request in the thread on
web, desktop, or mobile. Some tools offer access for one request, the current session, or
permanently. See [Permission modes](./permission-modes.md) for command and file approvals.

## Agents and activity

The web and desktop **Agents** panel shows each sub-agent's model and reasoning effort when Codex
reports them; Pylon does not substitute the parent's settings. Browser and Computer Use calls show
their task title when Codex provides one, with the website's icon or the macOS app's icon when
available.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for example
`/feedback The agent stopped before finishing the tests`. This uploads the conversation and Codex
logs to OpenAI without adding messages to the thread. When the upload succeeds, choose **Copy ID** to
share the thread ID with OpenAI support.
