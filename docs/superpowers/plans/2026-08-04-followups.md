# Follow-ups Implementation Plan

> **Implemented outcome (authoritative):** This file preserves the original task-by-task plan and
> its historical RED/GREEN snippets. Unchecked boxes, proposed code, exact test counts, and old
> commit commands below are not current instructions. The shipped source, focused tests,
> [`docs/user/follow-ups.md`](../../user/follow-ups.md), and
> [`docs/internals/followups.md`](../../internals/followups.md) are authoritative.
>
> The implementation uses migrations 37 and 38 and the compatibility-tagged
> `"t3/followups/FollowUpService"`; its subscription RPC is declared with `stream: true`. The MCP
> surface has five tools. All derive project authority from the invocation thread, accept no
> caller-selected project, and enforce the live beta guard. `followup_resolve` only resolves;
> evidence-backed moot outcomes go through `followup_record_validation`. Tool discovery is fixed at
> environment startup, so enabling requires a restart, while disabling immediately hides the UI,
> rejects handlers, ends streams, and disables the gate.
>
> The shipped web lifecycle includes **Start thread**, **Validate**, **Reopen**, resolution and
> validation evidence, tri-state route bootstrap, and an accessible unavailable gate status.
> Start/Validate draft prompts use distinct framed Pylon-owned sentinels and preserve unrelated
> draft bytes. The sole shipping gate is `GitManager.runPrStep`; it uses the resolved branch and an
> unambiguous persisted repository owner, runs before provider resolution or change-request lookup,
> and fails closed. It never launches automatic provider validation. That accepted residual is
> deliberate: validation is an explicit visible thread flow until a durable, cancellable,
> read-only provider-job boundary exists.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Pylon a project-scoped, durable list of follow-ups and ideas that both the developer and agents can file, that agents can pick up and adversarially re-validate, and that mechanically blocks shipping when a blocker is unresolved.

**Architecture:** A self-contained bounded context — its own contracts, pure decider, Effect service, SQLite projection, and RPC surface — plus a provider-neutral MCP toolkit. One deliberately minimal hook in change-request creation enforces the shipping gate. Everything ships behind a beta flag, default off.

**Read the design spec first:** `docs/superpowers/specs/2026-08-04-followups-design.md`. It carries the rationale (why not threads, why not memory, what killed the Kanban board) that this plan assumes.

**Tech Stack:** Effect + Effect/Schema (contracts, server), `effect/unstable/ai` `Tool`/`Toolkit` (MCP), SQLite via `effect/unstable/sql`, React + TanStack Router (web), vitest.

## Global Constraints

- **Work from the worktree** `/Users/rynfar/repos/pylon/.claude/worktrees/followups` on branch `worktree-followups`. Verify with `git rev-parse --abbrev-ref HEAD` before your first edit. Never `cd` to `/Users/rynfar/repos/pylon`.
- **Run tests through the repo-local binary**: `./node_modules/.bin/vp test run <files>` from the repo root, or `npx vitest run <path>` from inside a package directory. A global `vp` brings its own dependency tree and every `describe()` dies with `TypeError: Cannot read properties of undefined (reading 'config')`, which reads like a broken test rather than a broken toolchain.
- **Never run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck`. Typecheck per package with `vp run typecheck` from inside that package directory. CI owns the full suite.
- **Server work**: invoke the `effect-server` skill before editing anything under `apps/server`. It owns this repo's Effect and event-sourcing conventions.
- **Migration ids 37 and 38.** Id 36 is permanently retired (see the comment in `apps/server/src/persistence/Migrations.ts`) — never reuse it.
- Conventional commit titles, **no AI attribution lines**.
- `deferReason` is a closed set: `out-of-scope | needs-decision | blocked-externally | idea`. Never add a free-text escape.
- Agents may resolve addressed work. An agent records `moot` only through evidence-backed validation.
  **Agents may never set `waived`** — only a human may waive. If an agent could waive, the gate defeats itself.
- The beta flag gates UI surfaces, live MCP/WS handlers and streams, and gate enforcement. MCP
  discovery is fixed at startup, so enabling requires a restart; disabling is immediate.

---

## File Structure

**Create:**

- `packages/contracts/src/followups.ts` — schemas, ids, inputs, errors
- `apps/server/src/persistence/Migrations/037_FollowUps.ts` — tables
- `apps/server/src/followups/decider.ts` + `.test.ts` — pure command → event/rejection
- `apps/server/src/followups/FollowUpService.ts` + `.test.ts` — persistence, serialization, stream
- `apps/server/src/mcp/toolkits/followups/tools.ts` + `handlers.ts` (+ tests) — agent tool surface
- `packages/client-runtime/src/state/followups.ts` — stream reduction + commands
- `apps/web/src/state/followups.ts` — atom composition
- `apps/web/src/components/followups/FollowUpList.tsx`, `FollowUpDialog.tsx`, `followUps.logic.ts` (+ test)
- `apps/web/src/routes/_chat.followups.tsx` — route
- `docs/user/follow-ups.md`, `docs/internals/followups.md`

**Modify (registration points):** `packages/contracts/src/index.ts`, `packages/contracts/src/rpc.ts`, `apps/server/src/persistence/Migrations.ts`, `apps/server/src/server.ts`, `apps/server/src/ws.ts`, `apps/server/src/auth/RpcAuthorization.ts`, `apps/server/src/mcp/McpHttpServer.ts`, `apps/web/src/components/settings/BetaSettingsPanel.tsx`, `apps/web/src/components/sidebar/SidebarChrome.tsx`, `AGENTS.md`.

---

## Task 1: Contracts

**Files:**

- Create: `packages/contracts/src/followups.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

- Produces (every later task consumes these): `FollowUpId`, `FollowUpKind`, `FollowUpStatus`, `FollowUpDeferReason`, `FollowUpEvidence`, `FollowUpGate`, `FollowUpResolution`, `FollowUp`, `FollowUpSnapshot`, `FollowUpStreamItem`, `FollowUpFileInput`, `FollowUpUpdateStatusInput`, `FollowUpSubscribeInput`, `FollowUpOperationError`.

- [ ] **Step 1: Create the contract file**

Create `packages/contracts/src/followups.ts`:

