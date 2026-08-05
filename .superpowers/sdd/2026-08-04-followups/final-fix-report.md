# Follow-ups final fix report

Date: 2026-08-04

Worktree: `/Users/rynfar/repos/pylon/.claude/worktrees/followups`

Branch: `worktree-followups`

Status: **PASS with one documented architectural residual; shipping remains fail-closed.**

## Fixes delivered

### Authoritative project scope and trusted provenance

- Follow-up snapshots, streams, reads, mutations, blocker queries, and shipping gates are now
  project-scoped. Item ownership, idempotency replay, and resolution-thread ownership are checked
  against that project.
- Shipping derives the authoritative project from the persisted repository/worktree projection
  before querying `(projectId, branch)`. Focused regressions cover two projects using the same Git
  ref without cross-project collisions.
- MCP list, file, gate-check, validation, and resolution handlers derive project authority from the
  invocation thread. They no longer accept an opaque project identifier for those operations.
- Public WebSocket inputs no longer accept caller-controlled `sourceKind` or `actor`. The trusted
  WebSocket boundary injects human provenance, while MCP injects agent provenance and the current
  thread. Internal domain commands retain the authority fields needed by the decider.
- Public status updates carry `projectId`; cross-project item mutations and resolution threads are
  rejected.

### Per-environment beta behavior

- Web availability is computed per connected target environment. Route/sidebar visibility uses any
  eligible environment, and the project picker excludes projects whose environment is disconnected
  or has Follow-ups disabled.
- Follow-up shell bootstrap is limited to eligible environments, preventing hidden or disabled
  environments from being subscribed globally.
- WebSocket reads, mutations, and subscriptions and MCP handlers share the server-side live feature
  guard. Disabling Follow-ups terminates an already-open subscription as well as rejecting new work.
  The stream implementation subscribes to settings changes before the initial flag read, so there
  is no enable/disable observation gap.
- MCP tool registration still requires restart when enabling, as documented; a live disable takes
  effect immediately.

### Evidence-backed stale-blocker validation

- Added persisted validation outcomes `still-needed`, `moot`, and `uncertain`, with verification
  check, evidence, validator thread/project, revision, and timestamp recorded through the new
  `follow-up.validated` event and migration 38.
- Added the `followup_record_validation` MCP tool. The server stamps trusted thread/project/time
  authority and rejects stale revisions, changed verification checks, wrong projects, and wrong
  threads.
- `still-needed` and `uncertain` keep the item open and advance its revision. `moot` requires
  concrete evidence and atomically closes the item with a resolution. Directly setting `moot` is
  rejected, so there is no waiver-shaped bypass.
- The visible **Validate** action opens or reuses a normal draft in the correct project and seeds a
  read-only, fail-closed dossier prompt with the exact outcomes and recorder instruction.

### Required UI lifecycle and recovery

- Added a compact branch-toolbar blocker count scoped to the selected project/environment.
- Added dossier-seeded **Start thread**, visible **Validate**, closed-item **Reopen**, resolution
  note/thread/commit presentation, and last-validation presentation. No `in_progress` state or
  automatic context injection was added.
- Draft seeding now targets the exact reused or newly created project draft via an explicit
  `onDraftReady` callback. It preserves occupied draft text rather than writing to whichever draft
  happens to be active.
- The Follow-ups page recovers when its selected project disappears and when the first project is
  added after the page initially loaded empty.

### Gate invariants, provider copy, and documentation

- The domain enforces `gate !== null` exactly when `kind === "blocker"` in both directions.
- Blocker enforcement remains the single shipping call and runs before provider resolution with
  provider-neutral “change request” language. Provider-specific PR/MR language is used after
  resolution, with GitLab failure coverage.
- Updated the user guide and internals for validation, lifecycle actions, resolution metadata,
  branch status, project authority, live disable behavior, and the automatic-validation residual.
  Removed the unsupported claim that ideas can be archived. Updated MCP guidance in `AGENTS.md`.

## Focused verification

Final consolidated suite:

```text
./node_modules/.bin/vp test run packages/contracts/src/followups.test.ts packages/contracts/src/settings.test.ts packages/client-runtime/src/state/followups.test.ts apps/server/src/followups/decider.test.ts apps/server/src/followups/FollowUpService.test.ts apps/server/src/followups/gate.test.ts apps/server/src/mcp/toolkits/followups/tools.test.ts apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/serverSettings.test.ts apps/server/src/server.test.ts apps/server/src/git/GitManager.test.ts apps/web/src/components/followups/followUps.logic.test.ts apps/web/src/components/followups/FollowUpPresentation.test.tsx apps/web/src/components/followups/FollowUpBranchGateStatus.test.tsx apps/web/src/state/followups.test.ts
```

Result: **15 files passed, 311 tests passed**, exit 0. The only output outside the test results was
Node's SQLite experimental warning.

Additional focused rechecks during final audit:

- `apps/server/src/server.test.ts -t "follow-up WebSocket|existing follow-up subscription"`:
  **3 passed, 120 skipped**. This includes the no-sleep `Deferred`/`PubSub` regression proving an
  existing client stream fails forbidden immediately after live disable.
- `apps/server/src/git/GitManager.test.ts` focused gate/provider cases: **6 passed, 69 skipped**.
- `apps/server/src/followups/decider.test.ts`: **15 passed**.

Touched-package typechecks were run from each package directory using the repository-local `vp`:

- `packages/contracts`: exit 0, no diagnostics.
- `packages/client-runtime`: exit 0; one pre-existing TS377019 suggestion at
  `src/relay/discovery.ts:243`.
- `apps/server`: exit 0; six pre-existing TS377019 suggestions at
  `src/orchestration/decider.ts:458,469,479,550,562,574`.
- `apps/web`: exit 0, no diagnostics.

Targeted `vp lint --deny-warnings` checks for all changed TypeScript/TSX files passed, including a
fresh check of the live-disable stream changes. `git diff --check` passed. No browser, computer-use,
dev server, or repository-wide check was used.

## Independent audit closure

- UI audit findings for wrong-draft prompt seeding and global disabled-environment bootstrap were
  fixed and rechecked.
- Final diff audit found one blocker: an already-open WebSocket subscription could outlive a live
  feature disable. The stream guard and focused regression above close that gap. The audit found no
  other blocker in authority, provenance, validation, UI lifecycle, or shipping-gate behavior.

## Residual finding: automatic validation at the shipping boundary

Automatic gate-time agent validation was not added because the current mechanical boundary cannot
run it safely within this change's scope:

- `GitManager.runPrStep` has shipping context (`cwd`, branch, text-generation settings, progress),
  but no durable validation job identity, invoking thread, provider/runtime permission mode,
  validator cancellation lifecycle, or receipt/checkpoint contract.
- The existing text-generation adapters are not a safe read-only validator boundary. In particular,
  `ClaudeTextGeneration.ts` invokes the CLI with `--dangerously-skip-permissions`.
- In stacked commit/push/change-request actions, commit and push can already have occurred before
  `runPrStep`; inventing a provider orchestration path there would neither be uniformly read-only
  nor provide the durable semantics required by the server architecture.

The safe on-demand validator flow is implemented and persisted, but the shipping gate deliberately
continues to treat every open blocker—including `uncertain` and unvalidated items—as blocking. A
future automatic validator needs a dedicated durable, cancellable, read-only validation job bound
to authoritative project/thread/provider context. This residual does not weaken the gate.

## Commits and delivery

- `343a24d93 fix(followups): enforce authoritative lifecycle`
- This report is committed separately as delivery metadata on the same branch.
- No pull request was opened.
