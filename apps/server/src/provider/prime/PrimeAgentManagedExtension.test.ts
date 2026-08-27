import { describe, expect, it } from "@effect/vitest";

import {
  PRIME_AGENT_PLAN_PROTOCOL,
  PRIME_AGENT_PLAN_TOOL_NAME,
  makePrimeAgentManagedExtensionSource,
  projectPrimeAgentManagedPermissionRequest,
} from "./PrimeAgentManagedExtension.ts";

const token = "01234567-89ab-cdef-0123-456789abcdef";
const project = (input: {
  readonly method: string;
  readonly title?: string;
  readonly message?: string;
}) => projectPrimeAgentManagedPermissionRequest(input, token);

describe("projectPrimeAgentManagedPermissionRequest", () => {
  it("projects only the versioned, session-authorized managed confirmation format", () => {
    expect(
      project({
        method: "confirm",
        title: `Pylon execution approval:${token}`,
        message: "pylon-permission-v1\ncommand_execution_approval\nbash\nprintf ok",
      }),
    ).toEqual({
      _tag: "Request",
      requestType: "command_execution_approval",
      toolName: "bash",
      detail: "printf ok",
    });
    expect(
      project({
        method: "confirm",
        title: "Another extension",
        message: "pylon-permission-v1\ncommand_execution_approval\nbash\nprintf ok",
      }),
    ).toEqual({ _tag: "NotManaged" });
  });

  it("marks wrong-token or malformed known requests for fail-closed handling", () => {
    for (const input of [
      { method: "confirm", title: "Pylon execution approval:wrong", message: "value" },
      { method: "input", title: `Pylon execution approval:${token}`, message: "value" },
      { method: "confirm", title: `Pylon execution approval:${token}` },
      {
        method: "confirm",
        title: `Pylon execution approval:${token}`,
        message: "pylon-permission-v2\ncommand_execution_approval\nbash\nprintf ok",
      },
      {
        method: "confirm",
        title: `Pylon execution approval:${token}`,
        message: "pylon-permission-v1\nunknown\nbash\nprintf ok",
      },
      {
        method: "confirm",
        title: `Pylon execution approval:${token}`,
        message: "pylon-permission-v1\ndynamic_tool_call\ncustom\nhidden arguments",
      },
    ]) {
      expect(project(input)).toEqual({ _tag: "Malformed" });
    }
  });
});

interface LoadedExtension {
  readonly handlers: Map<string, (event: unknown, context: unknown) => Promise<unknown>>;
  readonly registrations: Array<string>;
  readonly activeTools: () => ReadonlyArray<string>;
  readonly tools: Map<
    string,
    {
      readonly execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        context: unknown,
      ) => Promise<unknown>;
    }
  >;
}

async function loadExtension(source: string): Promise<LoadedExtension> {
  const encoded = Buffer.from(source).toString("base64");
  const loaded = await import(`data:text/javascript;base64,${encoded}`);
  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>();
  const registrations: Array<string> = [];
  const tools = new Map<
    string,
    {
      readonly execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        context: unknown,
      ) => Promise<unknown>;
    }
  >();
  let activeTools = ["bash", PRIME_AGENT_PLAN_TOOL_NAME];
  loaded.default({
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: ReadonlyArray<string>) => {
      activeTools = [...names];
    },
    registerCommand: (name: string) => registrations.push(`command:${name}`),
    registerTool: (tool: {
      readonly name: string;
      readonly execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        context: unknown,
      ) => Promise<unknown>;
    }) => {
      registrations.push(`tool:${tool.name}`);
      tools.set(tool.name, tool);
    },
    on: (name: string, handler: (event: unknown, context: unknown) => Promise<unknown>) => {
      registrations.push(`hook:${name}`);
      handlers.set(name, handler);
    },
  });
  return { handlers, registrations, activeTools: () => [...activeTools], tools };
}

const ROOT_SESSION_DIR = "/tmp/pylon-session";
const extensionContext = (root: boolean) => ({
  sessionManager: {
    getSessionFile: () =>
      root ? `${ROOT_SESSION_DIR}/root.jsonl` : `${ROOT_SESSION_DIR}/children/child.jsonl`,
  },
});
const extensionSource = (permissionToken?: string) =>
  makePrimeAgentManagedExtensionSource({
    rootSessionDir: ROOT_SESSION_DIR,
    ...(permissionToken === undefined ? {} : { permissionToken }),
  });

