# Revert a conversation to an earlier message

Pylon v2 uses the selected provider's rollback support and saved workspace checkpoints. On web and desktop, choose **Edit from here** beneath a sent message. Mobile offers the rollback action from the conversation.

Choose **Revert and keep changes** to preserve workspace files, or **Revert files too** to restore the checkpoint as well. File restore is offered only for an isolated worktree. Pylon refuses it when another thread or agent session uses the same directory or an overlapping directory.

The selected prompt, attachments, and inline context return to the web or desktop composer for editing. Any unsent draft stays above the restored prompt. Later conversation leaves the active history after rollback succeeds. This does not undo external actions or separate provider memory.

Rollback availability depends on the active provider, its conversation history, and the saved checkpoint. Prime's initial v2 bridge does not support native conversation rollback, so Prime does not offer this action.

## Failure and queued messages

The server records each rollback request and any terminal failure. If the provider cannot roll back, Pylon shows the failure; retry after checking the provider and server logs.

Pylon v2 does not expose the former durable rollback saga, workspace lease, **Retry verification**, or **Resume compensation** controls. It cannot promise compensation to the original provider conversation after a partial failure.

Messages retained on a disconnected device remain subject to its local delivery and ownership checks. Review a held draft before sending it against a changed conversation.
