# Prime Agent

Pylon can run [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) as a provider on the
device that owns your environment. Prime Agent is not bundled with Pylon.

## Install And Sign In

Install Prime Agent on the environment host. Prime Agent requires Node.js 22.8 or newer:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

The Early Access integration is tested with Prime Agent 0.8.0. Start it once in a terminal and use `/login` to configure an underlying model provider:

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

Pylon normally uses Prime Agent's native daemon API. A non-empty **Launch arguments** value selects
ACP compatibility mode instead, because the daemon API cannot safely preserve arbitrary CLI
arguments. Pylon shows that fallback in the provider status rather than silently discarding the
arguments.

## Turn Completion

A Prime turn can contain several assistant segments around tool work. Pylon keeps those segments in
native order, so a final response appears after the work that preceded it instead of being appended
to an older message higher in the thread. If Prime authoritatively finishes without public assistant
text after its latest tool activity, Pylon shows **Prime Agent finished without sending a final
response.** as a status row rather than inventing an assistant reply. Failures use the corresponding
stopped status; cancellation remains cancellation. In ACP compatibility mode, Prime Agent 0.8.0 can
finish its immediate response before delegated descendants settle. Pylon waits for Prime's correlated
terminal-quiescence signal, so the turn does not finish early while descendant work or a resulting goal
continuation is still active.

In native daemon mode, an active turn can continue through a temporary daemon transport reconnect when
Prime supplies complete replay data or an exact completed-message snapshot. Root tool work, delegated
children, and the parent response remain part of the original turn. If Pylon cannot prove that the
reconnected stream is complete, it fails the turn once and closes that Prime session instead of retrying
your prompt or guessing at missing output. Restarting the Pylon server is a separate boundary and does not
yet adopt Prime work that is still running in another process.

On Windows, Pylon currently uses ACP compatibility mode because Prime Agent 0.8.0's public named-pipe daemon transport does not expose a verifiable per-user ACL or authenticated handshake. Native daemon mode remains fail-closed there until the transport can prevent another local OS user from impersonating or connecting to the daemon.

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
The continued parent answer appears in the same turn rather than as hidden background work. If the
daemon reconnects during this boundary or cannot confirm it, Pylon fails the turn and closes that native
session instead of reusing work whose ownership is uncertain.

In the main thread, each Prime tool call uses one activity row as it starts, updates, and completes. Pylon shows only a fixed friendly label such as **Code**, **Shell**, **Edit**, **Read**, **Search**, **Web search**, **Image**, or **Tool**, plus its coarse lifecycle state. Commands, code, paths, tool input, progress output, results, native titles and identifiers, and error text are not copied into thread activity.

For an active agent, **Live activity** opens an on-demand view on web, desktop, or mobile. It is a bounded replacement snapshot from Prime's public live-session watcher, not a durable transcript: Pylon does not persist it in the thread, share it with clients that did not open the view, or keep it after the panel closes. The panel shows assistant text plus a coarse tool timeline containing only a friendly label and **Started**, **Completed**, or **Failed**; IPython appears as **Code**. It also repeats the safe aggregate status already shown in the agent roster, such as token or tool counts. Child prompts, tool arguments, partial and final results, thinking, paths, timestamps, native identifiers and metadata, error text, attachments, and usage details are excluded. **No activity yet** means the agent may still be thinking; it does not mean the agent is inactive. The subscription closes when the view closes, the agent exits, the thread or provider changes, or the client disconnects. Pylon can build a bounded coarse skeleton from committed messages returned by the public watcher, but Prime Agent 0.8.0 cannot reopen an exited child, provide lossless historical child activity, or atomically expose activity that was already streaming when the view opened, so Pylon labels the view **Live only** rather than implying complete history.

Supervised daemon sessions also expose **Quick question** in the composer. It asks the selected session model one tool-free question against a snapshot of the current conversation, then returns one temporary answer. The question and answer are sent only to the requesting client: Pylon does not add them to the thread, checkpoint them, synchronize them to other clients, or retry them after a disconnect. Closing or cancelling the request makes one best-effort native abort, and a timeout or uncertain outcome stays explicit. Quick questions can still consume model tokens and incur provider charges.

