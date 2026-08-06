# Agents panel: resume freeze and lost model refinement

Date: 2026-08-06
Status: approved, not yet implemented

Two independent defects in the subagent observability feature adopted from T3 Code
upstream as `dc4dc1f6e` (upstream `a2ca89aa1`, PR #5219). Both were found during the
verification pass on that adoption. Both are fixed locally in Pylon and reported
upstream; neither is fixed upstream at time of writing.

## Fix 1 — a resumed subagent freezes in the Agents panel

Upstream issue: [#5529](https://github.com/pingdotgg/t3code/issues/5529) (open).

### Symptom

When a subagent finishes and is later resumed, its Agents panel row stays under
**Earlier**, frozen at the first run's elapsed time with a completion check. The
token counter keeps climbing, so the row is plainly still receiving events; only the
run state is stuck.

Reproduced locally against `dc4dc1f6e`, independent of the original reporter:

| Run | `task_id`  | `tool_use_id`    | started       | completed     |
| --- | ---------- | ---------------- | ------------- | ------------- |
| 1   | `ab96af7a` | `toolu_01BKRcmB` | 16:19:56.619Z | 16:21:04.125Z |
| 2   | `ab96af7a` | `toolu_01Nnnyix` | 16:43:16.955Z | 16:43:24.875Z |

The row read `1m 07s` — run 1's duration — while the panel total moved from
Σ 47.6k to Σ 49.8k.

### Cause

`packages/client-runtime/src/state/subagentRuntime.ts`, the `task.started` case:

```js
if (agent.activationCount === 0 && !isTerminalSubagentStatus(agent.status)) {
  agent.activationCount = 1;
  agent.startedAt = agent.startedAt ?? at;
  agent.status = "running";
} else if (agent.status === "idle") {
  applyStatus(agent, "running", at);
}
```

A resume arrives as `task.started` on an agent whose status is `completed` —
terminal but not `idle` — so neither branch fires and the row never reopens.

The guard is deliberate. Its comment records the review finding it was added for: a
late, out-of-order `task.started` must not reopen a run that already failed. The
problem is that at this point a genuine resume and a stale duplicate are
indistinguishable — both are a `task.started` on a settled agent — and the resumed
run emits no intermediate `running` status to pick up the slack. Its sequence is
`task.started` → `task.updated` (terminal) → `task.completed`.

### Approach

Discriminate on `toolUseId`. Verified on the wire: it changes across a resume while
`task_id` stays stable, and a late duplicate start necessarily carries the _same_
`toolUseId` as the run it belongs to. That makes it an identity comparison rather
than a timestamp heuristic, and it preserves the original ordering guard exactly.

No adapter or contract change is needed. `ClaudeAdapter.ts` already puts
`tool_use_id` on the `task.started` payload, and `toolUseId` is an optional field on
the task payload schemas in `packages/contracts`.

### Design

Track the activating `toolUseId` in a fold-local `Map<taskId, string>` declared
alongside `agents` in `foldSubagentActivities` — **not** as a field on the agent.
`foldSubagentActivities` returns `roster.map((agent) => ({ ...agent }))`, so the
internal `MutableAgent` and public `RuntimeSubagent` shapes are 1:1 today; adding a
field would either widen the public type for something no UI consumes or leak an
untyped one onto every returned object.

In the `task.started` case, add a third branch: the agent is terminal, the payload
carries a `toolUseId`, and it differs from the one recorded for the current run →
genuine resume → `applyStatus(agent, "running", at)`. Record the `toolUseId`
whenever an activation happens.

`applyStatus` already handles reactivation correctly — it bumps `activationCount`,
clears `result`, `error` and `completedAt`, and resets `startedAt`. This change is
only about letting a real resume reach it.

### Fallback

When `toolUseId` is absent — synthesized rows such as workflow members and Codex
children — behaviour is unchanged and no reactivation happens. This is deliberately
conservative. Those paths reactivate through the existing `idle` branch and explicit
status transitions, which is why the resumable-Codex case already works.

### Tests

In `packages/client-runtime/src/state/subagentRuntime.test.ts`:

1. A resume carrying a new `toolUseId` reactivates the agent: status `running`,
   `activationCount` 2, `completedAt` cleared, `startedAt` reset to the new start.
2. A duplicate `task.started` carrying the _same_ `toolUseId` does **not** reopen a
   terminal agent. This pins the original review finding.
3. A `task.started` with no `toolUseId` on a terminal agent does **not** reopen it.

## Fix 2 — a resume discards the refined subagent model

Not yet filed upstream. Fix 1's findings were posted to #5529; this one gets a
follow-up report once the cause below is confirmed by the fix.

### Symptom

After a resume, the Agents panel shows the session model rather than the model the
subagent actually ran on. Observed as a row flipping from `opus-5` to `fable-5`.

```
16:19:56  task.started    model=claude-fable-5   seeded from session model
16:20:05  task.progress   model=claude-opus-5    refined to authoritative id
16:21:04  task.completed  model=claude-opus-5

16:43:16  task.started    model=claude-fable-5   resume re-seeds, correction lost
16:43:24  task.completed  model=claude-fable-5
```

### Cause

The refinement mechanism itself is sound. `context.taskAgents` holds a per-task
record whose `model` is seeded at `task_started` from the launching tool's input,
falling back to the session model, and then corrected at `ClaudeAdapter.ts:2826`
when the subagent's own assistant snapshot arrives carrying the authoritative API
id. Later `task.*` payloads read the corrected value.

The bug is that `task_started` re-seeds the whole record:

```js
context.taskAgents.set(message.task_id, {
  ...
  runHandles: context.taskAgents.get(message.task_id)?.runHandles,
  model,
```

`runHandles` is explicitly carried across the re-seed. `model` is not, so a resume
overwrites run 1's corrected value with the launch-time seed.

### Design

Preserve the refined model across re-seed, mirroring the `runHandles` precedent
already present in the same object literal. Precedence: explicit launch-input
override → previously refined value → session model. The explicit override must stay
highest so a resume that genuinely changes model is still honoured.

### Tests

A focused adapter test in the existing `ClaudeAdapter` suite: a `task_started` for a
`task_id` whose record already carries a refined model keeps that model, while an
explicit launch-input override still wins.

### Out of scope

An agent that finishes before emitting any assistant snapshot never refines at all,
so a short _first_ run keeps the session-model placeholder. This is inherent to
upstream's placeholder-then-refine strategy. Fixing it means not displaying a model
until it is authoritative, which is a UX decision on that strategy rather than a
defect in it. Reported upstream, not fixed here.

## Delivery

Two branches off `pylon`, kept separate because they touch different layers and
either may be offered upstream independently:

| Branch                                  | Layer                     | Skill           |
| --------------------------------------- | ------------------------- | --------------- |
| `fix/2026-08-06-subagent-resume-freeze` | `packages/client-runtime` | —               |
| `fix/2026-08-06-subagent-model-refine`  | `apps/server`             | `effect-server` |

Both merge into local `pylon` once implemented and verified. Nothing is pushed
without explicit instruction.

Verification is `vp test run` scoped to the touched test files, plus targeted lint
and typecheck for the changed scope. No repo-wide checks. The resume repro is
re-run in a real client to confirm the row reopens and the model holds.

## Divergence note

`packages/client-runtime/src/state/subagentRuntime.ts` and
`apps/server/src/provider/Layers/ClaudeAdapter.ts` are currently byte-identical to
upstream `a2ca89aa1`. These are the first Pylon changes in either file. Both fixes
must be recorded in `.agents/upstream-review.md` so the next upstream sync expects a
conflict there, and so that an upstream fix landing in a different shape can be
reconciled deliberately rather than discovered during a merge.
