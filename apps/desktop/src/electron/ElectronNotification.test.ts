import * as NodeV8 from "node:v8";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

const { NativeNotification } = vi.hoisted(() => {
  class NativeNotification {
    static closed = 0;
    static eventOnShow: string | undefined;
    static closeReason: string | undefined;
    private handlers = new Map<string, () => void>();
    static isSupported() {
      return true;
    }
    on(event: string, callback: (event: { reason: string | undefined }) => void) {
      this.handlers.set(event, () => callback({ reason: NativeNotification.closeReason }));
      return this;
    }
    once(event: string, callback: () => void) {
      return this.on(event, callback);
    }
    show() {
      if (NativeNotification.eventOnShow) this.handlers.get(NativeNotification.eventOnShow)?.();
    }
    close() {
      NativeNotification.closed++;
    }
  }
  return { NativeNotification };
});

vi.mock("electron", () => ({ Notification: NativeNotification }));

import * as ElectronNotification from "./ElectronNotification.ts";

describe("ElectronNotification lifetime", () => {
  it.effect("keeps native notifications alive for delayed clicks and releases at shutdown", () =>
    Effect.gen(function* () {
      const baseline = NodeV8.queryObjects(NativeNotification);
      const closedBefore = NativeNotification.closed;
      yield* Effect.gen(function* () {
        const service = yield* ElectronNotification.ElectronNotification;
        yield* service.show({ title: "Thread", body: "Done", onClick: () => {} });
        assert.strictEqual(NodeV8.queryObjects(NativeNotification), Number(baseline) + 1);
      }).pipe(Effect.provide(ElectronNotification.layer), Effect.scoped);
      assert.strictEqual(NativeNotification.closed, closedBefore + 1);
      assert.strictEqual(NodeV8.queryObjects(NativeNotification), baseline);
    }),
  );
  for (const event of ["click", "close", "failed"]) {
    it.effect(`releases a notification after ${event}`, () =>
      Effect.gen(function* () {
        const baseline = NodeV8.queryObjects(NativeNotification);
        let clicked = 0;
        NativeNotification.eventOnShow = event;
        try {
          yield* Effect.gen(function* () {
            const service = yield* ElectronNotification.ElectronNotification;
            yield* service.show({
              title: "Thread",
              body: "Done",
              onClick: () => {
                clicked++;
              },
            });
            assert.strictEqual(NodeV8.queryObjects(NativeNotification), baseline);
            assert.strictEqual(clicked, event === "click" ? 1 : 0);
          }).pipe(Effect.provide(ElectronNotification.layer), Effect.scoped);
        } finally {
          NativeNotification.eventOnShow = undefined;
        }
      }),
    );
  }
  it.effect("retains a Windows notification moved into Action Center", () =>
    Effect.gen(function* () {
      const baseline = NodeV8.queryObjects(NativeNotification);
      NativeNotification.eventOnShow = "close";
      NativeNotification.closeReason = "timedOut";
      try {
        yield* Effect.gen(function* () {
          const service = yield* ElectronNotification.ElectronNotification;
          yield* service.show({ title: "Thread", body: "Done", onClick: () => {} });
          assert.strictEqual(NodeV8.queryObjects(NativeNotification), Number(baseline) + 1);
        }).pipe(Effect.provide(ElectronNotification.layer), Effect.scoped);
      } finally {
        NativeNotification.eventOnShow = undefined;
        NativeNotification.closeReason = undefined;
      }
      assert.strictEqual(NodeV8.queryObjects(NativeNotification), baseline);
    }),
  );
  it.effect("replaces notifications for a thread and bounds retained native objects", () =>
    Effect.gen(function* () {
      const baseline = NodeV8.queryObjects(NativeNotification);
      yield* Effect.gen(function* () {
        const service = yield* ElectronNotification.ElectronNotification;
        yield* service.show({ key: "same", title: "Thread", body: "Done", onClick: () => {} });
        yield* service.show({ key: "same", title: "Thread", body: "Again", onClick: () => {} });
        assert.strictEqual(NodeV8.queryObjects(NativeNotification), Number(baseline) + 1);
        yield* service.dismiss("same");
        assert.strictEqual(NodeV8.queryObjects(NativeNotification), baseline);
        for (let index = 0; index < 140; index++) {
          yield* service.show({
            key: String(index),
            title: "Thread",
            body: "Done",
            onClick: () => {},
          });
        }
        assert.strictEqual(NodeV8.queryObjects(NativeNotification), Number(baseline) + 128);
      }).pipe(Effect.provide(ElectronNotification.layer), Effect.scoped);
      assert.strictEqual(NodeV8.queryObjects(NativeNotification), baseline);
    }),
  );
});
