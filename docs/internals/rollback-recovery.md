# Exact conversation rollback state model

Exact rollback is a durable server-owned saga. Clients can request a target, choose whether to restore files, or resume an action that the server explicitly permits. They cannot provide provider anchors, clear the fence, or forge completion.

`thread.checkpoint.revert` restores the workspace and conversation. `thread.conversation.revert` preserves files while rewinding the conversation and Pylon history. A separate command ensures older servers reject the file-preserving action instead of ignoring a new option and restoring files. The private saga persists `restoreFiles: false`; an absent value retains the original full-restore behavior. Both modes require the same exact target proof and workspace lease. File-preserving operations skip workspace capture, apply, inspection and compensation, including after restart; provider verification, projection compare-and-set, and terminal cleanup remain durable.

```text
eligible checkpoint + exact idle provider gate
                  |
                  v
              pending
                  |
       workspace/provider apply
                  |
                  v
              recovering
            /      |       \
           v       v        v
      completed  failed  manual-recovery
        target    source       |
        proved    proved       +-- retry-verification (post-commit only)
                               +-- resume-compensation (pre-commit only)
```

`pending`, `recovering`, and `manual-recovery` fence thread input, provider mutation, checkpoint mutation, and workspace Git mutation. `completed` and `failed` are durable terminal user feedback and do not hold the lease.

## Public versus private state

Public thread state contains only:

- target checkpoint availability and a human-safe reason;
- source and target turn counts;
- progress state and a redacted error code/detail;
- server-authorized recovery actions.

Native session IDs, Prime leaf IDs, runtime generations, anchors, receipts, prompts, tool payloads, credentials, filesystem paths, and workspace pre-images stay in private persistence and provider adapter state.

## Eligibility

A target is published as available only after checkpoint capture proves all of the following:

1. the checkpoint is immutable and ready;
2. the provider adapter advertises the absolute rollback gate;
3. the live session is the managed native Prime or exact-capable OpenCode or Codex session for the projected incarnation;
4. a matching exact provider anchor was stored for that checkpoint.

Admission repeats the proof, checks the exact source revision, requires an idle thread and empty provider queues, and acquires the canonical workspace lease. Published availability is never admission authority.

OpenCode snapshots native history into private immutable forks and verifies full message contents and relationships before selecting a fresh fork. These snapshots preserve old checkpoint targets across compaction; current source proofs remain separate. Forks cost storage proportional to the retained histories. Legacy histories without a proved checkpoint boundary remain usable, but cannot gain rewind eligibility from a guessed turn count. A private idle recovery cursor restores only the same account, workspace and incarnation; ordinary Stop/resume keeps the selected native history and establishes new eligibility separately.

OpenCode's optional experimental plan mode stores a plan file under a name derived from the native session's creation time and slug. Native forks regenerate that identity without copying the file, so exact rewind is unavailable when `OPENCODE_EXPERIMENTAL_PLAN_MODE` is enabled, including through `OPENCODE_EXPERIMENTAL` unless the plan-mode flag explicitly disables it. Externally managed OpenCode servers also remain ineligible because their API does not expose that runtime flag. Ordinary plan mode, conversation history and resume remain usable; Pylon neither changes these flags nor copies plan files during rewind.

Codex captures immutable full native forks for owned completed turns. Exact proof includes the complete bounded native JSONL history and inactive native goal state; fresh forks defer goal continuation until the next explicit send. Original checkpoints survive compaction separately from current source proofs. Recovery verifies the same account, workspace and incarnation before selecting a fresh deferred fork. Active or uninspectable goals, paginated forks, external history bases, non-regular files, histories over 16 MiB or 100,000 records, and lines over 1 MiB are ineligible. Imported history has no guessed root or old Pylon turn bindings. Ordinary resume remains available.

## Multi-client behavior

The engine serializes admission. Requests for the same source, target and file choice join the active operation. A different target or file choice is rejected. Status is projected and streamed, so refresh, reconnect, remote clients, and multiple devices converge on the same fence and result.
