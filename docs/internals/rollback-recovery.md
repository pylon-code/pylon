# Exact conversation rollback state model

Exact rollback is a durable server-owned saga. Clients can request a target or resume an action that the server explicitly permits. They cannot provide provider anchors, clear the fence, or forge completion.

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
3. the live session is the managed native Prime session for the projected incarnation;
4. a matching exact provider anchor was stored for that checkpoint.

Admission repeats the proof, checks the exact source revision, requires an idle thread and empty provider queues, and acquires the canonical workspace lease. Published availability is never admission authority.

## Multi-client behavior

The engine serializes admission. Requests for the same source and target join the active operation. A different target is rejected. Status is projected and streamed, so refresh, reconnect, remote clients, and multiple devices converge on the same fence and result.