Quick question is intentionally unavailable in Full access. Prime Agent 0.8.0 gives a side question no model tools, but it still inherits provider hooks from discovered extensions; those hooks can run outside Pylon's normal turn and checkpoint ownership. Supervised sessions disable extension discovery and use only Pylon's verified approval gate, whose hooks do not run for a tool-free side answer. Restored sessions and ACP compatibility mode also fail closed.

When the selected model explicitly
exposes reasoning text, Pylon adds a bounded final **Reasoning** entry to the work log. Incremental
thinking deltas and provider-private reasoning metadata are not persisted.

Daemon-backed threads also show Prime's current context-window estimate and selected model limit in
the composer. The meter is separate from per-turn token totals and hides when Prime reports the
post-compaction context as unknown; it returns after the next successful model response. Pylon uses
the session's native automatic-compaction setting rather than assuming compaction is enabled.

Full-access daemon sessions expose context controls beside the context-window meter. **Compact now** is admitted only after Pylon confirms the native session is idle; it never accepts custom instructions. While compaction is active, **Abort compaction** requests Prime's native cancellation, but the control stays active until Prime reports a terminal outcome. **Automatic compaction** changes the current session and Prime's provider-wide default, which the control states explicitly. These mutations are serialized with other session controls and are never retried automatically. If a response is ambiguous and authoritative state cannot be restored, Pylon closes the native session instead of guessing. Supervised and ACP sessions do not offer these controls.

Full-access daemon sessions with goal observation expose an agent-managed **Goal** status in the web,
desktop, and mobile composers. **No goal** means no persistent objective is active; ask Prime Agent to
“start a persistent goal to …” when work should continue across turns. An active status shows a bounded
objective, provider-neutral status, token budget and usage, elapsed seconds, and continuation count.
Pylon does not send Prime's native goal ID, timestamps, stop reasons, or errors to clients. Pylon stores
this safe projection, including the objective, in the thread so authenticated remote clients can see the
same state; Prime retains the full native goal in its session. The composer cannot create, update, pause,
resume, complete, or clear a goal because Prime Agent 0.8.0 does not expose daemon mutation methods for
them. Prime's goal skill can still make those changes inside the agent conversation. Switching provider
instances, entering
Supervised mode, using ACP compatibility mode, or receiving an unavailable snapshot removes the old
goal instead of leaving stale state visible.

Daemon-backed sessions also expose **Subagent depth** under **Harness** on web and desktop and an
**Agent spawn depth** control on mobile while the session is idle. Depth 0 disables recursive child-agent
spawning; depths 1 through 4 bound how many nested levels Prime may create. The choice applies only to
that native session and never changes Prime's global setting.
Supervised sessions show the policy-fixed depth 0 and cannot change it.

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
composer follows the selected model: an Anthropic model shows your Claude accounts, an OpenAI Codex
model shows your Codex account. Pylon assumes Prime Agent is signed in to the same subscription as
the matching provider. See [the composer](composer.md#subscription-capacity).

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

## Current Limitations

- Prime Agent 0.8.0 has no daemon-native or operating-system sandbox policy. Supervised mode gates
  tool admission but does not restrict an approved tool.
- Authentication is managed in Prime Agent, not Pylon.
- Plan mode, provider-conversation rollback, and general per-item queue editing or reordering are
  not supported yet. Pylon integrates Prime Agent 0.8.0's mutation API only for removing a lane's
  sole item. With multiple count-only items, clients cannot identify a
  specific target safely without exposing queued text, and ambiguous mutations are never retried.
- Pylon does not present live Prime reasoning streams, durable or historical child-session transcripts,
  cost breakdowns, goal mutations, heartbeats, saved-session history, or native package or MCP catalogs as first-class features. Active children have only the bounded **Live activity** view described above.
- Heartbeat creation remains unavailable even though Prime Agent 0.8.0 exposes heartbeat methods. Prime does not identify a scheduled run in a way Pylon can safely match to a durable conversation turn and filesystem checkpoint. Clearing a heartbeat also does not return its underlying session to the normal lifecycle, so stopping or deleting the Pylon thread could otherwise leave invisible work behind. Pylon will not offer creation until recovery, clearing, stopping, and deletion can be made authoritative.
- Prime's daemon-global pause/resume controls for inbound agent messages are intentionally not exposed;
  they can clear queued messages and reset limits across unrelated sessions.
- Prime Agent is not used for Pylon's background text-generation helpers in Early Access.
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
