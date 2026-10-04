# Prime Agent

Pylon can run [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) as a provider on the
device that owns your environment. Prime Agent is not bundled with Pylon. The environment host must
run macOS, Linux, or WSL2. A Pylon server running directly on Windows shows Prime Agent as unavailable
and does not start Prime Agent. Run the server and Prime Agent inside WSL2 instead. Any Pylon web,
desktop, or mobile client can also connect to a WSL2 or remote environment that runs Prime Agent.

## Install And Sign In

Install Prime Agent on the environment host. Prime Agent requires Node.js 22.8 or newer:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

The Early Access integration is tested with Prime Agent 0.9.4. Start it once in a terminal and use `/login` to configure an underlying model provider:

```bash
prime-agent
```

### Upgrading from an earlier release

Prime Agent 0.8.0 binds generic MCP OAuth credentials to the server endpoint that issued them.
Credentials created before 0.8.0 do not contain that binding. After upgrading, run
`/mcp login <server>` once for each generic OAuth MCP server you still use.

An `mcpServers` entry whose name matches a built-in integration, such as `linear`, no longer overrides
that built-in with a custom URL. Such an entry disables the built-in and is not served by the generic
MCP runtime. Rename a custom endpoint to a distinct name, such as `linear-proxy`, then log in again if
it uses OAuth. These are Prime Agent migrations and apply whether you start Prime Agent in Pylon or in
a terminal.

Prime Agent 0.9.4 makes standard ACP prompt completion wait for delegated descendants and resulting
parent work, identifies separate assistant messages across autonomous ACP turns, and changes the fresh
no-override subagent-depth default from 1 to 2. Pylon still validates Prime's correlated completion
metadata. Explicit session, global, and `RLM_MAX_DEPTH` settings continue to override the new default.
The 0.9.4 live catalog omits Cloudflare AI Gateway's Workers AI mirror IDs and uses
`claude-sonnet-4.5` as that provider's default; Pylon discovers the installed catalog rather than pinning those
models.

### Upgrading Pylon to orchestrator v2

Finish or cancel every Prime turn, then stop its session before upgrading the environment host to
the first Pylon build with orchestrator v2. The initial v2 integration cannot adopt an active Prime
execution retained by the earlier orchestrator. Its private recovery identity is not part of the v2
thread import.

If an earlier Prime execution is still owned, use the previous Pylon build to finish or stop it.
For a quarantined instance, the managed-build settlement recovery described below may prove cleanup
before switching builds. Pylon keeps the instance unavailable when it cannot prove cleanup; do not
delete ownership records or change Agent home to bypass that check.

### Enable native mode with the Pylon Prime build

Stock Prime Agent runs in ACP compatibility mode with these limits: one account, Full access only, no
approvals, model change requires a new thread, and no Goal/Harness/queue/resources controls.
The stock 0.9.5 standalone installer contains an executable but no public JavaScript SDK. Pylon
attempts ACP compatibility with that executable, but native mode and Prime-based title and source-control text
generation require an installation with a compatible public SDK. Select the Pylon-managed Prime build
for native mode, or choose another text-generation provider for titles and source-control writing.

To enable native mode, open **Settings → Providers → Prime Agent** and choose **Install stable** under
**Pylon-managed Prime**. If a managed build is already selected, the button is **Update stable**.
Wait for **Succeeded**, then check that the card shows **Backend: Native daemon** and **Pylon managed**.
Pylon uses your existing Prime login and installs the build on the selected environment host.

You can also build and install the Pylon Prime fork yourself in a private prefix:

