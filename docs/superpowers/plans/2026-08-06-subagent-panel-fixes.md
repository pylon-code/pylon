# Agents Panel Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a resumed subagent reopen its Agents panel row, and stop a resume from discarding the subagent's authoritative model.

**Architecture:** Two independent fixes in two layers. Fix 1 is a pure change to the client-side fold that derives subagent state from persisted activities — it adds a fold-local map recording which `toolUseId` opened each agent's current run, and uses it to tell a genuine resume from a late duplicate start. Fix 2 is a change to the Claude provider adapter so the per-task record preserves an already-refined model when `task_started` re-enters for the same `task_id`.

**Tech Stack:** TypeScript, Effect (`apps/server`), vite-plus test runner, pnpm via `vp`.

## Global Constraints

- Base all branches on `pylon`. Never rebase onto a T3 remote.
- Never push. Nothing leaves the machine without explicit instruction.
- Do not run repo-wide checks. No `vp check`, no `vp run -r test`, no `vp run -r typecheck`. Scope every command to the touched files.
- Read verification output; do not trust exit codes alone. A filter matching no package exits 0 having checked nothing.
- Both files touched here are currently byte-identical to upstream `a2ca89aa1`. Every change must be recorded in `.agents/upstream-review.md`.
- Conventional commit titles, plain language. No AI attribution lines in commit messages.
- Spec: `docs/superpowers/specs/2026-08-06-subagent-panel-fixes-design.md`

---

## File Structure

| File                                                        | Responsibility                                              | Change                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/client-runtime/src/state/subagentRuntime.ts`      | Folds persisted thread activities into subagent panel state | Modify `foldSubagentActivities`: add fold-local activation map, add third branch in `task.started` |
| `packages/client-runtime/src/state/subagentRuntime.test.ts` | Fold behaviour tests                                        | Add 3 tests                                                                                        |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`          | Translates Claude SDK messages into runtime events          | Modify `task_started`: preserve refined model across re-seed                                       |
| `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`     | Adapter emission tests                                      | Add 1 test                                                                                         |
| `.agents/upstream-review.md`                                | Durable upstream review ledger                              | Add divergence entries                                                                             |

---

## Task 1: Reopen a resumed subagent row

**Branch:** `fix/2026-08-06-subagent-resume-freeze` off `pylon`

**Files:**

- Modify: `packages/client-runtime/src/state/subagentRuntime.ts` (declaration near `const agents = new Map<string, MutableAgent>();`, and the `case "task.started":` block)
- Test: `packages/client-runtime/src/state/subagentRuntime.test.ts`

**Interfaces:**

- Consumes: `foldSubagentActivities(activities, options?)`, `applyStatus(agent, status, at)`, `isTerminalSubagentStatus(status)`, `asString(value)`, `isBackgroundTaskActivity(payload)` — all already present in the file.
- Produces: no signature changes. `foldSubagentActivities` keeps returning `ReadonlyArray<RuntimeSubagent>` with the same fields. The activation map is module-private to the function body.

- [ ] **Step 1: Create the branch**

```bash
git checkout pylon
git checkout -b fix/2026-08-06-subagent-resume-freeze
```

- [ ] **Step 2: Write the three failing tests**

Add to `packages/client-runtime/src/state/subagentRuntime.test.ts`, inside the existing `describe("terminal robustness", ...)` block, after the test named `"a late start after a terminal task.updated does not reopen the run"`:

```ts
it("a resume carrying a new toolUseId reopens the run", () => {
  const agents = fold([
    activity("task.started", {
      taskId: "resume-1",
      taskType: "local_agent",
      toolUseId: "toolu_run_one",
      title: "Analyze math.js",
    }),
    activity("task.completed", { taskId: "resume-1", status: "completed", summary: "run 1" }),
    activity("task.started", {
      taskId: "resume-1",
      taskType: "local_agent",
      toolUseId: "toolu_run_two",
      title: "Analyze math.js",
    }),
  ]);
  expect(agents).toHaveLength(1);
  const agent = agents[0]!;
  expect(agent.status).toBe("running");
  expect(agent.activationCount).toBe(2);
  expect(agent.completedAt).toBeNull();
  expect(agent.result).toBeNull();
});

it("a duplicate start repeating the current toolUseId does not reopen the run", () => {
  const agents = fold([
    activity("task.started", {
      taskId: "dup-1",
      taskType: "local_agent",
      toolUseId: "toolu_only_run",
    }),
    activity("task.updated", { taskId: "dup-1", status: "failed" }),
    activity("task.started", {
      taskId: "dup-1",
      taskType: "local_agent",
      toolUseId: "toolu_only_run",
    }),
  ]);
  expect(agents).toHaveLength(1);
  expect(agents[0]!.status).toBe("failed");
  expect(agents[0]!.activationCount).toBe(1);
});

it("a start with no toolUseId never reopens a terminal run", () => {
  const agents = fold([
    activity("task.started", { taskId: "noid-1", taskType: "local_agent" }),
    activity("task.completed", { taskId: "noid-1", status: "completed", summary: "done" }),
    activity("task.started", { taskId: "noid-1", taskType: "local_agent", title: "Late" }),
  ]);
  expect(agents).toHaveLength(1);
  expect(agents[0]!.status).toBe("completed");
  expect(agents[0]!.activationCount).toBe(1);
});
```

