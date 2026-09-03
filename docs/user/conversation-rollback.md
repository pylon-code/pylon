# Revert a conversation to an earlier message

Pylon can revert an eligible thread to an earlier user message. The action moves the provider conversation, Pylon history, and the project workspace to the same verified point.

## When the action is available

**Revert to this message** appears only when all of these conditions are true:

- the thread uses an idle, Pylon-managed native Prime session;
- Pylon saved an immutable workspace checkpoint and matching exact conversation anchor for the target;
- no turn, provider input, approval, queued message, or other workspace rollback is active.

ACP sessions, supervised or unmanaged Prime sessions, other providers, and checkpoints without an exact anchor do not show the action. Pylon does not fall back to an approximate provider rollback.

## What a revert changes

Before Pylon starts, the confirmation names the selected message and explains the full effect. A revert rewrites:

- the provider conversation;
- Pylon message and turn history;
- the worktree and Git index;
- staged and unstaged changes;
- untracked files.

Newer history is retained until the rollback commits. Pylon then removes it only after the workspace and provider conversation both match the selected point.

## Queued messages

Pylon does not start a local rollback while that thread has queued messages. Send or cancel them first.

If another client completes a rollback while this device is offline, messages composed here before the rollback remain saved on this device. Pylon holds them instead of sending or deleting them. Review each held message, then explicitly reconfirm it against the current thread or edit or cancel it.

## Progress and recovery

Every connected web, desktop, or mobile client shows the same durable status. Sending messages, changing provider settings, and running Git actions stay blocked while the operation is pending or recovering.

If the original state can be restored safely, Pylon reports that the rollback failed without removing thread content. If Pylon cannot prove either the target or the restored source state, it keeps the thread fenced and shows **Manual recovery required**.

Use **Retry verification** or **Resume compensation** only when Pylon offers that action. These controls resume the server-owned operation. They do not let a client declare the rollback complete. If no action is offered, keep the environment running and contact support with the thread title and the visible recovery message. Do not delete checkpoint refs or edit Pylon's runtime data.
