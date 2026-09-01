// @effect-diagnostics preferSchemaOverJson:off
import {
  CheckpointRef,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../orchestration/Services/RuntimeReceiptBus.ts";
import {
  RollbackSagaRepository,
  type RollbackCheckpointAnchor,
  type RollbackSagaRecord,
  type RollbackSagaRepositoryShape,
  type RollbackSagaState,
} from "../persistence/Services/RollbackSagas.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { RollbackFaultInjector, make as makeRollbackSagaRunner } from "./RollbackSagaRunner.ts";
import { RollbackWorkspace, type RollbackWorkspacePreimage } from "./RollbackWorkspace.ts";

const threadId = ThreadId.make("thread-runner");
const projectId = ProjectId.make("project-runner");
const providerInstanceId = ProviderInstanceId.make("fake-absolute");
const sessionIncarnationId = RuntimeSessionId.make("fake-session-incarnation");
const now = "2026-08-31T00:00:00.000Z";
const privateTargetCanary = "PRIVATE_TARGET_LEAF_CANARY";
const privateSourceCanary = "PRIVATE_SOURCE_LEAF_CANARY";
const privatePreimageCanary = "/private/preimage/canary";

type ProviderMode = "success" | "unknown-target" | "stayed-source" | "wrong-target";

const makeState = (operationId: string): RollbackSagaState => ({
  operationId,
  requestEventId: `event-${operationId}`,
  threadId,
  projectId,
  workspaceKey: `workspace-${operationId}`,
  workspaceCwd: "/workspace/fake",
  sourceRevision: 2,
  targetRevision: 1,
  sourceTurnId: null,
  targetTurnId: null,
  sourceCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-runner/turn/2"),
  sourceCheckpointOid: "a".repeat(40),
  targetCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-runner/turn/1"),
  targetCheckpointOid: "b".repeat(40),
  targetCheckpointDigest: "target-tree-digest",
  providerInstanceId,
  sessionIncarnationId,
  phase: "source-anchor-capture-started",
  attempt: 0,
  lastErrorCode: null,
  compensation: "none",
  cleanup: "pending",
  sourceAnchor: null,
  sourceAnchorDigest: null,
  desiredAnchor: { leafId: privateTargetCanary },
  desiredAnchorDigest: "provider-target",
  preimage: null,
  workspaceReceiptDigest: null,
  providerReceiptDigest: null,
  projectionCommitSequence: null,
  createdAt: now,
  updatedAt: now,
});

const makeEnvironment = (
  operationId: string,
  providerMode: ProviderMode = "success",
  cleanupFailures = 0,
  projectionCommitFails = false,
) => {
  let record: RollbackSagaRecord = {
    operationId,
    requestEventId: `event-${operationId}`,
    threadId,
    projectId,
    workspaceKey: `workspace-${operationId}`,
    phase: "source-anchor-capture-started",
    terminal: false,
    ownerId: null,
    version: 0,
    state: makeState(operationId),
    createdAt: now,
    updatedAt: now,
  };
  let lease = true;
  let providerDigest = "provider-source";
  let currentProviderMode = providerMode;
  let workspaceDigest = "workspace-source";
  let preimageCleaned = false;
  let anchorsDeleted = false;
  let staleRefsDeleted = false;
  let projectionCommitted = false;
  let projectionCommits = 0;
  const commands: OrchestrationCommand[] = [];
  const runtimeReceipts: OrchestrationRuntimeReceipt[] = [];

  const preimage: RollbackWorkspacePreimage = {
    backupPath: privatePreimageCanary,
    digest: "workspace-source",
    indexPath: "/private/index/canary",
    indexExisted: true,
    headSymbolic: "refs/heads/main",
    headOid: "f".repeat(40),
    ownedRefs: [],
    paths: ["tracked.txt"],
    entryCount: 3,
    totalBytes: 42,
  };

  const repository: RollbackSagaRepositoryShape = {
    admit: () => Effect.void,
    get: (id) => Effect.succeed(id === operationId ? Option.some(record) : Option.none()),
    getByRequestEvent: (eventId) =>
      Effect.succeed(eventId === record.requestEventId ? Option.some(record) : Option.none()),
    getActiveByThread: (id) =>
      Effect.succeed(id === threadId && !record.terminal ? Option.some(record) : Option.none()),
    listNonterminal: () => Effect.succeed(record.terminal ? [] : [record]),
    listNonterminalForFence: () => Effect.succeed(record.terminal ? [] : [record]),
    clearOwnersForStartup: () =>
      Effect.sync(() => {
        if (!record.terminal) record = { ...record, ownerId: null };
      }),
    claim: (id, ownerId) =>
      Effect.sync(() => {
        if (
          id !== operationId ||
          record.terminal ||
          (record.ownerId !== null && record.ownerId !== ownerId)
        ) {
          return Option.none<RollbackSagaRecord>();
        }
        record = { ...record, ownerId };
        return Option.some(record);
      }),
    updateOwned: (input) =>
      Effect.sync(() => {
        if (
          record.terminal ||
          record.operationId !== input.operationId ||
          record.ownerId !== input.ownerId ||
          record.version !== input.expectedVersion
        )
          return Option.none<RollbackSagaRecord>();
        record = {
          ...record,
          phase: input.state.phase,
          terminal: input.terminal === true,
          version: record.version + 1,
          state: input.state,
          updatedAt: input.state.updatedAt,
        };
        return Option.some(record);
      }),
    releaseOwnerOwned: (id, ownerId) =>
      Effect.sync(() => {
        if (record.operationId === id && record.ownerId === ownerId && !record.terminal) {
          record = { ...record, ownerId: null };
        }
      }),
    releaseLeaseOwned: (input) =>
      Effect.sync(() => {
        if (
          record.terminal ||
          record.operationId !== input.operationId ||
          record.ownerId !== input.ownerId ||
          record.version !== input.expectedVersion
        )
          return Option.none<RollbackSagaRecord>();
        record = {
          ...record,
          phase: input.state.phase,
          terminal: true,
          ownerId: null,
          version: record.version + 1,
          state: input.state,
          updatedAt: input.state.updatedAt,
        };
        lease = false;
        return Option.some(record);
      }),
    findLeaseByWorkspace: () =>
      Effect.succeed(lease ? Option.some({ operationId, threadId, projectId }) : Option.none()),
    putCheckpointAnchor: () => Effect.void,
    getCheckpointAnchor: () => Effect.succeed(Option.none<RollbackCheckpointAnchor>()),
    deleteCheckpointAnchorsAfter: () =>
      Effect.sync(() => {
        anchorsDeleted = true;
      }),
  };

  const provider = {
    captureConversationAnchor: () =>
      Effect.succeed({
        anchor: { leafId: privateSourceCanary },
        digest: providerDigest,
      }),
    inspectConversationAnchor: () =>
      Effect.sync(() => ({
        anchor: { leafId: providerDigest },
        digest: providerDigest,
      })),
    releaseConversationAnchor: () => Effect.void,
    applyConversationAnchor: (input: { readonly anchor: unknown }) =>
      Effect.suspend(() => {
        const isTarget =
          (input.anchor as { readonly leafId?: string }).leafId === privateTargetCanary;
        if (!isTarget) {
          providerDigest = "provider-source";
          return Effect.void;
        }
        switch (currentProviderMode) {
          case "success":
            providerDigest = "provider-target";
            return Effect.void;
          case "unknown-target":
            providerDigest = "provider-target";
            return Effect.fail("provider-timeout");
          case "stayed-source":
            return Effect.fail("provider-failed");
          case "wrong-target":
            providerDigest = "provider-wrong";
            return Effect.void;
        }
      }),
  };

  const workspace = {
    capturePreimage: () => Effect.succeed(preimage),
    applyCheckpoint: () =>
      Effect.sync(() => {
        workspaceDigest = "workspace-target";
        return {
          digest: workspaceDigest,
          headSymbolic: "refs/heads/main",
          headOid: "f".repeat(40),
        };
      }),
    restorePreimage: () =>
      Effect.sync(() => {
        workspaceDigest = "workspace-source";
        return {
          digest: workspaceDigest,
          headSymbolic: "refs/heads/main",
          headOid: "f".repeat(40),
        };
      }),
    inspect: () =>
      Effect.succeed({
        digest: workspaceDigest,
        treeDigest: workspaceDigest,
        headSymbolic: "refs/heads/main",
        headOid: "f".repeat(40),
      }),
    inspectCheckpoint: () =>
      Effect.succeed({
        digest: workspaceDigest,
        treeDigest: workspaceDigest,
        headSymbolic: "refs/heads/main",
        headOid: "f".repeat(40),
      }),
    cleanupPreimage: () =>
      Effect.suspend(() => {
        if (cleanupFailures > 0) {
          cleanupFailures -= 1;
          return Effect.fail("cleanup-failed");
        }
        preimageCleaned = true;
        return Effect.void;
      }),
  };

  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.suspend(() => {
        commands.push(command);
        if (command.type === "thread.revert.complete" && projectionCommitFails) {
          return Effect.fail("projection-cas-failed");
        }
        if (command.type === "thread.revert.complete" && !projectionCommitted) {
          projectionCommitted = true;
          projectionCommits += 1;
        }
        return Effect.succeed({ sequence: 100, eventCount: 1 });
      }),
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(100),
  };

  const checkpointStore = {
    deleteCheckpointRefs: () =>
      Effect.sync(() => {
        staleRefsDeleted = true;
      }),
  };
  const receipts = {
    publish: (receipt: OrchestrationRuntimeReceipt) =>
      Effect.sync(() => {
        runtimeReceipts.push(receipt);
      }),
    streamEventsForTest: Stream.empty,
  };

  const makeRunner = (faultLabel: string | null = null) => {
    let armed = true;
    const fault = (label: string) => {
      if (armed && label === faultLabel) {
        armed = false;
        return Effect.interrupt;
      }
      return Effect.void;
    };
    return makeRollbackSagaRunner.pipe(
      Effect.provideService(RollbackSagaRepository, repository),
      Effect.provideService(RollbackWorkspace, workspace as never),
      Effect.provideService(ProviderService, provider as never),
      Effect.provideService(OrchestrationEngineService, engine as never),
      Effect.provideService(CheckpointStore, checkpointStore as never),
      Effect.provideService(RuntimeReceiptBus, receipts),
      Effect.provideService(RollbackFaultInjector, fault),
      Effect.provide(NodeServices.layer),
    );
  };

  return {
    repository,
    makeRunner,
    setProviderDigest: (digest: string) => {
      providerDigest = digest;
    },
    setProviderMode: (mode: ProviderMode) => {
      currentProviderMode = mode;
    },
    snapshot: () => ({
      record,
      lease,
      providerDigest,
      workspaceDigest,
      preimageCleaned,
      anchorsDeleted,
      staleRefsDeleted,
      projectionCommitted,
      projectionCommits,
      commands,
      runtimeReceipts,
    }),
  };
};

