const MANAGED_PERMISSION_TITLE_PREFIX = "Pylon execution approval";
const MANAGED_PERMISSION_MESSAGE_PREFIX = "pylon-permission-v1";
const MAX_TOOL_NAME_CHARS = 128;
const MAX_DETAIL_CHARS = 2_000;

export const PRIME_AGENT_MANAGED_EXTENSION_FILENAME = "pylon-managed-bridge-v1.mjs";
export const PRIME_AGENT_MANAGED_EXTENSION_MARKER_COMMAND = "pylon-managed-bridge-v1";
export const PRIME_AGENT_PLAN_TOOL_NAME = "pylon_update_plan";
export const PRIME_AGENT_PLAN_PROTOCOL = "pylon-plan-v1";
export const PRIME_AGENT_PLAN_MAX_STEPS = 32;
export const PRIME_AGENT_PLAN_MAX_STEP_CHARS = 500;
export const PRIME_AGENT_PLAN_MAX_EXPLANATION_CHARS = 1_000;
export const PRIME_AGENT_PLAN_TOOL_DEFINITION = {
  name: PRIME_AGENT_PLAN_TOOL_NAME,
  label: "Update Plan",
  description:
    "Publish the full authoritative task plan shown in Pylon. Use for multi-step work and meaningful status changes.",
  promptGuidelines: [
    "For multi-step work, keep Pylon's visible plan current with pylon_update_plan. Send the complete plan on every update. Plan steps describe meaningful root outcomes, not tools, files, test shards, or individual delegated agents.",
    "Use at most one active step: inProgress while work is underway, or waiting with waitingOn when progress depends on the user, delegated agents, or an external system.",
    "Before yielding control or sending a final response, reconcile the plan: complete finished outcomes, mark a real unresolved dependency waiting, and never leave a step inProgress when no work continues.",
    "Delegated agents must not call pylon_update_plan; only the root Pylon session owns the visible plan. Pylon derives delegated-work visibility from native task events, so do not add plan rows for individual agents.",
  ],
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      explanation: { type: "string", maxLength: PRIME_AGENT_PLAN_MAX_EXPLANATION_CHARS },
      plan: {
        type: "array",
        maxItems: PRIME_AGENT_PLAN_MAX_STEPS,
        items: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                step: {
                  type: "string",
                  minLength: 1,
                  maxLength: PRIME_AGENT_PLAN_MAX_STEP_CHARS,
                },
                status: {
                  type: "string",
                  enum: ["pending", "inProgress", "completed"],
                },
              },
              required: ["step", "status"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                step: {
                  type: "string",
                  minLength: 1,
                  maxLength: PRIME_AGENT_PLAN_MAX_STEP_CHARS,
                },
                status: { type: "string", const: "waiting" },
                waitingOn: {
                  type: "string",
                  enum: ["user", "delegates", "external"],
                },
              },
              required: ["step", "status", "waitingOn"],
            },
          ],
        },
      },
    },
    required: ["plan"],
  },
} as const;

export type PrimeAgentManagedPermissionRequestType =
  | "command_execution_approval"
  | "file_change_approval";

export type PrimeAgentManagedPermissionProjection =
  | { readonly _tag: "NotManaged" }
  | { readonly _tag: "Malformed" }
  | {
      readonly _tag: "Request";
      readonly requestType: PrimeAgentManagedPermissionRequestType;
      readonly toolName: string;
      readonly detail: string;
    };

const requestTypes = new Set<PrimeAgentManagedPermissionRequestType>([
  "command_execution_approval",
  "file_change_approval",
]);

