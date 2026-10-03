import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  IsoDateTime,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  CheckpointId,
  RunAttemptId,
  RunId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type ProviderSession,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "../../orchestration-v2/ProviderAdapter.ts";
import { legacyAdapterV2Capabilities, makeLegacyAdapterV2 } from "./LegacyAdapterV2Bridge.ts";
import * as Maintenance from "./LegacyAdapterV2Maintenance.ts";
import { makeLegacyRuntimeEventProjector } from "./LegacyRuntimeEventProjector.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";

const driver = ProviderDriverKind.make("primeAgent");
const instanceId = ProviderInstanceId.make("prime-test");
const threadId = ThreadId.make("thread-prime");
const providerSessionId = ProviderSessionId.make("session-prime");
const nativeTurnId = TurnId.make("turn-native");
const time = IsoDateTime.make("2026-10-02T12:00:00.000Z");
const now = DateTime.makeUnsafe(time);
const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const decodeV2Event = Schema.decodeUnknownSync(ProviderAdapterV2Event);
let nextEventId = 0;
function event(
  type: string,
  payload: unknown,
  extra: Readonly<Record<string, unknown>> = {},
): ProviderRuntimeEvent {
  return decodeEvent({
    eventId: EventId.make(`event:${++nextEventId}`),
    provider: driver,
    providerInstanceId: instanceId,
    threadId,
    turnId: nativeTurnId,
    createdAt: time,
    type,
    payload,
    ...extra,
  });
}

function legacyAdapter<Error = never>(
  overrides: Partial<ProviderAdapterShape<Error>> = {},
): ProviderAdapterShape<Error> {
  const session: ProviderSession = {
    provider: driver,
    providerInstanceId: instanceId,
    threadId,
    status: "ready",
    runtimeMode: "full-access",
    cwd: "/workspace",
    model: "prime-model",
    createdAt: time,
    updatedAt: time,
  };
  return {
    provider: driver,
    capabilities: { sessionModelSwitch: "in-session", conversationRollback: "unsupported" },
    startSession: () => Effect.succeed(session),
    sendTurn: () => Effect.succeed({ threadId, turnId: nativeTurnId }),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    readThread: () => Effect.succeed({ threadId, turns: [] }),
    rollbackThread: () => Effect.succeed({ threadId, turns: [] }),
    stopSession: () => Effect.void,
    hasSession: () => Effect.succeed(true),
    listSessions: () => Effect.succeed([session]),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
    ...overrides,
  };
}

