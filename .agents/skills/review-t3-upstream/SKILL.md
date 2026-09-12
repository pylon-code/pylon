---
name: review-t3-upstream
description: Compare or selectively adopt T3 Code changes into Pylon, including resuming an upstream review.
---

# Review T3 Upstream

Review useful final behavior in bounded dependency groups. A source-commit count is not a count of missing fixes. The active decision index is `.agents/upstream-review.md`; search linked history only for relevant SHAs, PRs or behavior.

- When resuming or handing off, read [continuation](references/continuation.md) to recover the active cycle, frozen range, owning issue and existing worktree.
- When deciding desirability, scope or review depth, use [decision framework](references/decision-framework.md).
- When inventorying, integrating or landing a cycle, use [integration](references/integration.md), reading the sections relevant to that phase.

Comparison/recommendation requests are read-only. For adoption, identify selected groups or existing standing approval and proceed through routine Pylon adaptations without asking per commit or conflict. Ask for a decision only where existing approval does not cover removing a capability, changing protected contract guarantees, or another material product choice. Continue independent approved work meanwhile.

Preserve Pylon identity, Prime/provider behavior, lifecycle ownership, migration lineage, remote authentication and release/runtime boundaries. If upstream duplicates an independently implemented Pylon feature, compare both implementations and obtain the maintainer's choice rather than silently selecting one.

`origin` is `pylon-code/pylon`, product branch `pylon`; T3 remotes stay fetch-only. Never replace Pylon with upstream, rebase onto T3, select all of theirs, or change the ancestry baseline without separate explicit approval. Follow `AGENTS.md` for PR/merge and computer-use boundaries.

Finish the authorized bounded cycle and preserve dispositions, verification and remaining work. Advance `reviewed-through` only when every included source has an authorized disposition; partial and deferred work must retain exclusions/triggers. Cursor advancement does not mean all changes were adopted. Report merged, released and installed status separately; release needs its own authorization.
