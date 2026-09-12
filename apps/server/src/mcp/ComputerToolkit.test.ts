import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { CuaService, decodeCuaResult } from "../computer/CuaService.ts";
import { McpInvocationContext, type McpCapability } from "./McpInvocationContext.ts";
import * as ComputerToolkit from "./ComputerToolkit.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const providers = ["codex", "claude", "cursor", "grok", "opencode", "antigravity", "prime-agent"];

const encodeResult = Schema.encodeEffect(McpSchema.CallToolResult);

for (const provider of providers) {
  it.effect(`exposes discovery and native screenshot results to ${provider}`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owners: string[] = [];
        const CuaMock = Layer.mock(CuaService)({
          tools: (owner) =>
            Effect.sync(() => {
              owners.push(owner.providerSessionId);
              return { tools: ["snapshot"] };
            }),
          call: (owner, name, args) =>
            Effect.gen(function* () {
              owners.push(owner.providerSessionId);
              expect(name).toBe("snapshot");
              expect(args).toEqual({ pid: 123 });
              return yield* decodeCuaResult({
                content: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
                isError: false,
              }).pipe(Effect.orDie);
            }),
        });
        const layer = ComputerToolkit.layer.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(CuaMock),
        );
        yield* Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const scope = {
            environmentId: EnvironmentId.make("env"),
            threadId: ThreadId.make("thread"),
            providerInstanceId: ProviderInstanceId.make(provider),
            providerSessionId: `${provider}-session`,
            capabilities: new Set<McpCapability>(["computer"]),
            issuedAt: 1,
          };
          const call = (
            name: string,
            args: Record<string, unknown>,
            capabilities = scope.capabilities,
          ) =>
            server
              .callTool({ name, arguments: args })
              .pipe(
                Effect.provideService(McpInvocationContext, { ...scope, capabilities }),
                Effect.provideService(McpSchema.McpServerClient, client),
              );
          expect(server.tools.map(({ tool }) => tool.name).sort()).toEqual([
            "computer_call",
            "computer_tools",
          ]);
          const denied = yield* call(
            "computer_call",
            { name: "snapshot", arguments: { pid: 123 } },
            new Set(),
          );
          expect(denied.isError).toBe(true);
          expect(owners).toEqual([]);
          yield* call("computer_tools", {});
          const result = yield* call("computer_call", {
            name: "snapshot",
            arguments: { pid: 123 },
          });
          const encoded = yield* encodeResult(result);
          expect(encoded.content).toEqual([{ type: "image", mimeType: "image/png", data: "cG5n" }]);
          expect(owners).toEqual([`${provider}-session`, `${provider}-session`]);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
}