describe("makePrimeAgentManagedExtensionSource", () => {
  it("registers a bounded authoritative plan tool without an execution gate in full access", async () => {
    const extension = await loadExtension(extensionSource());
    expect(extension.registrations).toEqual([
      `tool:${PRIME_AGENT_PLAN_TOOL_NAME}`,
      "hook:session_start",
      "command:pylon-managed-bridge-v1",
    ]);

    const result = await extension.tools.get(PRIME_AGENT_PLAN_TOOL_NAME)?.execute(
      "call-1",
      {
        explanation: "  Implement safely  ",
        plan: [
          { step: "  Inspect existing behavior ", status: "completed" },
          { step: "Add projection", status: "inProgress" },
        ],
      },
      undefined,
      undefined,
      extensionContext(true),
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "Plan updated (2 steps)." }],
      details: {
        protocol: PRIME_AGENT_PLAN_PROTOCOL,
        explanation: "Implement safely",
        plan: [
          { step: "Inspect existing behavior", status: "completed" },
          { step: "Add projection", status: "inProgress" },
        ],
      },
    });
    await expect(
      extension.tools
        .get(PRIME_AGENT_PLAN_TOOL_NAME)
        ?.execute("call-clear", { plan: [] }, undefined, undefined, extensionContext(true)),
    ).resolves.toEqual({
      content: [{ type: "text", text: "Plan updated (0 steps)." }],
      details: { protocol: PRIME_AGENT_PLAN_PROTOCOL, plan: [] },
    });
    await extension.handlers.get("session_start")?.({}, extensionContext(false));
    expect(extension.activeTools()).toEqual(["bash"]);
    await expect(
      extension.tools
        .get(PRIME_AGENT_PLAN_TOOL_NAME)
        ?.execute("call-2", { plan: [] }, undefined, undefined, extensionContext(false)),
    ).rejects.toThrow("root Pylon session");
  });

  it("combines plan updates with the supervised gate and allows only that side-effect-free tool", async () => {
    const source = extensionSource(token);
    expect(source).toContain('pi.on("tool_call"');
    expect(source).toContain('pi.on("user_bash"');
    expect(source).toContain("block: true");
    expect(source).toContain("timeout: TIMEOUT_MS");
    expect(source).toContain("ctx.signal");
    expect(source).toContain("text.length <= MAX_DETAIL_CHARS");
    expect(source).toContain(token);

    const extension = await loadExtension(source);
    expect(extension.registrations).toEqual([
      `tool:${PRIME_AGENT_PLAN_TOOL_NAME}`,
      "hook:session_start",
      "hook:tool_call",
      "hook:user_bash",
      "command:pylon-managed-bridge-v1",
    ]);
    const noUi = { hasUI: false, ui: {} };
    await expect(
      extension.handlers.get("tool_call")?.(
        { toolName: PRIME_AGENT_PLAN_TOOL_NAME, input: {} },
        noUi,
      ),
    ).resolves.toBeUndefined();
    await expect(
      extension.handlers.get("tool_call")?.(
        { toolName: "bash", input: { command: "touch denied" } },
        noUi,
      ),
    ).resolves.toMatchObject({ block: true });
    await expect(
      extension.handlers.get("user_bash")?.({ command: "touch denied" }, noUi),
    ).resolves.toMatchObject({ result: { exitCode: 1 } });
    let confirmations = 0;
    let confirmedMessage = "";
    const allowed = {
      hasUI: true,
      ui: {
        confirm: async (_title: string, message: string) => {
          confirmations += 1;
          confirmedMessage = message;
          return true;
        },
      },
    };
    await expect(
      extension.handlers.get("tool_call")?.(
        {
          toolName: "edit",
          input: { path: "/tmp/approved", edits: [{ oldText: "before", newText: "after" }] },
        },
        allowed,
      ),
    ).resolves.toBeUndefined();
    expect(confirmations).toBe(1);
    expect(confirmedMessage).toContain('"oldText": "before"');
    expect(confirmedMessage).toContain('"newText": "after"');
    await expect(
      extension.handlers.get("tool_call")?.(
        { toolName: "future-tool", input: { hidden: true } },
        allowed,
      ),
    ).resolves.toMatchObject({ block: true });
    await expect(
      extension.handlers.get("tool_call")?.(
        { toolName: "bash", input: { command: "a".repeat(2_001) } },
        allowed,
      ),
    ).resolves.toMatchObject({ block: true });
    await expect(
      extension.handlers.get("user_bash")?.({ command: "a".repeat(2_001) }, allowed),
    ).resolves.toMatchObject({ result: { exitCode: 1 } });
    expect(confirmations).toBe(1);
  });

  it("rejects unusable correlation tokens and malformed direct tool calls", async () => {
    expect(() => extensionSource("short")).toThrow();
    const extension = await loadExtension(extensionSource());
    await expect(
      extension.tools.get(PRIME_AGENT_PLAN_TOOL_NAME)?.execute(
        "call-1",
        {
          plan: [{ step: "   ", status: "pending" }],
        },
        undefined,
        undefined,
        extensionContext(true),
      ),
    ).rejects.toThrow("Plan steps must contain bounded non-empty text.");
  });
});
