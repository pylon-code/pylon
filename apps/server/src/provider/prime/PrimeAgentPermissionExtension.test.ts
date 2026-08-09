import { describe, expect, it } from "@effect/vitest";

import {
  makePrimeAgentPermissionExtensionSource,
  projectPrimeAgentManagedPermissionRequest,
} from "./PrimeAgentPermissionExtension.ts";

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

describe("makePrimeAgentPermissionExtensionSource", () => {
  it("builds a loadable gate for tools and user bash with denial and timeout paths", async () => {
    const source = makePrimeAgentPermissionExtensionSource(token);
    expect(source).toContain('pi.on("tool_call"');
    expect(source).toContain('pi.on("user_bash"');
    expect(source).toContain("block: true");
    expect(source).toContain("timeout: TIMEOUT_MS");
    expect(source).toContain("ctx.signal");
    expect(source).toContain("text.length <= MAX_DETAIL_CHARS");
    expect(source).toContain(token);

    const encoded = Buffer.from(source).toString("base64");
    const loaded = await import(`data:text/javascript;base64,${encoded}`);
    expect(loaded.default).toBeTypeOf("function");
    const handlers = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>();
    const registrations: Array<string> = [];
    loaded.default({
      registerCommand: (name: string) => registrations.push(`command:${name}`),
      on: (name: string, handler: (event: unknown, context: unknown) => Promise<unknown>) => {
        registrations.push(`hook:${name}`);
        handlers.set(name, handler);
      },
    });
    expect(registrations).toEqual([
      "hook:tool_call",
      "hook:user_bash",
      "command:pylon-permission-gate-v1",
    ]);
    const noUi = { hasUI: false, ui: {} };
    await expect(
      handlers.get("tool_call")?.({ toolName: "bash", input: { command: "touch denied" } }, noUi),
    ).resolves.toMatchObject({ block: true });
    await expect(
      handlers.get("user_bash")?.({ command: "touch denied" }, noUi),
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
      handlers.get("tool_call")?.(
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
      handlers.get("tool_call")?.({ toolName: "future-tool", input: { hidden: true } }, allowed),
    ).resolves.toMatchObject({ block: true });
    await expect(
      handlers.get("tool_call")?.(
        { toolName: "bash", input: { command: "a".repeat(2_001) } },
        allowed,
      ),
    ).resolves.toMatchObject({ block: true });
    await expect(
      handlers.get("user_bash")?.({ command: "a".repeat(2_001) }, allowed),
    ).resolves.toMatchObject({ result: { exitCode: 1 } });
    expect(confirmations).toBe(1);
  });

  it("rejects unusable correlation tokens", () => {
    expect(() => makePrimeAgentPermissionExtensionSource("short")).toThrow();
  });
});
