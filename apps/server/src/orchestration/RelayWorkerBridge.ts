// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  CommandId,
  EventId,
  ProviderDriverKind,
  ProviderCancelSessionAgentError,
  type ProviderCancelSessionAgentResult,
  type ProviderRuntimeEvent,
  ThreadId,
  RuntimeItemId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ThreadBackgroundLivenessService } from "./ThreadBackgroundLiveness.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));
const JOB_ID = /^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PANEL_ID = /^panel-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OBSERVE_BYTES = 128 * 1024;
const MAX_LABEL = 300;

interface RelayBinding {
  readonly kind: "job" | "panel";
  readonly id: string;
  readonly threadId: ThreadId;
  readonly turnId: string | null;
  readonly toolCallId: string;
  readonly environmentId: string;
  readonly panelId?: string;
  readonly agentIndex?: number;
  readonly slotAttempt?: number;
}

interface RelayToolReceipt {
  readonly binding: Omit<RelayBinding, "environmentId">;
  readonly toolName: "relay_delegate" | "relay_panel" | "relay_resume" | "relay_panel_continue";
  readonly attempt?: number;
  readonly jobIds?: ReadonlyArray<string>;
}

interface RelayJobObservation {
  readonly schemaVersion: 1;
  readonly kind: "job";
  readonly id: string;
  readonly attempt: number;
  readonly sequence: number;
  readonly status: string;
  readonly providerType?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly panelId?: string | null;
  readonly panelMemberIndex?: number | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly activity?: { readonly kind?: string; readonly label?: string } | null;
  readonly usage?: {
    readonly totalTokens?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
  } | null;
  readonly outcome?: {
    readonly kind?: string;
    readonly label?: string;
    readonly summary?: string | null;
    readonly error?: string | null;
  } | null;
  readonly pending?: boolean;
}

interface RelayPanelObservation {
  readonly schemaVersion: 1;
  readonly kind: "panel";
  readonly id: string;
  readonly createdAt?: string;
  readonly complete: boolean;
  readonly members: ReadonlyArray<{
    readonly index: number;
    readonly slotAttempt: number;
    readonly state: string;
    readonly jobId: string | null;
    readonly job?: RelayJobObservation | null;
  }>;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const boundedText = (value: unknown, max = MAX_LABEL): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, max) : undefined;
const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Only a direct successful result from the configured Relay MCP server can bind a job. */
export function relayBindingFromToolEvent(
  event: ProviderRuntimeEvent,
): ReadonlyArray<Omit<RelayBinding, "environmentId">> {
  const receipt = relayReceiptFromToolEvent(event);
  return receipt ? [receipt.binding] : [];
}

function relayReceiptFromToolEvent(event: ProviderRuntimeEvent): RelayToolReceipt | undefined {
  if (
    event.type !== "item.completed" ||
    event.payload.itemType !== "mcp_tool_call" ||
    event.payload.status !== "completed" ||
    event.itemId === undefined ||
    event.turnId === undefined
  )
    return undefined;
  const data = record(event.payload.data);
  const item = record(data?.item);
  const toolName =
    item?.server === "relay" && typeof item.tool === "string"
      ? item.tool
      : typeof data?.toolName === "string" &&
          /^(?:mcp__relay__|mcp__plugin_relay-orchestrator_relay__)relay_/.test(data.toolName)
        ? data.toolName.split("__").at(-1)
        : undefined;
  if (
    !toolName ||
    !["relay_delegate", "relay_panel", "relay_resume", "relay_panel_continue"].includes(toolName)
  ) {
    return undefined;
  }
  const result = item?.result ?? data?.result;
  const structured = relayStructuredResult(result);
  if (!structured || structured.schemaVersion !== 1) return undefined;
  const base = {
    threadId: event.threadId,
    turnId: String(event.turnId),
    toolCallId: String(event.itemId),
  };
  if (
    (toolName === "relay_delegate" || toolName === "relay_resume") &&
    structured.kind === "job" &&
    typeof structured.jobId === "string" &&
    JOB_ID.test(structured.jobId)
  ) {
    const attempt = nonNegativeInteger(structured.attempt);
    if (toolName === "relay_resume" && (attempt === undefined || attempt < 1)) return undefined;
    return {
      binding: { kind: "job", id: structured.jobId, ...base },
      toolName,
      ...(attempt !== undefined ? { attempt } : {}),
    };
  }
  if (
    (toolName === "relay_panel" || toolName === "relay_panel_continue") &&
    structured.kind === "panel" &&
    typeof structured.panelId === "string" &&
    PANEL_ID.test(structured.panelId)
  ) {
    const jobIds = Array.isArray(structured.jobIds)
      ? structured.jobIds.filter((id): id is string => typeof id === "string" && JOB_ID.test(id))
      : [];
    return {
      binding: { kind: "panel", id: structured.panelId, ...base },
      toolName,
      jobIds: jobIds.slice(0, 8),
    };
  }
  return undefined;
}