const runInterrupted = Effect.fn(function* (
  runner: { readonly run: (operationId: string, recovering: boolean) => Effect.Effect<void> },
  operationId: string,
) {
  const fiber = yield* runner
    .run(operationId, false)
    .pipe(Effect.forkChild({ startImmediately: true }));
  return yield* Fiber.await(fiber);
});

it.effect("commits last, clears private state, and never publishes private canaries", () =>
  Effect.gen(function* () {
    const environment = makeEnvironment("operation-success");
    const runner = yield* environment.makeRunner();
    yield* runner.run("operation-success", false);
    const snapshot = environment.snapshot();

    assert.equal(snapshot.record.state.phase, "complete");
    assert.isTrue(snapshot.record.terminal);
    assert.isFalse(snapshot.lease);
    assert.equal(snapshot.workspaceDigest, "workspace-target");
    assert.equal(snapshot.providerDigest, "provider-target");
    assert.equal(snapshot.projectionCommits, 1);
    assert.isTrue(snapshot.preimageCleaned);
    assert.isTrue(snapshot.anchorsDeleted);
    assert.isTrue(snapshot.staleRefsDeleted);
    assert.equal(snapshot.record.state.sourceAnchor, null);
    assert.equal(snapshot.record.state.desiredAnchor, null);
    assert.equal(snapshot.record.state.preimage, null);

    const publicJson = JSON.stringify({
      commands: snapshot.commands,
      receipts: snapshot.runtimeReceipts,
    });
    assert.notInclude(publicJson, privateTargetCanary);
    assert.notInclude(publicJson, privateSourceCanary);
    assert.notInclude(publicJson, privatePreimageCanary);
    const completeIndex = snapshot.commands.findIndex(
      (command) => command.type === "thread.revert.complete",
    );
    assert.isAtLeast(completeIndex, 0);
    const terminalStatus = snapshot.commands.findLast(
      (command) => command.type === "thread.rollback.status.set",
    );
    assert.equal(terminalStatus?.status, "completed");
    assert.equal(terminalStatus?.targetTurnCount, 1);
    assert.equal(terminalStatus?.sourceRevision, 2);
    assert.deepEqual(terminalStatus?.allowedActions, []);
    assert.isTrue(
      snapshot.runtimeReceipts.some(
        (receipt) => receipt.type === "rollback.saga.phase" && receipt.phase === "complete",
      ),
    );
  }),
);