export function projectPrimeAgentManagedPermissionRequest(
  input: {
    readonly method: string;
    readonly title?: string | undefined;
    readonly message?: string | undefined;
  },
  expectedToken: string,
): PrimeAgentManagedPermissionProjection {
  if (!input.title?.startsWith(`${MANAGED_PERMISSION_TITLE_PREFIX}:`)) {
    return { _tag: "NotManaged" };
  }
  if (input.title !== `${MANAGED_PERMISSION_TITLE_PREFIX}:${expectedToken}`) {
    return { _tag: "Malformed" };
  }
  if (input.method !== "confirm" || input.message === undefined) return { _tag: "Malformed" };

  const [prefix, requestType, toolName, ...detailLines] = input.message.split("\n");
  const detail = detailLines.join("\n").trim();
  if (
    prefix !== MANAGED_PERMISSION_MESSAGE_PREFIX ||
    !requestTypes.has(requestType as PrimeAgentManagedPermissionRequestType) ||
    toolName === undefined ||
    toolName.trim().length === 0 ||
    toolName.length > MAX_TOOL_NAME_CHARS ||
    detail.length === 0 ||
    detail.length > MAX_DETAIL_CHARS
  ) {
    return { _tag: "Malformed" };
  }

  return {
    _tag: "Request",
    requestType: requestType as PrimeAgentManagedPermissionRequestType,
    toolName: toolName.trim(),
    detail,
  };
}

/**
 * Builds Pylon's explicit Prime bridge. The task tool is always present. In
 * supervised mode the same source also installs the execution approval gate,
 * so one verified extension owns both behaviors and discovery stays disabled.
 */
