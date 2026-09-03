# Rollback manual recovery

Use this runbook when a thread shows `manual-recovery`. The state is a safety fence, not a cosmetic client error.

## Safety rules

- Do not delete the rollback saga row, workspace lease, checkpoint refs, recovery ledger, or pre-image.
- Do not edit private anchors or mark an operation complete by hand.
- Do not start a provider session or run Git mutations in the fenced workspace.
- Preserve the runtime home and the affected repository before collecting diagnostics.

## Triage

1. Record the public thread ID, status detail, server version, and time.
2. Check server logs for the operation's public error code. Never paste private state, native session IDs, anchors, prompts, tool payloads, paths, credentials, or pre-image content into an issue.
3. Confirm whether the UI offers **Retry verification** or **Resume compensation**.
   - **Retry verification** is safe only after the Pylon projection committed and the saga can re-prove the target.
   - **Resume compensation** is safe only before projection commit when the durable source state can still be restored.
4. Run the offered action once. A second client pressing the same action joins or receives a busy result; it must not create another saga.
5. Wait for a durable `completed`, `failed`, or `manual-recovery` status. Do not use a client spinner as proof.

## If no action is offered

Leave the server and workspace intact. Collect a redacted support bundle and escalate to a maintainer who can inspect the saga and provider recovery ledger locally. The absence of an action means the server cannot prove that an automated transition is safe.

## Resolution criteria

- `completed`: target workspace, provider anchor, and projection were verified; cleanup released the lease.
- `failed`: source workspace and provider anchor were restored and verified; projection content was not removed; the lease was released.
- `manual-recovery`: proof is incomplete and the lease remains active. The incident is not resolved.