it.effect("reconciles an unknown provider result by inspecting the exact target", () =>
  Effect.gen(function* () {
    const environment = makeEnvironment("operation-unknown-target", "unknown-target");
    const runner = yield* environment.makeRunner();
    yield* runner.run("operation-unknown-target", false);
    const snapshot = environment.snapshot();
    assert.equal(snapshot.record.state.phase, "complete");
    assert.equal(snapshot.providerDigest, "provider-target");
    assert.equal(snapshot.projectionCommits, 1);
  }),
);

it.effect("reapplies the target after a compatible reconnect returns to source", () =>
  Effect.gen(function* () {
    const operationId = "operation-reconnect-source";
    const environment = makeEnvironment(operationId);
    const interrupted = yield* environment.makeRunner("persisted:provider-applied");
    yield* runInterrupted(interrupted, operationId);
    assert.equal(environment.snapshot().record.state.phase, "provider-applied");

    environment.setProviderDigest("provider-source");
    yield* environment.repository.clearOwnersForStartup();
    const recovered = yield* environment.makeRunner();
    yield* recovered.run(operationId, true);
    const snapshot = environment.snapshot();
    assert.equal(snapshot.providerDigest, "provider-target");
    assert.equal(snapshot.record.state.phase, "complete");
    assert.equal(snapshot.projectionCommits, 1);
  }),
);

