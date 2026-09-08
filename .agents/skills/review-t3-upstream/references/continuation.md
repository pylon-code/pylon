# Continue an upstream integration cycle

Use this procedure when another agent takes over, a conversation is lost, or the maintainer asks to pause and preserve progress. The stable method belongs in this skill. The active issue owns current work; merged PRs and the decision index own completed dispositions. Local snapshots are recovery evidence, not a second adoption ledger.

## Find the handoff

Read the active-cycle link in `.agents/upstream-review.md`. If it is absent or stale, search Pylon's open issues for `Upstream integration cycle` and inspect matching open PRs. Do not start another cycle merely because your harness has no memory of the previous agent.

```bash
gh issue list --repo pylon-code/pylon --state open --search 'Upstream integration cycle in:title'
git worktree list --porcelain
git rev-parse --path-format=absolute --git-common-dir
```

For same-machine recovery, look below the returned common Git directory at `agent-handoffs/t3-upstream/CURRENT.md`. This location is shared by linked worktrees and is independent of Codex or Claude home directories. It is local-only: a fresh clone must use the issue and PRs, and must not assume another machine's paths exist.

## Reconcile before editing

- Recover the frozen upstream SHA, review cursor, exact remaining sources, standing approval and any exceptions. A new agent is not a new review cycle. Do not refetch upstream, reopen unchanged deferred decisions, or advance the cursor to simplify counting.
- Fetch `origin pylon`, then verify each pending PR's state and exact head. Prepared, pushed, merged, released and installed are separate states. Update counts only after confirming a disposition; a pending port is still work to land.
- Inspect the recorded worktree's branch, base, tracked diff and untracked files. Resume it when intact. Do not overwrite it with a new worktree, replay a partially applied patch, rerun one-off adaptation scripts, or clean untracked files. Coordinate with the maintainer if another agent is actively writing there.
- Reuse verification tied to unchanged files and known commits. Read the logs, including any failures and their subsequent fixes. Finish named gaps, inspect any rebase conflicts, and require CI on the final PR head. Do not repeat unrelated checks merely because the harness changed.
- Treat saved process/session IDs as observations to verify, not reusable handles. Check whether the recorded ports are listening. Follow `AGENTS.md` for stopping processes; never kill by pattern. Read credentials only when the next authorized operation needs them, and never put them in the issue or evidence.

Continue with the existing approval and next unfinished dependency group. Do not ask again for already approved Pylon-preserving adaptations. Ask only when the concrete change introduces a product tradeoff outside that approval.

## Leave a usable handoff

When asked to hand off, finish or accurately describe the current operation and stop starting new feature work. Update the owning issue with:

- frozen range, checked Pylon head, approved scope and outstanding exceptions;
- merged and pending PRs, their exact heads, and the next action;
- remaining source SHAs and titles, including unresolved parts of partial ports;
- unfinished branch/worktree and whether it has uncommitted or untracked work;
- completed verification, failures already fixed, remaining checks and client evidence;
- release/install status, plus any other worktrees that must be preserved.

Put machine-specific recovery details in `agent-handoffs/t3-upstream/` under the common Git directory. Preserve a timestamped snapshot of the unfinished tracked diff, copies of changed and untracked task files, their checksums, the base SHA, source inventory, and relevant verification logs. Keep credentials, live databases, dependency directories and unrelated files out of the snapshot. Point `CURRENT.md` to that snapshot and the issue, and record any isolated test state, ports and evidence paths needed to resume. Verify the saved files before claiming the handoff is complete.

The current worktree remains the first choice for continuation. Restore a snapshot only into a clean branch based on its recorded base after checking for newer work; do not apply it over an existing dirty checkout. One-off scripts and stale counters are not authoritative when Git or GitHub disagrees.

Close or update the tracking issue when its cycle finishes. Update the reusable skill only when the method changes; do not embed changing commit counts, current machine paths, test logs or pending task checklists in `AGENTS.md`, the skill, or the durable fact log.
