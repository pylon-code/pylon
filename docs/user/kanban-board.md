# Kanban Board

The board gives each environment a lightweight place to organize coding work without turning agent
activity into project-management automation.

Open **Board** from the sidebar, the Command Palette, or `Cmd/Ctrl + Shift + K`. Choose an
environment and project, then add work to the backlog.

## Work items and threads

A work item can stand on its own or link to an existing thread. A linked item shows the thread's
current branch and live state, including running work, failures, pending input, and approvals. Open
the trace on the card to return to that thread.

The board never moves a work item because an agent started or finished a turn. Drag cards between
columns when the workflow state has actually changed. Every drag operation also has an equivalent
menu action for keyboard and touch use.

## Environments and projects

Board data belongs to the selected environment and follows the same authenticated connection as
threads and projects. When you connect remotely, you see the board stored by that remote T3 Code
server. Ordering is scoped to a project, so switching projects does not mix their workflows.

## Archive and restore

Archive work that should leave the active board. Use the archive button in the board toolbar to see
archived items and restore them to their previous column.
