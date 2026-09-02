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

The Early Access integration is tested with Prime Agent 0.8.1. Start it once in a terminal and use `/login` to configure an underlying model provider:

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

Prime Agent 0.8.1 makes standard ACP prompt completion wait for delegated descendants and resulting
parent work, identifies separate assistant messages across autonomous ACP turns, and changes the fresh
no-override subagent-depth default from 1 to 2. Pylon still validates Prime's correlated completion
metadata. Explicit session, global, and `RLM_MAX_DEPTH` settings continue to override the new default.
The 0.8.1 live catalog also removes Cloudflare AI Gateway's Workers AI mirror IDs and changes that
provider's default to `claude-sonnet-4.5`; Pylon discovers the installed catalog rather than pinning those
models.

Pylon uses the existing Prime Agent login. Provider status reports **Authenticated** only when a
healthy, current catalog contains at least one configured model provider. An empty catalog leaves
authentication **Unknown** because catalog emptiness is not proof that credentials are absent. This
status does not verify live network access, and Pylon does not offer Prime Agent sign-in or sign-out
inside the app.

## Configure Pylon

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

Stable is the default managed channel. Preview requires checking the preview warning before
**Install/update preview** becomes available. Signed channel sequence and build identity determine
updates; the package version does not. If the signed feed is offline or invalid, Pylon keeps the
current verified build selected and shows the failure instead of guessing that an update is available.

Updates stage a new build before switching. If this Prime instance has an active admission, turn,
session, daemon, or loaded SDK runtime, Pylon schedules the switch until that exact instance drains.
It never interrupts a turn for maintenance. The same controls work when Settings connects to the host
locally, remotely, through a relay, or through a tunnel.

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

A Prime turn can contain several assistant segments around tool work. Pylon keeps those segments in
native order, so a final response appears after the work that preceded it instead of being appended
to an older message higher in the thread. If Prime authoritatively finishes without public assistant
text after its latest tool activity, Pylon shows **Prime Agent finished without sending a final
response.** as a status row rather than inventing an assistant reply. If the provider rejects a prompt,
Pylon shows its mapped explanation when available. **Prime Agent stopped before sending a final
response.** is reserved for an authoritative failed terminal with no public response rather than hiding
an actionable provider failure. Cancellation remains cancellation. Prime Agent 0.8.1 waits for delegated descendants
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
negotiated, recovery is stricter: Pylon never copies missing prompt output from a snapshot. Prime must
provide complete event continuity, and the completed-message transcript must exactly match messages
Pylon already received through attributed live events. Any extra snapshot message closes the uncertain
session rather than guessing whether it was your answer or unrelated background output.
An active Full access turn can also survive a Pylon server restart when the exact Prime installation is
Pylon managed and the replacement server can prove the same retained native execution and complete
event history. Pylon restores the turn's scoped browser/MCP access before showing recovered activity and
never sends your prompt again. The recovery identity and handle remain private to the server and are not
sent to clients or written to public thread history.

Supervised or other approval-required sessions do not use restart adoption. Neither do ACP sessions,
stock or manually installed Prime distributions, native Windows, a replaced Prime supervisor, or any turn
whose identity or complete event continuity cannot be proven. Those cases keep the existing orphaned
session result rather than guessing, replaying the prompt, or exposing partial native work.

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