export function makePrimeAgentManagedExtensionSource(input: {
  readonly rootSessionDir: string;
  readonly permissionToken?: string | undefined;
}): string {
  const normalizedRootSessionDir = input.rootSessionDir.trim().replace(/[\\/]+$/, "");
  if (
    normalizedRootSessionDir.length === 0 ||
    normalizedRootSessionDir.length > 4_000 ||
    normalizedRootSessionDir.includes("\0")
  ) {
    throw new Error("Prime Agent managed extensions require a bounded root session directory.");
  }
  const normalizedToken = input.permissionToken?.trim();
  if (
    normalizedToken !== undefined &&
    (normalizedToken.length < 16 || normalizedToken.length > 128)
  ) {
    throw new Error("Prime Agent permission tokens must contain between 16 and 128 characters.");
  }
  const permissionGateSource =
    normalizedToken === undefined
      ? ""
      : `
const TITLE = ${JSON.stringify(`${MANAGED_PERMISSION_TITLE_PREFIX}:${normalizedToken}`)};
const PREFIX = ${JSON.stringify(MANAGED_PERMISSION_MESSAGE_PREFIX)};
const TIMEOUT_MS = 600_000;
const MAX_DETAIL_CHARS = ${MAX_DETAIL_CHARS};

function reviewable(value, fallback) {
  const text = String(value ?? fallback).replaceAll("\\0", "�").trim() || fallback;
  return text.length <= MAX_DETAIL_CHARS ? text : undefined;
}

function reviewableInput(input) {
  try {
    return reviewable(JSON.stringify(input, null, 2), "{}");
  } catch {
    return undefined;
  }
}

function describeTool(event) {
  const detail = reviewableInput(event.input);
  if (!detail) return undefined;
  if (event.toolName === "edit") {
    return { requestType: "file_change_approval", toolName: "edit", detail };
  }
  if (event.toolName === "bash") {
    return { requestType: "command_execution_approval", toolName: "bash", detail };
  }
  if (event.toolName === "ipython") {
    return { requestType: "command_execution_approval", toolName: "ipython", detail };
  }
  return undefined;
}

async function approve(request, ctx) {
  if (!ctx.hasUI) return false;
  const message = [PREFIX, request.requestType, request.toolName, request.detail].join("\\n");
  try {
    return (
      (await ctx.ui.confirm(TITLE, message, {
        timeout: TIMEOUT_MS,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })) === true
    );
  } catch {
    return false;
  }
}
`;

  const permissionRegistrationSource =
    normalizedToken === undefined
      ? ""
      : `
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === PLAN_TOOL_NAME) return undefined;
    const request = describeTool(event);
    if (request && (await approve(request, ctx))) return undefined;
    return {
      block: true,
      reason: request
        ? "Execution was not approved in Pylon."
        : "This tool input cannot be reviewed completely in Pylon supervised mode.",
    };
  });

  pi.on("user_bash", async (event, ctx) => {
    const request = {
      requestType: "command_execution_approval",
      toolName: "bash",
      detail: reviewable(event.command, "Run a shell command"),
    };
    if (request.detail && (await approve(request, ctx))) return undefined;
    return {
      result: {
        output: "Execution was not approved in Pylon.\\n",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });
`;

  return `
const PLAN_TOOL_NAME = ${JSON.stringify(PRIME_AGENT_PLAN_TOOL_NAME)};
const PLAN_PROTOCOL = ${JSON.stringify(PRIME_AGENT_PLAN_PROTOCOL)};
const PLAN_MAX_STEPS = ${PRIME_AGENT_PLAN_MAX_STEPS};
const PLAN_MAX_STEP_CHARS = ${PRIME_AGENT_PLAN_MAX_STEP_CHARS};
const PLAN_MAX_EXPLANATION_CHARS = ${PRIME_AGENT_PLAN_MAX_EXPLANATION_CHARS};
const ROOT_SESSION_DIR = ${JSON.stringify(normalizedRootSessionDir)};
${permissionGateSource}
function isRootPylonSession(ctx) {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (typeof sessionFile !== "string") return false;
  for (const separator of ["/", "\\\\"]) {
    const prefix = ROOT_SESSION_DIR + separator;
    if (!sessionFile.startsWith(prefix)) continue;
    const relative = sessionFile.slice(prefix.length);
    return relative.length > 0 && !relative.includes("/") && !relative.includes("\\\\");
  }
  return false;
}

function normalizedPlan(params) {
  const explanation = params.explanation?.trim();
  if (explanation !== undefined && explanation.length > PLAN_MAX_EXPLANATION_CHARS) {
    throw new Error("Plan explanation is too long.");
  }
  if (!Array.isArray(params.plan) || params.plan.length > PLAN_MAX_STEPS) {
    throw new Error("Plan contains too many steps.");
  }
  const plan = params.plan.map((item) => {
    const step = item.step.trim();
    if (step.length === 0 || step.length > PLAN_MAX_STEP_CHARS) {
      throw new Error("Plan steps must contain bounded non-empty text.");
    }
    if (item.status === "waiting") {
      if (!["user", "delegates", "external"].includes(item.waitingOn)) {
        throw new Error("Waiting plan steps require waitingOn: user, delegates, or external.");
      }
      return { step, status: item.status, waitingOn: item.waitingOn };
    }
    if (item.waitingOn !== undefined) {
      throw new Error("waitingOn is valid only for waiting plan steps.");
    }
    return { step, status: item.status };
  });
  const activeSteps = plan.filter(
    (item) => item.status === "inProgress" || item.status === "waiting",
  );
  if (activeSteps.length > 1) {
    throw new Error("Plan must contain at most one in-progress or waiting step.");
  }
  return {
    protocol: PLAN_PROTOCOL,
    ...(explanation ? { explanation } : {}),
    plan,
  };
}

export default function pylonManagedBridge(pi) {
  pi.registerTool({
    ...${JSON.stringify(PRIME_AGENT_PLAN_TOOL_DEFINITION)},
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      if (!isRootPylonSession(ctx)) {
        throw new Error("Plan updates are available only in the root Pylon session.");
      }
      const details = normalizedPlan(params);
      return {
        content: [{ type: "text", text: "Plan updated (" + details.plan.length + " steps)." }],
        details,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (isRootPylonSession(ctx)) return;
    pi.setActiveTools(pi.getActiveTools().filter((name) => name !== PLAN_TOOL_NAME));
  });
${permissionRegistrationSource}
  pi.registerCommand(${JSON.stringify(PRIME_AGENT_MANAGED_EXTENSION_MARKER_COMMAND)}, {
    description: "Pylon managed provider bridge marker",
    handler: async () => undefined,
  });
}
`;
}
