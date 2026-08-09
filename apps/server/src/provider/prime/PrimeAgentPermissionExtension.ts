const MANAGED_PERMISSION_TITLE_PREFIX = "Pylon execution approval";
const MANAGED_PERMISSION_MESSAGE_PREFIX = "pylon-permission-v1";
const MAX_TOOL_NAME_CHARS = 128;
const MAX_DETAIL_CHARS = 2_000;

export const PRIME_AGENT_PERMISSION_EXTENSION_FILENAME = "pylon-permission-gate-v1.mjs";
export const PRIME_AGENT_PERMISSION_EXTENSION_MARKER_COMMAND = "pylon-permission-gate-v1";

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
 * Loaded explicitly only for approval-required daemon sessions. Every executable
 * Prime tool is stopped at the public blocking `tool_call` hook before its
 * implementation runs. User-initiated daemon bash uses a separate public hook,
 * so it receives the same gate and a synthetic failure when denied.
 */
export function makePrimeAgentPermissionExtensionSource(token: string): string {
  const normalizedToken = token.trim();
  if (normalizedToken.length < 16 || normalizedToken.length > 128) {
    throw new Error("Prime Agent permission tokens must contain between 16 and 128 characters.");
  }
  return `
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

export default function pylonPermissionGate(pi) {
  pi.on("tool_call", async (event, ctx) => {
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

  pi.registerCommand(${JSON.stringify("pylon-permission-gate-v1")}, {
    description: "Pylon managed execution approval marker",
    handler: async () => undefined,
  });
}
`;
}
