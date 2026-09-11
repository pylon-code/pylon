# Status indicators

Pylon uses small dots, icons, labels, and progress marks to show what needs your
attention. Color has a consistent meaning:

- **Sky** means a thread is working, connecting, or running delegated work.
- **Amber** means an approval is required.
- **Indigo** means Pylon is waiting for your input.
- **Violet** means a plan is ready to review.
- **Emerald** means work completed successfully.
- **Red** means work failed.
- **Muted** indicators are idle, offline, or waiting without requiring action.

Monitoring states remain still. Active progress can pulse, but Pylon stops that
motion when your device has Reduce Motion enabled.

Connection indicators use green for connected, amber for connecting or
reconnecting, red for an error, and muted grey while offline. Connecting or
reconnecting environments use an amber halo. Connected client sessions use a
green liveness halo. Reduce Motion hides both halos.

Task lists use `✓` for completed steps, `●` for the current step, and `○` for
pending or passive waiting steps. A step that is specifically waiting for you
uses an amber `●`. In the composer's task list, each row also names its state
as **Completed**, **Running**, **Pending**, or **Waiting**, and the tasks bar
shows progress as a count such as `2/5 complete`.

A working thread also carries its plan progress as a step count, such as
`3/7`, on sidebar rows and mobile thread rows. The count appears once the
agent publishes a plan and clears when the turn settles, so a finished
thread never keeps a stale number. After an environment restarts, a thread
that is still running shows no count until its agent next updates the plan.

On mobile, a thread that cannot load may show **Could not synchronize the
thread.** This can happen while the environment still shows connected. The
message remains until Pylon starts another attempt to load that thread.

A Cursor turn that returns only a recognized transport failure is marked failed.
Its diagnostic remains in the conversation so you can inspect it before retrying.
Pylon does not retry the prompt automatically, because the turn may already have
changed files or run commands.