it.effect("fails closed when reconnect inspection finds a third provider leaf", () =>
  Effect.gen(function* () {
    const operationId = "operation-reconnect-third-leaf";
    const environment = makeEnvironment(operationId);
    const interrupted = yield* environment.makeRunner("persisted:provider-applied");
    yield* runInterrupted(interrupted, operationId);
    environment.setProviderDigest("provider-third");
    yield* environment.repository.clearOwnersForStartup();

    const recovered = yield* environment.makeRunner();
    yield* recovered.run(operationId, true);
    const snapshot = environment.snapshot();
    assert.equal(snapshot.record.state.phase, "manual-recovery");
    assert.isFalse(snapshot.projectionCommitted);
  }),
);

it.effect("enters manual recovery when the target cannot be reproved after projection", () =>
  Effect.gen(function* () {
    const operationId = "operation-post-projection-source";
    const environment = makeEnvironment(operationId);
    const interrupted = yield* environment.makeRunner("persisted:projection-committed");
    yield* runInterrupted(interrupted, operationId);
    assert.equal(environment.snapshot().record.state.phase, "projection-committed");
    assert.equal(environment.snapshot().projectionCommits, 1);

    environment.setProviderDigest("provider-source");
    environment.setProviderMode("stayed-source");
    yield* environment.repository.clearOwnersForStartup();
    const recovered = yield* environment.makeRunner();
    yield* recovered.run(operationId, true);

    const snapshot = environment.snapshot();
    assert.equal(snapshot.record.state.phase, "manual-recovery");
    assert.equal(snapshot.record.state.attempt, 2);
    assert.equal(snapshot.projectionCommits, 1);
    assert.isFalse(snapshot.record.terminal);
  }),
);