- [ ] **Step 3: Run the tests to verify the first one fails**

```bash
vp test run packages/client-runtime/src/state/subagentRuntime.test.ts
```

Expected: `"a resume carrying a new toolUseId reopens the run"` FAILS — `status` is `"completed"`, not `"running"`, and `activationCount` is `1`, not `2`. The other two tests PASS already; they are regression pins for behaviour that must not change.

- [ ] **Step 4: Declare the fold-local activation map**

In `foldSubagentActivities`, immediately after `const agents = new Map<string, MutableAgent>();`:

```ts
// The tool_use_id that opened each agent's current run. A resume is a new
// Agent tool call so it carries a new one; a late/out-of-order duplicate
// start repeats the id of the run it belongs to. Fold-local because
// MutableAgent and the public RuntimeSubagent are 1:1 (the fold returns
// `{ ...agent }`), and no consumer reads this.
const activationToolUseIds = new Map<string, string>();
```

- [ ] **Step 5: Add the resume branch**

In `case "task.started":`, replace the activation block. Before:

```ts
if (agent.activationCount === 0 && !isTerminalSubagentStatus(agent.status)) {
  agent.activationCount = 1;
  agent.startedAt = agent.startedAt ?? at;
  agent.status = "running";
} else if (agent.status === "idle") {
  applyStatus(agent, "running", at);
}
```

After:

```ts
const toolUseId = asString(payload.toolUseId);
if (agent.activationCount === 0 && !isTerminalSubagentStatus(agent.status)) {
  agent.activationCount = 1;
  agent.startedAt = agent.startedAt ?? at;
  agent.status = "running";
  if (toolUseId) activationToolUseIds.set(taskId, toolUseId);
} else if (agent.status === "idle") {
  applyStatus(agent, "running", at);
  if (toolUseId) activationToolUseIds.set(taskId, toolUseId);
} else if (
  isTerminalSubagentStatus(agent.status) &&
  toolUseId &&
  toolUseId !== activationToolUseIds.get(taskId)
) {
  // A genuine resume: same task_id, new tool_use_id. A late duplicate
  // start repeats the current run's id and so fails this check, which
  // keeps the ordering guard above intact (a late start must not
  // reopen a failed child). Upstream t3code#5529.
  applyStatus(agent, "running", at);
  activationToolUseIds.set(taskId, toolUseId);
}
```

- [ ] **Step 6: Run the tests to verify all pass**

```bash
vp test run packages/client-runtime/src/state/subagentRuntime.test.ts
```

Expected: PASS, including every pre-existing test in the file. If any pre-existing test now fails, stop — the guard has been widened too far.

- [ ] **Step 7: Typecheck and lint the touched scope**

```bash
vp run -F @t3tools/client-runtime typecheck
vp lint packages/client-runtime/src/state/subagentRuntime.ts packages/client-runtime/src/state/subagentRuntime.test.ts
```

Expected: both clean. Read the output — confirm the typecheck filter actually matched the package and did work rather than exiting 0 having checked nothing.

Lint is invoked on paths, not through a package filter: neither `@t3tools/client-runtime` nor `t3` defines a `lint` script, so `vp run -F <pkg> lint` matches the package, finds no script, and does nothing. `lint` exists only as a root script, and running it bare is a repo-wide check.

- [ ] **Step 8: Commit**

```bash
git add packages/client-runtime/src/state/subagentRuntime.ts packages/client-runtime/src/state/subagentRuntime.test.ts
git commit -m "fix(web): resumed subagents reopen their Agents panel row"
```

---

## Task 2: Preserve the refined model across a resume

