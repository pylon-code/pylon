# Pylon delegation

Agent delegation lets an agent hand work to other threads that run on a different provider or
account, then follow that work through to the end. A Prime Agent thread can, for example, send a
review task to an Antigravity thread signed in with your Google account, wait for it, read its
answer and the files it changed, and send follow-ups.

## Turn it on

Delegation is off by default. Open **Settings → Integrations** and turn on **Pylon delegation**
under **All projects** for a machine default, or select a project to override that default. The
setting takes effect the next time an agent's session starts; a session that is already running
keeps the tools it started with.

The delegating thread needs Pylon's agent tools. On Prime Agent that means **Full access**:
Supervised sessions deny tools that Pylon cannot review, including delegation.

## Defaults

**Default delegation model** and **Child permissions** are always visible under **Pylon delegation**
in **Settings → Integrations**, even while it is off. You can configure them before enabling it.
Like delegation itself, they can be set for all projects or overridden per project. These settings
apply only to Pylon child threads, not the provider’s built-in subagents.

- **Default delegation model** is the provider and model a child uses when your request doesn't
  name one. It starts unset. Without a default, the agent asks you which provider to use instead of
  choosing one itself.
- **Child permissions** is **Same as parent** by default. Choose **Supervised** to have children ask
  before running commands or editing files.

Your request always wins. "Delegate this to Claude" uses Claude even when the default is Antigravity.
"Delegate this with gemini-3.6-flash-low" keeps the default provider but uses that model; a model
has to be one the provider offers, as listed in its Models section under Settings → Providers. Asking for a
permission mode works the same way, but a child can never have broader permissions than the agent that
started it.

A default is never swapped for something else. If the default provider is signed out or disabled, or
no longer offers that model, delegation fails with an error until you pick a new default.

**Preferred delegation method** chooses how agents delegate worthwhile independent work:
**Built-in agents** (the default) or **Pylon threads**. Set it once for all projects or override it
per project. Choosing Pylon lets agents use your default delegation model without being asked each
time. Small or tightly coupled tasks stay local, and explicit instructions in your message take
priority. Enabling delegation alone does not request it. With the built-in preference, unavailable
built-in subagents do not trigger automatic Pylon delegation.

The preference is read when the agent chooses a method for a new task. Turning delegation off makes
the saved Pylon preference inactive; turning it on restores it. To make a one-time request, say
“Use Pylon delegation for this task” or “Keep this task local.”

Turning Pylon delegation off leaves built-in subagents alone. Existing agent sessions retain their
tools until their next session start, and existing children keep running. Start a new thread for the
new setting to apply immediately; open a running child and stop it if you want that work to end.
Native subagent controls belong to the provider’s harness; for example, Prime Agent’s **Harness →
Subagent depth** controls its built-in agents separately.

## Ask for delegation

For example: “Use a separate Pylon thread to review the authentication changes. Keep the review
read-only and report concrete bugs with file references.” The agent loads Pylon's delegation skill
on demand, then follows its guidance for choosing the route, briefing the child, waiting, and
reviewing the result. The skill is available in any project through Pylon's agent tools; no separate
skill installation is needed. Enabling delegation alone does not start a child.

## What a child thread is

Each delegated task becomes an ordinary thread, so you can open it, answer its questions, approve
its actions, or stop it yourself. In the sidebar it appears indented under its parent. Pinning, snoozing,
or settling applies to one thread at a time, so when a child and its parent end up in different
sections, the child shows as its own row. The legacy per-project sidebar and the mobile app list
children as ordinary threads.

- **Its own worktree.** Pylon creates a worktree on a temporary branch from the parent thread's
  branch. It follows the **Start from origin** setting, like other new worktrees. Nothing is merged
  back automatically; the parent agent reviews the child's work and merges it with its own tools.
- **No setup script.** Project setup actions do not run in delegated worktrees.
- **Same or narrower permissions.** A child runs in the parent's permission mode or in
  Supervised, never with more autonomy than the parent. A parent in plan mode starts its children in
  plan mode on providers that support it; others run the child normally.
- **One level deep.** A child cannot delegate further.
- **A limit per parent.** An agent can have up to eight children queued or running at once.
- **The provider's own usage.** Work in a child counts against that provider account, not the
  parent's.

## Monitor delegated work

Pylon children appear in the existing **Agents** panel alongside native agents, using the same
status-row layout. Choose **Open thread** to inspect a result, answer a question, approve an action,
or stop the child. The panel's active-agent count includes children even after the parent stops.
“Completed” means execution finished, not that changes were reviewed or merged. Native-agent token
totals remain separate; Pylon children do not yet contribute to a combined usage total.