it.effect("compensates workspace and provider when the provider stays at source", () =>
  Effect.gen(function* () {
    const environment = makeEnvironment("operation-compensate", "stayed-source");
    const runner = yield* environment.makeRunner();
    yield* runner.run("operation-compensate", false);
    const snapshot = environment.snapshot();
    assert.equal(snapshot.record.state.phase, "compensated");
    assert.isTrue(snapshot.record.terminal);
    assert.equal(snapshot.workspaceDigest, "workspace-source");
    assert.equal(snapshot.providerDigest, "provider-source");
    assert.equal(snapshot.projectionCommits, 0);
    assert.isFalse(snapshot.lease);
    assert.isFalse(snapshot.commands.some((command) => command.type === "thread.revert.complete"));
    const status = snapshot.commands.findLast(
      (command) => command.type === "thread.rollback.status.set",
    );
    assert.equal(status?.status, "failed");
    assert.include(status?.detail ?? "", "no thread content was removed");
  }),
);

it.effect(
  "fails closed in manual recovery when inspection finds an unrelated provider anchor",
  () =>
    Effect.gen(function* () {
      const environment = makeEnvironment("operation-wrong-target", "wrong-target");
      const runner = yield* environment.makeRunner();
      yield* runner.run("operation-wrong-target", false);
      const snapshot = environment.snapshot();
      assert.equal(snapshot.record.state.phase, "manual-recovery");
      assert.isFalse(snapshot.record.terminal);
      assert.isTrue(snapshot.lease);
      assert.equal(snapshot.workspaceDigest, "workspace-target");
      assert.equal(snapshot.providerDigest, "provider-wrong");
      assert.equal(snapshot.projectionCommits, 0);
      assert.isTrue(
        snapshot.commands.some(
          (command) =>
            command.type === "thread.rollback.status.set" &&
            command.status === "manual-recovery" &&
            command.allowedActions?.includes("resume-compensation"),
        ),
      );

      const restarted = yield* environment.makeRunner();
      yield* restarted.run("operation-wrong-target", true);
      const statusCommands = environment
        .snapshot()
        .commands.filter((command) => command.type === "thread.rollback.status.set");
      assert.equal(statusCommands.at(-1)?.status, "manual-recovery");
    }),
);

it.effect("resumes server-authorized compensation and reports a safe durable failure", () =>
  Effect.gen(function* () {
    const operationId = "operation-manual-resume-compensation";
    const environment = makeEnvironment(operationId, "wrong-target");
    const runner = yield* environment.makeRunner();
    yield* runner.run(operationId, false);
    assert.equal(environment.snapshot().record.state.phase, "manual-recovery");

    yield* runner.recover({ threadId, action: "resume-compensation" });
    const snapshot = environment.snapshot();
    assert.equal(snapshot.record.state.phase, "compensated");
    assert.isTrue(snapshot.record.terminal);
    assert.isFalse(snapshot.lease);
    assert.equal(snapshot.workspaceDigest, "workspace-source");
    assert.equal(snapshot.providerDigest, "provider-source");
    assert.isFalse(snapshot.commands.some((command) => command.type === "thread.revert.complete"));
    const status = snapshot.commands.findLast(
      (command) => command.type === "thread.rollback.status.set",
    );
    assert.equal(status?.status, "failed");
    assert.deepEqual(status?.allowedActions, []);
  }),
);

