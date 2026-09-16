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

## What a child thread is

Each delegated task becomes an ordinary thread in the sidebar, so you can open it, answer its
questions, approve its actions, or stop it yourself.

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