function fixture() {
  const capabilities = legacyAdapterV2Capabilities(legacyAdapter());
  const providerSession: OrchestrationV2ProviderSession = {
    id: providerSessionId,
    driver,
    providerInstanceId: instanceId,
    status: "ready",
    cwd: "/workspace",
    model: "prime-model",
    capabilities,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  const providerThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("thread-provider"),
    driver,
    providerInstanceId: instanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const projector = makeLegacyRuntimeEventProjector({ providerSession, providerThread });
  const turnInput = makeTurnInput(providerThread);
  projector.prepareTurn(turnInput);
  return { projector, turnInput, providerThread };
}

function makeTurnInput(
  providerThread: OrchestrationV2ProviderThread,
  ordinal = 1,
): ProviderAdapterV2TurnInput {
  const modelSelection = { instanceId, model: "prime-model" };
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project-test"),
      title: "Prime bridge",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId,
    runId: RunId.make(`run:${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt:${ordinal}`),
    rootNodeId: NodeId.make(`node:${ordinal}`),
    providerThread,
    message: {
      messageId: MessageId.make(`message:${ordinal}`),
      text: "Run the task",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/workspace" },
  };
}

describe("legacy runtime event projector", () => {
  it("projects a golden Prime response, reasoning, tool, usage and terminal sequence", () => {
    const { projector, turnInput } = fixture();
    const assistantId = RuntimeItemId.make("assistant-native");
    const toolId = RuntimeItemId.make("tool-native");
    const output = [
      event("session.started", {}),
      event("thread.started", { providerThreadId: "prime-native-session" }),
      event("turn.started", { model: "prime-model" }),
      event(
        "item.started",
        { itemType: "assistant_message", status: "inProgress" },
        { itemId: assistantId },
      ),
      event(
        "content.delta",
        { streamKind: "assistant_text", delta: "Hello " },
        { itemId: assistantId },
      ),
      event(
        "content.delta",
        { streamKind: "assistant_text", delta: "world" },
        { itemId: assistantId },
      ),
      event(
        "item.completed",
        { itemType: "reasoning", status: "completed", detail: "Checking the task" },
        { itemId: RuntimeItemId.make("reason-native") },
      ),
      event(
        "item.started",
        { itemType: "command_execution", title: "Shell", data: { command: "pwd" } },
        { itemId: toolId },
      ),
      event(
        "content.delta",
        { streamKind: "command_output", delta: "/workspace" },
        { itemId: toolId },
      ),
      event(
        "item.completed",
        { itemType: "command_execution", status: "completed", data: { exitCode: 0 } },
        { itemId: toolId },
      ),
      event("thread.token-usage.updated", { usage: { usedTokens: 42, maxTokens: 1000 } }),
      event(
        "item.completed",
        { itemType: "assistant_message", status: "completed" },
        { itemId: assistantId },
      ),
      event("turn.completed", { state: "completed" }),
    ].flatMap(projector.project);
    for (const row of output) decodeV2Event(row);
    const snapshot = projector.snapshot();
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({
      text: "Hello world",
      streaming: false,
      runId: turnInput.runId,
    });
    expect(
      output.findLast(
        (row) => row.type === "node.updated" && row.node.kind === "assistant_message",
      ),
    ).toMatchObject({
      node: {
        id: snapshot.messages[0]?.nodeId,
        parentNodeId: turnInput.rootNodeId,
        rootNodeId: turnInput.rootNodeId,
        status: "completed",
      },
    });
    expect(snapshot.providerThread.nativeThreadRef?.nativeId).toBe("prime-native-session");
    expect(snapshot.providerTurns[0]).toMatchObject({
      status: "completed",
      ordinal: 1,
      tokenUsage: { usedTokens: 42, maxTokens: 1000 },
    });
    expect(
      output.findLast(
        (row) => row.type === "turn_item.updated" && row.turnItem.type === "command_execution",
      ),
    ).toMatchObject({
      turnItem: { input: "pwd", output: "/workspace", exitCode: 0, status: "completed" },
    });
    expect(output.filter((row) => row.type === "turn.terminal")).toEqual([
      expect.objectContaining({ status: "completed", runOrdinal: 1, failure: null }),
    ]);
  });

  it("preserves request identities, nested work and both plan forms", () => {
    const { projector } = fixture();
    const requestId = RuntimeRequestId.make("request-native");
    const questionId = RuntimeRequestId.make("question-native");
    const output = [
      event("turn.started", {}),
      event(
        "request.opened",
        { requestType: "command_execution_approval", detail: "Run pwd?" },
        { requestId },
      ),
      event(
        "request.resolved",
        { requestType: "command_execution_approval", decision: "accept" },
        { requestId },
      ),
      event(
        "user-input.requested",
        {
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Which option?",
              options: [{ label: "A", description: "First" }],
            },
          ],
        },
        { requestId: questionId },
      ),
      event("user-input.resolved", { answers: { choice: "A" } }, { requestId: questionId }),
      event("task.started", {
        taskId: "agent-native",
        description: "Inspect files",
        title: "Inspector",
      }),
      event("task.progress", {
        taskId: "agent-native",
        description: "Reading files",
        summary: "Read one file",
      }),
      event("task.completed", {
        taskId: "agent-native",
        status: "completed",
        summary: "All checked",
      }),
      event("turn.plan.updated", {
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Fix", status: "inProgress" },
        ],
      }),
      event("turn.proposed.delta", { delta: "# Plan\n" }),
      event("turn.proposed.completed", { planMarkdown: "# Plan\nShip the fix" }),
      event("turn.completed", { state: "completed" }),
    ].flatMap(projector.project);
    for (const row of output) decodeV2Event(row);
    expect(projector.snapshot().runtimeRequests).toEqual([
      expect.objectContaining({ status: "resolved", decision: "accept" }),
      expect.objectContaining({ status: "resolved", answers: { choice: "A" } }),
    ]);
    const runtimeRequest = projector.snapshot().runtimeRequests[0]!;
    expect(projector.getRequestRoute(runtimeRequest.id)).toMatchObject({
      legacyRequestId: requestId,
      kind: "approval",
    });
    expect(output.findLast((row) => row.type === "subagent.updated")).toMatchObject({
      subagent: {
        prompt: "Inspect files",
        progress: "Read one file",
        result: "All checked",
        status: "completed",
      },
    });
    expect(
      output.findLast((row) => row.type === "plan.updated" && row.plan.kind === "proposed_plan"),
    ).toMatchObject({ plan: { markdown: "# Plan\nShip the fix" } });
    expect(
      output.find((row) => row.type === "plan.updated" && row.plan.kind === "todo_list"),
    ).toMatchObject({
      plan: {
        steps: [
          { text: "Inspect", status: "completed" },
          { text: "Fix", status: "running" },
        ],
      },
    });
  });

  it("settles streaming output and requests on failure exactly once and filters other owners", () => {
    const { projector } = fixture();
    const started = event("turn.started", {});
    projector.project(started);
    expect(projector.project(started)).toEqual([]);
    expect(
      projector.project(
        event(
          "content.delta",
          { streamKind: "assistant_text", delta: "wrong" },
          { threadId: "another-thread" },
        ),
      ),
    ).toEqual([]);
    projector.project(
      event(
        "content.delta",
        { streamKind: "assistant_text", delta: "partial" },
        { itemId: "message" },
      ),
    );
    projector.project(
      event("request.opened", { requestType: "permission_approval" }, { requestId: "pending" }),
    );
    const failed = event("turn.completed", { state: "failed", errorMessage: "The request failed" });
    const output = projector.project(failed);
    for (const row of output) decodeV2Event(row);
    expect(projector.snapshot().messages[0]).toMatchObject({ text: "partial", streaming: false });
    expect(projector.snapshot().runtimeRequests[0]).toMatchObject({ status: "expired" });
    expect(output.find((row) => row.type === "turn.terminal")).toMatchObject({
      status: "failed",
      failureItemOrdinal: expect.any(Number),
      failure: { class: "provider_error", message: "The request failed" },
    });
    expect(projector.project({ ...failed, eventId: EventId.make("repeated-terminal") })).toEqual(
      [],
    );
  });

  it("maps blocking Prime extension dialogs to v2 structured questions", () => {
    const { projector } = fixture();
    projector.project(event("turn.started", {}));
    const output = projector.project(
      event(
        "interaction.requested",
        { request: { kind: "confirm", title: "Proceed?", message: "Continue the task?" } },
        { requestId: "confirm-native" },
      ),
    );
    for (const row of output) decodeV2Event(row);
    expect(output.find((row) => row.type === "turn_item.updated")).toMatchObject({
      turnItem: {
        type: "user_input_request",
        status: "waiting",
        questions: [
          { question: "Continue the task?", options: [{ label: "Confirm" }, { label: "Decline" }] },
        ],
      },
    });
    expect(projector.getRequestRoute(projector.snapshot().runtimeRequests[0]!.id)).toMatchObject({
      kind: "interaction",
      interaction: { kind: "confirm" },
    });
  });

  for (const status of ["completed", "interrupted", "cancelled", "failed"] as const) {
    it(`preserves the ${status} terminal disposition`, () => {
      const { projector } = fixture();
      projector.project(event("turn.started", {}));
      const output = projector.project(
        event("turn.completed", {
          state: status,
          ...(status === "failed" ? { errorMessage: "native failure" } : {}),
        }),
      );
      for (const row of output) decodeV2Event(row);
      expect(projector.snapshot().providerTurns[0]?.status).toBe(status);
      expect(output.filter((row) => row.type === "turn.terminal")).toEqual([
        expect.objectContaining({ status, threadDisposition: "reusable" }),
      ]);
    });
  }

  it("projects aborts and starts a later run without combining assistant messages", () => {
    const { projector, providerThread } = fixture();
    projector.project(event("turn.started", {}));
    projector.project(
      event(
        "content.delta",
        { streamKind: "assistant_text", delta: "First" },
        { itemId: "assistant" },
      ),
    );
    expect(
      projector
        .project(event("turn.aborted", { reason: "Interrupted" }))
        .find((row) => row.type === "turn.terminal"),
    ).toMatchObject({ status: "interrupted" });
    projector.prepareTurn(makeTurnInput(providerThread, 2));
    projector.project(event("turn.started", {}, { turnId: "native-second" }));
    projector.project(
      event(
        "content.delta",
        { streamKind: "assistant_text", delta: "Second" },
        { itemId: "assistant", turnId: "native-second" },
      ),
    );
    projector.project(event("turn.completed", { state: "completed" }, { turnId: "native-second" }));
    expect(
      projector.snapshot().messages.map((message) => ({
        text: message.text,
        runId: message.runId,
        streaming: message.streaming,
      })),
    ).toEqual([
      { text: "First", runId: "run:1", streaming: false },
      { text: "Second", runId: "run:2", streaming: false },
    ]);
    expect(projector.snapshot().providerTurns.map((turn) => turn.ordinal)).toEqual([1, 2]);
  });

  it("creates nested execution nodes and structured file-change snapshots", () => {
    const { projector, turnInput } = fixture();
    const output = [
      event("turn.started", {}),
      event("task.started", { taskId: "parent", description: "Parent task" }),
      event("task.started", {
        taskId: "child",
        parentAgentId: "parent",
        description: "Child task",
      }),
      event(
        "item.completed",
        {
          itemType: "file_change",
          agentId: "child",
          title: "Edit",
          status: "completed",
          data: { path: "src/task.ts", additions: 2, deletions: 1, diff: "@@ task" },
        },
        { itemId: "file-change" },
      ),
    ].flatMap(projector.project);
    for (const row of output) decodeV2Event(row);
    const child = output.find(
      (row) => row.type === "subagent.updated" && row.subagent.prompt === "Child task",
    );
    expect(child).toMatchObject({ subagent: { parentNodeId: "thread-provider:task:parent" } });
    expect(output.findLast((row) => row.type === "node.updated")).toMatchObject({
      node: {
        parentNodeId: "thread-provider:task:child",
        rootNodeId: turnInput.rootNodeId,
        kind: "tool_call",
        status: "completed",
      },
    });
    expect(output.at(-1)).toMatchObject({
      turnItem: {
        type: "file_change",
        fileName: "src/task.ts",
        additions: 2,
        deletions: 1,
        diffStr: "@@ task",
      },
    });
  });
});

