# Follow-ups follow-on review correction report

Date: 2026-08-05

Worktree: `/Users/rynfar/repos/pylon/.claude/worktrees/followups`

Branch: `worktree-followups`

Starting commit: `fe96e683cc3d372ce97cec3249f3f1c7be8ac661`

Status: **PASS. All four authorized review findings are closed, and the accepted automatic
provider-validation residual remains fail-closed.**

## Delivery

- `bca41fbe9888eb4189b10c51e3d40248f8a3296c` —
  `fix(followups): close follow-on review gaps`
- This report is committed separately as delivery metadata on the same branch.
- No pull request was opened.

## Corrections delivered

### Provider-accurate change-request failures

- `preparePullRequestThread` resolves provider terminology before the remaining preparation
  failures and carries it through both main-worktree conflict checks and dual-fetch branch
  materialization.
- Materialization errors now carry an optional provider-specific change-request name. Older
  payloads that omit it use provider-neutral `change request` copy rather than assuming GitHub.
- Real GitLab-path regressions require `MR`/`merge request` wording and reject user-facing
  `PR`/`pull request` prose. Compatibility branch identifiers such as `t3code/pr-*` remain intact.

### Collision-validated composer ownership

- Start-thread and validation dossiers use a versioned frame with duplicated mode, UTF-16
  code-unit length, and SHA-256 metadata in the header and footer. The checksum covers the exact
  UTF-16LE version, mode, length, and dossier body.
- The parser searches from the end and replaces only the rightmost frame whose header, footer,
  length, body, and checksum all agree. Switching modes removes contradictory Pylon instructions;
  same-mode reuse is byte-identical.
- Exact valid frame-looking user text before the owned frame, marker text in every interpolated
  field, corrupt/incomplete/legacy frames, NULs, CRLF, tabs, and non-BMP characters are covered.
  User prefix and suffix bytes remain unchanged.
- Recorded resolution note, thread, and commit context are included when present in either dossier
  mode.

### Current-generation eligibility and truthful recovery

- Server-config projections now retain an ephemeral synchronization generation established only
  by a live snapshot. Cached config has no generation, and settings/provider/keybinding deltas
  preserve the projection's existing source and generation rather than promoting stale state.
- Web eligibility compares that projection with each target environment's active connected
  generation. Cached false to live true and cached true to live false therefore remain pending
  until the current snapshot arrives, preventing both incorrect redirect and stale exposure.
- Availability carries a reason. Catalog/config bootstrap, connecting, reconnect backoff, and
  offline recovery stay on the route with truthful status copy; only settled disabled, connection
  error, or empty-environment states redirect. Any available environment still wins.
- The synchronization signal is carried through every web environment-presentation path used by
  the route, sidebar/list, toolbar, and shell bootstrap. Web changes also serve the Electron desktop
  renderer; mobile work was explicitly excluded.

### Precise missing repository owner failure

- A repository path with zero project owners now fails closed with
  `No project owns repository path … in this environment.` Multiple owners retain separate copy.
- A GitManager regression composes the real FollowUpService with in-memory SQLite and proves the
  domain error reaches the sole `GitManager.runPrStep` shipping gate in `GitManagerError.detail`
  and its cause before provider resolution or change-request calls.

## TDD evidence

Focused RED runs were established before production edits:

- Config freshness and route behavior: 3 files exercised, 14 failed and 12 passed. Failures covered
  both cached-value reversals, generation synchronization, bootstrap, reconnect, offline, settled
  disabled, shell, and route presentation.
- Draft framing: 1 file exercised, 12 failed and 13 passed. Failures covered both mode switches,
  exact-frame collision, every dossier field, corruption preservation, byte preservation, and
  idempotency.
- Service/GitManager terminology and owner propagation: 2 files exercised, 4 failed and 91 passed.
- Provider-carried contract copy: the targeted regression failed with 1 failed and 6 skipped.

The focused integrated GREEN run passed 7 files and 163 tests. The final consolidated command was:

```sh
./node_modules/.bin/vp test run \
  packages/contracts/src/followups.test.ts \
  packages/contracts/src/settings.test.ts \
  packages/client-runtime/src/state/followups.test.ts \
  apps/server/src/followups/decider.test.ts \
  apps/server/src/followups/FollowUpService.test.ts \
  apps/server/src/followups/gate.test.ts \
  apps/server/src/mcp/toolkits/followups/tools.test.ts \
  apps/server/src/mcp/McpHttpServer.test.ts \
  apps/server/src/serverSettings.test.ts \
  apps/server/src/server.test.ts \
  apps/server/src/git/GitManager.test.ts \
  apps/web/src/components/BranchToolbar.logic.test.ts \
  apps/web/src/components/followups/followUps.logic.test.ts \
  apps/web/src/components/followups/FollowUpPresentation.test.tsx \
  apps/web/src/components/followups/FollowUpBranchGateStatus.test.tsx \
  apps/web/src/state/followups.test.ts \
  packages/contracts/src/git.test.ts \
  packages/client-runtime/src/state/server.test.ts \
  apps/web/src/routes/followUpsRoute.logic.test.ts
```

Final result:

```text
Test Files  19 passed (19)
Tests       440 passed (440)
Exit        0
```

Output contained only Node's SQLite experimental warnings.

## Typecheck, lint, formatting, and diff checks

Package-local typechecks used `../../node_modules/.bin/vp run typecheck` from each touched package:

- `packages/contracts`: exit 0, no diagnostics.
- `packages/client-runtime`: exit 0; the pre-existing TS377019 suggestion remains at
  `src/relay/discovery.ts:243`.
- `apps/server`: exit 0; the six pre-existing TS377019 suggestions remain at
  `src/orchestration/decider.ts:458,469,479,550,562,574`.
- `apps/web`: exit 0, no diagnostics.

All changed TypeScript/TSX files passed targeted lint with
`--report-unused-disable-directives --deny-warnings`. The explicit changed-file formatting check
passed, as did `git diff --check` and `git diff --cached --check`. The commit hook also formatted all
22 staged implementation files successfully.

Branch and remote verification confirmed `worktree-followups`, writable `origin` at
`rynfar/pylon`, and disabled push URLs for both T3 reference remotes.

## Persistence, surfaces, and skipped work

Persistence and migration files were unchanged, so the brief-directed real migration boot was not
rerun. The retained 16-file suite was expanded with contract, client-runtime config, and route
logic coverage for every newly touched behavior.

The web route, environment presentations, composer actions, shell bootstrap, and GitManager server
boundary were updated. The desktop renderer inherits the web behavior. Contracts were extended
backward-compatibly for typed materialization errors. Local, remote, reconnect, and offline states
use per-environment generation checks; no client-global feature flag was added. Retained design,
plan, and internals documentation now describe the implemented behavior.

Browser/computer-use verification was not run, as explicitly required. No mobile UI, scheduled
validation, automatic context injection, migration, deployment, push, or pull request was added.

Automatic provider-run validation at the shipping boundary remains deliberately unimplemented and
documented. The sole gate stays in `GitManager.runPrStep` and continues to block every unresolved
blocker, including uncertain or unvalidated items, so the accepted residual does not weaken
shipping enforcement.