```ts
import * as Schema from "effect/Schema";

import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const FOLLOW_UP_KINDS = ["blocker", "open", "idea"] as const;
export const FOLLOW_UP_STATUSES = ["open", "resolved", "waived", "moot"] as const;
export const FOLLOW_UP_DEFER_REASONS = [
  "out-of-scope",
  "needs-decision",
  "blocked-externally",
  "idea",
] as const;

export const FollowUpKind = Schema.Literals(FOLLOW_UP_KINDS);
export type FollowUpKind = typeof FollowUpKind.Type;

export const FollowUpStatus = Schema.Literals(FOLLOW_UP_STATUSES);
export type FollowUpStatus = typeof FollowUpStatus.Type;

export const FollowUpDeferReason = Schema.Literals(FOLLOW_UP_DEFER_REASONS);
export type FollowUpDeferReason = typeof FollowUpDeferReason.Type;

export const FollowUpId = TrimmedNonEmptyString.pipe(Schema.brand("FollowUpId"));
export type FollowUpId = typeof FollowUpId.Type;

export const FollowUpTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const FollowUpObservation = TrimmedNonEmptyString.check(Schema.isMaxLength(8_000));
export const FollowUpVerifyCheck = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));

export const FollowUpEvidence = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  line: Schema.NullOr(NonNegativeInt),
  commitSha: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type FollowUpEvidence = typeof FollowUpEvidence.Type;

export const FollowUpGate = Schema.Struct({
  kind: Schema.Literal("branch"),
  ref: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
});
export type FollowUpGate = typeof FollowUpGate.Type;

export const FollowUpResolution = Schema.Struct({
  note: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  threadId: Schema.NullOr(ThreadId),
  commitSha: Schema.NullOr(TrimmedString.check(Schema.isMaxLength(64))),
});
export type FollowUpResolution = typeof FollowUpResolution.Type;

export const FollowUpSourceKind = Schema.Literals(["human", "agent"]);
export type FollowUpSourceKind = typeof FollowUpSourceKind.Type;

export const FollowUp = Schema.Struct({
  id: FollowUpId,
  projectId: ProjectId,
  kind: FollowUpKind,
  status: FollowUpStatus,
  title: FollowUpTitle,
  observation: FollowUpObservation,
  deferReason: FollowUpDeferReason,
  verifyCheck: FollowUpVerifyCheck,
  evidence: Schema.Array(FollowUpEvidence),
  gate: Schema.NullOr(FollowUpGate),
  sourceKind: FollowUpSourceKind,
  sourceThreadId: Schema.NullOr(ThreadId),
  resolution: Schema.NullOr(FollowUpResolution),
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FollowUp = typeof FollowUp.Type;

export const FollowUpEventType = Schema.Literals(["follow-up.filed", "follow-up.status-changed"]);
export type FollowUpEventType = typeof FollowUpEventType.Type;

export const FollowUpEventPayload = Schema.Struct({ item: FollowUp });
export type FollowUpEventPayload = typeof FollowUpEventPayload.Type;

export const FollowUpEvent = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  commandId: CommandId,
  type: FollowUpEventType,
  occurredAt: IsoDateTime,
  payload: FollowUpEventPayload,
});
export type FollowUpEvent = typeof FollowUpEvent.Type;

export const FollowUpSnapshot = Schema.Struct({
  sequence: NonNegativeInt,
  items: Schema.Array(FollowUp),
});
export type FollowUpSnapshot = typeof FollowUpSnapshot.Type;

export const FollowUpStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), snapshot: FollowUpSnapshot }),
  Schema.Struct({ kind: Schema.Literal("event"), event: FollowUpEvent }),
]);
export type FollowUpStreamItem = typeof FollowUpStreamItem.Type;

export const FollowUpFileInput = Schema.Struct({
  commandId: CommandId,
  itemId: FollowUpId,
  projectId: ProjectId,
  kind: FollowUpKind,
  title: FollowUpTitle,
  observation: FollowUpObservation,
  deferReason: FollowUpDeferReason,
  verifyCheck: FollowUpVerifyCheck,
  evidence: Schema.optional(Schema.Array(FollowUpEvidence)),
  gate: Schema.optional(Schema.NullOr(FollowUpGate)),
  sourceKind: FollowUpSourceKind,
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)),
});
export type FollowUpFileInput = typeof FollowUpFileInput.Type;

export const FollowUpUpdateStatusInput = Schema.Struct({
  commandId: CommandId,
  itemId: FollowUpId,
  expectedRevision: NonNegativeInt,
  status: FollowUpStatus,
  resolution: Schema.optional(Schema.NullOr(FollowUpResolution)),
  actor: FollowUpSourceKind,
});
export type FollowUpUpdateStatusInput = typeof FollowUpUpdateStatusInput.Type;

export const FollowUpSubscribeInput = Schema.Struct({});
export type FollowUpSubscribeInput = typeof FollowUpSubscribeInput.Type;

export const FollowUpErrorCode = Schema.Literals([
  "not-found",
  "conflict",
  "invalid-project",
  "invalid-thread",
  "invalid-command",
  "forbidden",
  "persistence",
]);
export type FollowUpErrorCode = typeof FollowUpErrorCode.Type;

export class FollowUpOperationError extends Schema.TaggedErrorClass<FollowUpOperationError>()(
  "FollowUpOperationError",
  { code: FollowUpErrorCode, message: TrimmedNonEmptyString },
) {}
```

- [ ] **Step 2: Export from the barrel**

In `packages/contracts/src/index.ts`, add alongside the other `export * from` lines:

```ts
export * from "./followups.ts";
```

- [ ] **Step 3: Typecheck**

Run from `packages/contracts`: `vp run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/followups.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): follow-up schemas"
```

---

## Task 2: Migration

**Files:**

- Create: `apps/server/src/persistence/Migrations/037_FollowUps.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`

**Interfaces:**

- Produces: tables `follow_up_events` (durable fact log) and `follow_ups` (read projection), consumed by Task 4.

Invoke the `effect-server` skill first.

- [ ] **Step 1: Create the migration**

Create `apps/server/src/persistence/Migrations/037_FollowUps.ts`:

```ts
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS follow_up_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      command_id TEXT NOT NULL UNIQUE,
      item_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS follow_ups (
      item_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      observation TEXT NOT NULL,
      defer_reason TEXT NOT NULL,
      verify_check TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      gate_json TEXT,
      source_kind TEXT NOT NULL,
      source_thread_id TEXT,
      resolution_json TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS follow_ups_project_status_idx
    ON follow_ups(project_id, status, kind, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS follow_ups_gate_idx
    ON follow_ups(status, kind, gate_json)
  `;
});
```

- [ ] **Step 2: Register it**

In `apps/server/src/persistence/Migrations.ts`, add the import after the `Migration0035` import:

```ts
import Migration0037 from "./Migrations/037_FollowUps.ts";
```

and add this entry to `migrationEntries` immediately **after** the retired-36 comment block, keeping that comment intact:

```ts
  [37, "FollowUps", Migration0037],
```

- [ ] **Step 3: Typecheck**

Run from `apps/server`: `vp run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/persistence/Migrations/037_FollowUps.ts apps/server/src/persistence/Migrations.ts
git commit -m "feat(server): follow-up tables"
```

---

## Task 3: Pure decider

**Files:**

- Create: `apps/server/src/followups/decider.ts`
- Test: `apps/server/src/followups/decider.test.ts`

**Interfaces:**

- Consumes: contracts from Task 1.
- Produces (consumed by Task 4): `FollowUpDomainCommand`, `FollowUpDomainEvent`, `FollowUpDecision`, `decideFollowUpCommand(snapshot, command, now): FollowUpDecision`.

Invoke the `effect-server` skill first. TDD: test first, watch it fail, then implement.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/followups/decider.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  FollowUpId,
  ProjectId,
  type FollowUp,
  type FollowUpSnapshot,
} from "@t3tools/contracts";

import { decideFollowUpCommand } from "./decider.ts";

const NOW = "2026-08-04T12:00:00.000Z";

function item(overrides: Partial<FollowUp> = {}): FollowUp {
  return {
    id: FollowUpId.make("item-1"),
    projectId: ProjectId.make("project-1"),
    kind: "open",
    status: "open",
    title: "Check the thing",
    observation: "The thing looked wrong during unrelated work.",
    deferReason: "out-of-scope",
    verifyCheck: "Open the thing and see whether it is still wrong.",
    evidence: [],
    gate: null,
    sourceKind: "agent",
    sourceThreadId: null,
    resolution: null,
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function snapshot(items: ReadonlyArray<FollowUp>): FollowUpSnapshot {
  return { sequence: 1, items };
}

describe("decideFollowUpCommand", () => {
  it("files a new follow-up at revision 0", () => {
    const decision = decideFollowUpCommand(
      snapshot([]),
      {
        type: "file",
        input: {
          commandId: CommandId.make("command-1"),
          itemId: FollowUpId.make("item-new"),
          projectId: ProjectId.make("project-1"),
          kind: "open",
          title: "Check the thing",
          observation: "Noticed during unrelated work.",
          deferReason: "out-of-scope",
          verifyCheck: "Does it still happen?",
          sourceKind: "agent",
        },
      },
      NOW,
    );

    expect(decision.kind).toBe("accepted");
    if (decision.kind === "accepted") {
      expect(decision.event.payload.item).toMatchObject({ status: "open", revision: 0 });
    }
  });

  it("rejects a blocker filed without a gate", () => {
    const decision = decideFollowUpCommand(
      snapshot([]),
      {
        type: "file",
        input: {
          commandId: CommandId.make("command-2"),
          itemId: FollowUpId.make("item-blocker"),
          projectId: ProjectId.make("project-1"),
          kind: "blocker",
          title: "Must fix before merge",
          observation: "A reviewer would refuse this.",
          deferReason: "needs-decision",
          verifyCheck: "Does the defect still reproduce?",
          sourceKind: "agent",
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({ kind: "rejected", error: { code: "invalid-command" } });
  });

  it("refuses to let an agent waive", () => {
    const current = item();
    const decision = decideFollowUpCommand(
      snapshot([current]),
      {
        type: "update-status",
        input: {
          commandId: CommandId.make("command-3"),
          itemId: current.id,
          expectedRevision: 0,
          status: "waived",
          actor: "agent",
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({ kind: "rejected", error: { code: "forbidden" } });
  });

  it("lets a human waive", () => {
    const current = item();
    const decision = decideFollowUpCommand(
      snapshot([current]),
      {
        type: "update-status",
        input: {
          commandId: CommandId.make("command-4"),
          itemId: current.id,
          expectedRevision: 0,
          status: "waived",
          actor: "human",
          resolution: { note: "Not worth doing.", threadId: null, commitSha: null },
        },
      },
      NOW,
    );

    expect(decision.kind).toBe("accepted");
    if (decision.kind === "accepted") {
      expect(decision.event.payload.item).toMatchObject({ status: "waived", revision: 1 });
    }
  });

  it("requires a resolution to leave open", () => {
    const current = item();
    const decision = decideFollowUpCommand(
      snapshot([current]),
      {
        type: "update-status",
        input: {
          commandId: CommandId.make("command-5"),
          itemId: current.id,
          expectedRevision: 0,
          status: "resolved",
          actor: "agent",
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({ kind: "rejected", error: { code: "invalid-command" } });
  });

  it("rejects stale revisions", () => {
    const current = item({ revision: 3 });
    const decision = decideFollowUpCommand(
      snapshot([current]),
      {
        type: "update-status",
        input: {
          commandId: CommandId.make("command-6"),
          itemId: current.id,
          expectedRevision: 2,
          status: "moot",
          actor: "agent",
          resolution: { note: "Code deleted.", threadId: null, commitSha: null },
        },
      },
      NOW,
    );

    expect(decision).toMatchObject({ kind: "rejected", error: { code: "conflict" } });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run from the repo root: `./node_modules/.bin/vp test run apps/server/src/followups/decider.test.ts`
Expected: FAIL — `decider.ts` does not exist.

- [ ] **Step 3: Implement the decider**

Create `apps/server/src/followups/decider.ts`:

```ts
import type {
  FollowUp,
  FollowUpEventPayload,
  FollowUpEventType,
  FollowUpFileInput,
  FollowUpOperationError,
  FollowUpSnapshot,
  FollowUpUpdateStatusInput,
} from "@t3tools/contracts";
import { FollowUpOperationError as FollowUpOperationErrorClass } from "@t3tools/contracts";

