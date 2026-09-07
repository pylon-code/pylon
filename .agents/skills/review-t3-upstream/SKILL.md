---
name: review-t3-upstream
description: Review and selectively adopt T3 Code upstream changes into Pylon. Use for upstream comparisons, catch-up, update recommendations, deferred work, or approved integration. Review final changes by dependency group, preserve Pylon behavior, and honor existing maintainer approval.
---

# Review T3 Upstream

Maintain Pylon as an independent fork. Optimize for useful, verified behavior and a bounded review backlog. Commit counts measure source history, not missing fixes or product quality.

Read `AGENTS.md` and the active `.agents/upstream-review.md`. Read [the decision framework](references/decision-framework.md) when choosing scope, review depth, or validation. Search archived decisions by SHA, PR, or affected behavior when needed; do not load the entire history each cycle.

## Authorization and boundaries

- A request to compare or recommend is read-only. Before integration, identify the change sets the user selected or the standing approval that covers them.
- Existing approval for compatible catch-up includes routine Pylon adaptations that preserve the approved behavior. State the intended batch and proceed; do not request approval per commit, PR, or routine conflict.
- Ask for a concrete decision if a change would remove an important Pylon capability, break compatibility or change the guarantees of a protected contract, or require a product choice outside that approval. Continue independent approved work while the question is pending.
- Preserve Pylon identity, Prime and provider behavior, lifecycle ownership, migration lineage, client compatibility, remote authentication, and release/runtime boundaries. See the framework for focused checks.
- Keep `origin` pointed at public `pylon-code/pylon`, with `pylon` as the product branch. T3 remotes remain fetch-only. Never replace Pylon, rebase onto T3, select all of `theirs`, or record an unreviewed upstream head as merged. Changing the Git ancestry baseline is a separate, explicitly approved task.

## Bound one integration cycle

Check the branch, worktree, and remotes. Fetch `origin pylon` and `t3code-upstream main` once at the start of a cycle; freeze their full SHAs for analysis. Compare against the fetched `origin/pylon`, not a potentially stale local `pylon` branch.

Validate that the ledger's `reviewed-through` is an ancestor of the bounded upstream head. If it is not, investigate before changing the cursor. Inventory **every** commit in the range, including its changed paths, then subtract recorded decisions and check patch equivalence:

```bash
git log --reverse --format='%H %s' <cursor>..<upstream-head>
git diff --name-status <cursor> <upstream-head>
git cherry -v <pylon-head> <upstream-head> <cursor>
```

A matching patch ID is evidence, not proof that a manual adaptation or later revert has the same behavior. Query archived records for partial ports and deferred work before counting a source as missing. New upstream arrivals belong to the next cycle; they do not continually expand an in-progress batch. Refresh at cycle completion and report any new arrivals separately.

## Review the final behavior

Group a feature and its fixes, reverts, tests, and necessary dependencies into one change set. Several related changes to one subsystem can share a PR when they form a reviewable and reversible unit. Do not impose a quota of upstream commits per PR. Keep independent product decisions and unrelated high-risk work separate.

Read the complete **proposed combined diff**, relevant tests, and Pylon callers. Prefer the finished behavior at the bounded upstream head over replaying temporary implementations that were later replaced. Inspect intermediate commits where migrations, persistent data, wire formats, reverts, or provider/lifecycle ordering make that history relevant.

Consult upstream PR descriptions and substantive review findings when they explain intent, dependencies, unresolved correctness questions, or high-risk changes. Do not reread every historical bot discussion for routine cleanup. Titles and clean cherry-picks alone never establish correctness.

A path-filtered upstream diff may mix several features. Account for all included hunks and retain Pylon-specific code; do not copy the latest version of a shared file simply because the desired feature touches it. Record outcomes as adopted, partially adopted, already covered, superseded, skipped, or deferred. A partial port must name the excluded behavior; it does not close the whole source commit.

## Revisit only triggered decisions

Read the open deferred register and watch list each cycle. Respect earliest-revisit dates. Check an entry's recorded paths, dependencies, or external state only when its trigger can be due or its cached evidence is invalidated. For an undated open PR watch, check its state once per cycle. Cache checked head/date and result in the cycle's working notes; do not repeat checks after each implementation PR.

Reassess due or changed entries as normal candidates. Keep unmet entries with their original date and trigger. Retire superseded entries explicitly. An unknown or missing trigger needs a concrete replacement, not indefinite silent deferral. Summarize unchanged entries collectively; give details for due, changed, or unresolved entries. Update an owning issue when authorized; otherwise record that follow-up without sending an unapproved message.

## Integrate and verify once per unit

Use a clean task worktree based on freshly fetched `origin/pylon`. Preserve other worktrees and unfinished work. Choose clean `cherry-pick -x` for coherent sources, a complete dependency series when useful, or a manual port of the final behavior with full source SHAs in the commit/PR. Preserve semantic intent when resolving conflicts.

For repeated conflicts, use repository-local `rerere` when enabled, with automatic staging disabled. Inspect reused resolutions before staging; they are suggestions, not correctness checks. Do not silently change global Git configuration.

Select existing regression checks for the affected Pylon boundaries before editing. Add focused tests for changed backend behavior or a missing protection. Run targeted checks during development, then the affected package checks and one integrated client pass for the completed unit where required by `AGENTS.md`. Reuse valid evidence for unchanged code. A rebase requires inspection and checks for the actual changes/conflicts; it does not automatically require replaying unrelated local suites or recapturing unchanged UI. CI must still pass on the final PR head.

Keep UI evidence for the final integrated behavior together in the PR; backend-only, workflow, and documentation changes do not require browser evidence. Use the specialized server, branding, or client skills only when the scope needs them and honor computer-use authorization.

## Land, record, and report

Follow `AGENTS.md` for branching, rebasing onto Pylon, opening a PR, checking bot findings, and merging under existing approval. Keep the compact decision record in the implementation PR. A decision-only PR is appropriate for genuinely new skip/defer decisions; avoid extra PRs just to restate already merged work, refresh counters, or record each release.

Each record identifies the bounded head, source SHAs (or an exact fully classified range with exclusions), final behavior, outcome and remaining scope, Pylon PR, material adaptations, and verification. The PR holds detailed implementation evidence; the ledger is an index. Preserve old records in linked archives and keep the active cursor and open registers easy to read.

Advance `reviewed-through` only when every source through that head has an authorized disposition. Deferred entries may advance the cursor only with their remaining work and revisit trigger recorded. Unclassified sources or unaccounted parts of partial ports keep the cursor behind. Cursor advancement is neither proof of adoption nor a change to Git ancestry.

After an integration cycle, validate one release containing the landed groups when release is authorized. Avoid publishing per minor PR. Report merged, released, and installed versions separately.

During active work, give useful progress updates at least once a minute: completed groups, current work, next checkpoint, and exceptions. Report remaining **unclassified groups**, approved work still to land, and due deferred work separately; source counts are secondary and must name their range. Never report an estimated grouping as an exact count, or intentionally excluded work as missing fixes.

For the first cycle under a changed process, use one coherent pilot batch. Record effort, repeated checks avoided, and any regressions or missed dependencies in the PR verification notes before broadening the approach. No promised speedup replaces that evidence.