it.effect("retries post-commit verification without committing projection twice", () =>
  Effect.gen(function* () {
    const operationId = "operation-manual-retry-verification";
    const environment = makeEnvironment(operationId);
    const interrupted = yield* environment.makeRunner("persisted:projection-committed");
    yield* runInterrupted(interrupted, operationId);
    environment.setProviderDigest("provider-source");
    environment.setProviderMode("stayed-source");
    yield* environment.repository.clearOwnersForStartup();
    const recovering = yield* environment.makeRunner();
    yield* recovering.run(operationId, true);
    const manual = environment.snapshot();
    assert.equal(manual.record.state.phase, "manual-recovery");
    const manualStatus = manual.commands.findLast(
      (command) => command.type === "thread.rollback.status.set",
    );
    assert.deepEqual(manualStatus?.allowedActions, ["retry-verification"]);

    environment.setProviderMode("success");
    yield* recovering.recover({ threadId, action: "retry-verification" });
    const complete = environment.snapshot();
    assert.equal(complete.record.state.phase, "complete");
    assert.isTrue(complete.record.terminal);
    assert.equal(complete.projectionCommits, 1);
    assert.equal(complete.providerDigest, "provider-target");
    assert.equal(
      complete.commands.findLast((command) => command.type === "thread.rollback.status.set")
        ?.status,
      "completed",
    );
  }),
);

it.effect("rejects recovery actions that the durable phase does not authorize", () =>
  Effect.gen(function* () {
    const environment = makeEnvironment("operation-action-not-allowed");
    const runner = yield* environment.makeRunner();
    const error = yield* runner.recover({ threadId, action: "retry-verification" }).pipe(
      Effect.match({
        onFailure: (failure) => failure,
        onSuccess: () => null,
      }),
    );
    assert.equal(error?.reason, "action-not-allowed");
    assert.equal(environment.snapshot().record.state.phase, "source-anchor-capture-started");
  }),
);

it.effect("lets only one client claim a permitted recovery action", () =>
  Effect.gen(function* () {
    const operationId = "operation-recovery-busy";
    const environment = makeEnvironment(operationId, "wrong-target");
    const runner = yield* environment.makeRunner();
    yield* runner.run(operationId, false);
    const claimed = yield* environment.repository.claim(operationId, "other-client");
    assert.equal(claimed._tag, "Some");

    const error = yield* runner.recover({ threadId, action: "resume-compensation" }).pipe(
      Effect.match({
        onFailure: (failure) => failure,
        onSuccess: () => null,
      }),
    );
    assert.equal(error?.reason, "operation-busy");
    assert.equal(environment.snapshot().record.state.phase, "manual-recovery");
  }),
);

it.effect("releases only the worker owner and retries post-commit cleanup idempotently", () =>
  Effect.gen(function* () {
    const environment = makeEnvironment("operation-cleanup-retry", "success", 1);
    const firstRunner = yield* environment.makeRunner();
    yield* firstRunner.run("operation-cleanup-retry", false);
    const pending = environment.snapshot();
    assert.equal(pending.record.state.phase, "cleanup-started");
    assert.isFalse(pending.record.terminal);
    assert.equal(pending.record.ownerId, null);
    assert.isTrue(pending.lease);
    assert.equal(pending.projectionCommits, 1);

    const retryRunner = yield* environment.makeRunner();
    yield* retryRunner.run("operation-cleanup-retry", true);
    const complete = environment.snapshot();
    assert.equal(complete.record.state.phase, "complete");
    assert.isTrue(complete.record.terminal);
    assert.isFalse(complete.lease);
    assert.equal(complete.projectionCommits, 1);
    assert.isTrue(complete.preimageCleaned);
  }),
);

it.effect("compensates a proved provider and workspace target when projection CAS fails", () =>
  Effect.gen(function* () {
    const environment = makeEnvironment("operation-projection-cas", "success", 0, true);
    const runner = yield* environment.makeRunner();
    yield* runner.run("operation-projection-cas", false);
    const snapshot = environment.snapshot();
    assert.equal(snapshot.record.state.phase, "compensated");
    assert.isTrue(snapshot.record.terminal);
    assert.equal(snapshot.workspaceDigest, "workspace-source");
    assert.equal(snapshot.providerDigest, "provider-source");
    assert.equal(snapshot.projectionCommits, 0);
    assert.isFalse(snapshot.lease);
  }),
);

const compensationFaultLabels = [
  "persisted:compensation-workspace-started",
  "side-effect:workspace-compensated",
  "persisted:compensation-workspace-complete",
  "persisted:compensation-provider-started",
  "side-effect:provider-compensated",
  "persisted:compensated",
] as const;

