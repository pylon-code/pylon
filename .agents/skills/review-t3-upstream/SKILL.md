---
name: review-t3-upstream
description: Review T3 Code upstream changes for selective adoption into Pylon. Use when the user asks what changed upstream, whether Pylon should sync or update, which T3 commits or pull requests are worth adopting, how the forks differ, whether previously deferred upstream work is ready to revisit, or asks to integrate selected upstream work. Fetch the protected upstream remote, consult the durable review ledger, re-evaluate deferred work against its recorded revisit conditions, group and assess candidate changes, wait for an explicit user decision, and then selectively port approved work with Pylon-first conflict resolution.
---

# Review T3 Upstream

Treat upstream review as a product decision workflow, not a synchronization command. Explain what changed and help the user choose before changing Pylon.

## Preserve the fork invariants

Read `AGENTS.md`, `.agents/upstream-review.md`, and [references/decision-framework.md](references/decision-framework.md) before reviewing candidates.

- Keep `origin` pointed at the private `pylon-code/pylon` repository and `pylon` as its product branch.
- Keep `t3code-upstream` and `t3code-fork` fetch-only. Never push to them or re-enable their push URLs.
- Never hard-reset Pylon, replace it with upstream, or merge all of upstream by default.
- Preserve visible Pylon identity and Pylon-specific product behavior. Compatibility identifiers may remain T3-named until deliberately migrated.
- Separate review from integration. Do not edit code, create an integration branch, cherry-pick, merge, commit, or push until the user explicitly selects change sets.

## Phase 1: Preflight the repository

Run from the Pylon repository root:

```bash
git status --short --branch
git remote -v
git branch --show-current
git rev-parse --verify pylon
```

Confirm:

- `origin` fetches and pushes `pylon-code/pylon`;
- `t3code-upstream` fetches `pingdotgg/t3code` and has a disabled push URL;
- `.agents/upstream-review.md` contains a `reviewed-through` commit;
- the ledger contains a `## Deferred register` section;
- the current checkout belongs to Pylon.

A dirty tree does not block read-only review, but it blocks integration. Never stash, discard, or commit unrelated work to make the tree clean.

If a required remote or ledger is missing, stop and explain the exact repair. Do not silently rewrite source-control configuration.

## Phase 2: Refresh and bound the review

Fetch only the official upstream tracking branch:

```bash
git fetch --prune t3code-upstream main
```

Read the ledger cursor as `<cursor>`, then verify it is still in upstream history:

```bash
git merge-base --is-ancestor <cursor> t3code-upstream/main
```

If that check fails, stop. Report that upstream history or the ledger diverged and investigate before choosing a new cursor.

Collect candidates in chronological order and detect patch-equivalent work already present in Pylon:

```bash
git log --reverse --date=short --format='%H%x09%ad%x09%s' <cursor>..t3code-upstream/main
git cherry -v pylon t3code-upstream/main <cursor>
```

Record the exact upstream head used for the report. Never describe a moving branch without its commit SHA.

## Phase 2.5: Re-evaluate deferred work

Deferred work is not decided work. It is a promise to look again, and a
deferral nobody revisits is indistinguishable from having lost it. Run this
phase on every review, including a review that finds no new commits.

Read the `## Deferred register` in `.agents/upstream-review.md`. For each open
entry:

1. Read its `Revisit when` condition and evaluate it against the current
   upstream head, not against memory. The condition names what to check, so
   check it — usually `git log`, `git show --stat`, or a path filter over
   `<deferred sha>..t3code-upstream/main`:

   ```bash
   git log --oneline --since="<deferred on>" t3code-upstream/main -- <paths from the condition>
   ```

2. Classify the entry as **due** (condition met), **not yet** (condition
   unmet, with the specific evidence), or **stale** (the upstream work was
   superseded, reverted, or has drifted so far that the original deferral no
   longer describes it).

3. Re-check the dependency and conflict picture. A deferral that has sat for
   weeks may now conflict with Pylon work that landed since, or may have
   grown follow-up commits that belong with it. Report the current shape, not
   the shape recorded when it was deferred.

Report every open entry in the decision brief, due or not, so nothing decays
silently. A **due** entry is a first-class candidate: give it the same
treatment as a new change set, including a concrete recommendation. A **not
yet** entry gets one line naming the evidence that keeps it waiting. A
**stale** entry should be proposed for outright skip, with the reason, so the
register does not accumulate work nobody intends to do.

Never adopt a deferred entry just because its condition came due. The
condition earns it a fresh review, not automatic approval — the user still
decides.

## Phase 3: Understand the changes

Group commits into coherent change sets before presenting them. A pull request, a dependency chain, or several commits implementing one behavior should normally be one decision.

For every candidate change set:

1. Inspect the complete commit diff and file list with `git show --stat --summary <sha>` and `git show <sha>`.
2. When a title references a pull request, inspect its description and relevant review context with `gh pr view <number> --repo pingdotgg/t3code` when available.
3. Trace dependencies on earlier or later upstream commits. Do not recommend a commit alone when it requires a series.
4. Compare touched paths with Pylon's changes since the fork base. Identify semantic conflicts, not only textual conflicts.
5. Evaluate every applicable client, provider, contract, connection mode, migration, generated file, and document.
6. Classify the change using the decision framework and give a concrete Pylon recommendation.