export type FollowUpDomainCommand =
  | { readonly type: "file"; readonly input: FollowUpFileInput }
  | { readonly type: "update-status"; readonly input: FollowUpUpdateStatusInput };

export interface FollowUpDomainEvent {
  readonly type: FollowUpEventType;
  readonly payload: FollowUpEventPayload;
}

export type FollowUpDecision =
  | { readonly kind: "accepted"; readonly event: FollowUpDomainEvent }
  | { readonly kind: "rejected"; readonly error: FollowUpOperationError };

function reject(
  code: FollowUpOperationError["code"],
  message: string,
): Extract<FollowUpDecision, { readonly kind: "rejected" }> {
  return { kind: "rejected", error: new FollowUpOperationErrorClass({ code, message }) };
}

function accepted(type: FollowUpEventType, item: FollowUp): FollowUpDecision {
  return { kind: "accepted", event: { type, payload: { item } } };
}

export function decideFollowUpCommand(
  snapshot: FollowUpSnapshot,
  command: FollowUpDomainCommand,
  now: string,
): FollowUpDecision {
  switch (command.type) {
    case "file": {
      const { input } = command;
      if (snapshot.items.some((candidate) => candidate.id === input.itemId)) {
        return reject("conflict", "A follow-up with that identifier already exists.");
      }
      // A blocker without a gate is unenforceable: "before shipping" is
      // meaningless unless it names what it blocks.
      const gate = input.gate ?? null;
      if (input.kind === "blocker" && gate === null) {
        return reject("invalid-command", "A blocker must name the branch it gates.");
      }
      const item: FollowUp = {
        id: input.itemId,
        projectId: input.projectId,
        kind: input.kind,
        status: "open",
        title: input.title,
        observation: input.observation,
        deferReason: input.deferReason,
        verifyCheck: input.verifyCheck,
        evidence: input.evidence ?? [],
        gate,
        sourceKind: input.sourceKind,
        sourceThreadId: input.sourceThreadId ?? null,
        resolution: null,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      return accepted("follow-up.filed", item);
    }

    case "update-status": {
      const { input } = command;
      const current = snapshot.items.find((candidate) => candidate.id === input.itemId) ?? null;
      if (current === null) {
        return reject("not-found", "That follow-up no longer exists.");
      }
      if (current.revision !== input.expectedRevision) {
        return reject(
          "conflict",
          "That follow-up changed elsewhere. The list already shows the latest version — try again.",
        );
      }
      // Only a human may waive. If an agent could waive its own blocker the
      // shipping gate would defeat itself.
      if (input.status === "waived" && input.actor !== "human") {
        return reject("forbidden", "Only a person can waive a follow-up.");
      }
      const resolution = input.resolution ?? null;
      if (input.status !== "open" && resolution === null) {
        return reject("invalid-command", "Closing a follow-up requires a resolution note.");
      }
      const item: FollowUp = {
        ...current,
        status: input.status,
        resolution: input.status === "open" ? null : resolution,
        revision: current.revision + 1,
        updatedAt: now,
      };
      return accepted("follow-up.status-changed", item);
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `./node_modules/.bin/vp test run apps/server/src/followups/decider.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/followups/decider.ts apps/server/src/followups/decider.test.ts
git commit -m "feat(server): pure follow-up decider"
```

---

## Task 4: FollowUpService

**Files:**

- Create: `apps/server/src/followups/FollowUpService.ts`
- Test: `apps/server/src/followups/FollowUpService.test.ts`

**Interfaces:**

- Consumes: `decideFollowUpCommand` (Task 3), tables (Task 2).
- Produces (consumed by Tasks 5, 6, 7): `FollowUpService` with `file(input) → Effect<FollowUp, FollowUpOperationError>`, `updateStatus(input) → Effect<FollowUp, FollowUpOperationError>`, `getSnapshot: Effect<FollowUpSnapshot, FollowUpOperationError>`, `openBlockersForBranch(ref: string) → Effect<ReadonlyArray<FollowUp>, FollowUpOperationError>`, `stream: Stream<FollowUpStreamItem, FollowUpOperationError>`, and `export const layer`.

Invoke the `effect-server` skill first.

**Model this file closely on the structure of `apps/server/src/kanban/KanbanService.ts` immediately before its removal at `d31439f62^`** (`git show d31439f62^:apps/server/src/kanban/KanbanService.ts`). That file is the proven pattern in this repo for: a mutation semaphore, `command_id` idempotency, a single transaction per command, `PubSub` fan-out, and a snapshot-then-events stream that attaches under the semaphore so there is no snapshot/subscribe gap. Reuse that shape; substitute follow-up schemas and add `openBlockersForBranch`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/followups/FollowUpService.test.ts`:

```ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, FollowUpId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { FollowUpService, layer as FollowUpServiceLive } from "./FollowUpService.ts";

const testLayer = it.layer(
  FollowUpServiceLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const now = "2026-08-04T12:00:00.000Z";

const seedProject = Effect.fn("FollowUpServiceTest.seedProject")(function* (projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, ${"Pylon"}, ${"/tmp/pylon"}, ${null},
      ${"[]"}, ${now}, ${now}, ${null}
    )
  `;
});

testLayer("FollowUpService", (it) => {
  it.effect("files and resolves a follow-up", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const projectId = ProjectId.make("project-followups");
      yield* seedProject(projectId);

      const filed = yield* service.file({
        commandId: CommandId.make("command-file"),
        itemId: FollowUpId.make("item-1"),
        projectId,
        kind: "open",
        title: "Check the picker",
        observation: "Showed a raw id during unrelated work.",
        deferReason: "out-of-scope",
        verifyCheck: "Open the picker — does it show a name?",
        sourceKind: "agent",
      });
      assert.equal(filed.status, "open");
      assert.equal(filed.revision, 0);

      const resolved = yield* service.updateStatus({
        commandId: CommandId.make("command-resolve"),
        itemId: filed.id,
        expectedRevision: filed.revision,
        status: "resolved",
        actor: "agent",
        resolution: { note: "Fixed.", threadId: null, commitSha: null },
      });
      assert.equal(resolved.status, "resolved");
      assert.equal(resolved.revision, 1);
    }),
  );

  it.effect("deduplicates a retried command", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const projectId = ProjectId.make("project-idempotent");
      yield* seedProject(projectId);
      const input = {
        commandId: CommandId.make("command-idempotent"),
        itemId: FollowUpId.make("item-idempotent"),
        projectId,
        kind: "open",
        title: "File once",
        observation: "Only one row should exist.",
        deferReason: "out-of-scope",
        verifyCheck: "Count the rows.",
        sourceKind: "agent",
      } as const;

      const first = yield* service.file(input);
      const retried = yield* service.file(input);
      const snapshot = yield* service.getSnapshot;

      assert.deepStrictEqual(retried, first);
      assert.equal(snapshot.items.filter((item) => item.id === first.id).length, 1);
    }),
  );

  it.effect("reports open blockers for a branch and ignores resolved ones", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const projectId = ProjectId.make("project-gate");
      yield* seedProject(projectId);

      yield* service.file({
        commandId: CommandId.make("command-blocker"),
        itemId: FollowUpId.make("item-blocker"),
        projectId,
        kind: "blocker",
        title: "A11y regression",
        observation: "Nested interactive controls.",
        deferReason: "needs-decision",
        verifyCheck: "Does the wrapper still nest buttons?",
        gate: { kind: "branch", ref: "feature/x" },
        sourceKind: "agent",
      });
      const other = yield* service.file({
        commandId: CommandId.make("command-blocker-other"),
        itemId: FollowUpId.make("item-blocker-other"),
        projectId,
        kind: "blocker",
        title: "Other branch",
        observation: "Unrelated.",
        deferReason: "out-of-scope",
        verifyCheck: "n/a",
        gate: { kind: "branch", ref: "feature/y" },
        sourceKind: "agent",
      });

      const before = yield* service.openBlockersForBranch("feature/x");
      assert.equal(before.length, 1);

      yield* service.updateStatus({
        commandId: CommandId.make("command-clear-other"),
        itemId: other.id,
        expectedRevision: other.revision,
        status: "resolved",
        actor: "agent",
        resolution: { note: "Done.", threadId: null, commitSha: null },
      });
      const otherAfter = yield* service.openBlockersForBranch("feature/y");
      assert.equal(otherAfter.length, 0);
    }),
  );

  it.effect("rejects a follow-up for an unknown project", () =>
    Effect.gen(function* () {
      const service = yield* FollowUpService;
      const error = yield* service
        .file({
          commandId: CommandId.make("command-bad-project"),
          itemId: FollowUpId.make("item-bad-project"),
          projectId: ProjectId.make("missing-project"),
          kind: "open",
          title: "Should fail",
          observation: "No such project.",
          deferReason: "out-of-scope",
          verifyCheck: "n/a",
          sourceKind: "agent",
        })
        .pipe(Effect.flip);

      assert.equal(error.code, "invalid-project");
    }),
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `./node_modules/.bin/vp test run apps/server/src/followups/FollowUpService.test.ts`
Expected: FAIL — `FollowUpService.ts` does not exist.

- [ ] **Step 3: Implement the service**

Create `apps/server/src/followups/FollowUpService.ts` following `git show d31439f62^:apps/server/src/kanban/KanbanService.ts`. Requirements, all of which that reference file demonstrates:

1. `Context.Service` tagged `"t3/followups/FollowUpService"` with the shape in **Interfaces** above.
2. A `Semaphore.make(1)` mutation mutex; every command runs under `mutationMutex.withPermits(1)`.
3. Idempotency: look up `follow_up_events` by `command_id` first; if found, decode `payload_json` and return its `item` without re-running the decider.
4. Inside `sql.withTransaction`: read the snapshot, validate the project exists (`SELECT project_id FROM projection_projects WHERE project_id = ? AND deleted_at IS NULL`, else `invalid-project`), validate `sourceThreadId` when present (`projection_threads`, else `invalid-thread`), run `decideFollowUpCommand`, insert into `follow_up_events` `RETURNING sequence`, then upsert `follow_ups`.
5. JSON columns: `evidence_json`, `gate_json`, `resolution_json` serialize with `JSON.stringify` and decode with `Schema.fromJsonString`. `gate_json` and `resolution_json` are nullable.
6. Publish the persisted event to an unbounded `PubSub` after the transaction commits.
7. `stream`: under the mutex, subscribe first, then read the snapshot, then `Stream.concat(Stream.succeed({kind:"snapshot",…}), Stream.fromSubscription(...))`. Subscribing before snapshotting is what removes the snapshot/subscribe gap.
8. `getSnapshot` orders items by `created_at, item_id`.
9. `openBlockersForBranch(ref)`: `SELECT` from `follow_ups` where `kind = 'blocker' AND status = 'open'`, decode, then filter in TypeScript on `item.gate?.ref === ref`. Do not attempt to match inside the JSON column in SQL.
10. Map every non-domain failure to `FollowUpOperationError({ code: "persistence", … })`; pass domain errors through unchanged.

- [ ] **Step 4: Run the tests**

Run: `./node_modules/.bin/vp test run apps/server/src/followups/FollowUpService.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/followups/FollowUpService.ts apps/server/src/followups/FollowUpService.test.ts
git commit -m "feat(server): follow-up service with gate query"
```

---

## Task 5: RPC surface

**Files:**

- Modify: `packages/contracts/src/rpc.ts`, `apps/server/src/ws.ts`, `apps/server/src/auth/RpcAuthorization.ts`, `apps/server/src/server.ts`

**Interfaces:**

- Consumes: `FollowUpService` (Task 4), contracts (Task 1).
- Produces (consumed by Task 7): `WS_METHODS.followUpFile`, `followUpUpdateStatus`, `followUpSubscribe`.

Invoke the `effect-server` skill first. **Reference `git show d31439f62^ -- packages/contracts/src/rpc.ts apps/server/src/ws.ts apps/server/src/auth/RpcAuthorization.ts apps/server/src/server.ts`** to see exactly how a bounded context was wired before; mirror it.

- [ ] **Step 1: Add the contract RPCs**

In `packages/contracts/src/rpc.ts`:

Import the follow-up types near the other context imports:

```ts
import {
  FollowUp,
  FollowUpFileInput,
  FollowUpOperationError,
  FollowUpStreamItem,
  FollowUpSubscribeInput,
  FollowUpUpdateStatusInput,
} from "./followups.ts";
```

Add to the `WS_METHODS` object:

```ts
  // Follow-up methods
  followUpFile: "followUp.file",
  followUpUpdateStatus: "followUp.updateStatus",
  followUpSubscribe: "followUp.subscribe",
```

Add the RPC definitions beside the other `Rpc.make` blocks:

```ts
export const WsFollowUpFileRpc = Rpc.make(WS_METHODS.followUpFile, {
  payload: FollowUpFileInput,
  success: FollowUp,
  error: Schema.Union([FollowUpOperationError, EnvironmentAuthorizationError]),
});

export const WsFollowUpUpdateStatusRpc = Rpc.make(WS_METHODS.followUpUpdateStatus, {
  payload: FollowUpUpdateStatusInput,
  success: FollowUp,
  error: Schema.Union([FollowUpOperationError, EnvironmentAuthorizationError]),
});

export const WsFollowUpSubscribeRpc = Rpc.make(WS_METHODS.followUpSubscribe, {
  payload: FollowUpSubscribeInput,
  success: FollowUpStreamItem,
  error: Schema.Union([FollowUpOperationError, EnvironmentAuthorizationError]),
  stream: true,
});
```

Add all three to the RPC registry array alongside the existing `Ws*Rpc` entries.

- [ ] **Step 2: Authorize them**

In `apps/server/src/auth/RpcAuthorization.ts`, add to the scope map:

```ts
  [WS_METHODS.followUpFile]: AuthOrchestrationOperateScope,
  [WS_METHODS.followUpUpdateStatus]: AuthOrchestrationOperateScope,
  [WS_METHODS.followUpSubscribe]: AuthOrchestrationReadScope,
```

- [ ] **Step 3: Wire the service layer**

In `apps/server/src/server.ts`, import the service and merge its layer where `VcsLayerLive` is merged:

```ts
import * as FollowUpService from "./followups/FollowUpService.ts";
```

```ts
const FollowUpLayerLive = FollowUpService.layer;
```

and change the `Layer.provideMerge(VcsLayerLive)` call to `Layer.provideMerge(Layer.mergeAll(VcsLayerLive, FollowUpLayerLive))`.

- [ ] **Step 4: Add the handlers**

In `apps/server/src/ws.ts`, import the service, acquire it beside the other services (`const followUps = yield* FollowUpService.FollowUpService;`), and add to the handler map:

```ts
        [WS_METHODS.followUpFile]: (input) =>
          observeRpcEffect(WS_METHODS.followUpFile, followUps.file(input), {
            "rpc.aggregate": "followup",
          }),
        [WS_METHODS.followUpUpdateStatus]: (input) =>
          observeRpcEffect(WS_METHODS.followUpUpdateStatus, followUps.updateStatus(input), {
            "rpc.aggregate": "followup",
          }),
        [WS_METHODS.followUpSubscribe]: () =>
          observeRpcStream(WS_METHODS.followUpSubscribe, followUps.stream, {
            "rpc.aggregate": "followup",
          }),
```

- [ ] **Step 5: Typecheck and run the server suite**

Run from `packages/contracts`: `vp run typecheck` — expected PASS.
Run from `apps/server`: `vp run typecheck` — expected PASS.
Run from the repo root: `./node_modules/.bin/vp test run apps/server/src/server.test.ts` — expected PASS. If `server.test.ts` builds a layer stack that now needs `FollowUpService`, add a `Layer.mock(FollowUpService.FollowUpService)({ … })` entry mirroring the neighbouring mocks, with `file`/`updateStatus`/`openBlockersForBranch` returning `Effect.die("FollowUpService not stubbed in this test")`, `getSnapshot` returning `Effect.succeed({ sequence: 0, items: [] })`, and `stream` returning `Stream.empty`.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/rpc.ts apps/server/src/ws.ts apps/server/src/auth/RpcAuthorization.ts apps/server/src/server.ts apps/server/src/server.test.ts
git commit -m "feat(server): follow-up rpc surface"
```

---

## Task 6: MCP toolkit

**Files:**

- Create: `apps/server/src/mcp/toolkits/followups/tools.ts`, `apps/server/src/mcp/toolkits/followups/handlers.ts`
- Test: `apps/server/src/mcp/toolkits/followups/tools.test.ts`
- Modify: `apps/server/src/mcp/McpHttpServer.ts`

**Interfaces:**

- Consumes: `FollowUpService` (Task 4), contracts (Task 1).
- Produces: `FollowUpToolkit`, `FollowUpToolkitHandlersLive`, `FollowUpToolkitRegistrationLive`.

Invoke the `effect-server` skill first. **Follow `apps/server/src/mcp/toolkits/preview/{tools,handlers}.ts` exactly** — same `Tool.make` / `Toolkit.make` / `McpServer.toolkit(...)` shape, same annotation helpers.

Tool descriptions are load-bearing: they are the only place an agent learns the rules. Use the text below verbatim.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/mcp/toolkits/followups/tools.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest";

import { FollowUpToolkit } from "./tools.ts";

describe("follow-up toolkit", () => {
  it("exposes exactly the five follow-up tools", () => {
    const names = Object.values(FollowUpToolkit.tools)
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual([
      "followup_check_gate",
      "followup_file",
      "followup_list",
      "followup_record_validation",
      "followup_resolve",
    ]);
  });

  it("states the bright-line rule in the file tool description", () => {
    const fileTool = Object.values(FollowUpToolkit.tools).find(
      (tool) => tool.name === "followup_file",
    );
    expect(fileTool?.description).toContain("was I asked to do this, and can I do it now");
  });

  it("tells agents they cannot waive", () => {
    const resolveTool = Object.values(FollowUpToolkit.tools).find(
      (tool) => tool.name === "followup_resolve",
    );
    expect(resolveTool?.description?.toLowerCase()).toContain("cannot waive");
  });
});
```

If `FollowUpToolkit.tools` is not the accessor this Effect version exposes, adapt the test to whatever `Toolkit.make` returns (check `apps/server/src/mcp/McpHttpServer.test.ts` around `server.tools.find(({ tool }) => tool.name === "preview_snapshot")` for the shape used elsewhere) — but keep all three assertions.

- [ ] **Step 2: Run it and watch it fail**

Run: `./node_modules/.bin/vp test run apps/server/src/mcp/toolkits/followups/tools.test.ts`
Expected: FAIL — `tools.ts` does not exist.

- [ ] **Step 3: Define the tools**

Create `apps/server/src/mcp/toolkits/followups/tools.ts` using five `Tool.make` definitions inside a `Toolkit.make(...)` export named `FollowUpToolkit`. Annotate `followup_list` and `followup_check_gate` as `Tool.Readonly, true` and `Tool.Idempotent, true`; annotate `followup_file`, `followup_resolve`, and `followup_record_validation` as `Tool.Destructive, false`.

`followup_file` — parameters `FollowUpFileInput` minus `commandId`/`itemId`/`sourceKind` (the handler supplies those), success `FollowUp`. Description verbatim:

> File a follow-up for work you are NOT doing now. Before filing, ask yourself: was I asked to do this, and can I do it now? If yes, filing is forbidden — do the work instead. Only file when the work genuinely falls outside what you were asked to do. You must supply a deferReason from the closed set (out-of-scope, needs-decision, blocked-externally, idea) — "ran out of time", "seemed hard", and "probably fine" are not valid reasons to defer. You must also supply verifyCheck: a concrete, falsifiable check a different agent can run weeks from now to decide whether this still matters. Use kind "blocker" only when a competent reviewer would refuse to merge the current work because of it, and then you must name the branch it gates.

`followup_list` — parameters optional `status` and `kind` filters, success `Schema.Array(FollowUp)`. The handler derives the project from the invocation thread. Description:

> List follow-ups for the current thread's project. Call this when you start work and again before you report work complete, so you do not claim done while a blocker is open.

`followup_resolve` — parameters `itemId`, `expectedRevision`, and `resolution`; it always selects `resolved`. Description:

> Close a follow-up you have actually addressed. You cannot waive it or mark it moot here: use followup_record_validation for a checked moot result, and only a person can waive work.

`followup_check_gate` — parameters a struct of `branchRef`, success a struct of `{ blocked: Schema.Boolean, blockers: Schema.Array(FollowUp) }`. Description verbatim:

> Report whether unresolved blockers are attached to a branch in the current project. Call this before reporting work complete or opening a change request. If blocked is true, resolve the listed blockers or ask the developer to waive them — do not report the work as finished.

`followup_record_validation` — parameters `FollowUpRecordValidationInput`, success `FollowUp`.
It records work already performed in the current visible thread as `still-needed`, `moot`, or
`uncertain`; it does not launch a provider. A moot outcome requires concrete evidence and is the
only validation outcome that closes the item.

- [ ] **Step 4: Implement handlers**

Create `apps/server/src/mcp/toolkits/followups/handlers.ts` exporting `FollowUpToolkitHandlersLive`, following `preview/handlers.ts`. Each handler resolves `FollowUpService` and `McpInvocationContext`, then:

- Every handler first checks the live beta setting and derives `projectId` from the authenticated
  invocation thread.
- `followup_file` — generate `commandId` and `itemId` with `crypto.randomUUIDv4`, stamp
  `sourceKind: "agent"` and the invocation thread, then call `service.file`.
- `followup_list` — call the project-scoped `service.getSnapshot`, then apply optional
  `status`/`kind` filters.
- `followup_resolve` — generate `commandId`, stamp agent authority and the invocation thread, and
  call `service.updateStatus` with status `resolved`.
- `followup_check_gate` — call `service.openBlockersForBranch(projectId, branchRef)`, return
  `{ blocked: blockers.length > 0, blockers }`.
- `followup_record_validation` — generate `commandId`, stamp the invocation thread/project, and
  call `service.recordValidation`.

- [ ] **Step 5: Register the toolkit**

In `apps/server/src/mcp/McpHttpServer.ts`, mirror `PreviewStandardToolkitRegistrationLive`:

```ts
const FollowUpToolkitRegistrationLive = McpServer.toolkit(FollowUpToolkit).pipe(
  Layer.provide(FollowUpToolkitHandlersLive),
);
```

and merge it into the exported registration layer beside `PreviewToolkitRegistrationLive`.

- [ ] **Step 6: Run tests and typecheck**

Run: `./node_modules/.bin/vp test run apps/server/src/mcp/toolkits/followups/tools.test.ts` — expected PASS.
Run from `apps/server`: `vp run typecheck` — expected PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/mcp/toolkits/followups apps/server/src/mcp/McpHttpServer.ts
git commit -m "feat(server): follow-up mcp toolkit"
```

---

## Task 7: Client runtime state

**Files:**

- Create: `packages/client-runtime/src/state/followups.ts`, `packages/client-runtime/src/state/followups.test.ts`
- Modify: `packages/client-runtime/package.json`

**Interfaces:**

- Consumes: `WS_METHODS` (Task 5), contracts (Task 1).
- Produces (consumed by Task 8): `FollowUpClientState`, `EMPTY_FOLLOW_UP_CLIENT_STATE`, `applyFollowUpStreamItem(state, item)`, `createFollowUpEnvironmentAtoms(runtime)` returning `{ list, file, updateStatus }`.

**Model on `git show d31439f62^:packages/client-runtime/src/state/kanban.ts`** — same reducer and `createEnvironmentSubscriptionAtomFamily` / `createEnvironmentRpcCommand` shape.

- [ ] **Step 1: Write the failing test**

Create `packages/client-runtime/src/state/followups.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";
import { FollowUpId, ProjectId, type FollowUp } from "@t3tools/contracts";

import { applyFollowUpStreamItem, EMPTY_FOLLOW_UP_CLIENT_STATE } from "./followups.ts";

function item(overrides: Partial<FollowUp> = {}): FollowUp {
  return {
    id: FollowUpId.make("item-1"),
    projectId: ProjectId.make("project-1"),
    kind: "open",
    status: "open",
    title: "Check the thing",
    observation: "Noticed during unrelated work.",
    deferReason: "out-of-scope",
    verifyCheck: "Does it still happen?",
    evidence: [],
    gate: null,
    sourceKind: "agent",
    sourceThreadId: null,
    resolution: null,
    revision: 0,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
    ...overrides,
  };
}

describe("applyFollowUpStreamItem", () => {
  it("adopts a snapshot and marks the state synchronized", () => {
    const next = applyFollowUpStreamItem(EMPTY_FOLLOW_UP_CLIENT_STATE, {
      kind: "snapshot",
      snapshot: { sequence: 3, items: [item()] },
    });
    expect(next.synchronized).toBe(true);
    expect(next.snapshot.items).toHaveLength(1);
  });

  it("ignores events that arrive before a snapshot", () => {
    const next = applyFollowUpStreamItem(EMPTY_FOLLOW_UP_CLIENT_STATE, {
      kind: "event",
      event: {
        sequence: 4,
        eventId: "event-1",
        commandId: "command-1",
        type: "follow-up.filed",
        occurredAt: "2026-08-04T12:00:00.000Z",
        payload: { item: item() },
      },
    } as never);
    expect(next).toBe(EMPTY_FOLLOW_UP_CLIENT_STATE);
  });

  it("applies a later event over the snapshot", () => {
    const base = applyFollowUpStreamItem(EMPTY_FOLLOW_UP_CLIENT_STATE, {
      kind: "snapshot",
      snapshot: { sequence: 3, items: [item()] },
    });
    const next = applyFollowUpStreamItem(base, {
      kind: "event",
      event: {
        sequence: 4,
        eventId: "event-1",
        commandId: "command-1",
        type: "follow-up.status-changed",
        occurredAt: "2026-08-04T12:00:00.000Z",
        payload: { item: item({ status: "resolved", revision: 1 }) },
      },
    } as never);
    expect(next.snapshot.items[0]?.status).toBe("resolved");
    expect(next.snapshot.sequence).toBe(4);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `./node_modules/.bin/vp test run packages/client-runtime/src/state/followups.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `packages/client-runtime/src/state/followups.ts` mirroring the kanban reference. The reducer must: adopt snapshots and set `synchronized: true`; ignore events when `!state.synchronized` or `event.sequence <= state.snapshot.sequence`; otherwise replace the item by id and set `sequence` to the event's. Sort items by `createdAt` then `id`. Export `createFollowUpEnvironmentAtoms(runtime)` returning `list` (subscription over `WS_METHODS.followUpSubscribe` scanned through `applyFollowUpStreamItem`), plus `file` and `updateStatus` commands using `createEnvironmentRpcCommand` with serial per-environment concurrency.

Then add the subpath export to `packages/client-runtime/package.json` beside the existing ones:

```json
    "./state/followups": {
      "types": "./src/state/followups.ts",
      "default": "./src/state/followups.ts"
    },
```

- [ ] **Step 4: Run the tests**

Run: `./node_modules/.bin/vp test run packages/client-runtime/src/state/followups.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/client-runtime/src/state/followups.ts packages/client-runtime/src/state/followups.test.ts packages/client-runtime/package.json
git commit -m "feat(client-runtime): follow-up stream state"
```

---

## Task 8: Web UI behind the beta flag

**Files:**

- Create: `apps/web/src/state/followups.ts`, `apps/web/src/components/followups/followUps.logic.ts`, `apps/web/src/components/followups/followUps.logic.test.ts`, `apps/web/src/components/followups/FollowUpList.tsx`, `apps/web/src/components/followups/FollowUpDialog.tsx`, `apps/web/src/routes/_chat.followups.tsx`
- Modify: `apps/web/src/components/settings/BetaSettingsPanel.tsx`, `apps/web/src/components/sidebar/SidebarChrome.tsx`

**Interfaces:**

- Consumes: `createFollowUpEnvironmentAtoms` (Task 7).
- Produces: `groupFollowUps(items)`, `isFollowUpBetaEnabled(settings)`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/followups/followUps.logic.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";
import { FollowUpId, ProjectId, type FollowUp } from "@t3tools/contracts";

import { groupFollowUps } from "./followUps.logic";

function item(overrides: Partial<FollowUp> = {}): FollowUp {
  return {
    id: FollowUpId.make("item-1"),
    projectId: ProjectId.make("project-1"),
    kind: "open",
    status: "open",
    title: "Check the thing",
    observation: "Noticed during unrelated work.",
    deferReason: "out-of-scope",
    verifyCheck: "Does it still happen?",
    evidence: [],
    gate: null,
    sourceKind: "agent",
    sourceThreadId: null,
    resolution: null,
    revision: 0,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
    ...overrides,
  };
}

describe("groupFollowUps", () => {
  it("groups open items by kind and excludes closed ones", () => {
    const grouped = groupFollowUps([
      item({ id: FollowUpId.make("a"), kind: "blocker", gate: { kind: "branch", ref: "main" } }),
      item({ id: FollowUpId.make("b"), kind: "open" }),
      item({ id: FollowUpId.make("c"), kind: "idea" }),
      item({ id: FollowUpId.make("d"), kind: "open", status: "resolved" }),
    ]);
    expect(grouped.blocker).toHaveLength(1);
    expect(grouped.open).toHaveLength(1);
    expect(grouped.idea).toHaveLength(1);
    expect(grouped.closed).toHaveLength(1);
  });

  it("orders each group newest first", () => {
    const grouped = groupFollowUps([
      item({ id: FollowUpId.make("older"), createdAt: "2026-08-01T00:00:00.000Z" }),
      item({ id: FollowUpId.make("newer"), createdAt: "2026-08-03T00:00:00.000Z" }),
    ]);
    expect(grouped.open.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `./node_modules/.bin/vp test run apps/web/src/components/followups/followUps.logic.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the logic module**

Create `apps/web/src/components/followups/followUps.logic.ts`:

```ts
import type { FollowUp, FollowUpKind } from "@t3tools/contracts";

export const FOLLOW_UP_KIND_LABELS: Readonly<Record<FollowUpKind, string>> = {
  blocker: "Blockers",
  open: "Open",
  idea: "Ideas",
};

export const FOLLOW_UP_DEFER_REASON_LABELS: Readonly<Record<FollowUp["deferReason"], string>> = {
  "out-of-scope": "Out of scope",
  "needs-decision": "Needs a decision",
  "blocked-externally": "Blocked externally",
  idea: "Idea",
};

export interface GroupedFollowUps {
  readonly blocker: ReadonlyArray<FollowUp>;
  readonly open: ReadonlyArray<FollowUp>;
  readonly idea: ReadonlyArray<FollowUp>;
  readonly closed: ReadonlyArray<FollowUp>;
}

export function groupFollowUps(items: ReadonlyArray<FollowUp>): GroupedFollowUps {
  const grouped: Record<"blocker" | "open" | "idea" | "closed", FollowUp[]> = {
    blocker: [],
    open: [],
    idea: [],
    closed: [],
  };
  for (const item of items) {
    if (item.status === "open") grouped[item.kind].push(item);
    else grouped.closed.push(item);
  }
  const newestFirst = (left: FollowUp, right: FollowUp) =>
    right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
  grouped.blocker.sort(newestFirst);
  grouped.open.sort(newestFirst);
  grouped.idea.sort(newestFirst);
  grouped.closed.sort(newestFirst);
  return grouped;
}
```

- [ ] **Step 4: Run the tests**

Run: `./node_modules/.bin/vp test run apps/web/src/components/followups/followUps.logic.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Build the UI**

Create `apps/web/src/state/followups.ts`:

```ts
import { createFollowUpEnvironmentAtoms } from "@t3tools/client-runtime/state/followups";

import { connectionAtomRuntime } from "../connection/runtime";

export const followUpEnvironment = createFollowUpEnvironmentAtoms(connectionAtomRuntime);
```

Create `FollowUpList.tsx` rendering four sections from `groupFollowUps` (Blockers, Open, Ideas, then a collapsed Closed section). Each row shows title, a `deferReason` badge, an agent/human source badge, and — for blockers — the gated branch ref. Row actions: **Resolve** and **Waive** (Waive is human-only and therefore UI-only; it sends `actor: "human"`). Follow the existing design system: compose `Button`, `Badge`, `Empty`, `Menu`, and `toastManager` from `apps/web/src/components/ui/` rather than hand-rolling. Any `Select` you add must receive an `items={[{value,label}]}` prop or Base UI renders the raw value instead of the label.

Create `FollowUpDialog.tsx` for manual capture with fields title, observation, kind, deferReason, verifyCheck, and (when kind is `blocker`) branch ref. Do **not** add a reset `useEffect` keyed on props — mount the dialog conditionally so `useState` initializers run fresh per open.

Create `apps/web/src/routes/_chat.followups.tsx` mirroring the shape of the other `_chat.*` routes, rendering `FollowUpList` inside `SidebarInset`.

- [ ] **Step 6: Gate it behind the beta flag**

In `apps/web/src/components/settings/BetaSettingsPanel.tsx`, add a second toggle inside the existing `SettingsSection title="Beta features"`, following the sidebar-v2 toggle already there. Persist it the same way that toggle persists, with `aria-label="Enable the follow-ups beta"`, default **off**.

In `apps/web/src/components/sidebar/SidebarChrome.tsx`, render a **Follow-ups** entry above **Settings** only when the flag is on, navigating to `/followups`.

- [ ] **Step 7: Typecheck**

Run from `apps/web`: `vp run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/state/followups.ts apps/web/src/components/followups apps/web/src/routes/_chat.followups.tsx apps/web/src/components/settings/BetaSettingsPanel.tsx apps/web/src/components/sidebar/SidebarChrome.tsx apps/web/src/routeTree.gen.ts
git commit -m "feat(web): follow-ups list behind a beta flag"
```

---

## Task 9: The shipping gate

**Files:**

- Create: `apps/server/src/followups/gate.ts`, `apps/server/src/followups/gate.test.ts`
- Modify: `apps/server/src/git/GitManager.ts` — `GitManager.runPrStep`

**Implemented call site:** `GitManager.runPrStep` is the common change-request boundary used by
every source-control provider. It has the authoritative final branch and repository cwd and runs
before provider resolution, lookup, or creation. One call there covers every provider.

**Interfaces:**

- Consumes: `FollowUpService.openBlockersForBranch` (Task 4).
- Produces: `assertNoOpenBlockers(branchRef, cwd) → Effect<void, FollowUpOperationError>`.

Invoke the `effect-server` skill first.

**Keep the call site to exactly one line.** All logic lives in `gate.ts`. Upstream actively develops the paths this touches, and a one-line call site turns any future upstream conflict into a trivial "keep both" rather than a logic merge.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/followups/gate.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest";
import { FollowUpId, ProjectId, type FollowUp } from "@t3tools/contracts";

import { describeBlockers, isBlocked } from "./gate.ts";

function blocker(ref: string, title: string): FollowUp {
  return {
    id: FollowUpId.make(`item-${title}`),
    projectId: ProjectId.make("project-1"),
    kind: "blocker",
    status: "open",
    title,
    observation: "Would fail review.",
    deferReason: "needs-decision",
    verifyCheck: "Does it still reproduce?",
    evidence: [],
    gate: { kind: "branch", ref },
    sourceKind: "agent",
    sourceThreadId: null,
    resolution: null,
    revision: 0,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
  };
}

describe("follow-up gate", () => {
  it("is not blocked when there are no open blockers", () => {
    expect(isBlocked([])).toBe(false);
  });

  it("is blocked when any open blocker exists", () => {
    expect(isBlocked([blocker("feature/x", "a11y")])).toBe(true);
  });

  it("names every blocker in its message", () => {
    const message = describeBlockers([blocker("feature/x", "a11y"), blocker("feature/x", "perf")]);
    expect(message).toContain("a11y");
    expect(message).toContain("perf");
    expect(message).toContain("waive");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `./node_modules/.bin/vp test run apps/server/src/followups/gate.test.ts`
Expected: FAIL — `gate.ts` does not exist.

- [ ] **Step 3: Implement the gate**

> The code sketch below records the original proposal. The implemented gate additionally reads the
> live beta setting, resolves exactly one persisted project owner for `cwd`, queries blockers by
> `(projectId, branchRef)`, and fails closed when ownership is missing or ambiguous. It does not
> launch a provider validation job.

Create `apps/server/src/followups/gate.ts`:

```ts
import { FollowUpOperationError, type FollowUp } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { FollowUpService } from "./FollowUpService.ts";

export function isBlocked(blockers: ReadonlyArray<FollowUp>): boolean {
  return blockers.length > 0;
}

export function describeBlockers(blockers: ReadonlyArray<FollowUp>): string {
  const lines = blockers.map((blocker) => `- ${blocker.title}`).join("\n");
  return [
    `This branch has ${blockers.length} unresolved follow-up ${
      blockers.length === 1 ? "blocker" : "blockers"
    }:`,
    lines,
    "Resolve them, or waive them from the follow-ups list, before shipping.",
  ].join("\n");
}

/**
 * The shipping gate. Call this from a Pylon-owned shipping action — never
 * inline the query, so upstream merges see a single line here.
 */
export const assertNoOpenBlockers = Effect.fn("FollowUps.assertNoOpenBlockers")(function* (
  branchRef: string,
  cwd: string,
) {
  const service = yield* FollowUpService;
  const projectId = yield* service.projectIdForRepositoryPath(cwd);
  const blockers = yield* service.openBlockersForBranch(projectId, branchRef);
  if (isBlocked(blockers)) {
    return yield* new FollowUpOperationError({
      code: "invalid-command",
      message: describeBlockers(blockers),
    });
  }
});
```

- [ ] **Step 4: Wire the single call site**

Open `apps/server/src/git/GitManager.ts` and find `runPrStep`. After resolving the final branch and
before resolving a provider or looking up a change request, add the sole production call:

```ts
yield * FollowUps.assertNoOpenBlockers(branchRef, cwd);
```

Import at the top as `import * as FollowUps from "./followups/gate.ts";`

The gate module reads the server-authoritative beta flag. Keep the provider-neutral “change
request” terminology before provider resolution; provider-specific pull/merge-request terms are
only available afterward.

- [ ] **Step 5: Run tests and typecheck**

Run: `./node_modules/.bin/vp test run apps/server/src/followups/gate.test.ts` — expected 3 passing.
Run from `apps/server`: `vp run typecheck` — expected PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/followups/gate.ts apps/server/src/followups/gate.test.ts
git commit -m "feat(server): block shipping on unresolved follow-up blockers"
```

---

## Task 10: Agent guidance and docs

**Files:**

- Modify: `AGENTS.md`
- Create: `docs/user/follow-ups.md`, `docs/internals/followups.md`
- Modify: `docs/README.md`

- [ ] **Step 1: Add the agent rules**

In `AGENTS.md`, add a `## Follow-ups` section after the `## Verifying` section:

```markdown
## Follow-ups

Pylon tracks follow-ups per project (beta). Use the `followup_*` MCP tools.

- **Before filing, ask: was I asked to do this, and can I do it now?** If yes, filing is
  forbidden — do the work. The list is not a place to put work you were asked to finish.
- Every follow-up needs a `deferReason` from the closed set: `out-of-scope`, `needs-decision`,
  `blocked-externally`, `idea`. "Ran out of time", "seemed hard", and "probably fine" are not
  valid reasons — finish the work or say you are stuck.
- Every follow-up needs a `verifyCheck`: a concrete, falsifiable check another agent can run
  later to decide whether it still matters.
- Use `blocker` only when a competent reviewer would refuse to merge the current work because of
  it, and name the branch it gates.
- Call `followup_list` when you start work in a project, and `followup_check_gate` before you
  report work complete or open a change request.
- You may resolve a follow-up you actually addressed. Record a checked moot result with evidence
  through `followup_record_validation`. **You may never waive one** — only the developer decides
  that something does not need doing.
```

- [ ] **Step 2: Write the user doc**

Create `docs/user/follow-ups.md` in shipped-product voice — no repo paths, no tooling names:

```markdown
# Follow-ups

Follow-ups are a per-project list of things to come back to: work you noticed but are not doing
now, and ideas you do not want to lose. Turn them on in **Settings → Beta**.

Open **Follow-ups** from the sidebar. Items are grouped into blockers, open items, and ideas.

## Filing

Add an item yourself, or ask an agent to file one in conversation — "add a follow-up to check the
retry logic". Agents also file follow-ups on their own when they consciously set work aside,
recording what they saw and why they did not do it.

Agents may not file a follow-up for work you asked them to do. If it was in scope, they finish it.

## Blockers

A blocker names the branch it gates. Pylon refuses to open a change request for a branch that still
has unresolved blockers, so work cannot quietly ship past something that needed attention.

Resolve a blocker once it is handled, or waive it if you decide it does not need doing. Only you
can waive — an agent cannot dismiss its own blocker.

## Ideas

Ideas are allowed to never happen. Capture them without committing to them; resolve or waive them
when you make a decision, and reopen them if that decision changes.
```

Add it to `docs/README.md` under "Using Pylon", beside the other user docs.

- [ ] **Step 3: Write the internals doc**

Create `docs/internals/followups.md` covering: the bounded-context boundary and why (mirrors the reasoning in `docs/internals/kanban.md` as it existed before removal); the durable `follow_up_events` log versus the `follow_ups` projection; per-command idempotency via `command_id` and `expectedRevision` for concurrent edits; why only a human may waive; and the single-line gate call site with a pointer to `apps/server/src/followups/gate.ts`.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/user/follow-ups.md docs/internals/followups.md docs/README.md
git commit -m "docs: follow-ups guidance for agents and users"
```

---

## Task 11: Integrated verification

- [ ] **Step 1: Run every touched suite**

```bash
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
  apps/web/src/state/followups.test.ts
```

Then typecheck per package from inside each of `packages/contracts`, `packages/client-runtime`, `apps/server`, `apps/web`: `vp run typecheck`. Do not run repo-wide checks.

- [ ] **Step 2: Verify the migration on real-shaped data**

From the worktree root, create a unique ignored home, snapshot the live database into it with
`VACUUM INTO`, remove only migrations 37/38 and their isolated tables, then boot the server-only
process against that copy. Never point a server at live state:

```bash
followups_migration_home="$(mktemp -d "$PWD/.t3/followups-migrations.XXXXXX")"
mkdir -p "$followups_migration_home/userdata"
FOLLOWUPS_MIGRATION_HOME="$followups_migration_home" bun -e 'new (require("bun:sqlite").Database)(process.env.HOME + "/.t3/userdata/state.sqlite", { readonly: true }).run(`VACUUM INTO ${JSON.stringify(process.env.FOLLOWUPS_MIGRATION_HOME + "/userdata/state.sqlite")}`)'
node apps/server/scripts/t3-sqlite-state.ts exec --base-dir "$followups_migration_home" --sql "DROP TABLE IF EXISTS follow_up_events; DROP TABLE IF EXISTS follow_ups; DELETE FROM effect_sql_migrations WHERE migration_id IN (37, 38)"
./node_modules/.bin/vp run dev:server --home-dir "$followups_migration_home" >"$followups_migration_home/server.log" 2>&1 &
followups_server_pid=$!
```

Capture that exact PID and stop only it with `kill -INT "$followups_server_pid"`. Confirm migration
rows 37 and 38, both tables and indexes, nullable `last_validation_json`, retained project/thread
counts, and `PRAGMA integrity_check`:

```bash
node apps/server/scripts/t3-sqlite-state.ts query --base-dir "$followups_migration_home" --sql "SELECT name FROM sqlite_master WHERE name LIKE 'follow_up%'"
```

Expected: migrations `37_FollowUps` and `38_FollowUpValidation`, `follow_ups`,
`follow_up_events`, their indexes, and `integrity_check = ok`.

- [ ] **Step 3: Ask before any browser verification**

A UI pass needs the developer's explicit go-ahead. If granted, use the `test-pylon-app` skill and
check beta visibility, filing, **Start thread**, **Validate**, **Resolve**, **Waive**, **Reopen**,
resolution/validation evidence, branch gate count/unavailable state, and live disable behavior.

- [ ] **Step 4: Report**

Summarize what passed, what was skipped, and anything left open. Do not open a pull request unless the developer asks.

---

## Explicit non-goals

- No cross-project aggregate view. Items are project-scoped.
- No automatic or scheduled provider-run validation. Validation runs on demand in a visible
  project thread; the gate reads durable state and fails closed.
- No mobile UI. Contracts stay client-agnostic so it can follow later.
- No automatic context injection into agents — Pylon has no injection hook, and building one means touching all five provider adapters. Awareness comes from the MCP tools plus the `AGENTS.md` rules, with the gate as the mechanical backstop.
- No `in_progress` state. Work being done is a thread, not a follow-up.