While a daemon-backed turn is working, sending another message steers the same turn. The separate
**Queue follow-up** action admits the current draft for the next native run instead. Pylon shows only
privacy-safe steering and follow-up counts; it never sends queued prompt previews to clients. The
**Session inputs** control also lets you choose whether steering inputs and follow-ups are delivered
**All at once** or **One at a time**. Those choices are shared with every client connected to the
session and survive reconnects for as long as the native session does. When either lane contains
exactly one item, the same control can remove that sole steering or follow-up input without revealing
its queued text. It also clears all pending inputs without interrupting current work, while stopping the
turn aborts current work, clears the native queue atomically, and resumes native input admission before
the session becomes reusable. A queued follow-up remains in the conversation as your durable intent; if
admission fails, Pylon marks it as not queued. Clearing session
inputs does not erase conversation history. On mobile, these shared session inputs
remain separate from pending sends saved on that device. Native select, confirm, and input dialogs appear in
the session panel. Submitted free-form input is sent through a transient provider RPC and is not
written to Pylon's event store or synchronized to other clients. Editor-replacement dialogs are
cancelled because Prime may place sensitive model or tool material in their prefills, which Pylon
cannot safely make durable; notifications, status, and widgets use the same provider-neutral presentation
surface. In Full access, the slash-command menu also shows the safe command names, descriptions, and
argument hints loaded for that thread when its native session starts, including prompt and skill commands.
The composer shows the saved names, descriptions, scopes, and argument hints for the session’s
discovered skills and prompts under **Harness** on web and desktop and **Resources** on mobile. It does
not show resource contents, paths, diagnostics, or provider-native identifiers, and browsing a resource
does not run or modify it. This metadata is part of the synchronized thread record and can remain visible
after the native session stops. While the session is idle, **Reload commands and resources** under
**Harness** reloads Prime's settings, authentication, MCP configuration, resources, runtime, and extension
lifecycle before replacing the visible resource and command catalogs. Use it after adding or changing a
session command, skill, or prompt; ordinary messages and project-file edits do not require a reload. It
is intentionally unavailable in Supervised mode. If the reload cannot finish safely, Pylon clears the catalog and closes that
native session rather than risking a partially reloaded runtime; it never retries automatically. Pylon does not
send resource paths, diagnostics, or extension source details
to clients. Supervised sessions keep discovered commands disabled. Observed Prime subagents appear in Pylon's Agents hierarchy. In Full access, an active agent can be stopped from its Agents row on web or desktop, or from the **Agents** control on mobile. Pylon waits for Prime's native cancelled status instead of marking the agent stopped optimistically; completed output and activity remain in the thread. A cancellation racing natural completion is treated as already settled, and Pylon never retries an uncertain cancellation automatically. Supervised sessions do not offer this control because child-agent spawning is disabled. In Full access, a live agent with a native message endpoint can also receive a direct message from its Agents row. Pylon reports only whether Prime delivered the message immediately or queued it behind current work; that receipt does not mean the agent read, answered, or completed it. Pylon does not copy the message or Prime's receipt identifiers into its event store, activity history, diagnostics, or other clients. Prime necessarily adds the text to the selected child agent's private native transcript and context so the agent can act on it. Sending is never retried automatically; if delivery becomes uncertain, sending again may duplicate the message. Supervised and ACP sessions do not offer native agent messaging.

When a daemon-backed parent waits for asynchronous children, the Pylon turn stays **Working** until
Prime reports descendant quiescence and finishes any parent continuation triggered by their replies.
The continued parent answer appears in the same turn rather than as hidden background work. If deleting a
child after its reply cancels Prime's in-flight descendant wait, Pylon retries that completion boundary while
the turn remains active, without resending your prompt. Cancelling the turn never retries the boundary.
If cancellation repeats while the turn remains active, another error occurs, or a daemon reconnect cannot
be reconciled, Pylon fails the turn and closes that native session instead of reusing work whose ownership
is uncertain.

In the main thread, each Prime tool call uses one activity row as it starts, updates, and completes. Pylon shows only a fixed friendly label such as **Code**, **Shell**, **Edit**, **Read**, **Search**, **Web search**, **Image**, or **Tool**, plus its coarse lifecycle state. Commands, code, paths, tool input, progress output, results, native titles and identifiers, and error text are not copied into thread activity.

For an active agent, **Live activity** opens an on-demand view on web, desktop, or mobile. It is a bounded replacement snapshot from Prime's public live-session watcher, not a durable transcript: Pylon does not persist it in the thread, share it with clients that did not open the view, or keep it after the panel closes. The panel shows assistant text plus a coarse tool timeline containing only a friendly label and **Started**, **Completed**, or **Failed**; IPython appears as **Code**. It also repeats the safe aggregate status already shown in the agent roster, such as token or tool counts. Child prompts, tool arguments, partial and final results, thinking, paths, timestamps, native identifiers and metadata, error text, attachments, and usage details are excluded. **No activity yet** means the agent may still be thinking; it does not mean the agent is inactive. The subscription closes when the view closes, the agent exits, the thread or provider changes, or the client disconnects. Pylon can build a bounded coarse skeleton from committed messages returned by the public watcher, but Prime Agent 0.8.1 cannot reopen an exited child, provide lossless historical child activity, or atomically expose activity that was already streaming when the view opened, so Pylon labels the view **Live only** rather than implying complete history.

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
home prevents the selected home's continual-harness entries from loading. Prime Agent 0.8.1 still appends
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