**Branch:** `fix/2026-08-06-subagent-model-refine` off `pylon`

**REQUIRED SKILL:** Use the `effect-server` skill before editing `apps/server`.

**Files:**

- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts` (the `case "task_started":` block — the `const model =` binding and the `context.taskAgents.set(...)` call)
- Test: `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`

**Interfaces:**

- Consumes: `context.taskAgents: Map<string, TaskAgentLink>` where the record carries `model: string | undefined` and `runHandles: TaskRunHandles | undefined`; `trimmedString(value)`; `launchingTool?.input`.
- Produces: no signature changes. The emitted `task.started` payload keeps the same shape; only the value of its optional `model` field changes on a resume.

- [ ] **Step 1: Create the branch**

```bash
git checkout pylon
git checkout -b fix/2026-08-06-subagent-model-refine
```

- [ ] **Step 2: Write the failing test**

Add to `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`, immediately after the existing test `"task.started carries model/effort; subagent snapshots refine the model"`:

```ts
it.effect("a resumed task keeps the refined model across the re-seed", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;

    const taskEventsFiber = yield* adapter.streamEvents.pipe(
      Stream.filter((event) => event.type === "task.started"),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );

    const session = yield* adapter.startSession({
      threadId: THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      runtimeMode: "full-access",
    });
    yield* adapter.sendTurn({
      threadId: session.threadId,
      input: "spawn an agent",
      attachments: [],
    });

    harness.query.emit({
      type: "system",
      subtype: "task_started",
      task_id: "task-resume",
      description: "Agent R",
      task_type: "local_agent",
      tool_use_id: "toolu_run_one",
      uuid: "task-resume-uuid-1",
      session_id: "sdk-session",
    } as unknown as SDKMessage);
    // The subagent's own assistant snapshot refines the seeded model.
    harness.query.emit({
      type: "assistant",
      parent_tool_use_id: "toolu_run_one",
      message: { model: "claude-sonnet-5[1m]", content: [] },
      uuid: "task-resume-snapshot-uuid",
      session_id: "sdk-session",
    } as unknown as SDKMessage);
    // A resume is a new Agent tool call: same task_id, new tool_use_id.
    harness.query.emit({
      type: "system",
      subtype: "task_started",
      task_id: "task-resume",
      description: "Agent R",
      task_type: "local_agent",
      tool_use_id: "toolu_run_two",
      uuid: "task-resume-uuid-2",
      session_id: "sdk-session",
    } as unknown as SDKMessage);

    const taskEvents = Array.from(yield* Fiber.join(taskEventsFiber));
    const first = taskEvents[0];
    assert.equal(first?.type, "task.started");
    if (first?.type === "task.started") {
      assert.equal(first.payload.model, "claude-opus-4-6");
    }
    const resumed = taskEvents[1];
    assert.equal(resumed?.type, "task.started");
    if (resumed?.type === "task.started") {
      assert.equal(resumed.payload.model, "claude-sonnet-5[1m]");
    }
  }).pipe(
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
vp test run apps/server/src/provider/Layers/ClaudeAdapter.test.ts
```

Expected: FAIL on the second assertion — `resumed.payload.model` is `"claude-opus-4-6"` (the session seed) instead of `"claude-sonnet-5[1m]"`.

If instead the whole file errors with `UnsupportedNodeSqliteVersionError`, that is the known pre-existing toolchain breakage recorded in `.agents/upstream-review.md` (repo requires Node `^24.13.1`). Do not work around it and do not claim a pass — report it and stop.

- [ ] **Step 4: Preserve the refined model**

In `case "task_started":`, replace the `model` binding. Before:

```ts
const launchInput = launchingTool?.input;
const model =
  trimmedString(launchInput?.model) ?? trimmedString(context.session.model ?? undefined);
```

After:

```ts
const launchInput = launchingTool?.input;
// A resume re-enters this path for the same task_id and rebuilds the
// record, so a model already refined from the subagent's own
// assistant snapshot has to survive it — the same reason runHandles
// is carried across below. An explicit launch override still wins, so
// a resume that genuinely changes model is honoured.
const previousAgent = context.taskAgents.get(message.task_id);
const model =
  trimmedString(launchInput?.model) ??
  trimmedString(previousAgent?.model) ??
  trimmedString(context.session.model ?? undefined);
```

- [ ] **Step 5: Reuse the lookup in the re-seed**

In the same block, in the `context.taskAgents.set(message.task_id, { ... })` call, replace:

```ts
          runHandles: context.taskAgents.get(message.task_id)?.runHandles,
```

with:

```ts
          runHandles: previousAgent?.runHandles,
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
vp test run apps/server/src/provider/Layers/ClaudeAdapter.test.ts
```

Expected: PASS, including the pre-existing `"task.started carries model/effort; subagent snapshots refine the model"` test, which pins that a first run still reports the session model at start and the refined model on later rows.

- [ ] **Step 7: Typecheck and lint the touched scope**

```bash
vp run -F t3 typecheck
vp lint apps/server/src/provider/Layers/ClaudeAdapter.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts
```

Expected: both clean. The server package is named `t3`, not `@t3tools/server` — a `-F @t3tools/server` filter matches nothing and exits 0 having checked nothing. Read the output and confirm work was actually done.

As in Task 1, lint takes paths rather than a package filter: `t3` defines no `lint` script.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/provider/Layers/ClaudeAdapter.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts
git commit -m "fix(server): a resumed subagent keeps its refined model"
```

---

## Task 3: Record the divergence and merge into `pylon`

**Files:**

- Modify: `.agents/upstream-review.md`

**Interfaces:**

- Consumes: both branches from Tasks 1 and 2, each committed and green.
- Produces: `pylon` containing both fixes; a ledger entry the next upstream sync will read.

- [ ] **Step 1: Confirm both branches are green and based on `pylon`**

```bash
git log --oneline pylon..fix/2026-08-06-subagent-resume-freeze
git log --oneline pylon..fix/2026-08-06-subagent-model-refine
git rev-list --left-right --count pylon...fix/2026-08-06-subagent-resume-freeze
git rev-list --left-right --count pylon...fix/2026-08-06-subagent-model-refine
```

Expected: one commit ahead on each, zero behind. If either shows commits behind, rebase it onto `pylon` before continuing.

- [ ] **Step 2: Merge both into `pylon`**

```bash
git checkout pylon
git merge --no-ff fix/2026-08-06-subagent-resume-freeze -m "merge: resumed subagents reopen their Agents panel row"
git merge --no-ff fix/2026-08-06-subagent-model-refine -m "merge: a resumed subagent keeps its refined model"
```

- [ ] **Step 3: Add the divergence entries to the ledger**

Append to `.agents/upstream-review.md`, under a new heading:

```markdown
## 2026-08-06 — Pylon-local fixes on top of `#5219`

First Pylon changes in two files that were byte-identical to upstream
`a2ca89aa1`. Expect conflicts in both on the next upstream sync, and check
whether upstream has landed its own fix in a different shape before
resolving.

| File                                                   | Change                                                                                                                                                                                | Upstream status                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/client-runtime/src/state/subagentRuntime.ts` | `task.started` gains a third branch: a terminal agent reopens when the payload's `toolUseId` differs from the one that opened the current run. Fold-local `activationToolUseIds` map. | Reported on [#5529](https://github.com/pingdotgg/t3code/issues/5529) with the wire evidence; open, unfixed. |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`     | `task_started` preserves an already-refined `model` when re-seeding `taskAgents` for the same `task_id`, mirroring the existing `runHandles` carry-across.                            | Not yet filed.                                                                                              |

Known remaining gap, not fixed: a subagent that settles before emitting any
assistant snapshot never refines its model, so a short first run keeps the
session-model placeholder. That is a UX decision on upstream's
placeholder-then-refine strategy, not a defect in it.
```

- [ ] **Step 4: Commit the ledger**

```bash
git add .agents/upstream-review.md
git commit -m "docs: record the Pylon-local Agents panel fixes in the upstream ledger"
```

- [ ] **Step 5: Verify the final state**

```bash
git log --oneline -5 pylon
git status --short
```

Expected: both merges and the ledger commit on `pylon`, clean working tree. Do not push.

---

## Manual Verification

After Task 3, confirm the fixes in a real client rather than trusting the unit tests alone. The dev environment from the verification pass can be reused if still running; otherwise follow `test-pylon-app`.

- [ ] Spawn a subagent in a thread, let it settle, then ask the thread agent to resume that same subagent.
- [ ] Confirm the row moves out of **Earlier** back into **Direct spawns**, that its elapsed timer restarts rather than staying frozen at the first run's duration, and that it settles again afterwards.
- [ ] Confirm the row's model label does not flip to the session model across the resume.
- [ ] Confirm a normal single-run subagent still behaves exactly as before — one activation, settles into Earlier.
