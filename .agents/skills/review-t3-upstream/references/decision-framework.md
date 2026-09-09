# T3 upstream decisions

Use the smallest integration unit that contains the finished behavior and its dependencies. Optimize review effort by risk; preserve traceability for every source disposition.

## Choose scope and depth

| Change                                                                        | Review and integration                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Already covered or superseded                                                 | Compare final behavior, Pylon callers, and recorded decisions. Group equivalent outcomes; do not port a temporary implementation just to count a commit.                                                                  |
| Routine fixes or cleanup                                                      | Read the combined diff and relevant callers/tests. Group related changes in one subsystem. Check that deleted helpers have no live Pylon callers.                                                                         |
| Provider, lifecycle, protocol, persistence, authentication, or native changes | Trace the complete dependency chain and affected surfaces. Read relevant upstream reasoning and intermediate transitions; verify Pylon-specific behavior explicitly.                                                      |
| Pylon product divergence                                                      | Describe the concrete behavior tradeoff. Adapt within standing approval if preservation is clear; request a decision for a capability loss or unresolved product choice.                                                  |
| Upstream reimplements an existing Pylon feature                               | Neither version wins by default. Present both implementations and their tradeoffs to the maintainer; adopting upstream's and deleting Pylon's is a legitimate outcome. Do not quietly skip the source as already covered. |
| Upstream-only infrastructure, branding, marketing, or product policy          | Usually skip with a scoped reason. Inspect shared runtime dependencies before deciding an entire mixed commit is irrelevant.                                                                                              |

A coherent subsystem batch can contain many commits. Split it when independent behavior, migration/native risk, or a difficult rollback would make the combined change hard to assess. Commit count alone is not the split criterion.

## Pylon boundaries to verify

Choose existing tests and source checks that apply. Extend them only where the changed behavior lacks meaningful coverage.

| Boundary                          | Preserve and verify                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent progress and recovery       | Prime admission and restart rules, provider ownership, Stop/cancel fences, typed receipts, checkpoint/rollback behavior, and visible terminal/error states. A provider-specific fix needs an explicit applicability decision for other adapters. |
| Contracts and persistence         | Pylon migration numbering and prior schema state, version-skew behavior, event/command ordering, and all clients that consume changed fields. Generated provider schemas alone do not prove ingestion or UI support.                             |
| Remote access                     | Local, relay/tunnel, multi-device and multi-environment routing, credential scopes, and single-origin browser behavior. Never use live user state for integration tests.                                                                         |
| Product identity and installation | Pylon app IDs, schemes, profiles, runtime homes, artifacts and visible branding from `AGENTS.md`; preserve compatibility identifiers and installer ownership.                                                                                    |
| UI and performance                | Web/desktop/mobile entry points that apply, reverse actions, bounded payload/list work, and motion that stops when its state or visibility ends. Reuse the final integrated UI evidence across related fixes.                                    |
| Build and dependencies            | Pylon-owned release/signing/hosting decisions; regenerate lockfiles and native/generated files with the pinned tools when their inputs change.                                                                                                   |

Clean application is not semantic compatibility. Avoid broad path-level `ours` rules for shared code; such rules can silently discard later fixes.

## Compact decision record

In the active ledger, use one row per coherent group, with a short paragraph only for a material exception:

| Group / bounded head            | Sources                                         | Outcome and remaining scope                                                                      | Pylon PR / verification           |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------- |
| Behavior and full upstream head | Full source SHAs or exact range plus exclusions | Adopted / partial / covered / superseded / skipped / deferred, with reason and any DEF reference | PR link; focused evidence summary |

A fully enumerated source list can live in the linked PR body rather than being duplicated in a long ledger table. It must remain recoverable from the repository/PR, not only from an agent's temporary files. Distinguish a reviewed classification from an implemented result. Count a source once even when it spans several ports; retain its unresolved scope until classified or explicitly deferred.

Deferred records need the original date, source and remaining behavior, reason, observable trigger (paths/dependency/external event), and an earliest date when timing matters. Watches identify an open effort and its owner, if one exists. A closed-unmerged PR earns a replacement condition or retirement, not a claim that its capability shipped.

## Decision brief

Report the frozen range and Pylon head, useful change groups, applicable standing approval, material exceptions, and the planned verification. Summarize unchanged deferred/watch entries collectively and explain triggered entries. Request a decision only for uncovered scope. Keep workflow evaluation separate from adopting new upstream code or changing the ancestry baseline.
