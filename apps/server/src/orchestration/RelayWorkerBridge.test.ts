// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  EventId,
  EnvironmentId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import {
  ThreadBackgroundLivenessService,
  make as makeLiveness,
} from "./ThreadBackgroundLiveness.ts";

import {
  makeWithCliPath,
  parseObservation,
  relayBindingFromToolEvent,
} from "./RelayWorkerBridge.ts";

const jobId = "job-11111111-1111-4111-8111-111111111111";
const panelInitialJobId = "job-44444444-4444-4444-8444-444444444444";
const replacementJobId = "job-33333333-3333-4333-8333-333333333333";
const panelId = "panel-22222222-2222-4222-8222-222222222222";
const completedPanelId = "panel-55555555-5555-4555-8555-555555555555";
const completedPanelJobId = "job-66666666-6666-4666-8666-666666666666";
const encodeJson = (value: unknown) => JSON.stringify(value);
const decodeJson = (value: unknown): unknown => JSON.parse(String(value));

function toolEvent(input: {
  readonly toolName: string;
  readonly result: unknown;
  readonly provider?: "claudeAgent" | "codex";
  readonly status?: "completed" | "failed";
  readonly server?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly itemId?: string;
}): ProviderRuntimeEvent {
  return {
    type: "item.completed",
    eventId: EventId.make("relay-tool-event"),
    provider: ProviderDriverKind.make(input.provider ?? "claudeAgent"),
    threadId: ThreadId.make(input.threadId ?? "thread-a"),
    turnId: TurnId.make(input.turnId ?? "turn-a"),
    itemId: RuntimeItemId.make(input.itemId ?? "tool-a"),
    createdAt: "2026-09-22T00:00:00.000Z",
    payload: {
      itemType: "mcp_tool_call",
      status: input.status ?? "completed",
      data:
        input.provider === "codex"
          ? {
              item: {
                type: "mcpToolCall",
                server: input.server ?? "relay",
                tool: input.toolName,
                result: input.result,
              },
            }
          : { toolName: input.toolName, result: input.result },
    },
  } as ProviderRuntimeEvent;
}

