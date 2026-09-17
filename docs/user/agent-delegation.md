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

Keep small or tightly coupled tasks in the current thread. Pylon instructs agents to prefer their
built-in subagents for worthwhile independent work, and to use Pylon delegation only when you
explicitly request a separate Pylon thread or work on another provider, model, or account. Turning
the switch on makes delegation available; it does not ask the agent to use it. If built-in subagents
are unavailable, the agent should continue locally instead of automatically creating Pylon threads.

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

## Things to know

- Give a child one bounded task, relevant file references, acceptance criteria, and a concise report.
  Review its completed changes and checks, then send consolidated corrections. Separate threads add
  briefing and review overhead; using them is not a guarantee of lower total usage.
- When waiting is necessary, an agent checks for up to 45 seconds inside its current turn. Completed
  children and children waiting for an approval or answer return immediately.
  Pylon does not wake the parent when a child finishes. If the parent's turn ends first, ask it to
  check on its children in your next message.
- Result summaries are limited to 4,000 characters by default. The agent can request more and should
  expand a truncated result before accepting the work. If the 60,000-character limit is still too
  small, inspect the child thread or ask it for a concise handoff.
- A child that sits idle for thirty minutes has its provider session stopped. Its next message
  starts a fresh session, which may not keep the provider's own conversation memory.
- Archiving a child hides its result from the parent agent. Unarchive it to let the parent read it
  again.
- Deleting a child thread does not undo work the parent already merged.
