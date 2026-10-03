import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const issue: McpSessionRegistry.McpSessionRegistryShape["issue"] = ({
  threadId,
  providerInstanceId,
  browserToolsAvailable = true,
  capabilities,
}) =>
  Effect.succeed({
    config: {
      environmentId: EnvironmentId.make("environment:mcp-test"),
      threadId,
      providerSessionId: `mcp-test:${threadId}`,
      providerInstanceId,
      endpoint: "http://127.0.0.1/mcp",
      authorizationHeader: `Bearer mcp-test:${threadId}`,
      browserToolsAvailable,
      ...(capabilities ? { capabilities } : {}),
    },
  });

export const layer = Layer.succeed(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.McpSessionRegistry.of({
    issue,
    issueIfCurrent: (request, isCurrent) =>
      isCurrent.pipe(
        Effect.flatMap((current) => (current ? issue(request) : Effect.succeed(undefined))),
      ),
    resolve: () => Effect.succeed(undefined),
    touch: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  }),
);
