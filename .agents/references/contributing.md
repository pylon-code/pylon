# Contribution and records

Read when preparing a commit/PR or updating the durable fact index. Paths below are repository-relative.

## Landing changes

Every change lands the same way, and you do not need to be asked each time. Do
not commit directly to `pylon`, and do not fast-forward a task branch onto it.

1. **Branch from the latest `pylon`.** `git fetch origin pylon`, then branch
   from `origin/pylon` — never from a stale local ref, which may sit well
   behind. Name the branch for the work: `fix/<topic>`, `feat/<topic>`,
   `docs/<topic>`, or `upstream/<yyyy-mm-dd>-<topic>` for adopted upstream work.
2. **Build and verify on the branch**, per `AGENTS.md` validation guidance.
3. **Open a PR against `pylon`.** Push the branch and open it. This workflow is
   the standing ask, so opening one needs no separate request.
4. **Merge once checks are green and the developer approves.** Delete the branch
   afterwards.

`pylon` only ever moves by merging a PR. If you are about to run
`git push origin pylon`, stop — closing that path is the point of this section.

A branch checked out in a worktree is pinned there and cannot advance elsewhere,
so keep `pylon` checked out in the main repository and give worktrees their own
task branches. A worktree left sitting on `pylon` silently holds the branch back
while work lands from elsewhere.

## Pull requests

- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- **Rebase onto the latest `pylon` branch before opening.** Stale branches conflict and burn a review round. Never rebase a Pylon branch directly onto a T3 remote.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- One concern per PR. An upstream dependency chain or closely related changes to one subsystem can be one concern, with a combined diff and verification. Split independent product decisions or unrelated high-risk changes; do not impose a source-commit quota.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active maintainer work in the GitHub issue or project item that owns it. External proposals follow `CONTRIBUTING.md` and belong in Ideas discussions.
- Put durable architecture, constraints, and decisions in `docs/internals/`. Update those docs when the product changes so agents find current facts instead of abandoned intentions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## Durable project facts

`.agents/durable-facts.jsonl` is the append-only fact log for coding agents. It is an index of stable project knowledge, not a replacement for canonical code and documentation.

- Never edit, delete, or reorder an existing line. Append new records at the end of the file.
- Each line is one JSON object with a unique `id`, UTC `recorded_at`, focused `scope`, concise current `fact`, full `source_commits`, repository-relative `source_paths` verified at the current head, and a `supersedes` array.
- Record non-obvious, durable product behavior, architecture, compatibility boundaries, and maintainer constraints. Do not record plans, task status, debugging chronology, guesses, or short-lived implementation details.
- When a fact changes, update its canonical code or documentation and append a complete replacement whose `supersedes` array names the old record IDs. Readers must prefer the replacement; history stays intact.