for (const faultLabel of compensationFaultLabels) {
  it.effect(`reconciles compensation after a crash at ${faultLabel}`, () =>
    Effect.gen(function* () {
      const operationId = `operation-compensation-fault-${faultLabel}`;
      const environment = makeEnvironment(operationId, "success", 0, true);
      const interruptedRunner = yield* environment.makeRunner(faultLabel);
      const exit = yield* runInterrupted(interruptedRunner, operationId);
      assert.equal(exit._tag, "Failure");

      yield* environment.repository.clearOwnersForStartup();
      const restartedRunner = yield* environment.makeRunner();
      yield* restartedRunner.run(operationId, true);
      const snapshot = environment.snapshot();
      assert.equal(
        snapshot.record.state.phase,
        "compensated",
        JSON.stringify({
          faultLabel,
          error: snapshot.record.state.lastErrorCode,
          compensation: snapshot.record.state.compensation,
          workspace: snapshot.workspaceDigest,
          provider: snapshot.providerDigest,
        }),
      );
      assert.isTrue(snapshot.record.terminal);
      assert.equal(snapshot.workspaceDigest, "workspace-source");
      assert.equal(snapshot.providerDigest, "provider-source");
      assert.equal(snapshot.projectionCommits, 0);
      assert.isFalse(snapshot.lease);
    }),
  );
}

it.effect("restores durable manual recovery status after a crash before status projection", () =>
  Effect.gen(function* () {
    const operationId = "operation-manual-status-crash";
    const environment = makeEnvironment(operationId, "wrong-target");
    const interruptedRunner = yield* environment.makeRunner("persisted:manual-recovery");
    const exit = yield* runInterrupted(interruptedRunner, operationId);
    assert.equal(exit._tag, "Failure");

    yield* environment.repository.clearOwnersForStartup();
    const restartedRunner = yield* environment.makeRunner();
    yield* restartedRunner.run(operationId, true);
    const snapshot = environment.snapshot();
    assert.equal(snapshot.record.state.phase, "manual-recovery");
    assert.isFalse(snapshot.record.terminal);
    assert.isTrue(snapshot.lease);
    const statuses = snapshot.commands.filter(
      (command) => command.type === "thread.rollback.status.set",
    );
    assert.equal(statuses.at(-1)?.status, "manual-recovery");
  }),
);

const restartFaultLabels = [
  "side-effect:source-anchor-captured",
  "persisted:source-anchor-captured",
  "persisted:preimage-capture-started",
  "side-effect:preimage-captured",
  "persisted:preimage-captured",
  "persisted:workspace-apply-started",
  "side-effect:workspace-target-applied",
  "persisted:workspace-applied",
  "persisted:provider-apply-started",
  "side-effect:provider-target-applied",
  "persisted:provider-applied",
  "persisted:projection-commit-started",
  "side-effect:projection-committed",
  "persisted:projection-committed",
  "persisted:cleanup-started",
  "side-effect:cleanup",
  "persisted:complete",
] as const;

for (const faultLabel of restartFaultLabels) {
  it.effect(`reconciles deterministically after a crash at ${faultLabel}`, () =>
    Effect.gen(function* () {
      const operationId = `operation-fault-${faultLabel}`;
      const environment = makeEnvironment(operationId);
      const interruptedRunner = yield* environment.makeRunner(faultLabel);
      const exit = yield* runInterrupted(interruptedRunner, operationId);
      assert.equal(exit._tag, "Failure");

      yield* environment.repository.clearOwnersForStartup();
      const restartedRunner = yield* environment.makeRunner();
      yield* restartedRunner.run(operationId, true);
      const snapshot = environment.snapshot();
      assert.equal(snapshot.record.state.phase, "complete");
      assert.isTrue(snapshot.record.terminal);
      assert.isFalse(snapshot.lease);
      assert.equal(snapshot.workspaceDigest, "workspace-target");
      assert.equal(snapshot.providerDigest, "provider-target");
      assert.equal(snapshot.projectionCommits, 1);
      assert.isTrue(snapshot.preimageCleaned);
      assert.isTrue(snapshot.anchorsDeleted);
      assert.isTrue(snapshot.staleRefsDeleted);
    }),
  );
}