Supervised daemon sessions also expose **Quick question** in the composer. It asks the selected session model one tool-free question against a snapshot of the current conversation, then returns one temporary answer. The question and answer are sent only to the requesting client: Pylon does not add them to the thread, checkpoint them, synchronize them to other clients, or retry them after a disconnect. Closing or cancelling the request makes one best-effort native abort, and a timeout or uncertain outcome stays explicit. Quick questions can still consume model tokens and incur provider charges.

Quick question is intentionally unavailable in Full access. Prime Agent 0.8.1 gives a side question no model tools, but it still inherits provider hooks from discovered extensions; those hooks can run outside Pylon's normal turn and checkpoint ownership. Supervised sessions disable extension discovery and use only Pylon's verified approval gate, whose hooks do not run for a tool-free side answer. Restored sessions and ACP compatibility mode also fail closed.

When the selected model explicitly
exposes reasoning text, Pylon adds a bounded final **Reasoning** entry to the work log. Incremental
thinking deltas and provider-private reasoning metadata are not persisted.

Daemon-backed threads also show Prime's current context-window estimate and selected model limit in
the composer. The meter is separate from per-turn token totals and hides when Prime reports the
post-compaction context as unknown; it returns after the next successful model response. Pylon uses
the session's native automatic-compaction setting rather than assuming compaction is enabled.

Full-access daemon sessions expose context controls beside the context-window meter. **Compact now** starts immediately without a confirmation dialog when the authoritative native session state is idle; it never accepts custom instructions. While compaction is active, **Abort compaction** requests Prime's native cancellation, but the control stays active until Prime reports a terminal outcome. Web, desktop, and mobile keep your draft but disable sending and queueing until that terminal update, so a message cannot collide with Prime's compaction boundary. **Automatic compaction** changes the current session and Prime's provider-wide default, which the control states explicitly. These mutations are serialized with other session controls and are never retried automatically. If a response is ambiguous and authoritative state cannot be restored, Pylon closes the native session instead of guessing. Supervised and ACP sessions do not offer these controls.

Full-access daemon sessions with goal observation expose an agent-managed **Goal** status in the web,
desktop, and mobile composers. **No goal** means no persistent objective is active; ask Prime Agent to
“start a persistent goal to …” when work should continue across turns. An active status shows a bounded
objective, provider-neutral status, token budget and usage, elapsed seconds, and continuation count.
Pylon does not send Prime's native goal ID, timestamps, stop reasons, or errors to clients. Pylon stores
this safe projection, including the objective, in the thread so authenticated remote clients can see the
same state; Prime retains the full native goal in its session. The composer cannot create, update, pause,
resume, complete, or clear a goal because Prime Agent 0.8.1 does not expose daemon mutation methods for
them. Prime's goal skill can still make those changes inside the agent conversation. Switching provider
instances, entering
Supervised mode, using ACP compatibility mode, or receiving an unavailable snapshot removes the old
goal instead of leaving stale state visible.

Daemon-backed sessions also expose **Subagent depth** under **Harness** on web and desktop and an
**Agent spawn depth** control on mobile while the session is idle. Depth 0 disables recursive child-agent
spawning; depths 1 through 4 bound how many nested levels Prime may create. On a fresh Prime Agent 0.8.1
Full-access session with no session, global, or `RLM_MAX_DEPTH` override, the default is 2: the root may
create a child and grandchild. A choice made in Pylon applies only to that native session and never changes
Prime's global setting. Supervised sessions show the policy-fixed depth 0 and cannot change it.

When Prime compacts a daemon-backed thread, Pylon shows one provider-neutral lifecycle row. Pylon
stores only constant started, completed, skipped, or failed presentation state; Prime's compaction
instructions, generated summary, and native errors are not copied into Pylon's event store or
remote clients. Prime still keeps the native compaction record in its private transcript for exact
resume. Automatic compaction keeps the current Pylon turn active while Prime performs its native
post-compaction continuation, including a reconnect gap before the next model run starts.