```bash
git clone https://github.com/pylon-code/prime-agent
cd prime-agent
git switch pylon
git switch --detach 514e40454e048707a8467940677170c2e15a8a39
fnm install 22.23.2
fnm exec --using 22.23.2 npm ci --ignore-scripts --no-audit --no-fund

PRIME_ARTIFACTS="$(mktemp -d)"
fnm exec --using 22.23.2 node scripts/build-pylon-prime-agent-release.mjs --pack --out-dir "$PRIME_ARTIFACTS"
PRIME_ARTIFACTS="$PRIME_ARTIFACTS/artifacts"

PRIME_PREFIX="$HOME/.local/prime-agent-pylon"
rm -rf "$PRIME_PREFIX"
mkdir -p "$PRIME_PREFIX"
cd "$PRIME_PREFIX"
cat > package.json <<EOF
{
  "name": "pylon-prime-agent-local",
  "private": true,
  "dependencies": {
    "prime-agent": "file:$PRIME_ARTIFACTS/pylon-prime-agent-0.9.4.tgz"
  },
  "overrides": {
    "@earendil-works/pi-agent-core": "file:$PRIME_ARTIFACTS/pylon-prime-agent-core-0.9.4.tgz",
    "@earendil-works/pi-ai": "file:$PRIME_ARTIFACTS/pylon-prime-agent-ai-0.9.4.tgz",
    "@earendil-works/pi-tui": "file:$PRIME_ARTIFACTS/pylon-prime-agent-tui-0.9.4.tgz"
  }
}
EOF
fnm exec --using 22.23.2 npm install --no-audit --no-fund
"$PRIME_PREFIX/node_modules/.bin/prime-agent" --version
```

Then set **Binary path** to `~/.local/prime-agent-pylon/node_modules/.bin/prime-agent`.

