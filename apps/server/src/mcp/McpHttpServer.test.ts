import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type FollowUp,
  type FollowUpFileCommand,
  type FollowUpRecordValidationCommand,
  type FollowUpUpdateStatusCommand,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as FollowUpService from "../followups/FollowUpService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);
const makeFollowUpServiceTestLayer = (
  overrides: Partial<FollowUpService.FollowUpService["Service"]> = {},
) =>
  Layer.mock(FollowUpService.FollowUpService)({
    file: () => Effect.die("unused"),
    updateStatus: () => Effect.die("unused"),
    recordValidation: () => Effect.die("unused"),
    getSnapshot: () => Effect.succeed({ sequence: 0, items: [] }),
    openBlockersForBranch: () => Effect.succeed([]),
    stream: () => Stream.empty,
    projectIdForThread: () => Effect.succeed(ProjectId.make("project-followups-mcp")),
    projectIdForRepositoryPath: () => Effect.die("unused"),
    ...overrides,
  });
const makeFollowUpRegistrationTestLayer = (
  followUpsEnabled: boolean,
  followUpService: Partial<FollowUpService.FollowUpService["Service"]> = {},
) =>
  McpHttpServer.FollowUpToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest({ followUpsEnabled })),
    Layer.provide(makeFollowUpServiceTestLayer(followUpService)),
  );

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("keeps follow-up tools undiscoverable when the initial beta setting is off", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const settings = yield* ServerSettings.ServerSettingsService;

    expect(server.tools.some(({ tool }) => tool.name.startsWith("followup_"))).toBe(false);
    yield* settings.updateSettings({ followUpsEnabled: true });
    expect(server.tools.some(({ tool }) => tool.name.startsWith("followup_"))).toBe(false);
  }).pipe(Effect.provide(makeFollowUpRegistrationTestLayer(false))),
);

it.effect("rejects follow-up calls immediately after the beta setting is disabled", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const settings = yield* ServerSettings.ServerSettingsService;
    expect(
      server.tools
        .filter(({ tool }) => tool.name.startsWith("followup_"))
        .map(({ tool }) => tool.name)
        .sort(),
    ).toEqual([
      "followup_check_gate",
      "followup_file",
      "followup_list",
      "followup_record_validation",
      "followup_resolve",
    ]);

    yield* settings.updateSettings({ followUpsEnabled: false });
    const result = yield* server
      .callTool({
        name: "followup_list",
        arguments: {},
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(true);
    const errorText = result.content.find((content) => content.type === "text");
    expect(errorText?.text).toContain("Follow-ups are disabled in server settings.");
  }).pipe(Effect.provide(makeFollowUpRegistrationTestLayer(true))),
);

it.effect("derives MCP project and agent provenance from the invocation thread", () => {
  const projectId = ProjectId.make("project-followups-authoritative");
  let filedInput: FollowUpFileCommand | undefined;
  let updateInput: FollowUpUpdateStatusCommand | undefined;
  let validationInput: FollowUpRecordValidationCommand | undefined;
  const gateQueries: Array<{ readonly projectId: ProjectId; readonly branchRef: string }> = [];
  const snapshotQueries: ProjectId[] = [];
  const now = "2026-08-04T12:00:00.000Z";
  const makeItem = (input: FollowUpFileCommand): FollowUp => ({
    id: input.itemId,
    projectId: input.projectId,
    kind: input.kind,
    status: "open",
    title: input.title,
    observation: input.observation,
    deferReason: input.deferReason,
    verifyCheck: input.verifyCheck,
    evidence: input.evidence ?? [],
    gate: input.gate ?? null,
    sourceKind: input.sourceKind,
    sourceThreadId: input.sourceThreadId ?? null,
    resolution: null,
    lastValidation: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const fileResult = yield* server
      .callTool({
        name: "followup_file",
        arguments: {
          kind: "blocker",
          title: "Keep scope authoritative",
          observation: "Caller-supplied ownership must not cross projects.",
          deferReason: "needs-decision",
          verifyCheck: "Inspect the MCP command provenance.",
          gate: { kind: "branch", ref: "feature/followups" },
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    if (fileResult.isError) {
      throw new Error(
        fileResult.content
          .map((entry) => (entry.type === "text" ? entry.text : entry.type))
          .join("; "),
      );
    }
    expect(filedInput).toMatchObject({
      projectId,
      sourceKind: "agent",
      sourceThreadId: threadId,
    });

    const listResult = yield* server
      .callTool({ name: "followup_list", arguments: {} })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(listResult.isError).not.toBe(true);
    expect(snapshotQueries).toEqual([projectId]);

    const filed = filedInput && makeItem(filedInput);
    expect(filed).toBeDefined();
    const resolveResult = yield* server
      .callTool({
        name: "followup_resolve",
        arguments: {
          itemId: filed?.id,
          expectedRevision: 0,
          resolution: { note: "Implemented.", commitSha: null },
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(resolveResult.isError).not.toBe(true);
    expect(updateInput).toMatchObject({
      projectId,
      actor: "agent",
      status: "resolved",
      resolution: { threadId },
    });

    const gateResult = yield* server
      .callTool({ name: "followup_check_gate", arguments: { branchRef: "feature/followups" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(gateResult.isError).toBe(false);
    expect(gateResult.structuredContent).toEqual({ blocked: false, blockers: [] });
    expect(gateResult.content).toEqual([{ type: "text", text: '{"blocked":false,"blockers":[]}' }]);
    expect(gateQueries).toEqual([{ projectId, branchRef: "feature/followups" }]);

    const validationResult = yield* server
      .callTool({
        name: "followup_record_validation",
        arguments: {
          itemId: filed?.id,
          expectedRevision: 0,
          outcome: "uncertain",
          verifyCheck: "Inspect the MCP command provenance.",
          note: "The available evidence was inconclusive.",
          evidence: [],
          checkedCommitSha: null,
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(validationResult.isError).not.toBe(true);
    expect(validationInput).toMatchObject({ projectId, threadId, outcome: "uncertain" });
  }).pipe(
    Effect.provide(
      makeFollowUpRegistrationTestLayer(true, {
        projectIdForThread: () => Effect.succeed(projectId),
        getSnapshot: (queriedProjectId) =>
          Effect.sync(() => {
            snapshotQueries.push(queriedProjectId);
            return { sequence: 0, items: [] };
          }),
        file: (input) =>
          Effect.sync(() => {
            filedInput = input;
            return makeItem(input);
          }),
        updateStatus: (input) =>
          Effect.sync(() => {
            updateInput = input;
            const source = filedInput && makeItem(filedInput);
            if (!source) throw new Error("file must run first");
            return { ...source, status: input.status, resolution: input.resolution ?? null };
          }),
        recordValidation: (input) =>
          Effect.sync(() => {
            validationInput = input;
            const source = filedInput && makeItem(filedInput);
            if (!source) throw new Error("file must run first");
            return source;
          }),
        openBlockersForBranch: (queriedProjectId, branchRef) =>
          Effect.sync(() => {
            gateQueries.push({ projectId: queriedProjectId, branchRef });
            return [];
          }),
      }),
    ),
  );
});

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const press = yield* server
        .callTool({ name: "preview_press", arguments: { key: "Enter" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);
