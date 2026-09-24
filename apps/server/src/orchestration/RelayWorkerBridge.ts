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
import * as Clock from "effect/Clock";
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
// Claude can JSON-serialize a Relay result that already contains JSON-escaped
// prompt text. Keep the wrapper bounded while allowing Relay's 100k prompt cap.
const MAX_MCP_RECEIPT_CODE_UNITS = 1024 * 1024;
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

interface RelayUsageRollup {
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
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
  const structured = relayStructuredResult(result) ?? relayLegacyResult(result);
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

/** The installed Claude plugin still returns its job/panel record as text. */
function relayLegacyResult(value: unknown): Record<string, unknown> | undefined {
  const object = record(value);
  const content = object?.content;
  if (!Array.isArray(content) || content.length > 4) return undefined;
  const text = record(content[0])?.text;
  if (typeof text !== "string" || text.length > MAX_MCP_RECEIPT_CODE_UNITS) return undefined;
  try {
    const parsed = record(JSON.parse(text));
    if (!parsed) return undefined;
    if (
      typeof parsed.id === "string" &&
      JOB_ID.test(parsed.id) &&
      typeof parsed.status === "string" &&
      parsed.status !== "not_dispatched"
    ) {
      return {
        schemaVersion: 1,
        kind: "job",
        jobId: parsed.id,
        ...(nonNegativeInteger(parsed.attempt) !== undefined ? { attempt: parsed.attempt } : {}),
      };
    }
    if (
      typeof parsed.id === "string" &&
      PANEL_ID.test(parsed.id) &&
      Array.isArray(parsed.jobs) &&
      parsed.jobs.length <= 8
    ) {
      return {
        schemaVersion: 1,
        kind: "panel",
        panelId: parsed.id,
        jobIds: parsed.jobs.filter((id): id is string => typeof id === "string" && JOB_ID.test(id)),
      };
    }
  } catch {
    /* Invalid plugin text is not a dispatch receipt. */
  }
  return undefined;
}

function relayStructuredResult(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 4) return undefined;
  const object = record(value);
  if (!object) {
    if (typeof value !== "string" || value.length > MAX_MCP_RECEIPT_CODE_UNITS) return undefined;
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
    // Relay appends a short versioned receipt after its human-readable result.
    // Inspect the tail first so large prompt/result text is never interpreted
    // as an origin receipt or copied into a task projection.
    for (const block of object.content.slice(-4).toReversed()) {
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

function legacyObservation(
  value: unknown,
  expectedId: string,
  priorJobSlots: ReadonlyMap<string, number> = new Map(),
): RelayJobObservation | RelayPanelObservation | undefined {
  const object = record(value);
  if (!object || object.id !== expectedId) return undefined;
  if (JOB_ID.test(expectedId)) {
    const attempt = nonNegativeInteger(object.attempt) ?? 1;
    const sequence = Date.parse(String(object.updatedAt ?? object.createdAt));
    if (attempt < 1 || !Number.isSafeInteger(sequence) || typeof object.status !== "string")
      return undefined;
    return parseObservation(
      {
        schemaVersion: 1,
        kind: "job",
        id: expectedId,
        attempt,
        sequence,
        status: object.status,
        providerType: object.providerType,
        model: object.actualModel ?? object.model,
        effort: object.effort,
        panelId: object.panelId,
        panelMemberIndex: object.panelMemberIndex,
        createdAt: object.createdAt,
        updatedAt: object.updatedAt,
      },
      expectedId,
    );
  }
  if (
    !PANEL_ID.test(expectedId) ||
    !Array.isArray(object.jobs) ||
    !Array.isArray(object.unstarted) ||
    object.jobs.length > 8
  )
    return undefined;
  const request = record(object.request);
  const requested = request?.members;
  if (!Array.isArray(requested) || requested.length < 2 || requested.length > 8) return undefined;
  const jobs = object.jobs.map(record);
  const members = requested.map((_, index) => {
    const prior = Array.isArray(object.previousJobs) ? object.previousJobs : [];
    const slotAttempt = 1 + prior.filter((id) => priorJobSlots.get(id) === index).length;
    const job = jobs.find((candidate) => candidate?.panelMemberIndex === index);
    const jobId = typeof job?.id === "string" && JOB_ID.test(job.id) ? job.id : null;
    return {
      index,
      slotAttempt,
      state: jobId ? "started" : "unstarted",
      jobId,
      ...(jobId ? { job: legacyObservation(job, jobId) } : {}),
    };
  });
  return parseObservation(
    {
      schemaVersion: 1,
      kind: "panel",
      id: expectedId,
      createdAt: object.createdAt,
      complete: object.complete === true,
      members,
    },
    expectedId,
  );
}

function legacyObserveUnavailable(value: unknown): boolean {
  const object = record(value);
  return typeof object?.usage === "string" && typeof object.request === "string";
}

function observationFingerprint(observation: RelayJobObservation | RelayPanelObservation): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(observation))
    .digest("hex")
    .slice(0, 16);
}

// A completed panel can reopen when a member resumes. Its coordinator needs
// an attempt that advances with either a resumed job or a replaced slot, so a
// previous terminal coordinator cannot mask the new run in the client fold.
function panelAttempt(observation: RelayPanelObservation): number | undefined {
  const attempt = observation.members.reduce((sum, member) => {
    const jobAttempt = nonNegativeInteger(record(member.job)?.attempt) ?? 1;
    return sum + member.slotAttempt - 1 + jobAttempt - 1;
  }, 1);
  return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : undefined;
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
  const missingObservationRetryAt = new Map<string, number>();
  const unavailable = new Set<string>();
  const outageEpochs = new Map<string, number>();
  const pendingPanelDispatchPolls = new Map<string, number>();
  const priorUsageCache = new Map<
    string,
    { attempt: number; usage: RelayUsageRollup | undefined }
  >();
  const legacyPriorJobSlots = new Map<string, Map<string, number>>();

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
        source: "relay",
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

  const decodeBindingRow = (raw: unknown): RelayBinding | undefined => {
    const row = record(raw);
    if (!row || typeof row.payload !== "string" || typeof row.threadId !== "string")
      return undefined;
    const decoded = decodeJson(row.payload);
    const payload = Option.isSome(decoded) ? record(decoded.value) : undefined;
    if (
      !payload ||
      !(
        (payload.kind === "job" && typeof payload.id === "string" && JOB_ID.test(payload.id)) ||
        (payload.kind === "panel" && typeof payload.id === "string" && PANEL_ID.test(payload.id))
      ) ||
      typeof payload.toolCallId !== "string" ||
      typeof payload.environmentId !== "string"
    )
      return undefined;
    return {
      kind: payload.kind as "job" | "panel",
      id: payload.id as string,
      threadId: ThreadId.make(row.threadId),
      turnId: typeof row.turnId === "string" ? row.turnId : null,
      toolCallId: payload.toolCallId,
      environmentId: payload.environmentId,
      ...(typeof payload.panelId === "string" ? { panelId: payload.panelId } : {}),
      ...(nonNegativeInteger(payload.agentIndex) !== undefined
        ? { agentIndex: payload.agentIndex as number }
        : {}),
      ...(nonNegativeInteger(payload.slotAttempt) !== undefined
        ? { slotAttempt: payload.slotAttempt as number }
        : {}),
    };
  };

  const readBinding = Effect.fn("RelayWorkerBridge.readBinding")(function* (id: string) {
    const rows = yield* sql`
      SELECT thread_id AS threadId, turn_id AS turnId, payload_json AS payload
      FROM projection_thread_activities
      WHERE activity_id = ${`relay-binding:${id}`} AND kind = 'relay.binding'
      LIMIT 1
    `;
    return decodeBindingRow(rows[0]);
  });

  const readBindingPage = Effect.fn("RelayWorkerBridge.readBindingPage")(function* (
    beforeRowId: number,
  ) {
    const rows = yield* sql`
      SELECT rowid AS rowId, thread_id AS threadId, turn_id AS turnId, payload_json AS payload
      FROM projection_thread_activities
      WHERE rowid < ${beforeRowId} AND kind = 'relay.binding'
        AND json_extract(payload_json, '$.environmentId') = ${environmentId}
      ORDER BY rowid DESC LIMIT 256
    `;
    return rows.map((raw) => ({
      rowId: nonNegativeInteger(record(raw)?.rowId) ?? 0,
      binding: decodeBindingRow(raw),
    }));
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
      ORDER BY rowid ASC LIMIT 1
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

  const hasUnobservedPanelDispatch = Effect.fn("RelayWorkerBridge.hasUnobservedPanelDispatch")(
    function* (panel: RelayBinding) {
      const rows = yield* sql`
        SELECT payload_json AS payload FROM projection_thread_activities
        WHERE thread_id = ${panel.threadId} AND kind = 'relay.activation'
          AND json_extract(payload_json, '$.environmentId') = ${environmentId}
          AND json_extract(payload_json, '$.id') = ${panel.id}
        ORDER BY rowid DESC LIMIT 1
      `;
      const raw = record(rows[0])?.payload;
      const decoded = typeof raw === "string" ? decodeJson(raw) : Option.none();
      const jobIds = Option.isSome(decoded) ? record(decoded.value)?.jobIds : undefined;
      if (!Array.isArray(jobIds)) return false;
      for (const id of jobIds.slice(0, 8)) {
        if (typeof id !== "string" || !JOB_ID.test(id)) continue;
        const existing = yield* readBinding(id);
        if (!existing || existing.panelId !== panel.id || existing.threadId !== panel.threadId)
          return true;
      }
      return false;
    },
  );

  const register = Effect.fn("RelayWorkerBridge.register")(function* (
    binding: RelayBinding,
    activate = true,
  ) {
    const existing = yield* readBinding(binding.id);
    if (
      existing &&
      (existing.threadId !== binding.threadId ||
        existing.kind !== binding.kind ||
        existing.environmentId !== binding.environmentId)
    ) {
      yield* Effect.logWarning("Relay ID already belongs to another thread", { id: binding.id });
      return false;
    }
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
    if (activate) active.set(binding.id, existing ?? binding);
    return true;
  });

  const recordReceipt = Effect.fn("RelayWorkerBridge.recordReceipt")(function* (
    receipt: RelayToolReceipt,
    activate = true,
  ) {
    const binding = { ...receipt.binding, environmentId };
    if (!(yield* register(binding, activate))) return;
    if (activate && receipt.toolName === "relay_resume") {
      const member = yield* readBinding(binding.id);
      if (member?.panelId) {
        const panel = yield* readBinding(member.panelId);
        if (
          panel?.kind === "panel" &&
          panel.threadId === member.threadId &&
          panel.environmentId === member.environmentId
        ) {
          active.set(panel.id, panel);
        }
      }
    }
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
          const existing = yield* readBinding(receipt.binding.id);
          if (existing && receipt.toolName === "relay_delegate") continue;
          if (
            existing &&
            receipt.toolName === "relay_resume" &&
            receipt.attempt !== undefined &&
            (yield* readActivation(existing, receipt.attempt))
          )
            continue;
          if (
            existing &&
            (receipt.toolName === "relay_panel" || receipt.toolName === "relay_panel_continue") &&
            (!receipt.jobIds?.length ||
              (yield* sql`
                SELECT 1 FROM projection_thread_activities
                WHERE activity_id = ${`relay-activation:${existing.id}:${receipt.binding.toolCallId}`}
                  AND kind = 'relay.activation' LIMIT 1
              `).length > 0)
          )
            continue;
          yield* recordReceipt(receipt, false);
        }
        if (rows.length < 256) break;
        offset += rows.length;
      }
    },
  );

  const runCli = Effect.fn("RelayWorkerBridge.runCli")(function* (
    args: ReadonlyArray<string>,
    timeout = 12_000,
  ) {
    if (!enabled || !cliPath) return Option.none<{ stdout: string; stderr: string }>();
    return yield* Effect.tryPromise({
      try: () =>
        execFile(process.execPath, [cliPath, ...args], {
          timeout,
          maxBuffer: args[0] === "panel-result" ? MAX_MCP_RECEIPT_CODE_UNITS : MAX_OBSERVE_BYTES,
          windowsHide: true,
        }),
      catch: () => undefined,
    }).pipe(Effect.option);
  });

  const parseLegacyCliObservation = Effect.fn("RelayWorkerBridge.parseLegacyCliObservation")(
    function* (value: unknown, id: string) {
      if (!PANEL_ID.test(id)) return legacyObservation(value, id);
      const previousJobs = record(value)?.previousJobs;
      if (!Array.isArray(previousJobs) || previousJobs.length > 64) return undefined;
      const previousIds = previousJobs.filter(
        (previousId): previousId is string =>
          typeof previousId === "string" && JOB_ID.test(previousId),
      );
      if (previousIds.length !== previousJobs.length) return undefined;
      const priorSlots = legacyPriorJobSlots.get(id) ?? new Map<string, number>();
      const missing = previousIds.filter((previousId) => !priorSlots.has(previousId));
      // Old retry records are immutable. Cache resolved slots and bound an
      // unavailable history lookup so a current panel cannot stall the sweep.
      const resolved = yield* Effect.forEach(
        missing,
        (previousId) =>
          Effect.gen(function* () {
            const result = yield* runCli(["status", previousId], 2_000);
            const decoded = Option.isSome(result) ? decodeJson(result.value.stdout) : Option.none();
            const job = Option.isSome(decoded) ? record(decoded.value) : undefined;
            const index = nonNegativeInteger(job?.panelMemberIndex);
            return job?.id === previousId && job.panelId === id && index !== undefined && index <= 7
              ? ([previousId, index] as const)
              : undefined;
          }),
        { concurrency: 8 },
      );
      if (resolved.some((entry) => entry === undefined)) return undefined;
      for (const entry of resolved) if (entry) priorSlots.set(entry[0], entry[1]);
      legacyPriorJobSlots.set(id, priorSlots);
      return legacyObservation(value, id, priorSlots);
    },
  );

  const readLatestTaskActivity = Effect.fn("RelayWorkerBridge.readLatestTaskActivity")(function* (
    binding: RelayBinding,
  ) {
    const rows = yield* sql`
      SELECT rowid AS rowId, kind, payload_json AS payload FROM projection_thread_activities
      WHERE thread_id = ${binding.threadId}
        AND kind IN ('task.started', 'task.progress', 'task.updated', 'task.completed')
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.taskId') END = ${bindingTaskId(binding)}
      ORDER BY sequence DESC, created_at DESC, rowid DESC LIMIT 1
    `;
    const row = record(rows[0]);
    const decoded = typeof row?.payload === "string" ? decodeJson(row.payload) : Option.none();
    return {
      kind: row?.kind,
      rowId: nonNegativeInteger(row?.rowId) ?? 0,
      payload: Option.isSome(decoded) ? record(decoded.value) : undefined,
    };
  });

  const shouldObserveOnBoot = Effect.fn("RelayWorkerBridge.shouldObserveOnBoot")(function* (
    binding: RelayBinding,
    bindingRowId: number,
  ) {
    const latest = yield* readLatestTaskActivity(binding);
    if (latest.kind !== "task.completed" || bindingRowId > latest.rowId) return true;
    // A resume or panel continuation accepted after the terminal row must be
    // reconciled even if the process stopped before emitting task.started.
    const activations = yield* sql`
      SELECT 1 FROM projection_thread_activities
      WHERE rowid > ${latest.rowId} AND thread_id = ${binding.threadId}
        AND kind = 'relay.activation'
        AND json_extract(payload_json, '$.environmentId') = ${environmentId}
        AND (
          json_extract(payload_json, '$.id') = ${binding.id}
          OR (
            json_extract(payload_json, '$.id') = ${binding.panelId ?? ""}
            AND EXISTS (
              SELECT 1 FROM json_each(json_extract(payload_json, '$.jobIds'))
              WHERE value = ${binding.id}
            )
          )
        )
      LIMIT 1
    `;
    return activations.length > 0;
  });

  const pendingGenerationAfter = Effect.fn("RelayWorkerBridge.pendingGenerationAfter")(function* (
    binding: RelayBinding,
    completedRowId: number,
    completedAttempt: number,
  ) {
    if (binding.kind === "panel") {
      // A resumed member reopens its completed panel even though the direct
      // relay_resume receipt names the job, not the panel. Resolve that ID
      // through the persisted owner binding before considering the receipt.
      const rows = yield* sql`
        SELECT activation.turn_id AS turnId, activation.payload_json AS payload
        FROM projection_thread_activities AS activation
        WHERE activation.rowid > ${completedRowId}
          AND activation.thread_id = ${binding.threadId}
          AND activation.kind = 'relay.activation'
          AND json_extract(activation.payload_json, '$.environmentId') = ${environmentId}
          AND (
            json_extract(activation.payload_json, '$.id') = ${binding.id}
            OR EXISTS (
              SELECT 1 FROM projection_thread_activities AS child
              WHERE child.activity_id = 'relay-binding:' || json_extract(activation.payload_json, '$.id')
                AND child.kind = 'relay.binding'
                AND child.thread_id = ${binding.threadId}
                AND json_extract(child.payload_json, '$.environmentId') = ${environmentId}
                AND json_extract(child.payload_json, '$.panelId') = ${binding.id}
            )
          )
        ORDER BY activation.rowid DESC LIMIT 1
      `;
      const activation = record(rows[0]);
      const decoded =
        typeof activation?.payload === "string" ? decodeJson(activation.payload) : Option.none();
      const payload = Option.isSome(decoded) ? record(decoded.value) : undefined;
      const attempt = completedAttempt + 1;
      return activation && Number.isSafeInteger(attempt) && typeof payload?.toolCallId === "string"
        ? {
            attempt,
            origin: {
              ...binding,
              turnId: typeof activation.turnId === "string" ? activation.turnId : null,
              toolCallId: payload.toolCallId,
            },
          }
        : undefined;
    }
    const activations = yield* sql`
      SELECT turn_id AS turnId, payload_json AS payload
      FROM projection_thread_activities
      WHERE rowid > ${completedRowId} AND thread_id = ${binding.threadId}
        AND kind = 'relay.activation'
        AND json_extract(payload_json, '$.environmentId') = ${environmentId}
        AND (
          json_extract(payload_json, '$.id') = ${binding.id}
          OR (
            json_extract(payload_json, '$.id') = ${binding.panelId ?? ""}
            AND EXISTS (
              SELECT 1 FROM json_each(json_extract(payload_json, '$.jobIds'))
              WHERE value = ${binding.id}
            )
          )
        )
      ORDER BY rowid DESC LIMIT 1
    `;
    const activation = record(activations[0]);
    const decoded =
      typeof activation?.payload === "string" ? decodeJson(activation.payload) : Option.none();
    const payload = Option.isSome(decoded) ? record(decoded.value) : undefined;
    const jobAttempt = payload?.kind === "job" ? nonNegativeInteger(payload.attempt) : undefined;
    const attempt =
      binding.slotAttempt === undefined
        ? jobAttempt
        : binding.slotAttempt * 1_000_000 + (jobAttempt ?? 1);
    if (
      attempt !== undefined &&
      Number.isSafeInteger(attempt) &&
      attempt > completedAttempt &&
      typeof payload?.toolCallId === "string"
    ) {
      return {
        attempt,
        origin: {
          ...binding,
          turnId: typeof activation?.turnId === "string" ? activation.turnId : null,
          toolCallId: payload.toolCallId,
        },
      };
    }
    if (binding.slotAttempt === undefined) return undefined;
    const rows = yield* sql`
      SELECT rowid AS rowId FROM projection_thread_activities
      WHERE activity_id = ${`relay-binding:${binding.id}`} AND kind = 'relay.binding'
      LIMIT 1
    `;
    const bindingRowId = nonNegativeInteger(record(rows[0])?.rowId) ?? 0;
    const firstAttempt = binding.slotAttempt * 1_000_000 + 1;
    return bindingRowId > completedRowId && firstAttempt > completedAttempt
      ? { attempt: firstAttempt, origin: binding }
      : undefined;
  });

  const getOutageEpoch = Effect.fn("RelayWorkerBridge.getOutageEpoch")(function* (
    binding: RelayBinding,
  ) {
    const cached = outageEpochs.get(binding.id);
    if (cached !== undefined) return cached;
    const rows = yield* sql`
      SELECT MAX(CAST(json_extract(payload_json, '$.outageEpoch') AS INTEGER)) AS epoch
      FROM projection_thread_activities
      WHERE thread_id = ${binding.threadId} AND kind = 'task.progress'
        AND json_extract(payload_json, '$.taskId') = ${bindingTaskId(binding)}
        AND json_type(payload_json, '$.outageEpoch') = 'integer'
    `;
    const epoch = nonNegativeInteger(record(rows[0])?.epoch) ?? 0;
    outageEpochs.set(binding.id, epoch);
    return epoch;
  });

  // A single bounded prefix replaces all prior usage rows in the client fold.
  // Each attempt contributes its maximum observed cumulative usage once.
  const readPriorUsage = Effect.fn("RelayWorkerBridge.readPriorUsage")(function* (
    binding: RelayBinding,
    attempt: number,
  ) {
    const cached = priorUsageCache.get(binding.id);
    if (cached?.attempt === attempt) return cached.usage;
    const rows = yield* sql`
      WITH prior_attempts AS (
        SELECT
          MAX(json_extract(payload_json, '$.typedUsage.totalTokens')) AS totalTokens,
          MAX(json_extract(payload_json, '$.typedUsage.inputTokens')) AS inputTokens,
          MAX(json_extract(payload_json, '$.typedUsage.outputTokens')) AS outputTokens,
          MAX(json_extract(payload_json, '$.typedUsage.cachedInputTokens')) AS cachedInputTokens
        FROM projection_thread_activities
        WHERE thread_id = ${binding.threadId}
          AND kind IN ('task.progress', 'task.completed')
          AND json_extract(payload_json, '$.source') = 'relay'
          AND json_extract(payload_json, '$.taskId') = ${bindingTaskId(binding)}
          AND json_type(payload_json, '$.attempt') = 'integer'
          AND json_extract(payload_json, '$.attempt') < ${attempt}
          AND json_type(payload_json, '$.typedUsage.totalTokens') = 'integer'
        GROUP BY json_extract(payload_json, '$.attempt')
      )
      SELECT SUM(totalTokens) AS totalTokens, SUM(inputTokens) AS inputTokens,
        SUM(outputTokens) AS outputTokens, SUM(cachedInputTokens) AS cachedInputTokens
      FROM prior_attempts
    `;
    const row = record(rows[0]);
    const totalTokens = nonNegativeInteger(row?.totalTokens);
    const inputTokens = nonNegativeInteger(row?.inputTokens);
    const outputTokens = nonNegativeInteger(row?.outputTokens);
    const cachedInputTokens = nonNegativeInteger(row?.cachedInputTokens);
    const usage: RelayUsageRollup | undefined =
      totalTokens === undefined
        ? undefined
        : {
            totalTokens,
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          };
    priorUsageCache.set(binding.id, { attempt, usage });
    return usage;
  });

  const markObserverUnavailable = Effect.fn("RelayWorkerBridge.markObserverUnavailable")(function* (
    binding: RelayBinding,
  ) {
    const failures = (failedObservations.get(binding.id) ?? 0) + 1;
    failedObservations.set(binding.id, failures);
    if (failures < 3 || unavailable.has(binding.id)) return;
    const taskId = bindingTaskId(binding);
    const latest = yield* readLatestTaskActivity(binding);
    const payload = latest.payload;
    const completedAttempt = nonNegativeInteger(payload?.attempt);
    const completedSequence = nonNegativeInteger(payload?.relaySequence);
    if (completedAttempt === undefined || completedSequence === undefined) {
      // A recovered receipt may outlive its Relay files. Retain the binding
      // for a later return, but do not recheck every missing historical job
      // on every sweep ahead of live workers.
      if (!unavailable.has(binding.id)) {
        yield* append(
          binding,
          "task.progress",
          {
            taskId,
            title: binding.kind === "panel" ? "Relay panel" : "Relay worker",
            attempt: 1,
            relaySequence: 0,
            outageEpoch: 1,
            status: "idle",
            summary: "Relay observer unavailable",
            detail: "Relay observer unavailable",
            ...bindingPayload(binding),
            cancellable: false,
          },
          "Relay observer unavailable",
          `relay-observer-unavailable:${binding.id}:1`,
          "1:0:1",
        );
        unavailable.add(binding.id);
      }
      missingObservationRetryAt.set(binding.id, (yield* Clock.currentTimeMillis) + 60_000);
      return;
    }
    const pending =
      latest.kind === "task.completed"
        ? yield* pendingGenerationAfter(binding, latest.rowId, completedAttempt)
        : undefined;
    if (latest.kind === "task.completed") {
      if (!pending) {
        active.delete(binding.id);
        legacyPriorJobSlots.delete(binding.id);
        seen.delete(binding.id);
        failedObservations.delete(binding.id);
        unavailable.delete(binding.id);
        outageEpochs.delete(binding.id);
        priorUsageCache.delete(binding.id);
        return;
      }
    }
    const attempt = pending?.attempt ?? completedAttempt;
    const relaySequence = pending ? 0 : completedSequence;
    const origin = pending?.origin ?? binding;
    const relayPriorUsage = yield* readPriorUsage(binding, attempt);
    const outageEpoch = (yield* getOutageEpoch(binding)) + 1;
    outageEpochs.set(binding.id, outageEpoch);
    yield* append(
      origin,
      "task.progress",
      {
        taskId,
        title: binding.kind === "panel" ? "Relay panel" : "Relay worker",
        attempt,
        relaySequence,
        outageEpoch,
        status: "idle",
        summary: "Relay observer unavailable",
        detail: "Relay observer unavailable",
        ...bindingPayload(origin),
        ...(relayPriorUsage ? { relayPriorUsage } : {}),
        cancellable: false,
      },
      "Relay observer unavailable",
      `relay-observer-unavailable:${binding.id}:${outageEpoch}`,
      `${attempt}:${relaySequence}:${outageEpoch}`,
    );
    unavailable.add(binding.id);
  });

  const poll = Effect.fn("RelayWorkerBridge.poll")(function* (binding: RelayBinding) {
    if ((missingObservationRetryAt.get(binding.id) ?? 0) > (yield* Clock.currentTimeMillis)) return;
    const result = yield* runCli(
      binding.kind === "job" ? ["observe", binding.id] : ["observe", "--panel", binding.id],
    );
    const parsed = Option.isSome(result) ? decodeJson(result.value.stdout) : Option.none();
    let observation = parseObservation(
      Option.isSome(parsed) ? parsed.value : undefined,
      binding.id,
    );
    if (!observation && Option.isSome(parsed) && legacyObserveUnavailable(parsed.value)) {
      const legacy = yield* runCli(
        binding.kind === "job" ? ["status", binding.id] : ["panel-result", binding.id],
      );
      const decoded = Option.isSome(legacy) ? decodeJson(legacy.value.stdout) : Option.none();
      observation = yield* parseLegacyCliObservation(
        Option.isSome(decoded) ? decoded.value : undefined,
        binding.id,
      );
    }
    if (!observation) return yield* markObserverUnavailable(binding);
    missingObservationRetryAt.delete(binding.id);
    const wasUnavailableInMemory = unavailable.delete(binding.id);
    const lastPersisted = seen.has(binding.id) ? undefined : yield* readLatestTaskActivity(binding);
    const wasUnavailable =
      wasUnavailableInMemory ||
      (lastPersisted?.payload?.status === "idle" &&
        lastPersisted.payload.summary === "Relay observer unavailable");
    const recoveryEpoch = wasUnavailable ? yield* getOutageEpoch(binding) : 0;
    failedObservations.delete(binding.id);
    const taskId = bindingTaskId(binding);
    if (observation.kind === "panel") {
      const derivedAttempt = panelAttempt(observation);
      if (derivedAttempt === undefined) return;
      const previous = seen.get(binding.id);
      const latest = previous ? undefined : yield* readLatestTaskActivity(binding);
      // A retry can replace a member whose previous job was itself resumed.
      // The new job's attempt resets to one, but the coordinator must never
      // move backwards relative to its persisted generation.
      const attempt = Math.max(
        derivedAttempt,
        previous?.attempt ?? nonNegativeInteger(latest?.payload?.attempt) ?? 0,
      );
      const priorPanelJobs = currentPanelJobs.get(binding.id);
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
      if (!previous || previous.attempt !== attempt) {
        yield* append(
          binding,
          "task.started",
          {
            taskId,
            title: "Relay panel",
            detail: "Relay panel",
            attempt,
            relaySequence: 0,
            ...bindingPayload(binding),
          },
          "Relay panel started",
          attempt === 1 ? `relay-start:${binding.id}` : `relay-start:${binding.id}:${attempt}`,
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
        if (priorPanelJobs?.get(member.index) === member.jobId) continue;
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
      const hasRunningMember = observation.members.some(
        (member) =>
          member.job && ["starting", "queued", "running", "cancelling"].includes(member.job.status),
      );
      if (previous?.state !== fingerprint || wasUnavailable) {
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
            attempt,
            relaySequence: 0,
            status: panelStatus,
            summary,
            detail: summary,
            ...bindingPayload(binding),
          },
          "Relay panel",
          attempt === 1
            ? `relay-panel-progress:${binding.id}`
            : `relay-panel-progress:${binding.id}:${attempt}`,
          wasUnavailable ? `${fingerprint}:recovered:${recoveryEpoch}` : fingerprint,
        );
      }
      seen.set(binding.id, { attempt, sequence: 0, state: fingerprint });
      const hasPendingDispatch =
        !observation.complete && !hasRunningMember
          ? yield* hasUnobservedPanelDispatch(binding)
          : false;
      const pendingPolls = hasPendingDispatch
        ? (pendingPanelDispatchPolls.get(binding.id) ?? 0) + 1
        : 0;
      if (pendingPolls > 0) pendingPanelDispatchPolls.set(binding.id, pendingPolls);
      else pendingPanelDispatchPolls.delete(binding.id);
      if (observation.complete) {
        yield* append(
          binding,
          "task.completed",
          {
            taskId,
            status: "completed",
            title: "Relay panel",
            attempt,
            relaySequence: 0,
            ...bindingPayload(binding),
          },
          "Relay panel completed",
          attempt === 1
            ? `relay-panel-complete:${binding.id}`
            : `relay-panel-complete:${binding.id}:${attempt}`,
          fingerprint,
        );
        active.delete(binding.id);
        legacyPriorJobSlots.delete(binding.id);
        seen.delete(binding.id);
        failedObservations.delete(binding.id);
        unavailable.delete(binding.id);
        outageEpochs.delete(binding.id);
        pendingPanelDispatchPolls.delete(binding.id);
        priorUsageCache.delete(binding.id);
      } else if (!hasRunningMember && (!hasPendingDispatch || pendingPolls >= 3)) {
        // Failed/cancelled members and unstarted slots remain visible as an
        // idle panel. A new continuation or member resume receipt reactivates
        // observation; polling this unchanged snapshot forever is needless.
        active.delete(binding.id);
        legacyPriorJobSlots.delete(binding.id);
        seen.delete(binding.id);
        failedObservations.delete(binding.id);
        unavailable.delete(binding.id);
        outageEpochs.delete(binding.id);
        pendingPanelDispatchPolls.delete(binding.id);
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
    const relayPriorUsage = yield* readPriorUsage(binding, displayAttempt);
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
      ...(relayPriorUsage ? { relayPriorUsage } : {}),
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
        wasUnavailable ? `${fingerprint}:recovered:${recoveryEpoch}` : fingerprint,
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
      seen.delete(binding.id);
      failedObservations.delete(binding.id);
      unavailable.delete(binding.id);
      outageEpochs.delete(binding.id);
      priorUsageCache.delete(binding.id);
    }
  });

  let bootstrapped = false;
  const sweep = Effect.fn("RelayWorkerBridge.sweep")(function* () {
    // Direct receipts register immediately. This bounded startup scan closes
    // the crash window after command dispatch and before observer registration.
    if (!bootstrapped) {
      yield* recoverPersistedToolReceipts();
      // Replay inserts historical bindings in receipt order. Visit newest
      // bindings first so current workers project before old missing jobs.
      let beforeRowId = Number.MAX_SAFE_INTEGER;
      for (;;) {
        const page = yield* readBindingPage(beforeRowId);
        if (page.length === 0) break;
        for (const { rowId, binding } of page) {
          beforeRowId = Math.min(beforeRowId, rowId);
          if (binding && !active.has(binding.id) && (yield* shouldObserveOnBoot(binding, rowId))) {
            active.set(binding.id, binding);
          }
        }
        if (page.length < 256) break;
      }
      bootstrapped = true;
    }
    const observeBound = (binding: RelayBinding) =>
      poll(binding).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Relay observation failed", { id: binding.id, cause }),
        ),
      );
    // A member may be resumed after its completed panel was evicted. On boot
    // and in-process, confirm the original parent binding before observing
    // the panel again; its snapshot is the authority for the current slot.
    for (const binding of Array.from(active.values())) {
      if (binding.kind !== "job" || !binding.panelId) continue;
      if (active.has(binding.panelId) || currentPanelJobs.has(binding.panelId)) continue;
      const panel = yield* readBinding(binding.panelId);
      if (
        panel?.kind === "panel" &&
        panel.threadId === binding.threadId &&
        panel.environmentId === binding.environmentId
      ) {
        active.set(panel.id, panel);
      }
    }
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
    for (const panelId of currentPanelJobs.keys()) {
      if (active.has(panelId)) continue;
      if ([...active.values()].some((binding) => binding.panelId === panelId)) continue;
      currentPanelJobs.delete(panelId);
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
    const readAuthorizedBinding = (id: string) =>
      readBinding(id).pipe(
        Effect.mapError(() => new ProviderCancelSessionAgentError({ reason: "request-failed" })),
      );
    const slot = /^relay-panel:(panel-[0-9a-f-]{36}):member:([0-7])$/i.exec(agentId);
    let binding: RelayBinding | undefined;
    if (slot && PANEL_ID.test(slot[1] ?? "")) {
      const panelId = slot[1]!;
      const index = Number(slot[2]);
      const panel = yield* readAuthorizedBinding(panelId);
      if (
        !panel ||
        panel.kind !== "panel" ||
        panel.threadId !== threadId ||
        panel.environmentId !== environmentId
      )
        return yield* new ProviderCancelSessionAgentError({ reason: "agent-not-active" });
      const current = yield* runCli(["observe", "--panel", panelId]);
      const decodedPanel = Option.isSome(current)
        ? decodeJson(current.value.stdout)
        : Option.none();
      let observedPanel = parseObservation(
        Option.isSome(decodedPanel) ? decodedPanel.value : undefined,
        panelId,
      );
      if (
        !observedPanel &&
        Option.isSome(decodedPanel) &&
        legacyObserveUnavailable(decodedPanel.value)
      ) {
        const legacy = yield* runCli(["panel-result", panelId]);
        const decoded = Option.isSome(legacy) ? decodeJson(legacy.value.stdout) : Option.none();
        observedPanel = yield* parseLegacyCliObservation(
          Option.isSome(decoded) ? decoded.value : undefined,
          panelId,
        );
      }
      if (observedPanel?.kind !== "panel")
        return yield* new ProviderCancelSessionAgentError({ reason: "request-failed" });
      const member = observedPanel.members.find((candidate) => candidate.index === index);
      if (!member?.jobId || !JOB_ID.test(member.jobId))
        return yield* new ProviderCancelSessionAgentError({ reason: "agent-not-active" });
      const currentBinding = yield* readAuthorizedBinding(member.jobId);
      binding =
        currentBinding?.kind === "job" &&
        currentBinding.panelId === panelId &&
        currentBinding.agentIndex === index &&
        currentBinding.threadId === threadId &&
        currentBinding.environmentId === environmentId
          ? currentBinding
          : undefined;
    } else {
      const id = agentId.startsWith("relay:") ? agentId.slice("relay:".length) : "";
      if (!JOB_ID.test(id))
        return yield* new ProviderCancelSessionAgentError({ reason: "unsupported" });
      const directBinding = yield* readAuthorizedBinding(id);
      binding =
        directBinding?.kind === "job" &&
        directBinding.panelId === undefined &&
        directBinding.threadId === threadId &&
        directBinding.environmentId === environmentId
          ? directBinding
          : undefined;
    }
    if (!binding) return yield* new ProviderCancelSessionAgentError({ reason: "agent-not-active" });
    const id = binding.id;
    const observed = yield* runCli(["observe", id]);
    const decodedJob = Option.isSome(observed) ? decodeJson(observed.value.stdout) : Option.none();
    let current = parseObservation(Option.isSome(decodedJob) ? decodedJob.value : undefined, id);
    if (!current && Option.isSome(decodedJob) && legacyObserveUnavailable(decodedJob.value)) {
      const legacy = yield* runCli(["status", id]);
      const decoded = Option.isSome(legacy) ? decodeJson(legacy.value.stdout) : Option.none();
      current = yield* parseLegacyCliObservation(
        Option.isSome(decoded) ? decoded.value : undefined,
        id,
      );
    }
    if (current?.kind !== "job") {
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
