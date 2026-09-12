import {
  CommandId,
  ComposerContextId,
  OrchestrationSession,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const persistedSessionCodec = Schema.fromJsonString(OrchestrationSession);
const decodePersistedSession = Schema.decodeUnknownEffect(persistedSessionCodec);
const encodePersistedSession = Schema.encodeEffect(persistedSessionCodec);

const NOW = "2026-09-12T00:00:00.000Z";
const threadId = ThreadId.make("compaction");
const rootId = CommandId.make("compact");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const run = Effect.fnUntraced(function* (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
) {
  const result = yield* decideOrchestrationCommand({ readModel, command });
  const events = Array.isArray(result) ? result : [result];
  let next = readModel;
  for (const event of events)
    next = yield* projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 }).pipe(
      Effect.orDie,
    );
  return { readModel: next, events };
});
const turn = (
  id: string,
  text = id,
  runtimeMode: "full-access" | "approval-required" = "full-access",
) => ({
  type: "thread.turn.start" as const,
  commandId: CommandId.make(id),
  threadId,
  message: {
    messageId: MessageId.make(`message-${id}`),
    role: "user" as const,
    text,
    attachments: [],
  },
  modelSelection,
  runtimeMode,
  interactionMode: "default" as const,
  sourceEpoch: 0,
  createdAt: NOW,
});
const init = Effect.fnUntraced(function* () {
  let state: OrchestrationReadModel = {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: NOW,
  };
  state = (yield* run(state, {
    type: "project.create",
    commandId: CommandId.make("project"),
    projectId: ProjectId.make("project"),
    title: "Project",
    workspaceRoot: "/tmp/compaction-project",
    defaultModelSelection: modelSelection,
    createdAt: NOW,
  })).readModel;
  state = (yield* run(state, {
    type: "thread.create",
    commandId: CommandId.make("thread"),
    threadId,
    projectId: ProjectId.make("project"),
    title: "Thread",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
  })).readModel;
  return (yield* run(state, turn("compact", "/compact"))).readModel;
});
const complete = (success: boolean) => ({
  type: "thread.compaction.complete" as const,
  commandId: CommandId.make("complete"),
  threadId,
  requestId: rootId,
  success,
  createdAt: NOW,
});
const resume = (id: string) => ({
  type: "thread.compaction.queue.resume" as const,
  commandId: CommandId.make(id),
  threadId,
  requestId: rootId,
  createdAt: NOW,
});