See [Pylon-managed installation](#optional-pylon-managed-installation) for updates, preview builds, and rollback.

Pylon uses the existing Prime Agent login. Provider status reports **Authenticated** only when a
healthy, current catalog contains at least one configured model provider. An empty catalog leaves
authentication **Unknown** because catalog emptiness is not proof that credentials are absent. This
status does not verify live network access, and Pylon does not offer Prime Agent sign-in or sign-out
inside the app.

## Configure Pylon

| What works in ACP compatibility mode                                                                           | What native mode adds                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One account through one enabled Prime Agent instance.                                                          | Native mode also supports one enabled instance per environment; it does not enable multiple Prime accounts.                                                                       |
| Full access only; no execution approvals.                                                                      | **Supervised** approvals, alongside Full access.                                                                                                                                  |
| Changing the model requires a new thread.                                                                      | Change to another named model in the same thread for the next message. **Prime Agent Default** still cannot be reselected after a thread has run on a named model.                |
| No **Goal** or **Harness** controls.                                                                           | The initial v2 integration also omits Goal status, subagent-depth controls, and harness refinement. Supervised depth stays fixed at 0.                                            |
| No native input queue, resources, context, or history controls.                                                | Compaction lifecycle rows and reported context usage remain visible. Native queue, resource, and context controls are unavailable in the initial v2 integration.                  |
| No Prime reasoning or normalized per-turn usage and cost in interactive threads.                               | Bounded final reasoning when the model exposes it and reported context usage. Prime per-turn cost and child-inclusive token totals are unavailable in the initial v2 integration. |
| Subscription capacity can still appear for a mapped model backend; it is separate from Prime's per-turn usage. | Subscription capacity is re-read after turns in both modes, subject to the short refresh cache.                                                                                   |

Open **Settings → Providers**. The default provider normally needs no changes:

```text
Display name: Prime Agent
Binary path: prime-agent
Agent home path: empty
Launch arguments: empty
```

An empty **Agent home path** uses Prime Agent's normal `~/.prime/agent` directory. Set it only
when this provider instance should use a separate Prime Agent home. If the app cannot find a CLI
installed outside the system path, set **Binary path** to the complete path of `prime-agent`.
Press **Enter** after editing a path to save it before changing another setting.

Pylon normally uses Prime Agent's native daemon API. With one enabled instance, a non-empty
**Launch arguments** value selects ACP compatibility mode instead, because the daemon API cannot safely
preserve arbitrary CLI arguments. Pylon shows that fallback in the provider status rather than silently
discarding the arguments. ACP compatibility is disabled while more than one Prime instance is enabled.

## Multiple Prime Accounts

Multiple enabled Prime Agent instances are not available yet. Pylon keeps this capability disabled until
signed-in macOS and hosted Linux/WSL2 graduation checks prove separate credentials, models, capacity,
MCP access, checkpoints, cleanup, and resource limits at N=1, N=2, and N=4.

Use one enabled Prime Agent instance per Pylon environment. The host rejects a second enabled instance
before settings are saved and explains the pending proof. The distinct-home and native isolation work is
retained for a later release, but it is not advertised as supported behavior.

Native Windows does not run Prime Agent. Run the Pylon environment inside WSL2 or on another macOS/Linux
host. Web, desktop, and mobile clients see the host environment's same capability and unavailable reason.

Pylon never runs OS-user-global Prime maintenance such as update, doctor, shutdown, or stop-all for a
provider instance. Run global Prime maintenance outside Pylon only after considering every Prime
session owned by that OS user. Web, desktop, and mobile receive the same host capability state. Mobile
does not offer a disabled or unavailable Prime instance as a fallback model.

### Optional Pylon-managed installation

Stock or configured Prime remains the default. To opt in, open **Settings → Providers → Prime Agent**
and use **Install stable** under **Pylon-managed Prime**. Pylon downloads and verifies the exact signed
publication on the selected environment host, installs it beside other builds, and changes only this
Prime provider instance's binary path. It does not overwrite or remove a global npm, pnpm, yarn, bun,
Homebrew, or standalone Prime installation.

The web and desktop card names the detected backend as **Native daemon** or **ACP compatibility**.
When no managed builds are installed and neither channel has a verifiable publication, maintenance
controls are disabled and the card points to manual installation. **Refresh status** checks again;
controls return when a signed stable or preview publication becomes available.

Stable is the default managed channel. Preview requires checking the preview warning before
**Install/update preview** becomes available. Signed channel sequence and build identity determine
updates; the package version does not. If the signed feed is offline or invalid, Pylon keeps the
current verified build selected and shows the failure instead of guessing that an update is available.

Updates stage a new build before switching. If this Prime instance has an active admission, turn,
session, daemon, or loaded SDK runtime, Pylon schedules the switch until that exact instance drains.
It never interrupts a turn for maintenance. The same controls work when Settings connects to the host
locally, remotely, through a relay, or through a tunnel.

If Prime is quarantined after an older Pylon session ended, install or update to a managed
build that supports settlement recovery. Pylon checks whether that earlier session has
finished cleanup before activating the build. If it cannot prove cleanup, it preserves your
current configuration and explains the failure. Do not delete ownership records or change
Agent home to bypass quarantine.

Use the build list to roll back to an already verified build. **Use stock/configured Prime** restores
the binary path that was configured before managed installation. **Prune unreferenced builds** removes
only verified Pylon-owned builds that no provider selection or scheduled switch references. It never
touches the stock installation.

Pylon Mobile shows each connected environment's Prime host-maintenance status under **Settings →
Environments**. Use web or desktop Provider Settings for install, update, rollback, switch-back, and
cleanup controls.

Native Windows does not perform a managed Prime download or install. Install and run Pylon and Prime
Agent inside WSL2, connect to that Linux environment, and use its Linux path. macOS and Linux use their
native managed build only after exact runtime negotiation succeeds.

## Turn Completion

Native daemon sessions keep delivering responses and Supervised approval requests across follow-up turns,
including after an earlier tool request was approved or declined.

A Prime turn can contain several assistant segments around tool work. Pylon keeps those segments in
native order, so a final response appears after the work that preceded it instead of being appended
to an older message higher in the thread. If Prime authoritatively finishes without public assistant
text after its latest tool activity, Pylon shows **Prime Agent finished without sending a final
response.** as a status row rather than inventing an assistant reply. If the provider rejects a prompt,
Pylon shows its mapped explanation when available. **Prime Agent stopped before sending a final
response.** is reserved for an authoritative failed terminal with no public response rather than hiding
an actionable provider failure. Cancellation remains cancellation. Prime Agent 0.9.4 waits for delegated descendants
and resulting parent work before its standard ACP prompt completes. Pylon still validates Prime's
correlated terminal-quiescence signal, including for 0.8.0 installations whose immediate ACP response can
finish earlier, so the turn does not finish while causally admitted work remains active.

In native daemon mode, an active turn can continue through a temporary daemon transport reconnect when
Prime supplies complete replay data or an exact completed-message snapshot. It also remains attached when
Prime's supervisor loses only the worker command client after the exact submitted user message was
admitted. Pylon never sends that prompt again; native events and the correlated descendant-quiescence
barrier keep ownership of completion. If Prime reports that same worker is still recovering, Pylon waits up
to 60 seconds without resending either your prompt or the completion check. This can occur when automatic
compaction and a worker snapshot transfer overlap. Pylon retries the completion check once only after the
same worker process is ready, Prime supplies an exact transcript snapshot, and that snapshot reconciles
with the turn already shown. The turn still needs a public final response before recovery can finish. When
those checks succeed, root tool work, delegated children, and the parent response remain part of the
original turn. Cancelling the turn stops this wait. If recovery exceeds the bound or Pylon cannot prove
prompt admission, worker continuity, or stream continuity, it fails the turn once and closes that Prime session
instead of retrying your prompt or guessing at missing output. When the optional correlated lifecycle is
negotiated, recovery is stricter: Prime must provide complete event continuity and a reconciled transcript.
A synchronization snapshot can confirm the exact text and images you just submitted before their live
notification arrives, provided Prime identifies your prompt as delivered. It can also recover completed
tool calls with matching results, or one missed terminal response after an already observed user message.
Recovered messages appear once even if their live notifications arrive later. Unreconciled output closes the uncertain
session rather than guessing whether it was your answer or unrelated background work.
The initial orchestrator v2 integration does not automatically adopt an active Prime turn after a Pylon
server restart. This applies to Pylon-managed native builds as well as ACP sessions. Stop and drain
Prime before restarting or upgrading the server; see [the v2 upgrade guidance](#upgrading-pylon-to-orchestrator-v2).
Temporary Prime transport reconnects within a running Pylon server still use the checks described above.

Native Windows is not a Prime Agent provider runtime. Pylon does not fall back to ACP there. Use
WSL2, where the server runs as Linux, or connect this client to another supported environment.

Pylon uses a short-lived, prompt-free Prime Agent RPC process to bootstrap the configured-model
catalog until a compatible daemon session publishes a usable list from Prime Agent's public model
APIs. Later health checks keep that daemon-backed list without launching another discovery process;
failed or late daemon refreshes keep the last usable list. A successful empty refresh clears stale native models and reports that Prime Agent needs a configured provider. Model names keep their underlying provider
qualifier, such as `anthropic/...` or `openai/...`.
**Prime Agent Default** lets Prime Agent use its configured or restored default instead of forcing a
model. Selecting a discovered reasoning model adds its supported thinking levels to the composer.
Eligible OpenAI Codex models also expose **Standard** and **Fast** service tiers. These choices apply
when the next message starts; they cannot be changed by a steering message after a run has begun.

A Prime Agent release can add or drop models. Upgrading may widen the list, and a thread pinned to a
model the new release removed keeps that saved choice until its next message, then reports that Prime
Agent rejected the selection and that the model may no longer exist in its catalog. Pick another model
in the picker to continue. Threads left on **Prime Agent Default** follow the new release's default
instead of failing.

**Prime Agent Default** can only be chosen for a thread that has not already run on a named model.
Prime Agent exposes no way to hand model choice back to itself inside a running session, so once a
conversation is running the picker shows the option as unavailable and points you at a new chat
instead of quietly continuing on the model it was already using. Naming a different model in an
existing thread still works normally.

The initial v2 integration cannot append steering to an active Prime run or manage Prime's native
input queue. A v2 steering action interrupts the current run and starts another instead. Native
**Queue follow-up**, **Session inputs**, delivery-mode, and queue-clearing controls are unavailable.
Pylon-owned wakes, such as delegated task results and [pull request watch](source-control.md#watch-a-pull-request)
updates, still reach Prime threads: they wait for the current run to finish and start the next one.

Blocking native select, confirm, and input dialogs use Pylon's structured user-input requests in the
thread. Prime editor-replacement dialogs remain cancelled because their prefills cannot be stored
safely. Nonblocking extension notifications also appear in the thread; native status and widget panels
are unavailable.

Prime's provider-owned extension and resource discovery can still run in Full access. Pylon's initial
v2 integration does not expose the native command/resource catalog or **Reload commands and resources**.
Supervised sessions keep discovered commands disabled. Observed Prime subagents remain visible in
Pylon's Agents hierarchy, but direct native child cancellation, messaging, and live-session watching
are unavailable in this integration.

When a daemon-backed parent waits for asynchronous children, the Pylon turn stays **Working** until
Prime reports descendant quiescence and finishes any parent continuation triggered by their replies.
The continued parent answer appears in the same turn rather than as hidden background work. If deleting a
child after its reply cancels Prime's in-flight descendant wait, Pylon retries that completion boundary while
the turn remains active, without resending your prompt. Cancelling the turn never retries the boundary.
If cancellation repeats while the turn remains active, another error occurs, or a daemon reconnect cannot
be reconciled, Pylon fails the turn and closes that native session instead of reusing work whose ownership
is uncertain.

In the main thread, each Prime tool call uses one activity row as it starts, updates, and completes. Pylon shows only a fixed friendly label such as **Code**, **Shell**, **Edit**, **Read**, **Search**, **Web search**, **Image**, or **Tool**, plus its coarse lifecycle state. Commands, code, paths, tool input, progress output, results, native titles and identifiers, and error text are not copied into thread activity.

## Background Writing

Prime Agent can be selected for thread titles and for source-control writing in Settings. Each title,
branch name, commit message, or change-request draft uses the selected model, thinking level, service
tier, Prime Agent home, and environment. The global **Text generation** setting and the optional
**Source control writer model** setting each show the selected model's background-only thinking and
service-tier controls, including when interactive Prime threads use ACP compatibility mode. Inherited
thinking levels and service tiers are clamped by Prime to the selected model's supported controls.
**Prime Agent Default** preserves Prime's default model selection. A named model keeps its complete
`provider/model` identifier, including model ids that contain additional `/` characters. Pylon never falls back to another provider or credential when the
selection cannot run.

Pylon runs this work in a short-lived, tool-free Node process through the selected Prime installation's
public SDK. The process has no session history, extensions, skills, prompt templates, themes, project
context files, MCP servers, goals, autonomy, kernels, retries, refinement, compaction, or telemetry.
No installed, user, or project prompt resource is loaded. The selected Prime home supplies credentials,
models, and persisted settings; Pylon calls only the four provider, model, thinking-level, and service-tier
default getters and copies those values into an in-memory manager. A separate scoped empty SDK-global
home prevents the selected home's continual-harness entries from loading. Prime Agent still appends
its fixed empty-harness guidance, with zero prompt, memory, skill, subagent, and recent-refinement counts,
after Pylon's short instruction and date/working-directory lines. Pylon adds a final instruction to ignore
that empty guidance for the isolated draft and rejects any nonempty harness state. This fixed text consumes
some input tokens on every request. The bounded writing prompt is sent through standard input rather than
the process command line, and the session is disposed after one model request. Images are included only when their attachment-store files
still validate; ordinary file attachments and arbitrary filesystem paths are not read.

Each title, branch, commit message, and change-request draft is a real model request. It consumes tokens
and can incur charges from the selected model provider. A timeout, missing or incompatible SDK,
unavailable model, authentication failure, spent quota, process crash, or invalid response fails that
writing action without adding provider-native errors or partial text to the thread. Pylon does not write
per-action usage or cost into thread history, but it refreshes Prime's account capacity after the attempt
through the normal provider snapshot path. This background support is available whether interactive Prime threads
use the native daemon or ACP compatibility mode.

**Quick question** and other session-side questions are unavailable in the initial v2 integration,
including Supervised daemon sessions. Background title and source-control writing still uses the
separate process described above.

When the selected model explicitly
exposes reasoning text, Pylon adds a bounded final **Reasoning** entry to the work log. Incremental
thinking deltas and provider-private reasoning metadata are not persisted.

Daemon-backed threads also show Prime's current context-window estimate and selected model limit in
the composer. The meter is separate from per-turn token totals and hides when Prime reports the
post-compaction context as unknown; it returns after the next successful model response. Automatic
compaction remains governed by Prime's native configuration.

Pylon's former **Compact now**, **Abort compaction**, and **Automatic compaction** controls are
unavailable for Prime in the initial v2 integration. Prime can still perform automatic compaction
under its native configuration.

Prime's own goal behavior can continue inside its native runtime when enabled, but Pylon does not
project **Goal** status or expose goal controls in this integration. **Subagent depth** and **Agent
spawn depth** controls are also unavailable. Prime's session, global, and `RLM_MAX_DEPTH` settings
still govern Full access; Supervised mode keeps subagent depth fixed at 0.

When Prime compacts a daemon-backed thread, Pylon shows one provider-neutral lifecycle row. Pylon
stores only constant started, completed, skipped, or failed presentation state; Prime's compaction
instructions, generated summary, and native errors are not copied into Pylon's event store or
remote clients. Prime still keeps the native compaction record in its private transcript for exact
resume. Automatic compaction keeps the current Pylon turn active while Prime performs its native
post-compaction continuation, including a reconnect gap before the next model run starts.

Automatic retries and harness refinement remain provider-owned behavior. Pylon's initial v2
integration does not expose **Refine local harness** or its result/status controls.

Prime per-turn **Reported cost** and child-inclusive token totals are unavailable in this integration.
Account subscription capacity is a separate reading described below.

## Subscription Capacity

Prime Agent runs each model on that backend's own subscription, so the capacity readout beside the
composer follows the selected model. Pylon resolves those sign-ins from the selected instance's explicit
Agent home or merged `PRIME_AGENT_CODING_AGENT_DIR` and home environment; an unresolved relative
environment path leaves capacity unknown rather than reading the Pylon server account. Pylon reads
Prime's sign-ins to show the right account: Prime's
own Anthropic or ChatGPT reading while Prime has used that backend recently — re-read after every
Prime turn — or the configured Codex account whose identity matches Prime's. A failed refresh keeps
its last good same-account reading for up to thirty minutes. Reading Prime's own ChatGPT capacity
requires the Codex CLI to be installed on the environment host as `codex` on the Pylon server
process's `PATH`; a custom Codex binary configured for another provider instance does not satisfy
this prerequisite. Only when neither reading can be used does Pylon fall back to your configured
accounts, and it says so. See [the composer](composer.md#subscription-capacity).

## Execution Approvals

Daemon-backed threads support **Supervised** and **Full access**. Supervised mode loads a
Pylon-managed gate that pauses supported built-in edits, shell commands, and IPython cells before
execution. You can approve one call, approve calls for the rest of that session, decline the call,
or cancel the turn. Inputs that are too large to show completely and tools whose arguments Pylon
cannot review completely are denied. A missing gate, invalid request, timeout, disconnect, or failed
response blocks execution instead of falling back to full access.

Supervised mode deliberately disables discovered Prime extensions, Prime slash commands, and Prime
subagent spawning. Extensions and slash commands are executable host code that cannot be contained
by the tool gate; child sessions also need their own independently verified gate. Full-access
threads keep normal Prime extension discovery, commands, and subagents.

This is an approval gate, not a sandbox. An approved IPython cell or shell command has the same host
access as Prime Agent, including access outside the workspace and the ability to start processes or
use the network.

Daemon-backed threads resume the exact Prime transcript selected for that Pylon thread. If the saved
transcript is removed or its private identity cannot be verified, Pylon reports a resume failure
instead of silently opening a blank or merely recent Prime session.

## Browser access

When **Agent browser access** is enabled in **Settings → Projects**, new Prime Agent sessions receive
Pylon's thread-scoped preview tools. Set it under **All projects** for a machine default, or select a
project to override that default. This works in daemon-backed sessions and ACP
compatibility mode. The scoped connection is removed when the provider session stops. Turning browser
access off withholds both the tools and their instructions; it does not affect browser tabs you control.

## Distribution Verification

Pylon treats Prime runtime support and Prime distribution proof as separate checks. The exact
configured `prime-agent` binary still negotiates its installed public SDK after Pylon attaches. A
missing or invalid distribution receipt does not disable the provider and does not bypass ACP
compatibility fallback.

In **Settings → Providers → Prime Agent**, a Pylon publication can show one of these labels:

- **Pylon managed** means a private Pylon receipt matches the exact package root and the build was
  admitted from signed Pylon preview or stable publication evidence.
- **Pylon build · manual** means the package claims Pylon build metadata but has no matching managed
  receipt. Update it using the same manual method that installed it.
- **Managed receipt invalid** means the private receipt, package-root binding, or local channel
  high-water is invalid. Prime remains usable, but managed update advice is disabled.
- Stock Prime Agent and other custom installations stay manually maintained and show no fork update
  warning.

Managed update advice compares the signed channel sequence and immutable build ID. It never orders
builds by the package version. Pylon verifies the GitHub/Sigstore issuer, transparency evidence,
repository, signer workflow and ref, source commit and tree, recipe, manifests, and artifact digest
before advancing its private channel high-water. An offline or rate-limited feed keeps the installed
build ready and retains the last authenticated advice.

This feature only verifies and reports. It does not download, install, switch, remove, or clean up a
Prime package. Native Windows receipts are not supported. Run Prime Agent in WSL2 to use the Linux
receipt path.

## Current Limitations

- Prime Agent 0.9.4 has no daemon-native or operating-system sandbox policy. Supervised mode gates
  tool admission but does not restrict an approved tool.
- Authentication is managed in Prime Agent, not Pylon.
- Formal Plan interaction mode is not supported. Pylon still shows bounded plan progress during Build
  turns through its managed daemon integration or plan updates from ACP compatibility mode.
- Native input-queue controls, session-side questions, resource catalogs/reload, Goal status, subagent
  depth, direct child messaging/cancellation/watching, and direct compaction/harness controls are
  unavailable in the initial v2 integration.
- Prime conversation rollback and native conversation forks are unavailable in both native daemon
  and ACP compatibility modes. Pylon can record filesystem checkpoints, but those checkpoints do
  not enable Prime rollback; see [Conversation rollback](conversation-rollback.md). Managed Prime
  **build** rollback remains available and changes the installed executable, not conversation history.
- Active-run steering is unavailable; v2 steering uses interrupt-and-restart. Automatic adoption of an
  active Prime turn after a Pylon server restart is unavailable. Temporary daemon transport reconnect
  within one running server is covered by the completion checks above.
- Pylon does not present live Prime reasoning streams, durable or historical child-session transcripts,
  per-turn cost or child-inclusive token totals, goal projections/mutations, heartbeats, saved-session
  history, or native package or MCP catalogs as first-class features.
- Heartbeat creation remains unavailable even though Prime Agent 0.9.4 exposes heartbeat methods. Prime does not identify a scheduled run in a way Pylon can safely match to a durable conversation turn and filesystem checkpoint. Clearing a heartbeat also does not return its underlying session to the normal lifecycle, so stopping or deleting the Pylon thread could otherwise leave invisible work behind. Pylon will not offer creation until recovery, clearing, stopping, and deletion can be made authoritative.
- Prime's daemon-global pause/resume controls for inbound agent messages are intentionally not exposed;
  they can clear queued messages and reset limits across unrelated sessions.
- Foreground prompts can wait safely behind native background work only when the installed Prime Agent
  explicitly supports Pylon's correlated lifecycle extension and the live model controls already match.
  Stock Prime Agent 0.9.4 instead returns a retryable busy result when Pylon can observe native activity;
  it cannot close the narrow race where native work starts before ordinary prompt admission completes.
- Background title, branch, commit, and change-request writing runs in a separate one-request Prime Agent process. It does not join or modify the interactive thread.
- Native scoped-model cycling and transport controls are omitted: Pylon's durable model picker and
  environment connection remain authoritative. Direct session bash, system-prompt and tool-definition
  reads, native recap text, retry-setting mutation, and Prime saved-session import/export/navigation
  are not mirrored because they would duplicate or bypass Pylon's terminal, thread history,
  checkpoints, privacy boundary, or multi-client state.
- ACP compatibility mode is intentionally narrower: it hides daemon-only thinking and service-tier
  controls, cannot switch models in a running session, supports only Full access, and does not expose
  native session UI or subagent hierarchy. Native active-run steering remains unavailable.

Remote web and mobile clients work normally: Prime Agent runs on the environment host, not on the
device displaying Pylon.
