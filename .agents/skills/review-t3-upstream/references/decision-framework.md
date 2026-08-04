# T3 upstream decision framework

Use this reference to turn upstream commits into product decisions for Pylon.

## Build coherent change sets

Group commits when they belong to one pull request, require one another, share a migration or contract, or split implementation and tests across commits. Keep independent fixes separate so the user can choose them independently.

Use patch equivalence from `git cherry` as a signal, then inspect the Pylon source before declaring a change already adopted. A manual Pylon implementation can be semantically equivalent without producing the same patch ID.

## Classify candidate value

- **Adopt now**: fixes a real Pylon defect, closes a security or data-loss risk, restores provider compatibility, materially improves performance or remote reliability, or supplies infrastructure required by planned Pylon work.
- **Consider**: valuable product or developer-experience work with manageable tradeoffs, but not urgent or clearly aligned enough to adopt automatically.
- **Defer**: potentially useful, but blocked by timing, a dependency, unresolved product direction, or integration cost. Record the condition that should trigger reconsideration.
- **Skip**: T3-specific branding, hosting, monetization, analytics, marketing, or product direction that conflicts with Pylon; superseded work; irrelevant changes; or complexity without a Pylon need.

Recommendations are judgments, not votes. Explain the evidence and tradeoff behind each one.

## Evaluate Pylon impact

For every change set, check the applicable dimensions:

| Dimension    | Questions                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Product fit  | Does it advance Pylon's direction or merely copy T3? Does it conflict with a Pylon workflow?                                 |
| Branding     | Does it restore T3 logos, names, hosted origins, analytics, or marketing copy? Can behavior be adopted without the branding? |
| Architecture | Does it respect contracts, deciders, projectors, reactors, receipts, and adapter boundaries?                                 |
| Providers    | What happens for Codex, Claude, Cursor, Grok, and OpenCode? Is unsupported behavior explicit?                                |
| Clients      | Does it cover web, desktop, mobile, settings, command palette, and keybindings where applicable?                             |
| Connectivity | Does it work locally, remotely, through relay, and through tunnels?                                                          |
| Persistence  | Are migrations compatible with Pylon's numbering and existing schema? Is rollback or reverse behavior present?               |
| Performance  | Does it change websocket volume, rendering cost, list behavior, background work, or continuous animation?                    |
| Operations   | Does it alter build, release, signing, hosting, secrets, telemetry, or infrastructure assumptions?                           |
| Integration  | Is a clean cherry-pick realistic, or should the behavior be manually ported? Which dependent commits are required?           |

## Inspect known conflict hotspots

- **Brand assets and visible copy**: retain Pylon sources and regenerate Pylon assets. Do not accept upstream generated icons or T3 product strings blindly.
- **Migrations**: Pylon already diverges from upstream. Detect duplicate migration numbers and reconcile ordering, schema assumptions, and tests deliberately.
- **Generated files**: regenerate route trees, generated schemas, native projects, and lockfiles with Pylon's pinned tools after integrating source changes.
- **Provider protocols**: generated protocol support is not the same as server ingestion or UI support. Trace the full path.
- **Contracts and events**: schema changes can affect server, web, desktop, mobile, persistence, and remote compatibility simultaneously.
- **Hosted services**: upstream T3 Connect, `app.t3.codes`, Clerk, telemetry, or release infrastructure may not match Pylon's deployment model.
- **Git metadata**: retain `origin` as Pylon and T3 remotes as fetch-only. Never import upstream branch tracking configuration.

## Decision brief template

Use a compact table followed by details only where needed:

| ID  | Upstream            | Change                  | Recommendation | Pylon impact                       | Integration                          |
| --- | ------------------- | ----------------------- | -------------- | ---------------------------------- | ------------------------------------ |
| A1  | `abc1234` / `#1234` | Plain-language behavior | Adopt now      | Web + server; low product conflict | Cherry-pick with branding adaptation |

Then state:

1. the exact review range and upstream head;
2. patch-equivalent or already-present work;
3. dependency groups;
4. recommended selections;
5. the candidate IDs the user should choose.

Avoid dumping a raw commit list without interpretation.
