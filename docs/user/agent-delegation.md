# Agent delegation

Agent delegation lets an agent hand work to other threads that run on a different provider or
account, then follow that work through to the end. A Prime Agent thread can, for example, send a
review task to an Antigravity thread signed in with your Google account, wait for it, read its
answer and the files it changed, and send follow-ups.

## Turn it on

Delegation is off by default. Open **Settings → Integrations** and turn on **Agent delegation**
under **All projects** for a machine default, or select a project to override that default. The
setting takes effect the next time an agent's session starts; a session that is already running
keeps the tools it started with.

The delegating thread needs Pylon's agent tools. On Prime Agent that means **Full access**:
Supervised sessions deny tools that Pylon cannot review, including delegation.

## Defaults

With delegation on, two more settings appear under it in **Settings → Integrations**. Like
delegation itself, they can be set for all projects or overridden per project.

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

Agents learn when to delegate from Pylon's instructions: delegation for work on another provider or in
its own thread, and their built-in subagents for quick help within the same session. Delegation doesn't
turn off built-in subagents. To make a Prime Agent thread use only delegation, set its **Subagent
depth** to 0 under **Harness**.

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

## Things to know

- An agent waits for a child in short checks of up to 45 seconds each, all inside its current turn.
  Pylon does not wake the parent when a child finishes. If the parent's turn ends first, ask it to
  check on its children in your next message.
- A child that sits idle for thirty minutes has its provider session stopped. Its next message
  starts a fresh session, which may not keep the provider's own conversation memory.
- Archiving a child hides its result from the parent agent. Unarchive it to let the parent read it
  again.
- Deleting a child thread does not undo work the parent already merged.