function relayStructuredResult(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 4) return undefined;
  const object = record(value);
  if (!object) {
    if (typeof value !== "string" || value.length > 16_384) return undefined;
    try {
      return relayStructuredResult(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (object.schemaVersion === 1 && (object.kind === "job" || object.kind === "panel"))
    return object;
  if (object.structuredContent !== undefined)
    return relayStructuredResult(object.structuredContent, depth + 1);
  if (object.result !== undefined) return relayStructuredResult(object.result, depth + 1);
  if (typeof object.content === "string") {
    return relayStructuredResult(object.content, depth + 1);
  }
  if (Array.isArray(object.content)) {
    for (const block of object.content.slice(0, 4)) {
      const nested = record(block);
      const parsed = relayStructuredResult(nested?.text ?? nested?.content, depth + 1);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

export function parseObservation(
  value: unknown,
  expectedId: string,
): RelayJobObservation | RelayPanelObservation | undefined {
  const object = record(value);
  if (!object || object.schemaVersion !== 1 || object.id !== expectedId) return undefined;
  if (
    object.kind === "job" &&
    JOB_ID.test(expectedId) &&
    nonNegativeInteger(object.attempt) !== undefined &&
    object.attempt !== 0 &&
    nonNegativeInteger(object.sequence) !== undefined &&
    typeof object.status === "string" &&
    [
      "starting",
      "queued",
      "running",
      "cancelling",
      "orphaned",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "timed_out",
      "output_limit",
      "blocked_permissions",
      "needs_review",
    ].includes(object.status)
  ) {
    return object as unknown as RelayJobObservation;
  }
  if (
    object.kind === "panel" &&
    PANEL_ID.test(expectedId) &&
    typeof object.complete === "boolean" &&
    Array.isArray(object.members) &&
    object.members.length <= 8 &&
    object.members.every((member: unknown) => {
      const slot = record(member);
      return (
        slot !== undefined &&
        nonNegativeInteger(slot.index) !== undefined &&
        nonNegativeInteger(slot.index)! <= 7 &&
        nonNegativeInteger(slot.slotAttempt) !== undefined &&
        nonNegativeInteger(slot.slotAttempt)! > 0 &&
        (slot.state === "started" || slot.state === "unstarted") &&
        (slot.jobId === null || (typeof slot.jobId === "string" && JOB_ID.test(slot.jobId)))
      );
    })
  ) {
    return object as unknown as RelayPanelObservation;
  }
  return undefined;
}

function observationFingerprint(observation: RelayJobObservation | RelayPanelObservation): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(observation))
    .digest("hex")
    .slice(0, 16);
}

const relayStatus = (
  status: string,
): "pending" | "running" | "idle" | "completed" | "failed" | "cancelled" | "interrupted" => {
  if (status === "queued" || status === "starting") return "pending";
  if (status === "running" || status === "cancelling") return "running";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "interrupted") return "interrupted";
  if (
    ["failed", "blocked_permissions", "needs_review", "timed_out", "output_limit"].includes(status)
  )
    return "failed";
  return "idle";
};

function bindingPayload(binding: RelayBinding) {
  return {
    taskType: binding.kind === "panel" ? "local_workflow" : "subagent",
    agentKind: "agent",
    source: "relay",
    cancellable: binding.kind === "job",
    watchable: false,
    messageable: false,
    timelineBypass: true,
    toolUseId: binding.toolCallId,
    ...(binding.panelId
      ? { parentAgentId: `relay-panel:${binding.panelId}`, workflowName: "Relay panel" }
      : {}),
    ...(binding.agentIndex !== undefined ? { agentIndex: binding.agentIndex } : {}),
  };
}

function bindingTaskId(binding: RelayBinding): string {
  if (binding.kind === "panel") return `relay-panel:${binding.id}`;
  if (binding.panelId !== undefined && binding.agentIndex !== undefined) {
    return `relay-panel:${binding.panelId}:member:${binding.agentIndex}`;
  }
  return `relay:${binding.id}`;
}

export class RelayWorkerBridge extends Context.Service<
  RelayWorkerBridge,
  {
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly reconcile: Effect.Effect<void>;
    readonly recordToolResult: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
    readonly cancel: (
      threadId: ThreadId,
      agentId: string,
    ) => Effect.Effect<ProviderCancelSessionAgentResult, ProviderCancelSessionAgentError>;
  }
>()("t3/orchestration/RelayWorkerBridge") {}

export const makeWithCliPath = Effect.fn("RelayWorkerBridge.makeWithCliPath")(function* (
  cliPath: string | undefined,
) {
  const enabled = cliPath !== undefined && NodePath.isAbsolute(cliPath);
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const environmentId = String(yield* (yield* ServerEnvironment).getEnvironmentId);
  const liveness = yield* ThreadBackgroundLivenessService;
  const active = new Map<string, RelayBinding>();
  const seen = new Map<string, { attempt: number; sequence: number; state: string }>();
  const currentPanelJobs = new Map<string, ReadonlyMap<number, string>>();
  const failedObservations = new Map<string, number>();
  const unavailable = new Set<string>();

  const append = Effect.fn("RelayWorkerBridge.append")(function* (
    binding: RelayBinding,
    kind: string,
    payload: Record<string, unknown>,
    summary: string,
    id: string,
    fingerprint: string,
  ) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const activity: OrchestrationThreadActivity = {
      id: EventId.make(id),
      createdAt,
      turnId: binding.turnId as OrchestrationThreadActivity["turnId"],
      tone: kind === "task.completed" && payload.status === "failed" ? "error" : "info",
      kind,
      summary,
      payload,
    };
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`relay:v2:${id}:${fingerprint}`),
      threadId: binding.threadId,
      activity,
      createdAt,
    });
    if (kind.startsWith("task.")) {
      liveness.recordTaskLiveness({
        threadId: binding.threadId,
        taskId: bindingTaskId(binding),
        taskType: binding.kind === "panel" ? "local_workflow" : "subagent",
        status: typeof payload.status === "string" ? payload.status : undefined,
        kind:
          kind === "task.started"
            ? "started"
            : kind === "task.completed"
              ? "completed"
              : "progress",
      });
    }
  });

  const readBindings = Effect.fn("RelayWorkerBridge.readBindings")(function* () {
    const rows = yield* sql`
      SELECT thread_id AS threadId, turn_id AS turnId, payload_json AS payload
      FROM projection_thread_activities WHERE kind = 'relay.binding'
        AND json_extract(payload_json, '$.environmentId') = ${environmentId}
    `;
    const bindings: RelayBinding[] = [];
    for (const raw of rows) {
      const row = record(raw);
      if (!row || typeof row.payload !== "string" || typeof row.threadId !== "string") continue;
      const decoded = decodeJson(row.payload);
      const payload = Option.isSome(decoded) ? record(decoded.value) : undefined;
      if (
        !payload ||
        !(
          (payload.kind === "job" && typeof payload.id === "string" && JOB_ID.test(payload.id)) ||
          (payload.kind === "panel" && typeof payload.id === "string" && PANEL_ID.test(payload.id))
        ) ||
        typeof payload.toolCallId !== "string"
      )
        continue;
      if (payload.environmentId !== environmentId) continue;
      bindings.push({
        kind: payload.kind as "job" | "panel",
        id: payload.id as string,
        threadId: ThreadId.make(row.threadId),
        turnId: typeof row.turnId === "string" ? row.turnId : null,
        toolCallId: payload.toolCallId,
        environmentId,
        ...(typeof payload.panelId === "string" ? { panelId: payload.panelId } : {}),
        ...(nonNegativeInteger(payload.agentIndex) !== undefined
          ? { agentIndex: payload.agentIndex as number }
          : {}),
        ...(nonNegativeInteger(payload.slotAttempt) !== undefined
          ? { slotAttempt: payload.slotAttempt as number }
          : {}),
      });
    }
    return bindings;
  });

  const readActivation = Effect.fn("RelayWorkerBridge.readActivation")(function* (
    binding: RelayBinding,
    attempt: number,
  ) {
    const rows = yield* sql`
      SELECT turn_id AS turnId, payload_json AS payload
      FROM projection_thread_activities
      WHERE activity_id = ${`relay-activation:${binding.id}:${attempt}`}
        AND thread_id = ${binding.threadId} AND kind = 'relay.activation'
        AND json_extract(payload_json, '$.environmentId') = ${environmentId}
      LIMIT 1
    `;
    const row = record(rows[0]);
    const decoded = typeof row?.payload === "string" ? decodeJson(row.payload) : Option.none();
    const payload = Option.isSome(decoded) ? record(decoded.value) : undefined;
    return payload?.id === binding.id &&
      payload.attempt === attempt &&
      typeof payload.toolCallId === "string"
      ? {
          ...binding,
          turnId: typeof row?.turnId === "string" ? row.turnId : null,
          toolCallId: payload.toolCallId,
        }
      : undefined;
  });

  const readPanelJobOrigin = Effect.fn("RelayWorkerBridge.readPanelJobOrigin")(function* (
    panel: RelayBinding,
    jobId: string,
  ) {
    const rows = yield* sql`
      SELECT turn_id AS turnId, payload_json AS payload
      FROM projection_thread_activities
      WHERE thread_id = ${panel.threadId} AND kind = 'relay.activation'
        AND json_extract(payload_json, '$.environmentId') = ${environmentId}
        AND json_extract(payload_json, '$.id') = ${panel.id}
        AND EXISTS (
          SELECT 1 FROM json_each(json_extract(payload_json, '$.jobIds'))
          WHERE value = ${jobId}
        )
      ORDER BY created_at DESC, activity_id DESC LIMIT 1
    `;
    const row = record(rows[0]);
    const decoded = typeof row?.payload === "string" ? decodeJson(row.payload) : Option.none();
    const payload = Option.isSome(decoded) ? record(decoded.value) : undefined;
    return typeof payload?.toolCallId === "string"
      ? {
          turnId: typeof row?.turnId === "string" ? row.turnId : null,
          toolCallId: payload.toolCallId,
        }
      : undefined;
  });

  const register = Effect.fn("RelayWorkerBridge.register")(function* (binding: RelayBinding) {
    const existing = (yield* readBindings()).find((candidate) => candidate.id === binding.id);
    if (existing && (existing.threadId !== binding.threadId || existing.kind !== binding.kind)) {
      yield* Effect.logWarning("Relay ID already belongs to another thread", { id: binding.id });
      return false;
    }
    const foreign = yield* sql`
      SELECT 1 FROM projection_thread_activities WHERE kind = 'relay.binding'
        AND json_extract(payload_json, '$.id') = ${binding.id}
        AND json_extract(payload_json, '$.environmentId') != ${environmentId}
      LIMIT 1
    `;
    if (foreign.length > 0) return false;
    if (!existing) {
      yield* append(
        binding,
        "relay.binding",
        {
          kind: binding.kind,
          id: binding.id,
          toolCallId: binding.toolCallId,
          environmentId: binding.environmentId,
          ...(binding.panelId ? { panelId: binding.panelId } : {}),
          ...(binding.agentIndex !== undefined ? { agentIndex: binding.agentIndex } : {}),
          ...(binding.slotAttempt !== undefined ? { slotAttempt: binding.slotAttempt } : {}),
        },
        "Relay worker bound",
        `relay-binding:${binding.id}`,
        "v1",
      );
    }
    active.set(binding.id, existing ?? binding);
    return true;
  });

  const recordReceipt = Effect.fn("RelayWorkerBridge.recordReceipt")(function* (
    receipt: RelayToolReceipt,
  ) {
    const binding = { ...receipt.binding, environmentId };
    if (!(yield* register(binding))) return;
    if (receipt.toolName === "relay_resume" && receipt.attempt !== undefined) {
      if (yield* readActivation(binding, receipt.attempt)) return;
      yield* append(
        binding,
        "relay.activation",
        {
          id: binding.id,
          kind: "job",
          attempt: receipt.attempt,
          toolCallId: binding.toolCallId,
          environmentId,
        },
        "Relay worker resumed",
        `relay-activation:${binding.id}:${receipt.attempt}`,
        "v1",
      );
    } else if (
      (receipt.toolName === "relay_panel" || receipt.toolName === "relay_panel_continue") &&
      receipt.jobIds?.length
    ) {
      yield* append(
        binding,
        "relay.activation",
        {
          id: binding.id,
          kind: "panel",
          jobIds: receipt.jobIds,
          toolCallId: binding.toolCallId,
          environmentId,
        },
        "Relay panel dispatched",
        `relay-activation:${binding.id}:${binding.toolCallId}`,
        "v1",
      );
    }
  });

  // Provider ingestion persists the direct MCP completion before it invokes
  // this observer. If the process dies in between, the accepted provider
  // receipt can still establish the same exact thread/turn/tool-call binding.
  const recoverPersistedToolReceipts = Effect.fn("RelayWorkerBridge.recoverPersistedToolReceipts")(
    function* () {
      const bound = new Set((yield* readBindings()).map((binding) => binding.id));
      let offset = 0;
      for (;;) {
        const rows = yield* sql`
          SELECT activity_id AS activityId, thread_id AS threadId,
            turn_id AS turnId, created_at AS createdAt, payload_json AS payload
          FROM projection_thread_activities
          WHERE kind = 'tool.completed'
            AND (
              json_extract(payload_json, '$.data.toolName') IN (
                'mcp__relay__relay_delegate',
                'mcp__relay__relay_resume',
                'mcp__relay__relay_panel',
                'mcp__relay__relay_panel_continue',
                'mcp__plugin_relay-orchestrator_relay__relay_delegate',
                'mcp__plugin_relay-orchestrator_relay__relay_resume',
                'mcp__plugin_relay-orchestrator_relay__relay_panel',
                'mcp__plugin_relay-orchestrator_relay__relay_panel_continue'
              ) OR (
                json_extract(payload_json, '$.data.item.server') = 'relay'
                AND json_extract(payload_json, '$.data.item.tool') IN (
                  'relay_delegate', 'relay_resume', 'relay_panel', 'relay_panel_continue'
                )
              )
            )
          ORDER BY created_at, activity_id LIMIT 256 OFFSET ${offset}
        `;
        for (const raw of rows) {
          const row = record(raw);
          if (
            !row ||
            typeof row.payload !== "string" ||
            typeof row.threadId !== "string" ||
            typeof row.turnId !== "string" ||
            typeof row.activityId !== "string" ||
            typeof row.createdAt !== "string"
          )
            continue;
          const decoded = decodeJson(row.payload);
          const payload = Option.isSome(decoded) ? record(decoded.value) : undefined;
          if (!payload || typeof payload.toolCallId !== "string") continue;
          const event = {
            type: "item.completed",
            eventId: EventId.make(row.activityId),
            provider: ProviderDriverKind.make("claudeAgent"),
            threadId: ThreadId.make(row.threadId),
            turnId: TurnId.make(row.turnId),
            itemId: RuntimeItemId.make(payload.toolCallId),
            createdAt: row.createdAt,
            payload: {
              itemType: "mcp_tool_call",
              status: payload.status,
              data: payload.data,
            },
          } as ProviderRuntimeEvent;
          const receipt = relayReceiptFromToolEvent(event);
          if (!receipt) continue;
          if (
            !bound.has(receipt.binding.id) ||
            receipt.toolName === "relay_resume" ||
            receipt.toolName === "relay_panel" ||
            receipt.toolName === "relay_panel_continue"
          ) {
            yield* recordReceipt(receipt);
            bound.add(receipt.binding.id);
          }
        }
        if (rows.length < 256) break;
        offset += rows.length;
      }
    },
  );

  const runCli = Effect.fn("RelayWorkerBridge.runCli")(function* (args: ReadonlyArray<string>) {
    if (!enabled || !cliPath) return Option.none<{ stdout: string; stderr: string }>();
    return yield* Effect.tryPromise({
      try: () =>
        execFile(process.execPath, [cliPath, ...args], {
          timeout: 12_000,
          maxBuffer: MAX_OBSERVE_BYTES,
          windowsHide: true,
        }),
      catch: () => undefined,
    }).pipe(Effect.option);
  });

  const markObserverUnavailable = Effect.fn("RelayWorkerBridge.markObserverUnavailable")(function* (
    binding: RelayBinding,
  ) {
    const failures = (failedObservations.get(binding.id) ?? 0) + 1;
    failedObservations.set(binding.id, failures);
    if (failures < 3 || unavailable.has(binding.id)) return;
    const taskId = bindingTaskId(binding);
    const rows = yield* sql`
      SELECT kind, payload_json AS payload FROM projection_thread_activities
      WHERE thread_id = ${binding.threadId}
        AND kind IN ('task.started', 'task.progress', 'task.updated', 'task.completed')
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.taskId') END = ${taskId}
      ORDER BY created_at DESC, activity_id DESC LIMIT 1
    `;
    const latest = record(rows[0]);
    if (!latest || typeof latest.payload !== "string") return;
    const decoded = decodeJson(latest.payload);
    const payload = Option.isSome(decoded) ? record(decoded.value) : undefined;
    const attempt = nonNegativeInteger(payload?.attempt);
    const relaySequence = nonNegativeInteger(payload?.relaySequence);
    if (attempt === undefined || relaySequence === undefined) return;
    if (latest.kind === "task.completed") {
      seen.set(binding.id, { attempt, sequence: relaySequence, state: "terminal" });
      active.delete(binding.id);
      return;
    }
    yield* append(
      binding,
      "task.progress",
      {
        taskId,
        title: binding.kind === "panel" ? "Relay panel" : "Relay worker",
        attempt,
        relaySequence,
        status: "idle",
        summary: "Relay observer unavailable",
        detail: "Relay observer unavailable",
        ...bindingPayload(binding),
        cancellable: false,
      },
      "Relay observer unavailable",
      `relay-observer-unavailable:${binding.id}`,
      `${attempt}:${relaySequence}`,
    );
    unavailable.add(binding.id);
  });

  const poll = Effect.fn("RelayWorkerBridge.poll")(function* (binding: RelayBinding) {
    const result = yield* runCli(
      binding.kind === "job" ? ["observe", binding.id] : ["observe", "--panel", binding.id],
    );
    if (Option.isNone(result)) return yield* markObserverUnavailable(binding);
    const parsed = decodeJson(result.value.stdout);
    const observation = parseObservation(
      Option.isSome(parsed) ? parsed.value : undefined,
      binding.id,
    );
    if (!observation) return yield* markObserverUnavailable(binding);
    const wasUnavailable = unavailable.delete(binding.id);
    failedObservations.delete(binding.id);
    const taskId = bindingTaskId(binding);
    if (observation.kind === "panel") {
      currentPanelJobs.set(
        binding.id,
        new Map(
          observation.members.flatMap((member) =>
            member.jobId && JOB_ID.test(member.jobId)
              ? [[member.index, member.jobId] as const]
              : [],
          ),
        ),
      );
      const fingerprint = observationFingerprint(observation);
      const previous = seen.get(binding.id);
      if (!previous) {
        yield* append(
          binding,
          "task.started",
          {
            taskId,
            title: "Relay panel",
            detail: "Relay panel",
            attempt: 1,
            relaySequence: 0,
            ...bindingPayload(binding),
          },
          "Relay panel started",
          `relay-start:${binding.id}`,
          "v1",
        );
      }
      for (const member of observation.members) {
        if (
          nonNegativeInteger(member.index) === undefined ||
          member.index > 7 ||
          nonNegativeInteger(member.slotAttempt) === undefined ||
          member.slotAttempt < 1 ||
          !member.jobId ||
          !JOB_ID.test(member.jobId)
        )
          continue;
        const origin = yield* readPanelJobOrigin(binding, member.jobId);
        yield* register({
          kind: "job",
          id: member.jobId,
          threadId: binding.threadId,
          turnId: origin?.turnId ?? binding.turnId,
          toolCallId: origin?.toolCallId ?? binding.toolCallId,
          environmentId: binding.environmentId,
          panelId: binding.id,
          agentIndex: member.index,
          slotAttempt: member.slotAttempt,
        });
      }
      if (previous?.state !== fingerprint || wasUnavailable) {
        const hasRunningMember = observation.members.some(
          (member) =>
            member.job &&
            ["starting", "queued", "running", "cancelling"].includes(member.job.status),
        );
        const panelStatus = observation.complete
          ? "completed"
          : hasRunningMember
            ? "running"
            : "idle";
        const summary = `${observation.members.filter((member) => member.jobId).length} of ${observation.members.length} members dispatched`;
        yield* append(
          binding,
          "task.progress",
          {
            taskId,
            title: "Relay panel",
            attempt: 1,
            relaySequence: 0,
            status: panelStatus,
            summary,
            detail: summary,
            ...bindingPayload(binding),
          },
          "Relay panel",
          `relay-panel-progress:${binding.id}`,
          fingerprint,
        );
      }
      seen.set(binding.id, { attempt: 0, sequence: 0, state: fingerprint });
      if (observation.complete) {
        yield* append(
          binding,
          "task.completed",
          {
            taskId,
            status: "completed",
            title: "Relay panel",
            attempt: 1,
            relaySequence: 0,
            ...bindingPayload(binding),
          },
          "Relay panel completed",
          `relay-panel-complete:${binding.id}`,
          fingerprint,
        );
        active.delete(binding.id);
      }
      return;
    }

    const previous = seen.get(binding.id);
    const origin = (yield* readActivation(binding, observation.attempt)) ?? binding;
    const status = relayStatus(observation.status);
    const fingerprint = observationFingerprint(observation);
    const displayAttempt =
      binding.slotAttempt === undefined
        ? observation.attempt
        : binding.slotAttempt * 1_000_000 + observation.attempt;
    if (!Number.isSafeInteger(displayAttempt)) return;
    if (
      previous &&
      (displayAttempt < previous.attempt ||
        (displayAttempt === previous.attempt && observation.sequence < previous.sequence))
    )
      return;
    if (previous?.state === fingerprint && !wasUnavailable) return;
    const fields = {
      taskId,
      title: "Relay worker",
      model: boundedText(observation.model, 100),
      effort: boundedText(observation.effort, 100),
      role: boundedText(observation.providerType, 100),
      attempt: displayAttempt,
      relaySequence: observation.sequence,
      ...bindingPayload(origin),
    };
    if (!previous || previous.attempt !== displayAttempt) {
      yield* append(
        origin,
        "task.started",
        { ...fields, detail: "Relay worker" },
        "Relay worker started",
        `relay-start:${binding.id}:${displayAttempt}`,
        "v1",
      );
    }
    const usage = record(observation.usage);
    const typedUsage =
      usage && nonNegativeInteger(usage.totalTokens) !== undefined
        ? {
            totalTokens: usage.totalTokens,
            ...(nonNegativeInteger(usage.inputTokens) !== undefined
              ? { inputTokens: usage.inputTokens }
              : {}),
            ...(nonNegativeInteger(usage.outputTokens) !== undefined
              ? { outputTokens: usage.outputTokens }
              : {}),
            ...(nonNegativeInteger(usage.cachedInputTokens) !== undefined
              ? { cachedInputTokens: usage.cachedInputTokens }
              : {}),
          }
        : undefined;
    if (
      !["completed", "failed", "cancelled", "interrupted"].includes(status) ||
      observation.pending
    ) {
      const activity = boundedText(observation.activity?.label);
      yield* append(
        origin,
        "task.progress",
        {
          ...fields,
          status:
            observation.pending &&
            ["completed", "failed", "cancelled", "interrupted"].includes(status)
              ? "running"
              : status,
          ...(activity ? { summary: activity, detail: activity } : {}),
          ...(boundedText(observation.activity?.kind)
            ? { lastToolName: boundedText(observation.activity?.kind) }
            : {}),
          ...(typedUsage ? { typedUsage } : {}),
        },
        "Relay worker",
        `relay-progress:${binding.id}`,
        fingerprint,
      );
    }
    seen.set(binding.id, {
      attempt: displayAttempt,
      sequence: observation.sequence,
      state: fingerprint,
    });
    if (
      ["completed", "failed", "cancelled", "interrupted"].includes(status) &&
      !observation.pending
    ) {
      yield* append(
        origin,
        "task.completed",
        {
          ...fields,
          status: status === "interrupted" ? "stopped" : status,
          ...(boundedText(observation.outcome?.summary, 2000) ||
          boundedText(observation.outcome?.error, 1000) ||
          boundedText(observation.outcome?.label)
            ? {
                summary:
                  boundedText(observation.outcome?.summary, 2000) ??
                  boundedText(observation.outcome?.error, 1000) ??
                  boundedText(observation.outcome?.label),
              }
            : {}),
          ...(typedUsage ? { typedUsage } : {}),
        },
        status === "completed"
          ? "Relay worker completed"
          : status === "cancelled"
            ? "Relay worker stopped"
            : "Relay worker failed",
        `relay-complete:${binding.id}:${observation.attempt}`,
        fingerprint,
      );
      active.delete(binding.id);
    }
  });

  let sweepCount = 0;
  const sweep = Effect.fn("RelayWorkerBridge.sweep")(function* () {
    // Direct receipts register immediately. The periodic persisted scan closes
    // the crash window after command dispatch and before observer registration.
    if (sweepCount++ % 10 === 0) {
      if (sweepCount === 1) yield* recoverPersistedToolReceipts();
      for (const binding of yield* readBindings()) {
        if (!seen.has(binding.id) && !active.has(binding.id)) active.set(binding.id, binding);
      }
    }
    const observeBound = (binding: RelayBinding) =>
      poll(binding).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Relay observation failed", { id: binding.id, cause }),
        ),
      );
    for (const binding of active.values()) {
      if (binding.kind === "panel") yield* observeBound(binding);
    }
    for (const binding of active.values()) {
      if (binding.kind !== "job") continue;
      if (binding.panelId !== undefined && binding.agentIndex !== undefined) {
        const current = currentPanelJobs.get(binding.panelId);
        if (!current) continue; // Panel observation must confirm a current slot before projection.
        if (current.get(binding.agentIndex) !== binding.id) {
          active.delete(binding.id);
          continue;
        }
      }
      yield* observeBound(binding);
    }
  });

  const start = forkParked(
    sweep().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Relay binding sweep failed", { cause })),
      Effect.repeat(Schedule.spaced("3 seconds")),
      Effect.asVoid,
    ),
  );

  const recordToolResult = (event: ProviderRuntimeEvent) =>
    enabled
      ? Effect.gen(function* () {
          const receipt = relayReceiptFromToolEvent(event);
          if (receipt) yield* recordReceipt(receipt);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Relay binding failed", { eventId: event.eventId, cause }),
          ),
        )
      : Effect.void;

  const cancel = Effect.fn("RelayWorkerBridge.cancel")(function* (
    threadId: ThreadId,
    agentId: string,
  ) {
    if (!enabled) return yield* new ProviderCancelSessionAgentError({ reason: "unsupported" });
    const bindings = yield* readBindings().pipe(
      Effect.mapError(() => new ProviderCancelSessionAgentError({ reason: "request-failed" })),
    );
    const slot = /^relay-panel:(panel-[0-9a-f-]{36}):member:([0-7])$/i.exec(agentId);
    let binding: RelayBinding | undefined;
    if (slot && PANEL_ID.test(slot[1] ?? "")) {
      const panelId = slot[1]!;
      const index = Number(slot[2]);
      const panel = bindings.find(
        (candidate) =>
          candidate.kind === "panel" && candidate.id === panelId && candidate.threadId === threadId,
      );
      if (!panel) return yield* new ProviderCancelSessionAgentError({ reason: "agent-not-active" });
      const current = yield* runCli(["observe", "--panel", panelId]);
      if (Option.isNone(current))
        return yield* new ProviderCancelSessionAgentError({ reason: "request-failed" });
      const decodedPanel = decodeJson(current.value.stdout);
      const observedPanel = parseObservation(
        Option.isSome(decodedPanel) ? decodedPanel.value : undefined,
        panelId,
      );
      if (observedPanel?.kind !== "panel")
        return yield* new ProviderCancelSessionAgentError({ reason: "request-failed" });
      const member = observedPanel.members.find((candidate) => candidate.index === index);
      if (!member?.jobId || !JOB_ID.test(member.jobId))
        return yield* new ProviderCancelSessionAgentError({ reason: "agent-not-active" });
      binding = bindings.find(
        (candidate) =>
          candidate.kind === "job" &&
          candidate.id === member.jobId &&
          candidate.panelId === panelId &&
          candidate.agentIndex === index &&
          candidate.threadId === threadId,
      );
    } else {
      const id = agentId.startsWith("relay:") ? agentId.slice("relay:".length) : "";
      if (!JOB_ID.test(id))
        return yield* new ProviderCancelSessionAgentError({ reason: "unsupported" });
      binding = bindings.find(
        (candidate) =>
          candidate.kind === "job" &&
          candidate.id === id &&
          candidate.panelId === undefined &&
          candidate.threadId === threadId,
      );
    }
    if (!binding) return yield* new ProviderCancelSessionAgentError({ reason: "agent-not-active" });
    const id = binding.id;
    const observed = yield* runCli(["observe", id]);
    if (Option.isNone(observed))
      return yield* new ProviderCancelSessionAgentError({ reason: "request-failed" });
    const decodedJob = decodeJson(observed.value.stdout);
    if (
      parseObservation(Option.isSome(decodedJob) ? decodedJob.value : undefined, id)?.kind !== "job"
    ) {
      return yield* new ProviderCancelSessionAgentError({ reason: "request-failed" });
    }
    const result = yield* runCli(["cancel", id]);
    if (Option.isNone(result))
      return yield* new ProviderCancelSessionAgentError({ reason: "request-failed" });
    const decoded = decodeJson(result.value.stdout);
    const value = Option.isSome(decoded) ? record(decoded.value) : undefined;
    if (value?.id !== id || typeof value.status !== "string")
      return yield* new ProviderCancelSessionAgentError({ reason: "request-failed" });
    active.set(id, binding);
    return {
      agentId: agentId as ProviderCancelSessionAgentResult["agentId"],
      disposition: [
        "completed",
        "failed",
        "cancelled",
        "interrupted",
        "timed_out",
        "output_limit",
        "blocked_permissions",
        "needs_review",
      ].includes(value.status)
        ? "already-settled"
        : "cancel-requested",
    } satisfies ProviderCancelSessionAgentResult;
  });

  return {
    start,
    reconcile: sweep().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Relay binding sweep failed", { cause })),
    ),
    recordToolResult,
    cancel,
  };
});

export const layer = Layer.effect(RelayWorkerBridge, makeWithCliPath(process.env.PYLON_RELAY_CLI));
