// @effect-diagnostics nodeBuiltinImport:off
//
// A transfer budget for the ACP adapter boundary.
//
// `apps/server/src/server.test.ts` already caps thread HTTP and WebSocket transfer, but it
// replays recorded fixtures through Codex and Claude, so it never runs an ACP adapter and
// cannot see how many provider events an ACP tool call produces in the first place. That
// decision is `decideToolCallUpdateEmission`, shared by Grok, Cursor, and Prime Agent.
//
// The budget is two-sided on purpose. A ceiling alone would have passed on the bug this
// guards: command tools keep `detail` equal to the command, so coalescing that measured only
// `detail` saw no growth, suppressed every in-progress update, and delivered the whole build
// log at completion. That reads as "wonderfully few messages" to a ceiling and as a dead UI
// to a user. The floor is what makes this test worth having.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  GrokSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeGrokAdapter } from "../Layers/GrokAdapter.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

/** Emitted stdout chunks, and the characters each one adds. */
const STREAM_CHUNKS = 40;
const CHUNK_CHARS = 64;
const TOTAL_OUTPUT_CHARS = STREAM_CHUNKS * CHUNK_CHARS;

// `TOOL_CALL_UPDATE_MIN_DETAIL_GROWTH_CHARS` is 256, so one emission per 256 characters of
// growth is the designed cadence: 2,560 characters of stdout costs about ten updates, not
// forty. Observed at the time of writing: 11, which is the ten growth flushes plus the
// pending-to-in_progress status change. The bounds keep headroom in both directions rather
// than pinning that number, so a deliberate change to the thresholds does not fail here —
// only losing streaming altogether, or losing coalescing altogether, does.
const MIN_IN_PROGRESS_UPDATES = 4;
const MAX_IN_PROGRESS_UPDATES = 16;

const emissionBudgetTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-acp-emission-budget-",
}).pipe(Layer.provideMerge(NodeServices.layer));

async function makeStreamingMockWrapper() {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-emission-budget-"));
  const wrapperPath = NodePath.join(dir, "fake-grok.sh");
  const script = `#!/bin/sh
export T3_ACP_STREAM_COMMAND_CHUNKS=${JSON.stringify(String(STREAM_CHUNKS))}
export T3_ACP_STREAM_COMMAND_CHUNK_CHARS=${JSON.stringify(String(CHUNK_CHARS))}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

it.layer(emissionBudgetTestLayer)("ACP tool call emission budget", (it) => {
  it.effect("coalesces a streaming command tool without withholding its output", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-emission-budget-thread");
      const wrapperPath = yield* Effect.promise(() => makeStreamingMockWrapper());
      const adapter = yield* makeGrokAdapter(decodeGrokSettings({ binaryPath: wrapperPath })).pipe(
        Effect.orDie,
      );

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-mock-alt" },
      });

      yield* adapter.sendTurn({ threadId, input: "run the build", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const toolCallEvents = runtimeEvents.filter((event) => event.itemId === "tool-call-stream-1");
      const inProgressUpdates = toolCallEvents.filter((event) => event.type === "item.updated");
      const completions = toolCallEvents.filter((event) => event.type === "item.completed");

      // The terminal update always emits, so the tool call must resolve exactly once.
      assert.lengthOf(completions, 1);

      // Floor: output has to stream. Withholding it until completion is the regression this
      // test exists for, and it looks like a hung UI to anyone running a build through Grok.
      assert.isAtLeast(
        inProgressUpdates.length,
        MIN_IN_PROGRESS_UPDATES,
        `expected streaming command output to reach clients before completion, got ${inProgressUpdates.length} in-progress updates for ${TOTAL_OUTPUT_CHARS} characters of stdout`,
      );

      // Ceiling: coalescing has to hold. One frame per incoming chunk would put every ACP
      // provider's live tool output straight onto the wire over relay and mobile links.
      assert.isAtMost(
        inProgressUpdates.length,
        MAX_IN_PROGRESS_UPDATES,
        `expected coalescing to bound live tool updates, got ${inProgressUpdates.length} for ${STREAM_CHUNKS} provider chunks`,
      );

      // And it must be coalescing rather than passing chunks through one for one.
      assert.isBelow(inProgressUpdates.length, STREAM_CHUNKS);

      yield* adapter.stopSession(threadId);
    }),
  );
});
