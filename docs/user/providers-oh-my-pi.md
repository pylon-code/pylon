# Oh My Pi

Pylon can run [Oh My Pi](https://github.com/can1357/oh-my-pi) as an **Early Access**
provider on the machine that owns your environment. Oh My Pi is not bundled with Pylon.
Web, desktop, and mobile clients all talk to that server-side CLI. Installing `omp` only on the
phone or browser device does not make it available to a remote environment.

## Install and authenticate

Install Oh My Pi on the environment host. For example:

```bash
curl -fsSL https://omp.sh/install | sh
# or with Bun
bun install -g @oh-my-pi/pi-coding-agent
# or with Homebrew
brew install can1357/tap/omp
```

Pylon requires Oh My Pi 15.13.1 or newer. Start it once in a terminal on the same host and use
`/login` to authenticate the model providers you want:

```bash
omp
```

Oh My Pi can also read provider API keys from its normal configuration and environment. Put
instance-specific keys in that provider instance's **Environment variables** section in Pylon.
Mark secrets as sensitive. Pylon does not provide an in-app Oh My Pi login terminal.

## Add a provider

Open **Settings → Providers → Add provider**, then choose **Oh My Pi**. Each entry has these
settings:

- **Display name** identifies the instance in model pickers.
- **Binary path** defaults to `omp`. Set an absolute path if the Pylon server cannot find it.
- **Profile** is an Oh My Pi profile name. Leave it empty to use the normal default profile.
- **Environment variables** apply only to that instance and its child processes.

Oh My Pi is instance-only in Pylon. You can add separate entries such as **Oh My Pi Work** with
profile `work` and **Oh My Pi Personal** with profile `personal`. They remain separate providers,
even when both use the same binary. Threads store the exact instance they use.

Profiles and credentials live on the environment host. When you connect through Pylon Connect,
SSH, a relay, or mobile, edit the provider on the environment where `omp` is installed.

## Models and thinking

Pylon checks the installed version and runs a bounded, extension-free catalog probe equivalent to:

```bash
omp --profile <profile> models --json --no-extensions
```

The profile flag is omitted when no profile is configured. Discovered selectors remain exact, such
as `anthropic/claude-sonnet-4-6`. The model row also shows the underlying Oh My Pi provider, such
as **Anthropic** or **OpenAI**, and that label is searchable on web and mobile.

**Profile default** lets Oh My Pi choose the current profile's model when the durable session is
created. Pylon captures that exact selector, so returning from an explicit model to **Profile
default** restores the session's original profile model. A resumed thread keeps the captured model
from its durable session. A failed or empty catalog keeps that fallback available and shows a
warning. Pylon reports authentication as unknown because a catalog can contain models whose
credentials are not currently usable. Session start remains the authoritative check.

For reasoning models, Pylon shows Oh My Pi's `off` and `auto` controls plus every exact thinking tier
reported for that model. Merely choosing a model does not override the profile's live thinking
value; Pylon sends a thinking value only after you explicitly choose one. A model change is applied
before its thinking choice because Oh My Pi can change the valid values with the model.

The discovery probe excludes extensions for predictable startup and bounded output. Normal chat
sessions still use Oh My Pi's profile behavior. Add an exact custom model in provider settings only
when you intentionally need a model the safe catalog cannot see.

## Permissions

Pylon maps its permission modes to Oh My Pi as follows:

| Pylon mode        | Oh My Pi approval mode |
| ----------------- | ---------------------- |
| Approval required | `always-ask`           |
| Auto              | `write`                |
| Auto-accept edits | `write`                |
| Full access       | `yolo`                 |

In Auto and Auto-accept edits, file edits can proceed while execution requests still reach Pylon.
Full access can approve every request. Approval and form-question requests are carried over ACP and
can be answered from web, desktop, or mobile. Early Access currently supports selectable form
questions. Oh My Pi requests that require free-form text input are cancelled instead of leaving a
headless turn blocked.

## Supported Early Access behavior

Pylon currently supports durable ACP sessions, resume, cancellation, model and thinking changes,
default and plan interaction modes, permission requests, form questions, image attachments, Pylon's
MCP server handoff, and structured text generation for titles, branches, commits, and pull requests.
The `omp` process runs in the project directory with only that provider instance's environment.

The ACP integration does not yet expose Oh My Pi-native subagent controls, manual compaction, input
queues, state inspection, goals or refinement controls, side questions, or terminal authentication.
Pylon rollback is disabled: trimming only Pylon's visible history would leave Oh My Pi's real context
unchanged. Start a new thread when you need a clean provider context.

## Troubleshooting

- **Not installed**: run `omp --version` on the environment host, or set **Binary path**.
- **Version too old**: run `omp update` or update through the package manager that installed it.
- **No models**: run `omp` on the host, use `/login`, then check the selected profile with
  `omp --profile <profile> models --json --no-extensions`.
- **Wrong account or defaults**: confirm the Pylon instance's profile and environment variables.
- **Remote client cannot find `omp`**: install it on the server-side environment, not only on the
  client device.
