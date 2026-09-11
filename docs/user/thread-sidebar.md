# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes need a separate
branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model and mode
selections, unless the destination project has its own model default. Its branch and workspace mode
come from your configured defaults. To continue in an existing worktree, use
**New thread in this worktree** from the branch toolbar.

When you change a new thread's project, Pylon stays in the current environment if that project
exists there. Otherwise it selects an environment that has it.

On mobile, touch and hold a thread that has a branch and choose **New thread on branch**. Pylon
checks out the branch, or reuses the thread's worktree, before the composer opens, and shows the Git
error if the checkout fails.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and
Linux to start a new thread and immediately open another draft. The next draft keeps the workspace
mode and base branch you selected. With **New worktree**, each background submission creates its
own worktree.

## Pin and arrange threads

Pin a thread from its menu, or press `mod+shift+p` in the open thread, to keep it above your active
work. Pinned threads appear regardless of their project, including across environments. To confirm
before unpinning on web and desktop, enable **Settings → General → Unpin confirmation**; mobile
unpins immediately.

On web and desktop, drag a thread to reorder it or change its state: drop it in the pinned section
to pin it, in the active list to unpin or un-settle it, on the **Settled** header to settle it, or
out of the snoozed shelf to wake it. The dragged row names the action before you drop. Threads
cannot be dragged into the snoozed shelf, because snoozing needs a wake time, and dragging a pinned
thread out does not ask for unpin confirmation.

On mobile, open a thread's menu and choose **Arrange threads**, then drag handles within or between
**Pinned** and **Active**, or onto the **Settled** divider. **Move up** and **Move down** are also in
the thread menu.

The server saves the order, so it survives a refresh and appears on your other devices. New threads
appear above the active threads you arranged, and thread activity does not change the order.
Settling clears a thread's position, while pinning and snoozing keep it until you move the thread
again; the settled shelf keeps sorting by settlement time. If dragging is unavailable for one
environment, update the Pylon server running there.

On web and desktop, you can also drag files from your computer onto any thread row, including search
results. The thread opens with the files attached in its composer; nothing is sent automatically.
See [attach files](./composer.md#attach-files) for limits.

## Settle finished work

Choose **Settle thread** from its menu, or press `mod+shift+s`, to move finished work out of the
active list without deleting the conversation. **Un-settle thread** returns it to the top of the
active list and prevents automatic settlement until new activity resumes the usual rules. Pinning
does not prevent automatic settlement, and settling removes a pin. Manually settling an idle thread
dismisses unanswered async questions without sending an answer; questions that pause the agent still
need an answer or an interrupted turn.

By default, environments settle inactive threads after three days and settle threads whose pull
request merged. A closed pull request can also settle an idle thread. Work in progress, pending
questions or approvals, and live background work prevent automatic settlement. An open pull request
does not prevent inactivity settlement, and an old closed or merged pull request does not settle
work you resumed after it closed. **Settled** lists threads newest first by when their work
finished, or by when you settled them yourself.

Change these rules in **Settings → General**. They continue to run when your apps are closed. Changes
apply to connected environments that support shared settings; offline environments and older
servers keep their previous values. If connected environments disagree, **Apply to all** copies your
current settings to those named in the warning. Changing a rule does not reopen already settled
threads, and turning both rules off stops the background checks.

## Link a pull request

The server finds the pull request for each unsettled thread's saved branch, even while your apps are
closed. Settled threads keep their saved links. Update older servers if automatic branch links do
not appear.

On web and desktop, right-click a pull request link in a thread and choose **Link to thread** to
select a different pull request. **Unlink from thread** returns to the branch pull request, if one
exists. The linked pull request participates in automatic settlement.

## Manage drafts and unsent work

On web and desktop, a thread with an unsent draft is marked in the flat sidebar. Hover its row and
choose **Discard draft** to clear the draft without opening the thread; model and mode choices are
kept.

On mobile, unsent work appears under **Unsent** at the top of the thread list. Each **New Task**
starts its own draft. A queued task shows what happens next, such as **Sends on reconnect** or
**Waiting for upload**, and a task Pylon held back reads **Held** until you edit or retarget it.
Touch and hold a draft or held task to discard or delete it. An existing thread with a message
waiting on the device shows an outbox icon and stays in the active list until that message is sent
or deleted. See [mobile thread status](./mobile-thread-status.md) for status inside a thread.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search settings, threads,
projects, and branches across connected environments. Message search starts after two characters
and includes your messages and final agent responses.

On web and desktop, the flat sidebar's project filter stays selected when you visit Settings or
reload; choose **All projects** to clear it. Open a project's settings from its menu in either
sidebar, from any thread's menu, or from the breadcrumb menu when composing a new thread.

Use **Settings → Keybindings** to find or customize shortcuts for searching files and copying a
thread reference. A copied reference uses the thread's pull request link when available, otherwise
its thread ID. See [keybindings](./keybindings.md) for custom configuration.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. The option is hidden when the environment needs a server update.

When several accounts share a provider, or an account has an accent color, the provider icon on a
mobile thread row carries that account's initials in its accent color.

Select several threads to delete them together; bulk deletion continues past a failure and keeps
failed threads selected so you can retry. In the flat sidebar, select several pinned threads to unpin
them together.

## Inspect agent work

On web and desktop, use **Agents** to follow work delegated to subagents.

Expand a tool group in the conversation to see its calls, and expand a call to see its full command
and output. Summaries show the program inside a shell wrapper, such as "Running vp", and the live
summary can still describe the latest call after it finishes; the call's own row shows its status.
Failed calls open to their full error.

A subagent card groups the agents launched in a turn; expand it to see each agent's latest reported
status. On web and desktop, tool calls that finish after the final reply stay below that reply, and
failures and agent cards remain visible.