describe("RelayWorkerBridge direct receipts", () => {
  it("binds Claude plugin and Codex direct Relay tool results to the exact thread, turn and item", () => {
    const claude = toolEvent({
      toolName: "mcp__plugin_relay-orchestrator_relay__relay_delegate",
      result: {
        type: "tool_result",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              content: [{ type: "text", text: "Worker dispatched" }],
              structuredContent: { schemaVersion: 1, kind: "job", jobId, attempt: 1 },
            }),
          },
        ],
      },
    });
    expect(relayBindingFromToolEvent(claude)).toEqual([
      {
        kind: "job",
        id: jobId,
        threadId: "thread-a",
        turnId: "turn-a",
        toolCallId: "tool-a",
      },
    ]);

    // Claude SDK serializes the MCP tool result's content array as a single
    // JSON string inside its tool_result block in live provider sessions.
    const liveClaudeShape = toolEvent({
      toolName: "mcp__relay__relay_delegate",
      result: {
        type: "tool_result",
        tool_use_id: "tool-a",
        content: JSON.stringify({
          content: [{ type: "text", text: "Worker dispatched" }],
          structuredContent: { schemaVersion: 1, kind: "job", jobId, attempt: 1 },
        }),
      },
    });
    expect(relayBindingFromToolEvent(liveClaudeShape)).toEqual([
      { kind: "job", id: jobId, threadId: "thread-a", turnId: "turn-a", toolCallId: "tool-a" },
    ]);

    const largePanelResult = toolEvent({
      toolName: "mcp__relay__relay_panel",
      result: {
        type: "tool_result",
        content: JSON.stringify({
          content: [
            { type: "text", text: "Private prompt: " + "x".repeat(20_000) },
            { type: "text", text: JSON.stringify({ schemaVersion: 1, kind: "panel", panelId }) },
          ],
        }),
      },
    });
    expect(relayBindingFromToolEvent(largePanelResult)).toEqual([
      { kind: "panel", id: panelId, threadId: "thread-a", turnId: "turn-a", toolCallId: "tool-a" },
    ]);

    const codex = toolEvent({
      provider: "codex",
      toolName: "relay_panel",
      result: { structuredContent: { schemaVersion: 1, kind: "panel", panelId } },
    });
    expect(relayBindingFromToolEvent(codex)).toEqual([
      {
        kind: "panel",
        id: panelId,
        threadId: "thread-a",
        turnId: "turn-a",
        toolCallId: "tool-a",
      },
    ]);
  });

  it("finds the short receipt after a 100k escaped prompt in Claude's nested MCP wrapper", () => {
    const prompt = "\n\\".repeat(50_000);
    const firstText = JSON.stringify({ prompt });
    const wrapper = JSON.stringify({
      content: [
        { type: "text", text: firstText },
        { type: "text", text: JSON.stringify({ schemaVersion: 1, kind: "panel", panelId }) },
      ],
    });
    expect(prompt).toHaveLength(100_000);
    expect(wrapper.length).toBeGreaterThan(256 * 1024);
    expect(wrapper.length).toBeLessThan(1024 * 1024);
    expect(
      relayBindingFromToolEvent(
        toolEvent({
          toolName: "mcp__relay__relay_panel",
          result: { type: "tool_result", content: wrapper },
        }),
      ),
    ).toEqual([
      { kind: "panel", id: panelId, threadId: "thread-a", turnId: "turn-a", toolCallId: "tool-a" },
    ]);
  });

  it("rejects lookalike servers, failed calls, model text and malformed IDs", () => {
    const structured = { structuredContent: { schemaVersion: 1, kind: "job", jobId, attempt: 1 } };
    expect(
      relayBindingFromToolEvent(
        toolEvent({ toolName: "mcp__other__relay_delegate", result: structured }),
      ),
    ).toEqual([]);
    expect(
      relayBindingFromToolEvent(
        toolEvent({
          provider: "codex",
          server: "other",
          toolName: "relay_delegate",
          result: structured,
        }),
      ),
    ).toEqual([]);
    expect(
      relayBindingFromToolEvent(
        toolEvent({ toolName: "mcp__relay__relay_delegate", status: "failed", result: structured }),
      ),
    ).toEqual([]);
    expect(
      relayBindingFromToolEvent(
        toolEvent({
          toolName: "mcp__relay__relay_delegate",
          result: { content: [{ type: "text", text: `job ${jobId}` }] },
        }),
      ),
    ).toEqual([]);
    expect(
      relayBindingFromToolEvent(
        toolEvent({
          toolName: "mcp__relay__relay_delegate",
          result: { structuredContent: { schemaVersion: 1, kind: "job", jobId: "../../other" } },
        }),
      ),
    ).toEqual([]);
  });
});

describe("Relay observe v1", () => {
  it("accepts bounded job and panel snapshots and rejects malformed members/statuses", () => {
    const job = {
      schemaVersion: 1,
      kind: "job",
      id: jobId,
      attempt: 1,
      sequence: 3,
      status: "running",
      pending: false,
    };
    expect(parseObservation(job, jobId)).toEqual(job);
    expect(parseObservation({ ...job, status: "made-up" }, jobId)).toBeUndefined();
    expect(
      parseObservation({ ...job, id: "job-33333333-3333-4333-8333-333333333333" }, jobId),
    ).toBeUndefined();
    const panel = {
      schemaVersion: 1,
      kind: "panel",
      id: panelId,
      complete: false,
      members: [
        { index: 0, slotAttempt: 2, state: "started", jobId, job },
        { index: 1, slotAttempt: 1, state: "unstarted", jobId: null, job: null },
      ],
    };
    expect(parseObservation(panel, panelId)).toEqual(panel);
    expect(parseObservation({ ...panel, members: [null] }, panelId)).toBeUndefined();
    expect(
      parseObservation(
        { ...panel, members: [{ index: 0, slotAttempt: 0, state: "started", jobId }] },
        panelId,
      ),
    ).toBeUndefined();
  });
});