Automatic provider retries and Prime harness refinements also appear as provider-neutral work rows.
Retry error text and refinement proposals, summaries, native IDs, paths, and edit details are not
copied to Pylon. A refinement that applies some changes and rejects others is shown as partially
applied rather than wholly failed.

For a new Full access daemon session, Pylon can also explicitly request **Refine local harness** when
the loaded Prime Agent exposes that method. The request always uses Prime's local scope. Pylon does
not accept refinement instructions, a rollback selection, or a global/local toggle, and it never
copies Prime's proposal, summary, changed paths, native IDs, or logs into the response. Only applied
and failed counts plus completed, partial, or failed outcome are returned. The control is unavailable
for Supervised, restored, and ACP sessions, and Pylon never retries an uncertain request automatically.
While an uncertain result remains reserved, every connected client keeps the control unavailable until
that provider session ends.

Completed daemon turns can show a **Reported cost** beside the terminal reply. This is Prime's
model-pricing estimate for that turn as reported at completion, not an invoice or account-wide
billing total. Very small estimates remain visible instead of rounding to zero; a reported zero can
also mean the selected model has no registered price.

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

When **Settings → Integrations → Browser → Allow agent browser access** is enabled, new Prime Agent
sessions receive Pylon's thread-scoped preview tools. This works in daemon-backed sessions and ACP
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

- Prime Agent 0.8.1 has no daemon-native or operating-system sandbox policy. Supervised mode gates
  tool admission but does not restrict an approved tool.
- Authentication is managed in Prime Agent, not Pylon.
- Formal Plan interaction mode is not supported. Pylon still shows bounded plan progress during Build
  turns through its managed daemon integration or plan updates from ACP compatibility mode.
- Provider-conversation rollback and general per-item queue editing or reordering are not supported yet.
  Pylon integrates Prime Agent 0.8.1's mutation API only for removing a lane's sole item. With multiple
  count-only items, clients cannot identify a specific target safely without exposing queued text, and
  ambiguous mutations are never retried.
- Pylon does not present live Prime reasoning streams, durable or historical child-session transcripts,
  cost breakdowns, goal mutations, heartbeats, saved-session history, or native package or MCP catalogs as first-class features. Active children have only the bounded **Live activity** view described above.
- Heartbeat creation remains unavailable even though Prime Agent 0.8.1 exposes heartbeat methods. Prime does not identify a scheduled run in a way Pylon can safely match to a durable conversation turn and filesystem checkpoint. Clearing a heartbeat also does not return its underlying session to the normal lifecycle, so stopping or deleting the Pylon thread could otherwise leave invisible work behind. Pylon will not offer creation until recovery, clearing, stopping, and deletion can be made authoritative.
- Prime's daemon-global pause/resume controls for inbound agent messages are intentionally not exposed;
  they can clear queued messages and reset limits across unrelated sessions.
- Foreground prompts can wait safely behind native background work only when the installed Prime Agent
  explicitly supports Pylon's correlated lifecycle extension and the live model controls already match.
  Stock Prime Agent 0.8.1 instead returns a retryable busy result when Pylon can observe native activity;
  it cannot close the narrow race where native work starts before ordinary prompt admission completes.
- Background title, branch, commit, and change-request writing runs in a separate one-request Prime Agent process. It does not join or modify the interactive thread.
- Quick questions are one-shot and temporary because Prime cannot recover or list them after reconnect.
  They are available only under the Supervised safeguards described above. Native scoped-model cycling
  and transport controls are also omitted: Pylon's durable model picker and environment connection remain authoritative. Direct session bash, system-prompt and
  tool-definition reads, native recap text, retry-setting mutation, and Prime saved-session
  import/export/navigation are not mirrored because they would duplicate or bypass Pylon's terminal,
  thread history, checkpoints, privacy boundary, or multi-client state.
- ACP compatibility mode is intentionally narrower: it hides daemon-only thinking and service-tier
  controls, cannot steer or switch models in a running session, supports only Full access, and does
  not expose native session UI or subagent hierarchy.

Remote web and mobile clients work normally: Prime Agent runs on the environment host, not on the
device displaying Pylon.
