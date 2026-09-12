import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { CuaService } from "../computer/CuaService.ts";
import { McpInvocationContext, requireMcpCapability } from "./McpInvocationContext.ts";

const ToolsInput = Schema.Struct({ name: Schema.optional(Schema.String) });
const CallInput = Schema.Struct({
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});

const decodeToolsInput = Schema.decodeUnknownEffect(ToolsInput);
const decodeCallInput = Schema.decodeUnknownEffect(CallInput);

const textResult = (value: unknown) =>
  new McpSchema.CallToolResult({
    content: [{ type: "text", text: JSON.stringify(value) }],
  });

/** Discovery keeps the current upstream schemas available without injecting dozens of tools
 * into every provider's prompt. Preserve native MCP images and error flags on calls. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const cua = yield* CuaService;
    const register = <E>(
      name: string,
      description: string,
      inputSchema: McpSchema.Tool["inputSchema"],
      readOnly: boolean,
      handle: (input: unknown) => Effect.Effect<McpSchema.CallToolResult, E, McpInvocationContext>,
    ) =>
      server.addTool({
        tool: new McpSchema.Tool({
          name,
          description,
          inputSchema,
          annotations: {
            readOnlyHint: readOnly,
            destructiveHint: !readOnly,
            idempotentHint: readOnly,
            openWorldHint: true,
          },
        }),
        annotations: Context.empty(),
        handle: (input) =>
          Effect.withFiber((fiber) =>
            handle(input).pipe(
              Effect.provideService(
                McpInvocationContext,
                Context.getUnsafe(fiber.context, McpInvocationContext),
              ),
              Effect.catch((error) =>
                Effect.succeed(
                  new McpSchema.CallToolResult({
                    isError: true,
                    content: [
                      {
                        type: "text",
                        text: error instanceof Error ? error.message : "Computer access failed.",
                      },
                    ],
                  }),
                ),
              ),
            ),
          ),
      });
    yield* register(
      "computer_tools",
      "Discover Cua desktop automation tools on the environment server computer. Optional name returns that tool's exact input schema. Start here before computer_call. Requires Computer access in Pylon Settings → Integrations. Use preview_* for Pylon browser pages and device_* for simulators.",
      { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
      true,
      (input) =>
        Effect.gen(function* () {
          const owner = yield* requireMcpCapability("computer");
          const args = yield* decodeToolsInput(input);
          return textResult(yield* cua.tools(owner, args.name));
        }),
    );
    yield* register(
      "computer_call",
      "Call a Cua desktop tool using its exact name and arguments from computer_tools. Results include native screenshot images. Inspect current windows/elements before acting and verify changes afterward. This controls the environment server's desktop. Respect user authorization and Cua's background/foreground limits; do not retry an uncertain action blindly.",
      {
        type: "object",
        properties: {
          name: { type: "string" },
          arguments: { type: "object", additionalProperties: true },
        },
        required: ["name", "arguments"],
        additionalProperties: false,
      },
      false,
      (input) =>
        Effect.gen(function* () {
          const owner = yield* requireMcpCapability("computer");
          const args = yield* decodeCallInput(input);
          return yield* cua.call(owner, args.name, args.arguments);
        }),
    );
  }),
);
