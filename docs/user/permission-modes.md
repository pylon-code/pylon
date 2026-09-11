# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread. Mobile offers the same modes.

New threads start in **Full access** unless you choose another mode before sending. A thread created
from another thread inherits its mode.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.          |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others. |
| **Full access**       | Allows commands and edits without approval prompts.                                   |

Approve or reject requests in the conversation to let the agent continue. Permission modes do not
prevent the agent from asking questions about the task.

Use **Full access** for work in a worktree or sandbox you can throw away, and **Supervised** where an
unwanted command is expensive or the task is unfamiliar.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, and Cursor; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking.

For Grok, **Always allow this session** remembers the matching command or tool input. Other actions
still require approval, and the thread does not switch to **Full access**.

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

Prime Agent's **Supervised** mode is an approval gate, not a workspace sandbox. It asks before
supported built-in edits, commands, and IPython cells; disables discovered Prime extensions, slash
commands, and subagents; and refuses to run when the gate cannot be verified. Tool inputs Pylon
cannot show or review completely are denied rather than approved. An approved command or IPython
cell still has normal host access. Prime Agent's ACP compatibility mode supports only
**Full access**.

See the [provider guides](./install.md#providers) for setup and provider-specific limits.