describe("legacy v2 runtime", () => {
  it("keeps native background ownership alive until queues, compaction and tasks drain", () => {
    const { projector } = fixture();
    projector.project(event("turn.started", {}));
    projector.project(event("session.input-queue.updated", { steeringCount: 0, followUpCount: 1 }));
    expect(projector.hasPendingBackgroundWork()).toBe(true);
    projector.project(event("session.input-queue.updated", { steeringCount: 0, followUpCount: 0 }));
    expect(projector.hasPendingBackgroundWork()).toBe(false);
    projector.project(
      event("session.compaction.updated", {
        available: true,
        status: "compacting",
        abortable: true,
        autoCompactionWritable: false,
        manualCompactionSettable: false,
      }),
    );
    expect(projector.hasPendingBackgroundWork()).toBe(true);
    projector.project(
      event("session.compaction.updated", {
        available: true,
        status: "idle",
        abortable: false,
        autoCompactionWritable: false,
        manualCompactionSettable: true,
      }),
    );
    projector.project(
      event("task.started", { taskId: "background", description: "Still running" }),
    );
    expect(projector.hasPendingBackgroundWork()).toBe(true);
    projector.project(event("task.completed", { taskId: "background", status: "completed" }));
    expect(projector.hasPendingBackgroundWork()).toBe(false);
  });

  it("projects configured session state, native metadata, cleared usage and diagnostics", () => {
    const { projector } = fixture();
    const output = [
      event("session.configured", { config: { model: "updated-model", cwd: "/updated" } }),
      event("session.state.changed", { state: "waiting" }),
      event("thread.metadata.updated", { name: "Native thread" }),
      event("thread.token-usage.updated", { usage: { usedTokens: 100 } }),
      event("thread.token-usage.cleared", { reason: "unknown" }),
      event("runtime.warning", { message: "Transient provider warning" }),
      event("runtime.error", { message: "Transport failed", class: "transport_error" }),
      event("model.rerouted", { fromModel: "old", toModel: "new", reason: "capacity" }),
      event("tool.denied", { toolName: "Shell", reason: "policy" }),
      event("session.exited", { exitKind: "error", reason: "Runtime exited" }),
    ].flatMap(projector.project);
    for (const row of output) decodeV2Event(row);
    expect(projector.getProviderSession()).toMatchObject({
      model: "updated-model",
      cwd: "/updated",
      status: "error",
      lastError: "Runtime exited",
    });
    expect(projector.getProviderThread()).toMatchObject({
      nativeMetadata: { name: "Native thread" },
      contextUsage: null,
    });
    expect(
      output.filter((row) => row.type === "turn_item.updated").map((row) => row.turnItem.type),
    ).toEqual(["system_notice", "system_notice", "system_notice", "system_notice"]);
  });

  it.effect("wraps legacy admission and snapshot failures in the matching v2 errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failure = new ProviderAdapterValidationError({
          provider: driver,
          operation: "test",
          issue: "Native operation failed",
        });
        const bridge = makeLegacyAdapterV2({
          instanceId,
          adapter: legacyAdapter<ProviderAdapterValidationError>({
            sendTurn: () => Effect.fail(failure),
            readThread: () => Effect.fail(failure),
          }),
        });
        const runtime = yield* bridge.openSession({
          threadId,
          providerSessionId,
          modelSelection: { instanceId, model: "prime-model" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "prime-model" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        expect(
          yield* runtime.startTurn(makeTurnInput(providerThread)).pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProviderAdapterTurnStartError", cause: failure },
        });
        expect(
          yield* runtime.readThreadSnapshot({ providerThread }).pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProviderAdapterReadThreadSnapshotError", cause: failure },
        });
      }),
    ),
  );

  it.effect("delegates relative rollback counts and returns only retained entity snapshots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
        const rollbacks: unknown[] = [];
        let nextTurn = 0;
        const bridge = makeLegacyAdapterV2({
          instanceId,
          adapter: legacyAdapter({
            capabilities: { sessionModelSwitch: "in-session", conversationRollback: "relative" },
            streamEvents: Stream.fromPubSub(pubsub),
            sendTurn: () =>
              Effect.gen(function* () {
                const turnId = TurnId.make(`native:${++nextTurn}`);
                yield* PubSub.publishAll(pubsub, [
                  event("turn.started", {}, { turnId }),
                  event(
                    "content.delta",
                    { streamKind: "assistant_text", delta: `Response ${nextTurn}` },
                    { turnId, itemId: "assistant" },
                  ),
                  event(
                    "item.completed",
                    { itemType: "assistant_message", status: "completed" },
                    { turnId, itemId: "assistant" },
                  ),
                  event("turn.completed", { state: "completed" }, { turnId }),
                ]);
                return { threadId, turnId };
              }),
            rollbackThread: (ownerThreadId, count) =>
              Effect.sync(() => {
                rollbacks.push({ ownerThreadId, count });
                return { threadId, turns: [] };
              }),
          }),
        });
        const runtime = yield* bridge.openSession({
          threadId,
          providerSessionId,
          modelSelection: { instanceId, model: "prime-model" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "prime-model" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        for (const ordinal of [1, 2]) {
          const terminal = yield* runtime.events.pipe(
            Stream.filter((row) => row.type === "turn.terminal" && row.runOrdinal === ordinal),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* runtime.startTurn(makeTurnInput(providerThread, ordinal));
          yield* Fiber.join(terminal);
        }
        const before = yield* runtime.readThreadSnapshot({ providerThread });
        const after = yield* runtime.rollbackThread({
          providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-first"),
            appRunOrdinal: 1,
            providerTurn: before.providerTurns[0]!,
          },
          providerThreadTurns: before.providerTurns,
        });
        expect(rollbacks).toEqual([{ ownerThreadId: threadId, count: 1 }]);
        expect(after.providerTurns.map((turn) => turn.ordinal)).toEqual([1]);
        expect(after.messages.map((message) => message.text)).toEqual(["Response 1"]);
      }),
    ),
  );

  it.effect(
    "subscribes before admission and flushes final assistant snapshots before terminal",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const pubsub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
          const subscribed = yield* Deferred.make<void>();
          let stopped = false;
          const calls: unknown[] = [];
          const adapter = legacyAdapter({
            streamEvents: Stream.fromPubSub(pubsub).pipe(
              Stream.onStart(Deferred.succeed(subscribed, undefined)),
            ),
            sendTurn: (sendInput) =>
              Effect.gen(function* () {
                yield* Deferred.await(subscribed);
                calls.push(sendInput);
                yield* PubSub.publishAll(pubsub, [
                  event("turn.started", {}),
                  event(
                    "content.delta",
                    { streamKind: "assistant_text", delta: "superseded" },
                    { itemId: "assistant", sessionIncarnationId: "older-incarnation" },
                  ),
                  event(
                    "content.delta",
                    { streamKind: "assistant_text", delta: "one" },
                    { itemId: "assistant" },
                  ),
                  event(
                    "content.delta",
                    { streamKind: "assistant_text", delta: " two" },
                    { itemId: "assistant" },
                  ),
                  event(
                    "item.completed",
                    { itemType: "assistant_message", status: "completed" },
                    { itemId: "assistant" },
                  ),
                  event("turn.completed", { state: "completed" }),
                ]);
                return { threadId, turnId: nativeTurnId };
              }),
            stopSession: () =>
              Effect.sync(() => {
                stopped = true;
              }),
          });
          const bridge = makeLegacyAdapterV2({ instanceId, adapter });
          const runtimeScope = yield* Scope.make();
          const runtime = yield* bridge
            .openSession({
              threadId,
              providerSessionId,
              modelSelection: { instanceId, model: "prime-model" },
              runtimePolicy: {
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: "/workspace",
              },
            })
            .pipe(Scope.provide(runtimeScope));
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: { instanceId, model: "prime-model" },
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            },
          });
          const collected = yield* runtime.events.pipe(
            Stream.takeUntil((row) => row.type === "turn.terminal"),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* runtime.startTurn(makeTurnInput(providerThread));
          const output = yield* Fiber.join(collected);
          const lastMessage = output.findLast((row) => row.type === "message.updated");
          expect(lastMessage).toMatchObject({ message: { text: "one two", streaming: false } });
          expect(output.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
          expect(calls).toEqual([
            expect.objectContaining({
              input: "Run the task",
              admissionRequestId: "run:1",
              sessionIncarnationId: providerSessionId,
            }),
          ]);
          yield* Scope.close(runtimeScope, Exit.void);
          expect(stopped).toBe(true);
        }),
      ),
  );

  it.effect("maintenance reserves only a drained instance and blocks new runtime admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const maintenance = yield* Maintenance.make();
        const runtimeScope = yield* Scope.make();
        yield* maintenance.acquireRuntime(instanceId).pipe(Scope.provide(runtimeScope));
        expect(yield* maintenance.reserveProviderMaintenance(instanceId)).toMatchObject({
          status: "busy",
        });
        const drained = yield* maintenance.streamDrainedInstances.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Scope.close(runtimeScope, Exit.void);
        expect(yield* Fiber.join(drained)).toEqual([instanceId]);
        const reservation = yield* maintenance.reserveProviderMaintenance(instanceId);
        expect(reservation.status).toBe("reserved");
        const admission = yield* maintenance.acquireRuntime(instanceId).pipe(Effect.exit);
        expect(admission._tag).toBe("Failure");
        if (reservation.status === "reserved")
          yield* maintenance.releaseProviderMaintenance(reservation.reservation);
        yield* maintenance.acquireRuntime(instanceId);
      }),
    ),
  );

  it.effect("reports unsupported Prime native rollback, fork and active steering honestly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = legacyAdapter<ProviderAdapterValidationError>({
          capabilities: { sessionModelSwitch: "in-session", conversationRollback: "absolute" },
          rollbackThread: () =>
            Effect.fail(
              new ProviderAdapterValidationError({
                provider: driver,
                operation: "rollbackThread",
                issue: "Prime native conversation rollback is unsupported",
              }),
            ),
        });
        const bridge = makeLegacyAdapterV2({ instanceId, adapter });
        const capabilities = yield* bridge.getCapabilities();
        expect(capabilities).toMatchObject({
          threads: { canRollbackThread: false, canForkThread: false, canForkFromTurn: false },
          turns: { supportsActiveSteering: false },
          checkpointing: {
            appCanCheckpointFilesystem: true,
            providerCanRollbackConversation: false,
          },
        });
        const runtime = yield* bridge.openSession({
          threadId,
          providerSessionId,
          modelSelection: { instanceId, model: "prime-model" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "prime-model" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        const providerTurn = {
          id: ProviderTurnId.make("provider-turn"),
          providerThreadId: providerThread.id,
          nodeId: NodeId.make("root-node"),
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed" as const,
          startedAt: now,
          completedAt: now,
        };
        expect(
          yield* runtime
            .rollbackThread({
              providerThread,
              target: {
                type: "thread_start",
                checkpointId: CheckpointId.make("checkpoint-start"),
                appRunOrdinal: 0,
              },
              providerThreadTurns: [providerTurn],
            })
            .pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProviderAdapterRollbackThreadError" },
        });
        expect(
          yield* runtime
            .forkThread({
              sourceProviderThread: providerThread,
              targetThreadId: ThreadId.make("fork-target"),
            })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderAdapterForkThreadError" } });
        expect(
          yield* runtime
            .steerTurn({
              threadId,
              runId: RunId.make("run:1"),
              providerThread,
              providerTurnId: providerTurn.id,
              message: makeTurnInput(providerThread).message,
            })
            .pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProviderAdapterSteerRunUnsupportedError" },
        });
      }),
    ),
  );

  it.effect(
    "wraps legacy startup failure and releases the exact maintenance admission on scope close",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const maintenance = yield* Maintenance.make();
          const runtimeScope = yield* Scope.make();
          const bridge = makeLegacyAdapterV2({
            instanceId,
            maintenance,
            adapter: legacyAdapter<ProviderAdapterValidationError>({
              startSession: () =>
                Effect.fail(
                  new ProviderAdapterValidationError({
                    provider: driver,
                    operation: "startSession",
                    issue: "Cannot launch native provider",
                  }),
                ),
            }),
          });
          const opened = yield* bridge
            .openSession({
              threadId,
              providerSessionId,
              modelSelection: { instanceId, model: "prime-model" },
              runtimePolicy: {
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: "/workspace",
              },
            })
            .pipe(Scope.provide(runtimeScope), Effect.result);
          expect(opened).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "ProviderAdapterOpenSessionError" },
          });
          expect(yield* maintenance.reserveProviderMaintenance(instanceId)).toMatchObject({
            status: "busy",
          });
          yield* Scope.close(runtimeScope, Exit.void);
          expect(yield* maintenance.reserveProviderMaintenance(instanceId)).toMatchObject({
            status: "reserved",
          });
        }),
      ),
  );

  it.effect(
    "rejects stale turns and requests without interrupting or answering the active owner",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let interrupts = 0;
          let responses = 0;
          const bridge = makeLegacyAdapterV2({
            instanceId,
            adapter: legacyAdapter({
              interruptTurn: () =>
                Effect.sync(() => {
                  interrupts += 1;
                }),
              respondToRequest: () =>
                Effect.sync(() => {
                  responses += 1;
                }),
            }),
          });
          const runtime = yield* bridge.openSession({
            threadId,
            providerSessionId,
            modelSelection: { instanceId, model: "prime-model" },
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            },
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: { instanceId, model: "prime-model" },
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            },
          });
          expect(
            yield* runtime
              .interruptTurn({
                providerThread,
                providerTurnId: ProviderTurnId.make("unknown-turn"),
              })
              .pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderAdapterInterruptError" } });
          expect(
            yield* runtime
              .respondToRuntimeRequest({
                requestId: RuntimeRequestId.make("unknown-request"),
                decision: "accept",
              })
              .pipe(Effect.result),
          ).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "ProviderAdapterRuntimeRequestResponseError" },
          });
          expect(interrupts).toBe(0);
          expect(responses).toBe(0);
        }),
      ),
  );

  it.effect("forwards injected context, typed responses and the correct native request id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
        const sends: unknown[] = [];
        const responses: unknown[] = [];
        const bridge = makeLegacyAdapterV2({
          instanceId,
          adapter: legacyAdapter({
            streamEvents: Stream.fromPubSub(pubsub),
            sendTurn: (sendInput) =>
              Effect.gen(function* () {
                sends.push(sendInput);
                yield* PubSub.publishAll(pubsub, [
                  event("turn.started", {}),
                  event(
                    "interaction.requested",
                    { request: { kind: "confirm", title: "Continue?" } },
                    { requestId: "native-confirm" },
                  ),
                ]);
                return { threadId, turnId: nativeTurnId };
              }),
            respondToInteraction: (ownerThreadId, requestId, response) =>
              Effect.sync(() => {
                responses.push({ ownerThreadId, requestId, response });
              }),
          }),
        });
        const runtime = yield* bridge.openSession({
          threadId,
          providerSessionId,
          modelSelection: { instanceId, model: "prime-model" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "prime-model" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        yield* runtime.injectHistory!({
          providerThread,
          context: "Previous provider context",
          messages: [],
        });
        const pending = yield* runtime.events.pipe(
          Stream.filter((row) => row.type === "runtime_request.updated"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* runtime.startTurn(makeTurnInput(providerThread));
        const request = (yield* Fiber.join(pending))[0]!;
        yield* runtime.respondToRuntimeRequest({
          requestId: request.runtimeRequest.id,
          answers: { interaction: "Confirm" },
        });
        expect(sends).toEqual([
          expect.objectContaining({ input: "Previous provider context\n\nRun the task" }),
        ]);
        expect(responses).toEqual([
          {
            ownerThreadId: threadId,
            requestId: "native-confirm",
            response: { kind: "confirmed", confirmed: true },
          },
        ]);
        expect(
          yield* runtime
            .respondToRuntimeRequest({
              requestId: request.runtimeRequest.id,
              response: { kind: "unrecognized" },
            })
            .pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProviderAdapterRuntimeRequestResponseError" },
        });
      }),
    ),
  );
});
