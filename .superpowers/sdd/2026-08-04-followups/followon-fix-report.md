# Follow-ups authorized follow-on fix report

Date: 2026-08-04

Worktree: `/Users/rynfar/repos/pylon/.claude/worktrees/followups`

Branch: `worktree-followups`

Status: **PASS. All authorized follow-on findings are closed; the accepted automatic-validation
residual remains fail-closed.**

## Delivery

- `aa3d7f04df2f8bcfbab1a5315439be613a7b592b` —
  `fix(followups): close follow-on integrity gaps`
- This report is committed separately as delivery metadata on the same branch.
- No pull request was opened.

## Corrections delivered

### Project and item authority

- New file commands now ownership-check a globally existing follow-up ID before projection upsert.
  Cross-project reuse fails with `invalid-project`; same-project duplicate filing keeps its
  existing `conflict` behavior. The original item's blocker, branch gate, revision, and project
  remain unchanged after a rejected cross-project attempt.
- Public snapshots validate that the requested project exists. Project streams filter out events
  from every other project, and item, source-thread, resolution-thread, and validation-thread
  checks all enforce the same project boundary.
- Repository-path authority now reads every distinct project matching either a project root or a
  live thread worktree. Exactly one owner succeeds; zero or multiple owners fail closed before
  provider lookup or any change-request action. Multiple root/worktree matches for the same
  project correctly collapse to one owner.

### No-gap live configuration

- `subscribeServerConfig` eagerly acquires the settings subscription before loading its snapshot.
  A deterministic `Deferred`/`PubSub` regression publishes inside the former vulnerable interval
  and proves the update follows the snapshot. The test makes the legacy lazy stream die if used,
  so it cannot pass through the old implementation.

### Mode-safe draft ownership

- Start-thread and validation dossiers now use distinct Pylon-owned start/end frames.
- Reusing a draft in either direction replaces the prior complete Pylon-owned frame and preserves
  every byte outside it. Same-mode reuse is idempotent, and incomplete/user-authored marker text is
  treated as unrelated content rather than deleted.

### Truthful web state

- Follow-ups route availability is explicit `pending | available | unavailable`. Connection or
  config bootstrap renders an accessible loading surface; only settled unavailability redirects.
  Any available environment wins over pending or unavailable peers.
- Shell bootstrap ignores ineligible environments, while eligible environments must have a shell
  snapshot.
- Branch gate failures render an accessible static unavailable badge instead of looking clear.
  When `AsyncResult` retains a prior synchronized value, the badge retains that blocker count,
  including zero.
- Toolbar gating is wired through the exact active project and resolved branch. Closed-item primary
  action coverage invokes the rendered Reopen handler directly.

### Inspectable validation and provider copy

- Durable validation evidence renders path, optional line, and full evidence commit. The checked
  commit and full ISO validation timestamp are visible and inspectable even if the validation
  thread is unavailable.
- The remaining post-provider failure paths use provider terminology. A real GitLab-path regression
  proves `merge request` wording and rejects `PR`/`pull request` copy.
- Successful `followup_check_gate` MCP output is asserted in both structured content and its text
  representation.

### Retained documentation

- The design is marked implemented and describes the shipped five-tool MCP surface, explicit
  evidence-backed validation, migrations 37/38, live-disable/restart behavior, tri-state route,
  framed drafts, durable evidence, and the sole project-scoped change-request gate.
- The implementation plan keeps its historical task rationale and RED/GREEN sketches, but an
  authoritative outcome note and corrected retained passages clearly supersede obsolete project
  parameters, direct moot handling, four-tool registration, stale Kanban reference, missing stream
  metadata, PR-only language, old lifecycle copy, and gate-time provider validation.

## TDD evidence

The first focused RED run exercised the new regressions before production changes:

```text
Test Files  8 exercised
Tests       193 total, 26 intentionally failing
```

Failures covered cross-project item ownership, ambiguous repository ownership, public snapshot
validation, project stream/thread isolation, deterministic settings-stream ordering, draft mode
switching, route/bootstrap state, unavailable gate presentation, provider terminology, MCP output,
toolbar/Reopen wiring, and durable evidence rendering.

After implementation, the same focused set passed. The final consolidated command included every
Follow-ups suite plus contracts/settings, server settings/config, MCP, GitManager, toolbar, route
state, presentation, and branch-gate coverage:

```text
Test Files  16 passed (16)
Tests       395 passed (395)
Exit        0
```

One earlier consolidated attempt had 394/395 passing when an unrelated server-router localhost
auth socket closed. That exact test passed immediately in isolation (`1 passed, 123 skipped`), and
the complete 16-file consolidated rerun above passed. Test output otherwise contained only Node's
SQLite experimental warning.

## Typecheck, lint, and formatting

Package-local typechecks used the repository-local binary from each package directory:

- `packages/contracts`: exit 0, no diagnostics.
- `packages/client-runtime`: exit 0; one pre-existing TS377019 suggestion at
  `src/relay/discovery.ts:243`.
- `apps/server`: exit 0; six pre-existing TS377019 suggestions at
  `src/orchestration/decider.ts:458,469,479,550,562,574`.
- `apps/web`: exit 0, no diagnostics.

All changed TypeScript/TSX files passed targeted `vp lint --deny-warnings`. All 21 implementation
and retained-documentation files passed `vp fmt --check`. `git diff --check` and the staged diff
check passed.

## Real-shaped migration boot

The live database was opened read-only and copied with `VACUUM INTO` to the unique ignored home:

```text
.t3/followon-migrations.IQDKo5
```

No server was pointed at live state. Before boot, the isolated snapshot contained 3 projects and 9
threads and had neither migration 37/38 nor Follow-ups schema objects. A server-only process booted
against that copy and logged both `37_FollowUps` and `38_FollowUpValidation` before listening.

Post-shutdown verification proved:

- migration rows `37 / FollowUps` and `38 / FollowUpValidation` exist;
- `follow_up_events` and `follow_ups` exist;
- `follow_ups_project_status_idx` and `follow_ups_gate_idx` exist;
- `follow_ups.last_validation_json` is nullable `TEXT`;
- project/thread counts remain 3/9;
- `PRAGMA integrity_check` returns `ok`.

The initially captured wrapper PID was `28815`. Its foreground tree did not fully stop on the first
interrupt, so shutdown stayed exact: the wrapper received `TERM`, then the known server port owner
`28867` and dev runner `28823` were verified by cwd and stopped directly. No pattern-based process
lookup or kill was used, and port 15590 was closed afterward.

## Residual and skipped work

Automatic provider-run validation at the shipping boundary remains deliberately unimplemented and
documented. The gate has no durable validation-job identity, visible thread, provider/runtime
permission context, cancellation lifecycle, or uniformly read-only provider session. It continues
to treat every unresolved blocker—including uncertain or unvalidated items—as blocking, so the
residual does not weaken shipping enforcement.

Browser/computer-use verification was not run, per the explicit no-browser constraint. No mobile
UI, aggregate view, scheduled validation, automatic context injection, or `in_progress` state was
added.
