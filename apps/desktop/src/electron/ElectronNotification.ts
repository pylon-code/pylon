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

export const make = ElectronNotification.of({
  isSupported: Effect.sync(() => Electron.Notification.isSupported()),
  show: (input) =>
    Effect.sync(() => {
      const notification = new Electron.Notification({
        title: input.title,
        body: input.body,
      });
      notification.on("click", input.onClick);
      notification.show();
    }),
});

export const layer = Layer.succeed(ElectronNotification, make);
