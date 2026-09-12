# Pylon

Pylon is an independent coding-agent GUI forked from T3 Code: a Node WebSocket server with web, Electron desktop, and React Native mobile clients.

## Working boundaries

- Work on a task branch from freshly fetched `origin/pylon` in an isolated worktree. The canonical writable remote is `pylon-code/pylon`; inherited `main` is not the product branch. T3 remotes stay fetch-only. Preserve other worktrees and user changes.
- Carry authorized work through implementation, focused verification, fixes, and a PR against `pylon`. Existing authorization covers these steps. Merge requires green checks and developer approval; never push directly to `pylon`. See [contribution details](.agents/references/contributing.md) when committing or landing work.
- Pylon may be running the agent doing this work. Stop only processes whose ownership you verified, preferably PIDs captured at spawn; never kill by name/path pattern.
- `~/.pylon-code/userdata` and `~/.t3/userdata` are live data. Read-only inspection is allowed; never run test servers against them, write to them, or clean them. Use isolated worktree `.t3` or temporary state. Snapshot only from Pylon, never from T3's incompatible migration history.
- Development is single-origin. Do not set `VITE_HTTP_URL` or `VITE_WS_URL`; Vite proxies backend paths. Pairing tokens are one-use secrets. Use [local development](.agents/references/local-development.md) for server launch, fixture snapshots, and human pairing handoffs.
- Browser/computer use needs the user's request or existing explicit approval. Reuse that authorization within the task. EAS quota, device updates, release, and other external actions retain their workflow-specific boundaries.

## Code and product constraints

Commands → pure decider → persisted events → projected read model. Queue-backed reactors own side effects and emit typed receipts; provider adapters own protocol-specific complexity. Keep orchestration pure and clients driven by contracts.

- `apps/server`: server, providers, checkpointing. Use `effect-server` for Effect/orchestration behavior; consult the relevant API sections of `.repos/effect-smol/LLMS.md` for pinned Effect conventions.
- `apps/web`, `apps/desktop`, `apps/mobile`, `apps/marketing`: product surfaces.
- `packages/contracts`: wire schemas and small derived helpers; `packages/client-runtime`: shared client behavior; `packages/shared`: runtime utilities with subpath exports, no barrel.
- `.repos/` contains read-only dependency references. Never edit or import from it; sync the matching reference when upgrading a dependency.
- Preserve inferred types; avoid `any`. Continuous animation runs only for the live transient state and stops for reduced motion, backgrounding, and unfocused screens (`thread-work-log.tsx` is the reference).
- Preserve Pylon branding and independent runtime/profile identity. Compatibility identifiers (`.t3`, `T3CODE_HOME`, `@t3tools/*`, legacy names) require a coordinated migration to rename. For exact identifiers use [product identity](.agents/references/product-identity.md).

For behavior changes, cover the affected entry points, clients, providers, wire consumers, reverse transitions, and local/remote/tunnel modes. Record unsupported behavior explicitly. This is an impact assessment, not a mandatory test matrix for unrelated edits.

## Validation and discovery

Use focused tests (`vp test run <files>`), lint and typechecks for the changed scope. Backend behavior changes need focused regression coverage; wait on receipts and worker drains rather than sleeps. Check the output: a nonexistent `vp run -F` package silently checks nothing; the server package is `t3`. Repository-wide `vp check`, recursive tests and recursive typechecks require a user request; CI owns the full suite.

Use only the skill needed for the work in `.agents/skills/` (shared with Claude through `.claude/skills`): `test-pylon-app` for web/dev pairing, `test-pylon-mobile` for emulator/simulator verification, `ship-pylon-mobile` for physical iPhone delivery, `pylon-branding` for brand assets, and `review-t3-upstream` for T3 comparison/adoption. Upstream continuation uses that skill's continuation reference and owning issue, not a fresh unbounded inventory. Upstream adoption remains opt-in and Pylon-first; duplicated product implementations need a maintainer choice.

Keep user-facing docs in `docs/user/`, architecture/glossary in `docs/internals/`, and runbooks in `docs/operations/`. Keep task status in the owning issue/PR and scratch artifacts outside the worktree. `.agents/durable-facts.jsonl` is append-only; consult contribution details when adding a fact. Load topic docs as needed rather than reading the repository map before every edit.