function fakeRelayCli() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pylon-relay-bridge-"));
  const path = NodePath.join(dir, "relay-fixture.mjs");
  NodeFS.writeFileSync(
    path,
    `
import fs from "node:fs";
const dataPath = new URL("./state.json", import.meta.url);
const callsPath = new URL("./calls.json", import.meta.url);
const state = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const calls = JSON.parse(fs.readFileSync(callsPath, "utf8"));
const args = process.argv.slice(2);
calls.push(args);
fs.writeFileSync(callsPath, JSON.stringify(calls));
const id = args[0] === "observe" && args[1] === "--panel" ? args[2] : args[1];
if (args[0] === "observe" && state[id]) console.log(JSON.stringify(state[id]));
else if (args[0] === "cancel" && state[id]) console.log(JSON.stringify({id, status: "cancelling"}));
else process.exit(1);
`,
  );
  const statePath = NodePath.join(dir, "state.json");
  const callsPath = NodePath.join(dir, "calls.json");
  NodeFS.writeFileSync(statePath, "{}");
  NodeFS.writeFileSync(callsPath, "[]");
  return {
    path,
    setState: (state: unknown) => NodeFS.writeFileSync(statePath, JSON.stringify(state)),
    calls: (): ReadonlyArray<ReadonlyArray<string>> =>
      JSON.parse(NodeFS.readFileSync(callsPath, "utf8")),
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
}

const fakeEnvironment = ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
  getDescriptor: Effect.die("unused"),
});

const persistence = effectIt.layer(SqlitePersistenceMemory);

