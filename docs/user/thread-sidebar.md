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

### Start without a project

A thread does not need a project. To start one, click **or start without a project** under a new
thread's heading, pick **No project** from the project menu in that heading or from
**New thread in...** in the command palette, or press `mod+alt+n`. On mobile, pick **No project** at
the top of the project list. To move a draft into a project, pick the project in the heading.

Each thread without a project works in its own folder inside the `scratch` folder of the Pylon data
directory on the machine that runs it (`~/.pylon-code/scratch` by default, or `scratch` inside the
directory set with `--base-dir`). The folder is named after the date, the first words of the first
message, and a short tag, like `2026-10-03-convert-these-pngs-to-webp-3f9c2a1b7d4e`. Deleting the
thread keeps the folder, so the files the agent wrote stay until you remove them yourself. These
folders are not Git repositories, so branches, worktrees, and Git diffs do not apply to them.

**No project** starts on the machine you are working on: the machine of the open thread or draft, or
on mobile, the machine of the project or machine you last picked for the new task. It never switches
to another machine. When nothing is open or picked, it starts on the only connected machine that
offers it, which can be a remote one; with several such machines, open a thread or pick a project on
the one you want first. On mobile you can then move the draft with its machine picker. Threads
without a project are unavailable on a machine whose Pylon data directory sits inside a Git checkout.

Older Pylon apps connected to the same machine list these threads under an ordinary project named
**No project**, and starting one there in **New worktree** mode fails because the folder is not a
Git repository. If Pylon cannot record a new thread after making its folder, the empty folder stays
in `scratch`; you can delete it.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and
Linux to start a new thread and immediately open another draft. The next draft keeps the workspace
mode and base branch you selected. With **New worktree**, each background submission creates its
own worktree.

### Follow worktree setup

A new worktree shows its setup progress before the agent starts. Open the progress details to see
checkout and setup script output. You can cancel while setup is running; cancellation waits for
cleanup before the task can be retried. Setup history remains visible when you reopen the thread.
If the server restarts during setup, the task is marked interrupted so you can retry it.

Project setup scripts normally run in the background. Enable **Wait for it to finish before the agent starts** for a script
when the agent needs its results before starting. A failed required script prevents the first turn
from starting. After a successful waited setup script, Pylon closes its terminal when no command
remains active; its output stays in setup history. Failed scripts and terminals with active commands
stay open.

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

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.
After unpinning, settling, snoozing, or archiving one thread on web and desktop, use **Undo** in the
notification or press `mod+z` while it is visible to reverse that action. Undo restores a
settled thread's previous pin and snooze state. The shortcut leaves text editing alone.

The server saves the order, so it survives a refresh and appears on your other devices. New threads
appear above the active threads you arranged, and thread activity does not change the order.
Settling clears a thread's position, while pinning and snoozing keep it until you move the thread
again; the settled shelf keeps sorting by settlement time. If dragging is unavailable for one
environment, update the Pylon server running there.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; **Done** returns to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the T3 Code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

Agents connected through T3 Code can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Fold working threads (beta)

On web and desktop, turn on **Settings → General → Working section (beta)** to move threads that
are working or monitoring into a collapsed **Working** section at the bottom of the sidebar. A
thread returns to the top of the active list when it finishes, fails, or needs an approval or
answer. Pinned threads stay in the pinned section.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag to reorder it. Your saved order returns when you turn it off.
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

To keep one thread out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Disabled**. The current option is checked. Pick
**Enabled** to return to the usual rules. Manual settle, snooze, and archive still work while it
is disabled. The option appears only for environments whose Pylon server supports it.

Change these rules in **Settings → General**. They continue to run when your apps
are closed. On web and desktop, choose an environment at the top to change only
its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Snooze until a chosen time

Choose **Snooze** from a thread's menu and pick a preset or **Custom…** to set a local date and
time or an elapsed duration. A date and time uses the timezone of the device where you choose it;
duration days are 24 hours. Times that have passed or do not exist during a daylight-saving change
are rejected. For a repeated fall-back hour, the first occurrence is used. Snoozing hides the thread
until it wakes or new work needs your attention. The success notice on web and desktop offers
**Undo**, and **Wake thread** is available from the snoozed shelf.

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

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
On web and desktop, press **Resume** in an empty composer to continue a limited
or interrupted turn manually.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the thread. Enable **Auto-resume limited
threads** in **Settings → General** on web and desktop, or **Settings → Thread
behavior** on mobile, to schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Sending a new message, archiving, or settling the
thread prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze limited threads** in thread behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents.

Subagent threads started by the agent can't take messages; message the parent
thread instead. When such a subagent needs an approval or an answer, the parent
thread asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

A subagent card groups the agents launched in a turn; expand it to see each agent's latest reported
status. On web and desktop, tool calls that finish after the final reply stay below that reply, and
failures and agent cards remain visible.
