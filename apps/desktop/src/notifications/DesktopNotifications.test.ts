import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";
import type * as Electron from "electron";

import * as ElectronNotification from "../electron/ElectronNotification.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { NOTIFICATION_NAVIGATE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopNotifications from "./DesktopNotifications.ts";

const candidates = [
  { environmentId: "env-1", threadId: "t1", title: "First — Pylon", body: "Agent finished" },
  { environmentId: "env-2", threadId: "t2", title: "Second — Pylon", body: "Approval needed" },
];

function harness(
  options: { supported?: boolean; focused?: boolean; noWindow?: boolean; onSend?: () => void } = {},
) {
  const shown: Array<Parameters<ElectronNotification.ElectronNotification["Service"]["show"]>[0]> =
    [];
  const send = vi.fn(() => options.onSend?.());
  const window = {
    isFocused: () => options.focused ?? false,
    webContents: { send },
  } as unknown as Electron.BrowserWindow;
  const reveal = vi.fn(() => window);
  const dependencies = Layer.mergeAll(
    Layer.succeed(ElectronNotification.ElectronNotification, {
      isSupported: Effect.succeed(options.supported ?? true),
      show: (input) =>
        Effect.sync(() => {
          shown.push(input);
        }),
    }),
    Layer.mock(ElectronWindow.ElectronWindow)({
      focusedMainOrFirst: Effect.succeed(options.noWindow ? Option.none() : Option.some(window)),
    }),
    Layer.mock(DesktopWindow.DesktopWindow)({ revealOrCreateMain: Effect.sync(reveal) }),
  );
  return {
    shown,
    send,
    reveal,
    layer: DesktopNotifications.layer.pipe(Layer.provide(dependencies)),
  };
}

describe("DesktopNotifications", () => {
  it.effect("drops all candidates while a Pylon window is focused", () => {
    const h = harness({ focused: true });
    return Effect.gen(function* () {
      const service = yield* DesktopNotifications.DesktopNotifications;
      yield* service.deliver(candidates);
      assert.deepEqual(h.shown, []);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("delivers each candidate when the fallback main window is unfocused", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* DesktopNotifications.DesktopNotifications;
      yield* service.deliver(candidates);
      assert.deepEqual(
        h.shown.map(({ title, body }) => ({ title, body })),
        candidates.map(({ title, body }) => ({ title, body })),
      );
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("delivers when the focused-window lookup is empty", () => {
    const h = harness({ noWindow: true });
    return Effect.gen(function* () {
      const service = yield* DesktopNotifications.DesktopNotifications;
      yield* service.deliver(candidates);
      assert.lengthOf(h.shown, 2);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("silently drops candidates when unsupported", () => {
    const h = harness({ supported: false });
    return Effect.gen(function* () {
      const service = yield* DesktopNotifications.DesktopNotifications;
      yield* service.deliver(candidates);
      assert.deepEqual(h.shown, []);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("returns false for an unsupported test notification", () => {
    const h = harness({ supported: false });
    return Effect.gen(function* () {
      const service = yield* DesktopNotifications.DesktopNotifications;
      assert.isFalse(yield* service.sendTest);
      assert.deepEqual(h.shown, []);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("shows the test notification even while focused", () => {
    const h = harness({ focused: true });
    return Effect.gen(function* () {
      const service = yield* DesktopNotifications.DesktopNotifications;
      assert.isTrue(yield* service.sendTest);
      assert.lengthOf(h.shown, 1);
      assert.strictEqual(h.shown[0]?.title, "Pylon");
      assert.strictEqual(
        h.shown[0]?.body,
        "Notifications are working. Pylon will tell you when an agent needs you.",
      );
      h.shown[0]?.onClick();
      assert.strictEqual(h.reveal.mock.calls.length, 0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("reveals the window before sending the clicked candidate's route parameters", () =>
    Effect.gen(function* () {
      const sent = yield* Deferred.make<void>();
      const runSync = Effect.runSyncWith(yield* Effect.context<never>());
      const h = harness({
        onSend: () => {
          runSync(Deferred.succeed(sent, undefined));
        },
      });
      yield* Effect.gen(function* () {
        const service = yield* DesktopNotifications.DesktopNotifications;
        yield* service.deliver(candidates);
        const second = h.shown[1];
        assert.isDefined(second);
        second!.onClick();
        yield* Deferred.await(sent);
        assert.strictEqual(h.reveal.mock.calls.length, 1);
        assert.deepEqual(h.send.mock.calls, [
          [NOTIFICATION_NAVIGATE_CHANNEL, { environmentId: "env-2", threadId: "t2" }],
        ]);
        assert.isBelow(h.reveal.mock.invocationCallOrder[0]!, h.send.mock.invocationCallOrder[0]!);
      }).pipe(Effect.provide(h.layer));
    }),
  );
});