it.layer(NodeServices.layer)("compaction admission FIFO", (it) => {
  it.effect(
    "accepts queued messages without replacing compact admission and preserves FIFO settings",
    () =>
      Effect.gen(function* () {
        let state = yield* init();
        const first = yield* run(state, turn("one", "first", "approval-required"));
        expect(first.events.map((event) => event.type)).toEqual([
          "thread.message-sent",
          "thread.session-set",
        ]);
        state = (yield* run(first.readModel, turn("two", "second"))).readModel;
        expect(state.threads[0]?.session?.pendingTurnRequestId).toBe(rootId);
        state = (yield* run(state, complete(true))).readModel;
        const admitted = yield* run(state, resume("resume-one"));
        expect(
          admitted.events.find((event) => event.type === "thread.turn-start-requested"),
        ).toMatchObject({
          payload: { messageId: "message-one", runtimeMode: "approval-required" },
        });
        state = admitted.readModel;
        expect(state.threads[0]?.session?.compactionQueue).toMatchObject({
          inFlightRequestId: "resume-one",
          inFlightMessageId: "message-one",
          queued: [{ messageId: "message-two" }],
        });
        expect(
          state.threads[0]?.messages.filter((message) => message.id === "message-one"),
        ).toHaveLength(1);
        expect((yield* run(state, resume("duplicate-resume"))).events).toEqual([]);
        state = (yield* run(state, {
          type: "thread.compaction.queue.sent",
          commandId: CommandId.make("sent"),
          threadId,
          requestId: rootId,
          sentRequestId: CommandId.make("resume-one"),
          createdAt: NOW,
        })).readModel;
        // Send settlement alone cannot bypass the exact pending admission.
        expect((yield* run(state, resume("still-pending"))).events).toEqual([]);
      }),
  );

  it.effect(
    "retains context through durable queue decoding, resume and uncertain restart cancellation",
    () =>
      Effect.gen(function* () {
        const context = {
          version: 1 as const,
          records: [
            {
              version: 1 as const,
              contextId: ComposerContextId.make("queued-context"),
              kind: "mention" as const,
              label: "source.ts",
              path: "src/source.ts",
            },
          ],
        };
        const command = turn("context", "[source.ts](t3-context://v1/mention/queued-context)");
        let state = (yield* run(yield* init(), {
          ...command,
          message: { ...command.message, context },
        })).readModel;
        const serialized = yield* encodePersistedSession(state.threads[0]!.session!);
        const persistedSession = yield* decodePersistedSession(serialized);
        expect(persistedSession.compactionQueue?.queued[0]?.context).toEqual(context);
        state = {
          ...state,
          threads: state.threads.map((thread) => ({ ...thread, session: persistedSession })),
        };
        state = (yield* run(state, complete(true))).readModel;
        state = (yield* run(state, resume("context-resume"))).readModel;
        expect(
          state.threads[0]?.messages.find((message) => message.id === command.message.messageId)
            ?.context,
        ).toEqual(context);
        const canceled = yield* run(state, { ...complete(false), reconcileInFlight: true });
        expect(canceled.readModel.threads[0]?.session?.compactionQueue).toBeUndefined();
        expect(
          canceled.readModel.threads[0]?.messages.find(
            (message) => message.id === command.message.messageId,
          )?.context,
        ).toEqual(context);
      }),
  );

  it.effect("cancels every queued bubble on stop and ignores stale completion", () =>
    Effect.gen(function* () {
      let state = yield* init();
      state = (yield* run(state, turn("one"))).readModel;
      state = (yield* run(state, turn("two"))).readModel;
      const stopped = yield* run(state, {
        type: "thread.session.stop",
        commandId: CommandId.make("stop"),
        threadId,
        createdAt: NOW,
      });
      expect(
        stopped.events.filter((event) => event.type === "thread.activity-appended"),
      ).toHaveLength(2);
      expect(stopped.readModel.threads[0]?.session).toMatchObject({ status: "stopped" });
      expect(stopped.readModel.threads[0]?.session?.compactionQueue).toBeUndefined();
      expect((yield* run(stopped.readModel, complete(true))).events).toEqual([]);
    }),
  );

  it.effect("accounts for an in-flight head when Stop cancels its pending admission", () =>
    Effect.gen(function* () {
      let state = yield* init();
      state = (yield* run(state, turn("one"))).readModel;
      state = (yield* run(state, turn("two"))).readModel;
      state = (yield* run(state, complete(true))).readModel;
      state = (yield* run(state, resume("resume-one"))).readModel;
      const stopped = yield* run(state, {
        type: "thread.session.stop",
        commandId: CommandId.make("stop-pending"),
        threadId,
        createdAt: NOW,
      });
      const receipts = stopped.events.filter((event) => event.type === "thread.activity-appended");
      expect(receipts).toHaveLength(2);
      expect(receipts[0]?.payload.activity).toMatchObject({
        summary: "Queued message delivery was interrupted",
        payload: { requestId: "message-one" },
      });
      expect(receipts[1]?.payload.activity).toMatchObject({
        summary: "Queued message was not sent",
        payload: { requestId: "message-two" },
      });
      expect(stopped.readModel.threads[0]?.session?.compactionQueue).toBeUndefined();
    }),
  );

  it.effect(
    "does not let an old provider snapshot erase the queue or completion drain a replacement incarnation",
    () =>
      Effect.gen(function* () {
        let state = yield* init();
        const old = state.threads[0]!.session!;
        state = (yield* run(state, turn("one"))).readModel;
        state = (yield* run(state, {
          type: "thread.session.set",
          commandId: CommandId.make("snapshot"),
          threadId,
          session: { ...old, sessionIncarnationId: RuntimeSessionId.make("replacement") },
          createdAt: NOW,
        })).readModel;
        expect(state.threads[0]?.session?.compactionQueue?.queued).toHaveLength(1);
        const canceled = yield* run(state, {
          ...complete(true),
          expectedSessionIncarnationId: RuntimeSessionId.make("original"),
        });
        expect(
          canceled.events.filter((event) => event.type === "thread.activity-appended"),
        ).toHaveLength(1);
        expect(canceled.readModel.threads[0]?.session?.compactionQueue).toBeUndefined();
        expect(canceled.readModel.threads[0]?.session?.sessionIncarnationId).toBe("replacement");
      }),
  );

  it.effect(
    "records uncertain in-flight delivery and cancels remaining bubbles during restart reconciliation",
    () =>
      Effect.gen(function* () {
        let state = yield* init();
        state = (yield* run(state, turn("one"))).readModel;
        state = (yield* run(state, turn("two"))).readModel;
        state = (yield* run(state, complete(true))).readModel;
        state = (yield* run(state, resume("resume-one"))).readModel;
        const canceled = yield* run(state, {
          ...complete(false),
          reconcileInFlight: true,
          detail: "Server restarted; delivery may have started.",
        });
        expect(
          canceled.events
            .filter((event) => event.type === "thread.activity-appended")
            .map((event) => event.payload.activity.payload),
        ).toEqual([
          {
            requestId: "message-one",
            detail:
              "Server restarted; delivery may have started. Delivery may already have started; check the conversation before resending.",
          },
          { requestId: "message-two", detail: "Server restarted; delivery may have started." },
        ]);
        expect(canceled.readModel.threads[0]?.session?.compactionQueue).toBeUndefined();
      }),
  );

  it.effect(
    "rejects stale source epochs before queueing and retains ordinary admission exclusion",
    () =>
      Effect.gen(function* () {
        const state = yield* init();
        expect(
          (yield* run(state, { ...turn("stale"), sourceEpoch: 1 }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        const ordinary = {
          ...state,
          threads: state.threads.map((thread) => ({
            ...thread,
            session: { ...thread.session!, compactionQueue: undefined },
          })),
        };
        expect((yield* run(ordinary, turn("blocked")).pipe(Effect.result))._tag).toBe("Failure");
      }),
  );
});
