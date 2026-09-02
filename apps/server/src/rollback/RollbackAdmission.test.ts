import {
  CheckpointRef,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import {
  RollbackSagaRepository,
  type RollbackSagaRepositoryShape,
} from "../persistence/Services/RollbackSagas.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { make as makeRollbackAdmission } from "./RollbackAdmission.ts";
import { RollbackWorkspace } from "./RollbackWorkspace.ts";

const threadId = ThreadId.make("thread-admission");
const projectId = ProjectId.make("project-admission");
const providerInstanceId = ProviderInstanceId.make("fake-absolute");
const sessionIncarnationId = RuntimeSessionId.make("session-admission");
const now = "2026-08-31T00:00:00.000Z";
const baselineRef = checkpointRefForThreadTurn(threadId, 0);
const turnOneRef = checkpointRefForThreadTurn(threadId, 1);
const turnTwoRef = checkpointRefForThreadTurn(threadId, 2);

type HarnessOptions = {
  readonly mode?: "absolute" | "relative" | "unsupported";
  readonly queueCount?: number;
  readonly workspaceMismatch?: boolean;
  readonly activeLease?: boolean;
  readonly missingAbsoluteMethod?: boolean;
  readonly checkpoints?: ReadonlyArray<number>;
};

const makeReadModel = (checkpoints: ReadonlyArray<number>): OrchestrationReadModel =>
  ({
    snapshotSequence: 10,
    projects: [
      {
        id: projectId,
        title: "Admission project",
        workspaceRoot: "/workspace/exact",
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        faviconPath: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: threadId,
        projectId,
        title: "Admission thread",
        modelSelection: { instanceId: providerInstanceId, model: "fake-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        linkedPullRequest: null,
        latestTurn: {
          turnId: TurnId.make("turn-2"),
          state: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          assistantMessageId: null,
        },
        rollbackStatus: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        titleRegeneration: null,
        continuedFromThreadId: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: checkpoints.map((checkpointTurnCount) => ({
          turnId: TurnId.make(`turn-${checkpointTurnCount}`),
          checkpointTurnCount,
          checkpointRef: checkpointTurnCount === 1 ? turnOneRef : turnTwoRef,
          status: "ready" as const,
          files: [],
          assistantMessageId: null,
          completedAt: now,
        })),
        session: {
          threadId,
          status: "idle",
          providerName: "fake",
          providerInstanceId,
          activeTurnId: null,
          startedAt: now,
          updatedAt: now,
        },
      },
    ],
    updatedAt: now,
  }) as unknown as OrchestrationReadModel;

const makeHarness = (options: HarnessOptions = {}) => {
  const mode = options.mode ?? "absolute";
  const checkpoints = options.checkpoints ?? [1, 2];
  const provider = {
    getCapabilities: () => Effect.succeed({ conversationRollback: mode }),
    hasAbsoluteConversationRollback: () => Effect.succeed(true),
    captureConversationAnchor: () => Effect.succeed({ anchor: {}, digest: "source" }),
    inspectConversationAnchor: () => Effect.succeed({ anchor: {}, digest: "source" }),
    applyConversationAnchor: () => Effect.void,
    getSessionInputQueue: () =>
      Effect.succeed({
        steeringCount: options.queueCount ?? 0,
        followUpCount: 0,
        mode: "steer",
        steering: [],
        followUps: [],
      }),
    listSessions: () =>
      Effect.succeed([
        {
          threadId,
          provider: "fake",
          providerInstanceId,
          sessionIncarnationId,
          cwd: options.workspaceMismatch ? "/workspace/other" : "/workspace/exact",
          status: "ready",
          createdAt: now,
          updatedAt: now,
        },
      ]),
  } as Record<string, unknown>;
  if (options.missingAbsoluteMethod === true) delete provider.applyConversationAnchor;

  const repository = {
    getCheckpointAnchor: (input: { readonly checkpointTurnCount: number }) =>
      Effect.succeed(
        Option.some({
          threadId,
          checkpointTurnCount: input.checkpointTurnCount,
          providerInstanceId,
          sessionIncarnationId,
          checkpointRef: input.checkpointTurnCount === 0 ? baselineRef : turnOneRef,
          checkpointOid: input.checkpointTurnCount === 0 ? "0".repeat(40) : "1".repeat(40),
          anchor: { leafId: `PRIVATE_TARGET_${input.checkpointTurnCount}` },
          anchorDigest: `target-${input.checkpointTurnCount}`,
          capturedAt: now,
        }),
      ),
    getActiveByThread: () => Effect.succeed(Option.none()),
    findLeaseByWorkspace: () =>
      Effect.succeed(
        options.activeLease === true
          ? Option.some({ operationId: "other-operation", threadId, projectId })
          : Option.none(),
      ),
  } as unknown as RollbackSagaRepositoryShape;

  const workspace = {
    resolveIdentity: (cwd: string) =>
      Effect.succeed({
        cwd,
        workspaceKey: cwd === "/workspace/exact" ? "exact-key" : "other-key",
        gitCommonDir: "/git/common",
      }),
    resolveCheckpoint: (input: { readonly checkpointRef: CheckpointRef }) =>
      Effect.succeed(
        input.checkpointRef === turnTwoRef
          ? { oid: "2".repeat(40), digest: "tree-2" }
          : input.checkpointRef === turnOneRef
            ? { oid: "1".repeat(40), digest: "tree-1" }
            : { oid: "0".repeat(40), digest: "tree-0" },
      ),
  };

  const admission = makeRollbackAdmission.pipe(
    Effect.provideService(ProviderService, provider as never),
    Effect.provideService(RollbackSagaRepository, repository),
    Effect.provideService(RollbackWorkspace, workspace as never),
    Effect.provide(NodeServices.layer),
  );
  return { admission, readModel: makeReadModel(checkpoints) };
};

const prepare = Effect.fn(function* (
  options: HarnessOptions,
  targetRevision: number,
  expectedSourceRevision: number | "omit" = 2,
) {
  const harness = makeHarness(options);
  const admission = yield* harness.admission;
  return yield* admission.prepare({
    command: {
      type: "thread.checkpoint.revert",
      commandId: "command-admission" as never,
      threadId,
      turnCount: targetRevision,
      ...(expectedSourceRevision === "omit" ? {} : { expectedSourceRevision }),
      createdAt: now,
    },
    readModel: harness.readModel,
    requestEventId: "request-event-admission",
  });
});

it.effect("admits turn 0 only from explicit immutable workspace and provider baselines", () =>
  Effect.gen(function* () {
    const admitted = yield* prepare({}, 0);
    assert.isTrue(Option.isSome(admitted));
    if (Option.isNone(admitted)) return;
    assert.equal(admitted.value.sourceRevision, 2);
    assert.equal(admitted.value.targetRevision, 0);
    assert.equal(admitted.value.targetCheckpointRef, baselineRef);
    assert.equal(admitted.value.targetCheckpointOid, "0".repeat(40));
    assert.deepEqual(admitted.value.desiredAnchor, { leafId: "PRIVATE_TARGET_0" });
    assert.equal(admitted.value.workspaceKey, "exact-key");
  }),
);

it.effect(
  "leaves every relative or unsupported production-style adapter on the fail-closed path",
  () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* prepare({ mode: "relative" }, 1)));
      assert.isTrue(Option.isNone(yield* prepare({ mode: "unsupported" }, 1)));
    }),
);

it.effect("requires the full absolute adapter contract and an empty provider queue", () =>
  Effect.gen(function* () {
    const incomplete = yield* prepare({ missingAbsoluteMethod: true }, 1).pipe(Effect.result);
    assert.equal(incomplete._tag, "Failure");
    const queued = yield* prepare({ queueCount: 1 }, 1).pipe(Effect.result);
    assert.equal(queued._tag, "Failure");
  }),
);

it.effect("rejects stale clients, partial checkpoint history, and mismatched workspaces", () =>
  Effect.gen(function* () {
    assert.equal((yield* prepare({}, 1, "omit").pipe(Effect.result))._tag, "Failure");
    assert.equal((yield* prepare({}, 1, 1).pipe(Effect.result))._tag, "Failure");
    assert.equal((yield* prepare({ checkpoints: [2] }, 0).pipe(Effect.result))._tag, "Failure");
    assert.equal(
      (yield* prepare({ workspaceMismatch: true }, 1).pipe(Effect.result))._tag,
      "Failure",
    );
  }),
);

it.effect("rejects a second thread or client when the canonical workspace lease is active", () =>
  Effect.gen(function* () {
    const result = yield* prepare({ activeLease: true }, 1).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
  }),
);