Recognized delegation spawns use the same compact streaming entry as native subagents and remain
visible when the parent's work log collapses. Select the entry to open Agents. Original tool details
remain available. If the provider truncates the child ID, the entry cannot show that child's live
status; use Agents for the authoritative roster. No child is matched by its title.

“Waiting for delegated agent” requires an active parent turn and a recognized running status call
with a positive wait budget. Codex and Claude expose this structured tool data. Providers without
it, including current Prime and OpenCode live events, retain their generic tool logs and show child
status through the existing Agents panel and active-agent count. Mobile retains its existing
child-thread sidebar display.

## Automatic parent follow-through

While Pylon delegation is enabled, a child's completion, interruption, error, or request for
approval/input queues a follow-through turn for its parent. A busy parent receives the latest
updates together when it becomes eligible to run again. The parent is instructed to review results
and inspect blockers; a completed child is not automatically treated as verified work.

A parent that waited for a child inside its own turn and already received the finished result is not
woken again for it, so no turn is spent repeating what it knows. A child that needs your approval or
an answer always queues its update.

This applies only to separate Pylon child threads. Built-in subagents keep their provider's lifecycle
behavior. Updates use ordinary parent turns and the existing work log; no separate monitoring panel
is required. Follow-through runs on the server, including when using a remote or tunneled client.

A stopped, errored, snoozed, settled, archived, or blocked parent does not automatically resume.
Pylon does not approve a child's actions or blindly restart a stopped child. Turning delegation off
prevents further automatic parent turns; children already running are unaffected. Historical completed
children are not automatically revisited when the server starts.

To limit unattended usage, Pylon allows three automatic follow-through turns after your latest
ordinary message, then records **Automatic delegation follow-through paused** in the work log.
Send another message to continue. This is a turn limit, not a token or billing budget; parent and
child provider usage still applies.

## Pair with an executor

Instead of handing out many separate tasks, an agent can pair with one executor: a second thread on a
faster, cheaper model that stays linked for as long as the first thread lives. The lead plans, writes
the brief, and checks the result; the executor does the implementation in the same worktree, so there
is nothing to merge back.

In the web composer, **Pair** sits beside the model picker. Open it, choose the executor's model, and
turn the switch on. The executor starts from your **Default delegation model** when you have one, and
follows **Child permissions**. While the pair is on, the control shows the executor's model and what
it is doing, and **Open executor** takes you to its thread. The switch waits while the lead is
mid-turn, because a change applies between turns. Turning the pair off deletes an executor that was
never briefed and archives one that has history; turning it on again brings an archived executor
back. To change the executor's model, turn the pair off first. You can also ask for a pair in your
message, for example “Pair with Antigravity for this.”

While a thread is paired, the lead's own subagents are paused for that thread only, so
implementation goes to the executor. Your provider's settings are not changed and other threads are
unaffected; this takes effect the next time the lead's session starts. Antigravity can be the
executor but cannot lead a pair, because Pylon has no way to pause its own subagents; on an
Antigravity thread **Pair** is unavailable and says why. Codex can lead, though its own subagents
cannot be switched off, so it is told to leave them alone rather than prevented from using them.

The executor appears under its parent in the sidebar like any delegated thread. Archive it to turn
the pair off for that thread. Archiving, settling, or deleting the lead does the same to its
executor. Rewinding the lead stops the executor first, because both work on the same files. The Pair
control is on the web and desktop apps; the mobile app does not have it yet.

Pairing does not need **Pylon delegation** turned on. That setting decides whether agents may start
other threads on their own; a pair is something you switch on yourself, for one thread. With the
setting off, a paired lead still briefs its executor and is still told when it finishes, and an agent
that is merely asked to "pair with" another provider cannot start one by itself.

## Things to know

- Give a child one bounded task, relevant file references, acceptance criteria, and a concise report.
  Review its completed changes and checks, then send consolidated corrections. Separate threads add
  briefing and review overhead; using them is not a guarantee of lower total usage.
- When waiting is necessary, an agent checks for up to 45 seconds inside its current turn. Completed
  children and children waiting for an approval or answer return immediately.
  The parent can also end its turn and rely on automatic follow-through below.
- Result summaries are limited to 4,000 characters by default. The agent can request more and should
  expand a truncated result before accepting the work. If the 60,000-character limit is still too
  small, inspect the child thread or ask it for a concise handoff.
- A child that sits idle for thirty minutes has its provider session stopped. Its next message
  starts a fresh session, which may not keep the provider's own conversation memory.
- Archiving a child hides its result from the parent agent. Unarchive it to let the parent read it
  again.
- Deleting a child thread does not undo work the parent already merged.
