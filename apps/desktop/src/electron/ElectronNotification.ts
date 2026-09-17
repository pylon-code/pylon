import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export class ElectronNotification extends Context.Service<
  ElectronNotification,
  {
    /** False on Linux without a notification daemon; the feature no-ops. */
    readonly isSupported: Effect.Effect<boolean>;
    readonly dismiss: (key: string) => Effect.Effect<void>;
    readonly show: (input: {
      readonly key?: string;
      readonly title: string;
      readonly body: string;
      readonly onClick: () => void;
    }) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronNotification") {}

const make = Effect.gen(function* () {
  // Electron drops the native event delegate when the JS notification is collected.
  const pending = new Map<string, Electron.Notification>();
  let sequence = 0;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const notification of pending.values()) notification.close();
      pending.clear();
    }),
  );

  return ElectronNotification.of({
    isSupported: Effect.sync(() => Electron.Notification.isSupported()),
    dismiss: (key) =>
      Effect.sync(() => {
        const notification = pending.get(key);
        pending.delete(key);
        notification?.close();
      }),
    show: (input) =>
      Effect.sync(() => {
        const key = input.key ?? `test:${++sequence}`;
        const replaced = pending.get(key);
        pending.delete(key);
        replaced?.close();
        const notification = new Electron.Notification({
          title: input.title,
          body: input.body,
          silent: true,
        });
        pending.set(key, notification);
        if (pending.size > 128) {
          const oldest = pending.keys().next().value;
          if (oldest !== undefined) {
            const expired = pending.get(oldest);
            pending.delete(oldest);
            expired?.close();
          }
        }
        const release = () => {
          if (pending.get(key) === notification) pending.delete(key);
        };
        notification.once("click", () => {
          try {
            input.onClick();
          } finally {
            release();
          }
        });
        notification.on("close", (event) => {
          // Windows can move a banner into Action Center while it remains clickable.
          if (event.reason === "timedOut" || event.reason === "applicationHidden") return;
          release();
        });
        notification.once("failed", release);
        try {
          notification.show();
        } catch (cause) {
          release();
          throw cause;
        }
      }),
  });
});

export const layer = Layer.effect(ElectronNotification, make);
