import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as NodeURL from "node:url";

import { make, type AcpSessionRequestLogEvent } from "./AcpSessionRuntime.ts";

const mockPeerPath = NodeURL.fileURLToPath(
  new URL("../../../../../packages/effect-acp/test/fixtures/acp-mock-peer.ts", import.meta.url),
);

const startRuntime = (authMethodId?: string) =>
  Effect.gen(function* () {
    const requestLog = yield* Ref.make<Array<AcpSessionRequestLogEvent>>([]);
    const runtime = yield* make({
      spawn: {
        command: process.execPath,
        args: [mockPeerPath],
      },
      cwd: process.cwd(),
      clientInfo: {
        name: "acp-session-runtime-test",
        version: "0.0.0",
      },
      ...(authMethodId !== undefined ? { authMethodId } : {}),
      requestLogger: (event) => Ref.update(requestLog, (events) => [...events, event]),
    });

    yield* runtime.start();
    return (yield* Ref.get(requestLog))
      .filter((event) => event.status === "started")
      .map((event) => event.method);
  });

it.effect("skips ACP authentication only when no auth method is configured", () =>
  Effect.gen(function* () {
    const withoutAuthentication = yield* startRuntime();
    const withAuthentication = yield* startRuntime("cursor_login");

    assert.deepEqual(withoutAuthentication, ["initialize", "session/new"]);
    assert.deepEqual(withAuthentication, ["initialize", "authenticate", "session/new"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
