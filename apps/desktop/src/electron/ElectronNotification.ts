import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export class ElectronNotification extends Context.Service<
  ElectronNotification,
  {
    /** False on Linux without a notification daemon; the feature no-ops. */
    readonly isSupported: Effect.Effect<boolean>;
    readonly show: (input: {
      readonly title: string;
      readonly body: string;
      readonly onClick: () => void;
    }) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronNotification") {}

export const make = Effect.gen(function* () {
  // Electron drops the native event delegate when the JS notification is collected.
  const pending = new Set<Electron.Notification>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const notification of pending) notification.close();
      pending.clear();
    }),
  );

  return ElectronNotification.of({
    isSupported: Effect.sync(() => Electron.Notification.isSupported()),
    show: (input) =>
      Effect.sync(() => {
        const notification = new Electron.Notification({ title: input.title, body: input.body });
        pending.add(notification);
        const release = () => {
          pending.delete(notification);
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
