import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as CodexClient from "./client.ts";
import * as CodexError from "./errors.ts";
import * as Replay from "./replay.ts";

const initialize = {
  clientInfo: { name: "T3 Code", title: "T3 Code", version: "recorded-version" },
  capabilities: { experimentalApi: true, optOutNotificationMethods: null },
};

const transcript: Replay.CodexAppServerReplayTranscript = {
  provider: "codex",
  protocol: "codex.app-server",
  version: "0.0.1",
  scenario: "desktop-product-identity",
  entries: [
    { type: "expect_outbound", frame: { id: 1, method: "initialize", params: initialize } },
    {
      type: "emit_inbound",
      frame: {
        id: 1,
        result: {
          userAgent: "replay",
          codexHome: "/fixture",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
  ],
};

it.effect("replays the recorded desktop handshake with Pylon identity", () =>
  Effect.gen(function* () {
    const driver = yield* Replay.makeReplayDriver(transcript);
    const response = yield* Effect.gen(function* () {
      const client = yield* CodexClient.CodexAppServerClient;
      return yield* client.request("initialize", {
        ...initialize,
        clientInfo: { name: "t3code_desktop", title: "Pylon Desktop", version: "current-version" },
      });
    }).pipe(Effect.provide(Replay.layerReplayWithDriver(driver)));
    assert.equal(response.userAgent, "replay");
    assert.deepEqual(yield* Ref.get(driver.state), { cursor: 2, failure: null });
  }),
);

it.effect.each([
  { ...initialize, clientInfo: { ...initialize.clientInfo, name: "unrelated-client" } },
  { ...initialize, capabilities: { ...initialize.capabilities, experimentalApi: false } },
])("retains mismatches for unrelated identities and protocol capabilities: %j", (params) =>
  Effect.gen(function* () {
    const driver = yield* Replay.makeReplayDriver(transcript);
    yield* Effect.gen(function* () {
      const client = yield* CodexClient.CodexAppServerClient;
      return yield* client.request("initialize", params).pipe(Effect.result);
    }).pipe(Effect.provide(Replay.layerReplayWithDriver(driver)));
    assert.instanceOf(
      (yield* Ref.get(driver.state)).failure,
      Replay.CodexAppServerReplayFrameMismatchError,
    );
  }),
);

it.effect("reports the app-server exit to clients waiting on termination", () =>
  Effect.gen(function* () {
    const driver = yield* Replay.makeReplayDriver({
      ...transcript,
      entries: [...transcript.entries, { type: "runtime_exit", status: "success" }],
    });
    const termination = yield* Effect.gen(function* () {
      const client = yield* CodexClient.CodexAppServerClient;
      yield* client.request("initialize", initialize);
      return yield* client.awaitTermination;
    }).pipe(Effect.provide(Replay.layerReplayWithDriver(driver)));
    assert.instanceOf(termination, CodexError.CodexAppServerProcessExitedError);
  }),
);
