import { queryObjects } from "node:v8";
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
  it("keeps displayed notifications alive for clicks and releases them at shutdown", () => {
    // queryObjects performs a full collection before counting; no timing or GC polling.
    const baseline = queryObjects(NativeNotification);
    if (typeof baseline !== "number") throw new Error("Expected an instance count");
    const closedBefore = NativeNotification.closed;
    Effect.runSync(
      Effect.gen(function* () {
        const service = yield* ElectronNotification.ElectronNotification;
        yield* service.show({ title: "Thread", body: "Agent finished", onClick: () => {} });
        assert.strictEqual(queryObjects(NativeNotification), baseline + 1);
      }).pipe(Effect.provide(ElectronNotification.layer), Effect.scoped),
    );
    assert.strictEqual(NativeNotification.closed, closedBefore + 1);
    assert.strictEqual(queryObjects(NativeNotification), baseline);
  });
  for (const event of ["click", "close", "failed"]) {
    it(`releases a notification after ${event}`, () => {
      const baseline = queryObjects(NativeNotification);
      let clicked = 0;
      NativeNotification.eventOnShow = event;
      try {
        Effect.runSync(
          Effect.gen(function* () {
            const service = yield* ElectronNotification.ElectronNotification;
            yield* service.show({
              title: "Thread",
              body: "Done",
              onClick: () => {
                clicked++;
              },
            });
            assert.strictEqual(queryObjects(NativeNotification), baseline);
            assert.strictEqual(clicked, event === "click" ? 1 : 0);
          }).pipe(Effect.provide(ElectronNotification.layer), Effect.scoped),
        );
      } finally {
        NativeNotification.eventOnShow = undefined;
      }
    });
  }

  it("retains a Windows notification moved into Action Center", () => {
    const baseline = queryObjects(NativeNotification);
    if (typeof baseline !== "number") throw new Error("Expected an instance count");
    NativeNotification.eventOnShow = "close";
    NativeNotification.closeReason = "timedOut";
    try {
      Effect.runSync(
        Effect.gen(function* () {
          const service = yield* ElectronNotification.ElectronNotification;
          yield* service.show({ title: "Thread", body: "Done", onClick: () => {} });
          assert.strictEqual(queryObjects(NativeNotification), baseline + 1);
        }).pipe(Effect.provide(ElectronNotification.layer), Effect.scoped),
      );
    } finally {
      NativeNotification.eventOnShow = undefined;
      NativeNotification.closeReason = undefined;
    }
  });
});