persistence("Relay persisted observer and controls", (it) => {
  it.effect(
    "retains exact thread ownership across recovery, emits stable lifecycle, and rejects another thread's cancel",
    () => {
      const cli = fakeRelayCli();
      const job = {
        schemaVersion: 1,
        kind: "job",
        id: jobId,
        attempt: 1,
        sequence: 1,
        status: "running",
        providerType: "codex",
        model: "gpt-6-sol",
        effort: "high",
        activity: { kind: "editing", label: "Editing files" },
        usage: { totalTokens: 18, inputTokens: 12, outputTokens: 6 },
        pending: false,
        outcome: null,
      };
      cli.setState({ [jobId]: job });
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const commands = new Set<string>();
        const engine = {
          dispatch: (command: {
            readonly type: string;
            readonly commandId: string;
            readonly threadId: string;
            readonly activity?: {
              readonly id: string;
              readonly turnId: string | null;
              readonly kind: string;
              readonly tone: string;
              readonly summary: string;
              readonly payload: unknown;
              readonly createdAt: string;
            };
          }) =>
            Effect.gen(function* () {
              if (commands.has(command.commandId))
                return { sequence: commands.size, eventCount: 0 };
              if (command.type !== "thread.activity.append" || !command.activity)
                throw new Error("unexpected command");
              commands.add(command.commandId);
              const activity = command.activity;
              yield* sql`
                INSERT INTO projection_thread_activities (
                  activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
                ) VALUES (
                  ${activity.id}, ${command.threadId}, ${activity.turnId}, ${activity.tone},
                  ${activity.kind}, ${activity.summary}, ${encodeJson(activity.payload)}, ${commands.size}, ${activity.createdAt}
                ) ON CONFLICT(activity_id) DO UPDATE SET
                  payload_json = excluded.payload_json, sequence = excluded.sequence,
                  created_at = excluded.created_at
              `;
              return { sequence: commands.size, eventCount: 1 };
            }),
        } as unknown as OrchestrationEngineService["Service"];
        const liveness = makeLiveness();
        const bridge = yield* makeWithCliPath(cli.path).pipe(
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(ServerEnvironment, fakeEnvironment),
          Effect.provideService(ThreadBackgroundLivenessService, liveness),
        );
        const persistedReceipt = {
          itemType: "mcp_tool_call",
          toolCallId: "tool-a",
          status: "completed",
          data: {
            toolName: "mcp__relay__relay_delegate",
            result: {
              type: "tool_result",
              tool_use_id: "tool-a",
              content: encodeJson({
                content: [{ type: "text", text: "Worker dispatched" }],
                structuredContent: { schemaVersion: 1, kind: "job", jobId, attempt: 1 },
              }),
            },
          },
        };
        yield* sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
            ) VALUES (
              'persisted-relay-tool', 'thread-a', 'turn-a', 'tool', 'tool.completed',
              'Relay delegate', ${encodeJson(persistedReceipt)}, NULL, '2026-09-22T00:00:00.000Z'
            )
          `;
        yield* bridge.reconcile;
        const started =
          yield* sql`SELECT payload_json AS payload FROM projection_thread_activities WHERE kind = 'task.started'`;
        expect(started).toHaveLength(1);
        expect(decodeJson(started[0]?.payload)).toMatchObject({
          taskId: `relay:${jobId}`,
          agentKind: "agent",
          source: "relay",
          attempt: 1,
          relaySequence: 1,
          model: "gpt-6-sol",
          effort: "high",
          cancellable: true,
        });
        const wrongThread = yield* Effect.result(
          bridge.cancel(ThreadId.make("thread-b"), `relay:${jobId}`),
        );
        expect(wrongThread._tag).toBe("Failure");
        expect(cli.calls().some((args) => args[0] === "cancel")).toBe(false);

        // Removing the integration while a worker is visible downgrades it
        // to reversible idle and hides cancellation without claiming death.
        const unavailable = yield* makeWithCliPath(undefined).pipe(
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(ServerEnvironment, fakeEnvironment),
          Effect.provideService(ThreadBackgroundLivenessService, liveness),
        );
        yield* unavailable.reconcile;
        yield* unavailable.reconcile;
        yield* unavailable.reconcile;
        const idleRows =
          yield* sql`SELECT payload_json AS payload FROM projection_thread_activities WHERE kind = 'task.progress' AND summary = 'Relay observer unavailable'`;
        expect(idleRows).toHaveLength(1);
        expect(decodeJson(idleRows[0]?.payload)).toMatchObject({
          taskId: `relay:${jobId}`,
          status: "idle",
          cancellable: false,
          outageEpoch: 1,
        });

        const reconnected = yield* makeWithCliPath(cli.path).pipe(
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(ServerEnvironment, fakeEnvironment),
          Effect.provideService(ThreadBackgroundLivenessService, liveness),
        );
        yield* reconnected.reconcile;
        const recoveredProgress = yield* sql`
          SELECT payload_json AS payload FROM projection_thread_activities
          WHERE activity_id = ${`relay-progress:${jobId}`}
        `;
        expect(decodeJson(recoveredProgress[0]?.payload)).toMatchObject({
          status: "running",
          relaySequence: 1,
        });
        cli.setState({});
        yield* reconnected.reconcile;
        yield* reconnected.reconcile;
        yield* reconnected.reconcile;
        const repeatedOutage = yield* sql`
          SELECT payload_json AS payload FROM projection_thread_activities
          WHERE kind = 'task.progress' AND summary = 'Relay observer unavailable'
          ORDER BY sequence
        `;
        expect(repeatedOutage).toHaveLength(2);
        expect(decodeJson(repeatedOutage[1]?.payload)).toMatchObject({
          status: "idle",
          relaySequence: 1,
          outageEpoch: 2,
        });

        cli.setState({
          [jobId]: {
            ...job,
            status: "completed",
            sequence: 2,
            outcome: {
              kind: "completed",
              label: "Completed",
              summary: "Reviewed the change",
              error: null,
            },
          },
        });
        yield* reconnected.reconcile;
        const completed =
          yield* sql`SELECT payload_json AS payload FROM projection_thread_activities WHERE kind = 'task.completed'`;
        expect(completed).toHaveLength(1);
        expect(decodeJson(completed[0]?.payload)).toMatchObject({
          taskId: `relay:${jobId}`,
          status: "completed",
          summary: "Reviewed the change",
          typedUsage: { totalTokens: 18 },
        });

        // A new bridge instance reconstructs the binding from persisted
        // activity; a resumed worker keeps its row identity and advances attempt.
        cli.setState({ [jobId]: { ...job, attempt: 2, sequence: 1, status: "running" } });
        const recovered = yield* makeWithCliPath(cli.path).pipe(
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(ServerEnvironment, fakeEnvironment),
          Effect.provideService(ThreadBackgroundLivenessService, liveness),
        );
        yield* recovered.recordToolResult(
          toolEvent({
            toolName: "mcp__relay__relay_resume",
            threadId: "thread-b",
            turnId: "turn-foreign",
            itemId: "tool-foreign",
            result: { structuredContent: { schemaVersion: 1, kind: "job", jobId, attempt: 2 } },
          }),
        );
        yield* recovered.recordToolResult(
          toolEvent({
            toolName: "mcp__relay__relay_resume",
            turnId: "turn-resume",
            itemId: "tool-resume",
            result: { structuredContent: { schemaVersion: 1, kind: "job", jobId, attempt: 2 } },
          }),
        );
        // A completed prior attempt must not retire a resumed worker when
        // observe is unavailable before the first new task.started receipt.
        cli.setState({});
        // The attempt origin survives a server restart before the next poll.
        const resumedBridge = yield* makeWithCliPath(cli.path).pipe(
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(ServerEnvironment, fakeEnvironment),
          Effect.provideService(ThreadBackgroundLivenessService, liveness),
        );
        yield* resumedBridge.reconcile;
        yield* resumedBridge.reconcile;
        yield* resumedBridge.reconcile;
        const pendingResume = yield* sql`
          SELECT turn_id AS turnId, payload_json AS payload FROM projection_thread_activities
          WHERE kind = 'task.progress' AND activity_id LIKE 'relay-observer-unavailable:%'
          ORDER BY sequence DESC LIMIT 1
        `;
        expect(pendingResume).toHaveLength(1);
        expect(pendingResume[0]?.turnId).toBe("turn-resume");
        expect(decodeJson(pendingResume[0]?.payload)).toMatchObject({
          taskId: `relay:${jobId}`,
          attempt: 2,
          relaySequence: 0,
          status: "idle",
          toolUseId: "tool-resume",
          relayPriorUsage: { totalTokens: 18, inputTokens: 12, outputTokens: 6 },
        });
        cli.setState({ [jobId]: { ...job, attempt: 2, sequence: 1, status: "running" } });
        yield* resumedBridge.reconcile;
        const resumed =
          yield* sql`SELECT turn_id AS turnId, payload_json AS payload FROM projection_thread_activities WHERE kind = 'task.started' ORDER BY created_at`;
        expect(resumed).toHaveLength(2);
        expect(decodeJson(resumed[1]?.payload)).toMatchObject({
          taskId: `relay:${jobId}`,
          attempt: 2,
          toolUseId: "tool-resume",
          relayPriorUsage: { totalTokens: 18, inputTokens: 12, outputTokens: 6 },
        });
        expect(resumed[1]?.turnId).toBe("turn-resume");
        const activations = yield* sql`
          SELECT thread_id AS threadId, payload_json AS payload FROM projection_thread_activities
          WHERE kind = 'relay.activation' AND activity_id = ${`relay-activation:${jobId}:2`}
        `;
        expect(activations).toHaveLength(1);
        expect(activations[0]?.threadId).toBe("thread-a");
        expect(decodeJson(activations[0]?.payload)).toMatchObject({
          id: jobId,
          attempt: 2,
          toolCallId: "tool-resume",
          environmentId: "test-environment",
        });
        const cancelled = yield* resumedBridge.cancel(ThreadId.make("thread-a"), `relay:${jobId}`);
        expect(cancelled.disposition).toBe("cancel-requested");
        expect(cli.calls().some((args) => args[0] === "cancel" && args[1] === jobId)).toBe(true);

        const panelJob = { ...job, id: panelInitialJobId, attempt: 1, sequence: 1 };
        const replacementJob = { ...job, id: replacementJobId, attempt: 1, sequence: 1 };
        const panel = {
          schemaVersion: 1,
          kind: "panel",
          id: panelId,
          complete: false,
          members: [
            {
              index: 0,
              slotAttempt: 1,
              state: "started",
              jobId: panelInitialJobId,
              job: panelJob,
            },
            { index: 1, slotAttempt: 1, state: "unstarted", jobId: null, job: null },
          ],
        };
        cli.setState({
          [panelInitialJobId]: panelJob,
          [replacementJobId]: replacementJob,
          [panelId]: panel,
        });
        yield* resumedBridge.recordToolResult(
          toolEvent({
            toolName: "mcp__relay__relay_panel",
            turnId: "turn-panel",
            itemId: "tool-panel",
            result: {
              structuredContent: {
                schemaVersion: 1,
                kind: "panel",
                panelId,
                jobIds: [panelInitialJobId],
              },
            },
          }),
        );
        // A continuation can arrive before the first panel observation. Its
        // cumulative jobIds must not steal the initial member's origin.
        yield* resumedBridge.recordToolResult(
          toolEvent({
            toolName: "mcp__relay__relay_panel_continue",
            turnId: "turn-continue",
            itemId: "tool-continue",
            result: {
              structuredContent: {
                schemaVersion: 1,
                kind: "panel",
                panelId,
                jobIds: [panelInitialJobId, replacementJobId],
              },
            },
          }),
        );
        yield* resumedBridge.reconcile;
        const slotId = `relay-panel:${panelId}:member:0`;
        const slotRows =
          yield* sql`SELECT payload_json AS payload FROM projection_thread_activities WHERE kind = 'task.started' AND json_extract(payload_json, '$.taskId') = ${slotId}`;
        expect(slotRows).toHaveLength(1);
        expect(decodeJson(slotRows[0]?.payload)).toMatchObject({
          taskId: slotId,
          attempt: 1_000_001,
          toolUseId: "tool-panel",
        });
        const unstarted =
          yield* sql`SELECT COUNT(*) AS count FROM projection_thread_activities WHERE kind = 'task.started' AND json_extract(payload_json, '$.taskId') = ${`relay-panel:${panelId}:member:1`}`;
        expect(unstarted[0]?.count).toBe(0);

        cli.setState({
          [panelInitialJobId]: { ...panelJob, status: "failed", sequence: 2 },
          [replacementJobId]: replacementJob,
          [panelId]: {
            ...panel,
            members: [
              { ...panel.members[0], job: { ...panelJob, status: "failed", sequence: 2 } },
              panel.members[1],
            ],
          },
        });
        yield* resumedBridge.reconcile;
        const completedMemberObserveCount = cli
          .calls()
          .filter((args) => args[0] === "observe" && args[1] === panelInitialJobId).length;
        yield* resumedBridge.reconcile;
        expect(
          cli.calls().filter((args) => args[0] === "observe" && args[1] === panelInitialJobId),
        ).toHaveLength(completedMemberObserveCount);

        cli.setState({
          [panelInitialJobId]: { ...panelJob, status: "failed", sequence: 3 },
          [replacementJobId]: replacementJob,
          [panelId]: {
            ...panel,
            members: [
              {
                index: 0,
                slotAttempt: 2,
                state: "started",
                jobId: replacementJobId,
                job: replacementJob,
              },
              { index: 1, slotAttempt: 1, state: "unstarted", jobId: null, job: null },
            ],
          },
        });
        yield* resumedBridge.reconcile;
        const replaced =
          yield* sql`SELECT turn_id AS turnId, payload_json AS payload FROM projection_thread_activities WHERE kind = 'task.started' AND json_extract(payload_json, '$.taskId') = ${slotId} ORDER BY created_at`;
        expect(replaced).toHaveLength(2);
        expect(decodeJson(replaced[1]?.payload)).toMatchObject({
          taskId: slotId,
          attempt: 2_000_001,
          toolUseId: "tool-continue",
        });
        expect(replaced[1]?.turnId).toBe("turn-continue");
        const slotCancel = yield* resumedBridge.cancel(ThreadId.make("thread-a"), slotId);
        expect(slotCancel.disposition).toBe("cancel-requested");
        expect(
          cli.calls().some((args) => args[0] === "cancel" && args[1] === replacementJobId),
        ).toBe(true);

        // An incomplete panel with no active members remains visible as idle,
        // while the observer parks until a continuation or resume receipt.
        const failedReplacement = { ...replacementJob, status: "failed", sequence: 2 };
        const idlePanel = {
          ...panel,
          members: [
            {
              ...panel.members[0],
              slotAttempt: 2,
              jobId: replacementJobId,
              job: failedReplacement,
            },
            panel.members[1],
          ],
        };
        cli.setState({ [panelId]: idlePanel, [replacementJobId]: failedReplacement });
        yield* resumedBridge.reconcile;
        const idlePanelObserveCount = cli
          .calls()
          .filter(
            (args) => args[0] === "observe" && args[1] === "--panel" && args[2] === panelId,
          ).length;
        yield* resumedBridge.reconcile;
        expect(
          cli
            .calls()
            .filter(
              (args) => args[0] === "observe" && args[1] === "--panel" && args[2] === panelId,
            ),
        ).toHaveLength(idlePanelObserveCount);
        const idlePanelProgress = yield* sql`
          SELECT payload_json AS payload FROM projection_thread_activities
          WHERE kind = 'task.progress' AND json_extract(payload_json, '$.taskId') = ${`relay-panel:${panelId}`}
          ORDER BY sequence DESC LIMIT 1
        `;
        expect(decodeJson(idlePanelProgress[0]?.payload)).toMatchObject({ status: "idle" });

        // Relay recalculates panel.complete from current member jobs. A
        // resumed member keeps its slot and job ID, while job.attempt grows.
        const completedPanelJob = {
          ...job,
          id: completedPanelJobId,
          status: "completed",
          sequence: 2,
        };
        const completedPanel = {
          schemaVersion: 1,
          kind: "panel",
          id: completedPanelId,
          complete: true,
          members: [
            {
              index: 0,
              slotAttempt: 1,
              state: "started",
              jobId: completedPanelJobId,
              job: completedPanelJob,
            },
          ],
        };
        cli.setState({
          [completedPanelId]: completedPanel,
          [completedPanelJobId]: completedPanelJob,
        });
        yield* resumedBridge.recordToolResult(
          toolEvent({
            toolName: "mcp__relay__relay_panel",
            turnId: "turn-completed-panel",
            itemId: "tool-completed-panel",
            result: {
              structuredContent: {
                schemaVersion: 1,
                kind: "panel",
                panelId: completedPanelId,
                jobIds: [completedPanelJobId],
              },
            },
          }),
        );
        yield* resumedBridge.reconcile;
        const completedPanelMemberId = `relay-panel:${completedPanelId}:member:0`;
        const completedPanelRows = yield* sql`
          SELECT payload_json AS payload FROM projection_thread_activities
          WHERE kind = 'task.completed' AND json_extract(payload_json, '$.taskId') = ${completedPanelMemberId}
        `;
        expect(completedPanelRows).toHaveLength(1);
        const resumedPanelJob = {
          ...completedPanelJob,
          attempt: 2,
          sequence: 1,
          status: "running",
        };
        cli.setState({
          [completedPanelId]: {
            ...completedPanel,
            complete: false,
            members: [{ ...completedPanel.members[0], job: resumedPanelJob }],
          },
          [completedPanelJobId]: resumedPanelJob,
        });
        yield* resumedBridge.recordToolResult(
          toolEvent({
            toolName: "mcp__relay__relay_resume",
            turnId: "turn-panel-resume",
            itemId: "tool-panel-resume",
            result: {
              structuredContent: {
                schemaVersion: 1,
                kind: "job",
                jobId: completedPanelJobId,
                attempt: 2,
              },
            },
          }),
        );
        yield* resumedBridge.reconcile;
        const resumedPanelRows = yield* sql`
          SELECT turn_id AS turnId, payload_json AS payload FROM projection_thread_activities
          WHERE kind = 'task.started' AND json_extract(payload_json, '$.taskId') = ${completedPanelMemberId}
          ORDER BY sequence
        `;
        expect(resumedPanelRows).toHaveLength(2);
        expect(decodeJson(resumedPanelRows[1]?.payload)).toMatchObject({
          attempt: 1_000_002,
          toolUseId: "tool-panel-resume",
          cancellable: true,
        });
        expect(resumedPanelRows[1]?.turnId).toBe("turn-panel-resume");
        const panelCoordinatorRows = yield* sql`
          SELECT payload_json AS payload FROM projection_thread_activities
          WHERE kind = 'task.started' AND json_extract(payload_json, '$.taskId') = ${`relay-panel:${completedPanelId}`}
          ORDER BY sequence
        `;
        expect(panelCoordinatorRows).toHaveLength(2);
        expect(decodeJson(panelCoordinatorRows[1]?.payload)).toMatchObject({ attempt: 2 });
        expect(
          (yield* resumedBridge.cancel(ThreadId.make("thread-a"), completedPanelMemberId))
            .disposition,
        ).toBe("cancel-requested");
        expect(
          cli.calls().some((args) => args[0] === "cancel" && args[1] === completedPanelJobId),
        ).toBe(true);

        // Crash after a later resume receipt but before observation: startup
        // must reactivate the completed parent from its active child binding.
        const completedSecondAttempt = {
          ...resumedPanelJob,
          status: "completed",
          sequence: 2,
        };
        cli.setState({
          [completedPanelId]: {
            ...completedPanel,
            members: [{ ...completedPanel.members[0], job: completedSecondAttempt }],
          },
          [completedPanelJobId]: completedSecondAttempt,
        });
        yield* resumedBridge.reconcile;
        const thirdAttempt = { ...resumedPanelJob, attempt: 3 };
        cli.setState({
          [completedPanelId]: {
            ...completedPanel,
            complete: false,
            members: [{ ...completedPanel.members[0], job: thirdAttempt }],
          },
          [completedPanelJobId]: thirdAttempt,
        });
        yield* resumedBridge.recordToolResult(
          toolEvent({
            toolName: "mcp__relay__relay_resume",
            turnId: "turn-panel-resume-after-restart",
            itemId: "tool-panel-resume-after-restart",
            result: {
              structuredContent: {
                schemaVersion: 1,
                kind: "job",
                jobId: completedPanelJobId,
                attempt: 3,
              },
            },
          }),
        );
        const restartedPanelBridge = yield* makeWithCliPath(cli.path).pipe(
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(ServerEnvironment, fakeEnvironment),
          Effect.provideService(ThreadBackgroundLivenessService, liveness),
        );
        // Three failed observations must park the reactivated coordinator as
        // idle at its new attempt, not discard the resumed child binding.
        cli.setState({});
        yield* restartedPanelBridge.reconcile;
        yield* restartedPanelBridge.reconcile;
        yield* restartedPanelBridge.reconcile;
        const unavailablePanel = yield* sql`
          SELECT payload_json AS payload FROM projection_thread_activities
          WHERE kind = 'task.progress' AND summary = 'Relay observer unavailable'
            AND json_extract(payload_json, '$.taskId') = ${`relay-panel:${completedPanelId}`}
          ORDER BY sequence DESC LIMIT 1
        `;
        expect(unavailablePanel).toHaveLength(1);
        expect(decodeJson(unavailablePanel[0]?.payload)).toMatchObject({
          attempt: 3,
          status: "idle",
          toolUseId: "tool-panel-resume-after-restart",
        });
        cli.setState({
          [completedPanelId]: {
            ...completedPanel,
            complete: false,
            members: [{ ...completedPanel.members[0], job: thirdAttempt }],
          },
          [completedPanelJobId]: thirdAttempt,
        });
        yield* restartedPanelBridge.reconcile;
        const thirdStart = yield* sql`
          SELECT turn_id AS turnId, payload_json AS payload FROM projection_thread_activities
          WHERE kind = 'task.started' AND json_extract(payload_json, '$.taskId') = ${completedPanelMemberId}
            AND json_extract(payload_json, '$.attempt') = 1000003
        `;
        expect(thirdStart).toHaveLength(1);
        expect(thirdStart[0]?.turnId).toBe("turn-panel-resume-after-restart");
        expect(decodeJson(thirdStart[0]?.payload)).toMatchObject({
          taskId: completedPanelMemberId,
          toolUseId: "tool-panel-resume-after-restart",
        });
        expect(
          (yield* restartedPanelBridge.cancel(ThreadId.make("thread-a"), completedPanelMemberId))
            .disposition,
        ).toBe("cancel-requested");

        // Startup pages historical bindings without observing settled jobs or
        // retaining a terminal seen entry for each completed worker.
        yield* sql`
          WITH RECURSIVE jobs(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM jobs WHERE n < 300
          )
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          )
          SELECT
            'relay-binding:' || printf('job-00000000-0000-4000-8000-%012d', n),
            'thread-a', 'turn-a', 'info', 'relay.binding', 'Relay worker bound',
            json_object('kind', 'job', 'id', printf('job-00000000-0000-4000-8000-%012d', n),
              'toolCallId', 'tool-old', 'environmentId', 'test-environment'),
            n, '2026-09-22T00:00:00.000Z'
          FROM jobs
        `;
        yield* sql`
          WITH RECURSIVE jobs(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM jobs WHERE n < 300
          )
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          )
          SELECT
            'relay-complete:' || printf('job-00000000-0000-4000-8000-%012d', n),
            'thread-a', 'turn-a', 'info', 'task.completed', 'Relay worker completed',
            json_object('taskId', 'relay:' || printf('job-00000000-0000-4000-8000-%012d', n),
              'source', 'relay', 'attempt', 1, 'relaySequence', 1, 'status', 'completed'),
            n + 1000, '2026-09-22T00:00:01.000Z'
          FROM jobs
        `;
        const bootAfterChurn = yield* makeWithCliPath(cli.path).pipe(
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(ServerEnvironment, fakeEnvironment),
          Effect.provideService(ThreadBackgroundLivenessService, liveness),
        );
        yield* bootAfterChurn.reconcile;
        expect(
          cli
            .calls()
            .filter((args) => args[0] === "observe" && args[1]?.startsWith("job-00000000-")),
        ).toHaveLength(0);
      }).pipe(Effect.ensuring(Effect.sync(() => cli.cleanup())));
    },
  );
});
