import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
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

const makeReadModel = (session: OrchestrationSession, sourceEpoch = 0): OrchestrationReadModel => ({
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
      sourceEpoch,
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

  it.effect(
    "binds accepted provider settings and the compatible target session in one decision",
    () =>
      Effect.gen(function* () {
        const current = makeSession();
        const targetInstanceId = ProviderInstanceId.make("codex_personal");
        const acceptedSession = makeSession({
          providerInstanceId: targetInstanceId,
          runtimeMode: "approval-required",
          sessionIncarnationId: RuntimeSessionId.make("session-target"),
          pendingTurnSessionId: RuntimeSessionId.make("session-target"),
        });
        const command = {
          type: "thread.session.bind-pending" as const,
          commandId: CommandId.make("cmd-bind-compatible-target"),
          threadId: THREAD_ID,
          requestId: REQUEST_ID,
          messageId: MESSAGE_ID,
          expectedProviderInstanceId: INSTANCE_ID,
          modelSelection: {
            instanceId: targetInstanceId,
            model: "gpt-5.4",
            options: [{ id: "reasoningEffort", value: "xhigh" }],
          },
          runtimeMode: "approval-required" as const,
          interactionMode: "plan" as const,
          session: acceptedSession,
          createdAt: NOW,
        };

        const accepted = yield* decideOrchestrationCommand({
          command,
          readModel: makeReadModel(current),
        });
        const events = Array.isArray(accepted) ? accepted : [accepted];
        expect(events.map((event) => event.type)).toEqual([
          "thread.meta-updated",
          "thread.runtime-mode-set",
          "thread.interaction-mode-set",
          "thread.session-set",
        ]);

        const stale = yield* decideOrchestrationCommand({
          command: { ...command, expectedProviderInstanceId: targetInstanceId },
          readModel: makeReadModel(current),
        });
        expect(stale).toEqual([]);
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
          expectedProviderInstanceId: INSTANCE_ID,
          modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          session: quarantined,
          createdAt: NOW,
        },
        readModel: makeReadModel(quarantined),
      });
      expect(result).toEqual([]);
    }),
  );

  it.effect("keeps branch metadata while rejecting stale provider-shaped metadata", () =>
    Effect.gen(function* () {
      const session = makeSession({ status: "ready" });
      const readModel = makeReadModel(session);
      const branchUpdate = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-bound-branch-update"),
          threadId: THREAD_ID,
          modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.4" },
          branch: "fix/accepted-branch",
        },
        readModel,
      });
      const events = Array.isArray(branchUpdate) ? branchUpdate : [branchUpdate];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "thread.meta-updated",
        payload: { branch: "fix/accepted-branch" },
      });
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.modelSelection).toBeUndefined();
      }

      const staleModelFailure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-stale-model-update"),
            threadId: THREAD_ID,
            modelSelection: {
              instanceId: INSTANCE_ID,
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "xhigh" }],
            },
          },
          readModel,
        }),
      );
      expect(staleModelFailure.message).toContain("validated turn transition");

      const staleRuntimeFailure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("cmd-stale-runtime-update"),
            threadId: THREAD_ID,
            runtimeMode: "approval-required",
            createdAt: NOW,
          },
          readModel,
        }),
      );
      expect(staleRuntimeFailure.message).toContain("validated turn transition");

      const staleInteractionFailure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.interaction-mode.set",
            commandId: CommandId.make("cmd-stale-interaction-update"),
            threadId: THREAD_ID,
            interactionMode: "plan",
            createdAt: NOW,
          },
          readModel,
        }),
      );
      expect(staleInteractionFailure.message).toContain("validated turn transition");
    }),
  );

  it.effect("accepts exact older provider-setting writes as no-event successes", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel(makeSession({ status: "ready" }));
      expect(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-bound-model-idempotent"),
            threadId: THREAD_ID,
            modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.4" },
          },
          readModel,
        }),
      ).toEqual([]);
      expect(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("cmd-bound-runtime-idempotent"),
            threadId: THREAD_ID,
            runtimeMode: "full-access",
            createdAt: NOW,
          },
          readModel,
        }),
      ).toEqual([]);
      expect(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.interaction-mode.set",
            commandId: CommandId.make("cmd-bound-interaction-idempotent"),
            threadId: THREAD_ID,
            interactionMode: "default",
            createdAt: NOW,
          },
          readModel,
        }),
      ).toEqual([]);
    }),
  );

  it.effect("requires exact admission for running settings changes but keeps plain steering", () =>
    Effect.gen(function* () {
      const running = makeSession({
        status: "running",
        pendingTurnRequestId: undefined,
        pendingTurnMessageId: undefined,
        pendingTurnRequestedAt: undefined,
        pendingTurnDeadlineAt: undefined,
        pendingTurnSessionId: undefined,
        activeTurnRequestId: CommandId.make("request-active"),
        activeTurnId: TurnId.make("turn-active"),
      });
      const readModel = makeReadModel(running);
      const settingsChange = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-running-settings-change"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("message-running-settings-change"),
            role: "user",
            text: "restart through exact admission",
            attachments: [],
          },
          modelSelection: {
            instanceId: INSTANCE_ID,
            model: "gpt-5.4",
            options: [{ id: "reasoningEffort", value: "xhigh" }],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel,
      });
      const settingsEvents = Array.isArray(settingsChange) ? settingsChange : [settingsChange];
      expect(settingsEvents.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.session-set",
        "thread.turn-start-requested",
      ]);
      expect(settingsEvents[1]).toMatchObject({
        type: "thread.session-set",
        payload: {
          session: {
            status: "starting",
            providerInstanceId: INSTANCE_ID,
            pendingTurnRequestId: CommandId.make("cmd-running-settings-change"),
          },
        },
      });

      const accepted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-running-steer"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("message-running-steer"),
            role: "user",
            text: "steer with accepted settings",
            attachments: [],
          },
          modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(accepted) ? accepted : [accepted];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("starts a new turn instead of steering when a running session has no active turn", () =>
    Effect.gen(function* () {
      // Claude flips the session to "running" on its own system/status
      // notifications between turns, so status alone cannot prove a turn
      // exists. Steering nothing would hand the provider a turn the admission
      // gate can never correlate, and the user's message would vanish.
      const runningWithoutTurn = makeSession({
        status: "running",
        pendingTurnRequestId: undefined,
        pendingTurnMessageId: undefined,
        pendingTurnRequestedAt: undefined,
        pendingTurnDeadlineAt: undefined,
        pendingTurnSessionId: undefined,
        activeTurnRequestId: undefined,
        activeTurnId: null,
      });
      const commandId = CommandId.make("cmd-running-without-turn");
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId,
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("message-running-without-turn"),
            role: "user",
            text: "nothing is running, start a turn",
            attachments: [],
          },
          modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel(runningWithoutTurn),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.session-set",
        "thread.turn-start-requested",
      ]);
      expect(events[1]).toMatchObject({
        type: "thread.session-set",
        payload: {
          session: {
            status: "starting",
            pendingTurnRequestId: commandId,
            activeTurnId: null,
          },
        },
      });
      expect(events[2]).toMatchObject({
        type: "thread.turn-start-requested",
        payload: { admissionIntent: { kind: "start", expectedActiveTurnRequestId: null } },
      });
    }),
  );

  it.effect("captures the exact stop target and projects stopped atomically", () =>
    Effect.gen(function* () {
      const turnId = TurnId.make("turn-stop-target");
      const current = makeSession({
        status: "running",
        pendingTurnRequestId: undefined,
        pendingTurnMessageId: undefined,
        pendingTurnRequestedAt: undefined,
        pendingTurnDeadlineAt: undefined,
        pendingTurnSessionId: undefined,
        activeTurnRequestId: REQUEST_ID,
        activeTurnId: turnId,
      });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.stop",
          commandId: CommandId.make("cmd-exact-session-stop"),
          threadId: THREAD_ID,
          createdAt: NOW,
        },
        readModel: makeReadModel(current),
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events.map((event) => event.type)).toEqual([
        "thread.session-stop-requested",
        "thread.session-set",
      ]);
      expect(events[0]).toMatchObject({
        type: "thread.session-stop-requested",
        payload: {
          targetProviderInstanceId: INSTANCE_ID,
          targetSessionIncarnationId: INCARNATION_ID,
          targetPendingTurnSessionId: null,
          targetTurnRequestId: REQUEST_ID,
          targetTurnId: turnId,
        },
      });
      expect(events[1]).toMatchObject({
        type: "thread.session-set",
        payload: {
          session: {
            status: "stopped",
            providerInstanceId: INSTANCE_ID,
            sessionIncarnationId: INCARNATION_ID,
            activeTurnRequestId: REQUEST_ID,
            pendingStopRequestId: CommandId.make("cmd-exact-session-stop"),
            pendingStopProviderInstanceId: INSTANCE_ID,
            pendingStopSessionIncarnationId: INCARNATION_ID,
            pendingStopTurnRequestId: REQUEST_ID,
            pendingStopTurnId: turnId,
            activeTurnId: null,
          },
        },
      });
    }),
  );

  it.effect("rejects a turn composed against an older rollback source epoch", () =>
    Effect.gen(function* () {
      const session = makeSession({
        status: "ready",
        pendingTurnRequestId: undefined,
        pendingTurnMessageId: undefined,
        pendingTurnRequestedAt: undefined,
        pendingTurnDeadlineAt: undefined,
        pendingTurnSessionId: undefined,
      });
      const command = {
        type: "thread.turn.start" as const,
        commandId: CommandId.make("command-stale-source-epoch"),
        threadId: THREAD_ID,
        message: {
          messageId: MessageId.make("message-stale-source-epoch"),
          role: "user" as const,
          text: "Keep this unsent",
          attachments: [],
        },
        modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.4" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        sourceEpoch: 1,
        createdAt: NOW,
      };

      const rejected = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(session, 2),
      }).pipe(Effect.result);
      expect(rejected._tag).toBe("Failure");
      if (rejected._tag === "Failure") {
        expect(rejected.failure.message).toContain(
          "Thread source epoch mismatch: expected 1; actual 2.",
        );
      }

      const accepted = yield* decideOrchestrationCommand({
        command: {
          ...command,
          commandId: CommandId.make("command-current-source-epoch"),
          sourceEpoch: 2,
        },
        readModel: makeReadModel(session, 2),
      });
      const events = Array.isArray(accepted) ? accepted : [accepted];
      expect(events.map((event) => event.type)).toContain("thread.message-sent");
      expect(
        events.find((event) => event.type === "thread.turn-start-requested")?.payload.sourceEpoch,
      ).toBe(2);
    }),
  );

  it.effect("rejects a forged turn start while rollback recovery is active", () =>
    Effect.gen(function* () {
      const session = makeSession({
        status: "ready",
        pendingTurnRequestId: undefined,
        pendingTurnMessageId: undefined,
        pendingTurnRequestedAt: undefined,
        pendingTurnDeadlineAt: undefined,
        pendingTurnSessionId: undefined,
      });
      const readModel = makeReadModel(session, 2);
      const rollingBack = {
        ...readModel,
        threads: readModel.threads.map((thread) => ({
          ...thread,
          rollbackStatus: {
            state: "recovering" as const,
            updatedAt: NOW,
          },
        })),
      };
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("command-during-rollback"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("message-during-rollback"),
            role: "user",
            text: "Do not race rollback",
            attachments: [],
          },
          modelSelection: { instanceId: INSTANCE_ID, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          sourceEpoch: 2,
          createdAt: NOW,
        },
        readModel: rollingBack,
      }).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain(
          "cannot start a turn while rollback recovery is active",
        );
      }
    }),
  );
});
