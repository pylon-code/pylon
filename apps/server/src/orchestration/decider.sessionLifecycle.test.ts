import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-session-lifecycle");
const INSTANCE_ID = ProviderInstanceId.make("codex");
const INCARNATION_ID = RuntimeSessionId.make("session-current");
const REQUEST_ID = CommandId.make("request-current");
const MESSAGE_ID = MessageId.make("message-current");

const makeSession = (overrides: Partial<OrchestrationSession> = {}): OrchestrationSession => ({
  threadId: THREAD_ID,
  status: "starting",
  providerName: "codex",
  providerInstanceId: INSTANCE_ID,
  runtimeMode: "full-access",
  sessionIncarnationId: INCARNATION_ID,
  pendingTurnRequestId: REQUEST_ID,
  pendingTurnMessageId: MESSAGE_ID,
  pendingTurnRequestedAt: NOW,
  pendingTurnDeadlineAt: "2026-01-01T00:01:00.000Z",
  pendingTurnSessionId: INCARNATION_ID,
  activeTurnId: null,
  lastError: null,
  updatedAt: NOW,
  ...overrides,
});

const makeReadModel = (session: OrchestrationSession): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project-session-lifecycle"),
      title: "Lifecycle",
      modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session,
    },
  ],
  updatedAt: NOW,
});

const applyLifecycleCommand = (
  expected: OrchestrationSession,
  session: OrchestrationSession,
  allowFailedTurnRequestClear = false,
) => ({
  type: "thread.session.apply-lifecycle" as const,
  commandId: CommandId.make("cmd-apply-session-lifecycle"),
  threadId: THREAD_ID,
  expectedStatus: expected.status,
  expectedProviderInstanceId: expected.providerInstanceId ?? null,
  expectedSessionIncarnationId: expected.sessionIncarnationId ?? null,
  expectedPendingTurnRequestId: expected.pendingTurnRequestId ?? null,
  expectedPendingTurnSessionId: expected.pendingTurnSessionId ?? null,
  expectedActiveTurnRequestId: expected.activeTurnRequestId ?? null,
  expectedActiveTurnId: expected.activeTurnId,
  expectedFailedTurnRequestId: expected.failedTurnRequestId ?? null,
  ...(allowFailedTurnRequestClear ? { allowFailedTurnRequestClear: true as const } : {}),
  session,
  createdAt: NOW,
});

it.layer(NodeServices.layer)("session lifecycle CAS decider", (it) => {
  it.effect("applies lifecycle state only for the exact observed lineage", () =>
    Effect.gen(function* () {
      const current = makeSession();
      const next = makeSession({ status: "ready", pendingTurnSessionId: INCARNATION_ID });
      const accepted = yield* decideOrchestrationCommand({
        command: applyLifecycleCommand(current, next),
        readModel: makeReadModel(current),
      });
      const events = Array.isArray(accepted) ? accepted : [accepted];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);

      const staleObservation = makeSession({
        sessionIncarnationId: RuntimeSessionId.make("session-stale"),
      });
      const rejected = yield* decideOrchestrationCommand({
        command: applyLifecycleCommand(staleObservation, next),
        readModel: makeReadModel(current),
      });
      expect(rejected).toEqual([]);
    }),
  );

  it.effect("keeps failed admission quarantine unless an explicit stop allows clearing it", () =>
    Effect.gen(function* () {
      const failedRequestId = CommandId.make("request-failed");
      const quarantined = makeSession({
        status: "error",
        failedTurnRequestId: failedRequestId,
        lastError: "admission failed",
      });
      const stopped = makeSession({
        status: "stopped",
        pendingTurnRequestId: undefined,
        pendingTurnMessageId: undefined,
        pendingTurnRequestedAt: undefined,
        pendingTurnDeadlineAt: undefined,
        pendingTurnSessionId: undefined,
        failedTurnRequestId: undefined,
      });

      const rejected = yield* decideOrchestrationCommand({
        command: applyLifecycleCommand(quarantined, stopped),
        readModel: makeReadModel(quarantined),
      });
      expect(rejected).toEqual([]);

      const accepted = yield* decideOrchestrationCommand({
        command: applyLifecycleCommand(quarantined, stopped, true),
        readModel: makeReadModel(quarantined),
      });
      const events = Array.isArray(accepted) ? accepted : [accepted];
      expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
    }),
  );

  it.effect("rejects a pending bind after that admission was quarantined", () =>
    Effect.gen(function* () {
      const quarantined = makeSession({
        failedTurnRequestId: REQUEST_ID,
        lastError: "admission failed",
      });
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.bind-pending",
          commandId: CommandId.make("cmd-bind-quarantined"),
          threadId: THREAD_ID,
          requestId: REQUEST_ID,
          messageId: MESSAGE_ID,
          session: quarantined,
          createdAt: NOW,
        },
        readModel: makeReadModel(quarantined),
      });
      expect(result).toEqual([]);
    }),
  );
});
