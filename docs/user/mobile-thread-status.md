# Mobile thread status

The status pill above the composer shows connection problems, message loading or syncing, compaction, and active work. Tap a connection problem to reconnect to that environment. Once connected, the same pill follows message synchronization and the running turn.

When the agent is working through a plan, the pill also names the step it is on, so "Working for 2m 14s" becomes "Working for 2m 14s · Writing tests". Agents that publish no plan show the timer alone.

A working timer is hidden while the agent waits for approval, an answer, or another interaction. When there is no active status, the pill disappears. The scroll-to-end button remains available when you have scrolled away from the latest messages.

Status spinners respect Reduce Motion and stop while the app is inactive or the screen is unfocused.

When you start a new task while connected, its thread opens as soon as the task is saved on your device. Your prompt appears in the conversation and the pill reads **Setting up worktree…** or **Starting…** until the agent begins working. Sending another message waits until the task has started. If the server rejects the task, a **Could not start task** card replaces the composer; choose **Edit task** to reopen your prompt, including anything you typed during setup. When Pylon holds a new task back, the card shows why, and **Edit task** opens the held task with anything you typed during setup added to its prompt, so you can change or retarget it. To delete a held task, touch and hold it in the thread list.

Messages waiting on your device appear at the end of the conversation labelled **Pending**, or **Held** when Pylon is holding them back. Tap the pencil to move a pending message back into the composer. The message keeps its place in the conversation while it is delivered.