Do not infer value from a commit title alone. Read the implementation and tests.

## Phase 4: Present a decision brief

Lead with a compact summary:

- upstream head and review range;
- number of commits and coherent change sets;
- patch-equivalent or already-adopted work;
- **deferred entries that are now due**, named up front rather than buried
  after the new candidates — they have already waited once;
- highest-value recommendations;
- areas likely to conflict with Pylon.

Give deferred work its own section, before or after the new change sets but
never merged into them, so the user can tell "this is back again" from "this is
new". Report the register's full state there: due, not yet, and stale.

For each change set, report:

- stable candidate ID, upstream SHA, and pull request;
- what changed in plain language;
- why Pylon would or would not benefit;
- recommendation: **adopt now**, **consider**, **defer**, or **skip**;
- affected surfaces and providers;
- dependency chain;
- conflict risk and expected integration shape: clean cherry-pick, cherry-pick with adaptation, or manual port;
- validation required.

End with an explicit decision request keyed by candidate ID. Do not integrate while the user's selection is ambiguous.

## Phase 5: Lock completed review decisions

After the user decides every candidate through the reported upstream head, prepare one ledger batch and the new `reviewed-through` value. Do not modify the ledger yet when an approved integration still needs a clean branch setup.

Record each change set as adopted, skipped, or deferred with its upstream SHA or PR, rationale, and eventual Pylon branch or commit when known. Deferred work remains visible in the ledger even though the cursor advances.

A deferral is a decision, so it does not block the cursor. What it does require
is an entry in the `## Deferred register` before the batch is considered closed.
Keep the register current in both directions:

- **Add** an entry for every newly deferred change set, keyed `DEF-<n>` so
  register ids never collide with a batch's change-set ids, with a
  `Revisit when` condition that a later session can actually check — name the
  paths, the command, or the observable event. "Revisit later" is not a
  condition, and neither is anything that depends on remembering this
  conversation. Beware a condition that reads as satisfied the day it is
  written: "no commits touching X recently" is also true one minute after
  deferring, so pair a quiet-period check with an explicit earliest-revisit
  date.
- **Move out** an entry as soon as it is adopted or skipped for good: record
  the outcome in that batch's table and delete the register row. The register
  holds open questions only.
- **Carry forward** everything else untouched, including its original
  `Deferred on` date, so the age of a deferral stays visible.

An entry whose condition has come due repeatedly without anyone acting on it is
a signal the answer is really "skip" — say so rather than deferring a fourth
time.

Do not advance the cursor when:

- the user has not decided every candidate;
- the report covered only a filtered subset;
- upstream history validation failed;
- the session ended before decisions were confirmed.

If the user selects no integration, update the ledger as the only intended source change and offer a scoped commit and push. If the user selects work to integrate, create the integration branch first, then update the ledger on that branch after the integration outcome is known.

## Phase 6: Integrate only approved change sets

Before modifying the ledger or source, require a clean worktree, then refresh the private product branch without rewriting history:

```bash
git fetch origin pylon
git switch pylon
git pull --ff-only origin pylon
git switch -c upstream/<yyyy-mm-dd>-<topic>
```

Choose the smallest faithful integration method:

- Use `git cherry-pick -x <sha>` in oldest-first order for coherent commits that fit Pylon.
- Cherry-pick a complete dependency series when the selected behavior depends on it.
- Manually port only the approved behavior when upstream structure, branding, migrations, or product direction conflict. Cite the upstream PR and SHA in the commit body.
- Never resolve conflicts by taking all of `theirs`. Read both sides and preserve Pylon's intent.
- If the integration proves materially broader than the approved change set, stop and return to the user with the new scope.

Use `pylon-branding` for asset or visible-name conflicts and `effect-server` for Effect, orchestration, provider, contract, or persistence changes. Treat migration number collisions, generated route trees, lockfiles, mobile native projects, and compatibility identifiers as explicit reconciliation work.

Run the smallest relevant tests, lint, formatting, typechecks, asset checks, and real-client verification required by `AGENTS.md`. Do not claim upstream tests prove the adapted Pylon behavior.

Show the integrated diff, validation results, and remaining risks. Do not merge into `pylon`, push, or open a pull request unless the user explicitly requests that publishing step.

## Finish with traceability

When the integration outcome becomes known, append the prepared batch to `.agents/upstream-review.md` on the integration branch and advance the cursor to the reviewed upstream head. If integration is abandoned, record the decisions separately without claiming an adopted Pylon commit.

Keep the review ledger and final handoff aligned. Report:

- upstream PRs and SHAs reviewed;
- user decisions;
- Pylon branch and commits created;
- adaptations made for Pylon;
- checks run and unresolved risks;
- the deferred register's state after this review: what was added, what came
  due and what happened to it, what was retired, and what is still waiting
  with its next check.

Closing without mentioning the register is an incomplete handoff, even when
nothing in it changed.
